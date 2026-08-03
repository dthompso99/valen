import {fileURLToPath} from 'url';
import {SemanticAnalyzer} from './semantic.js';
import {formatDiagnostic} from './diagnostics.js';

export class IrGenerator {
    generate(semanticResult) {
        if (!semanticResult.success) {
            throw new Error('Cannot generate IR for a program with semantic errors');
        }

        this.program = {
            kind: 'IrProgram',
            types: [],
            functions: [],
            externals: [],
            foreignLibraries: [],
            entry: null
        };

        const programs = semanticResult.modules
            ? [...semanticResult.modules.values()].map(module => module.program)
            : [semanticResult.program];

        this.contractTypes = new Set();
        for (const program of programs) {
            for (const declaration of [...program.objects, ...program.libraries]) this.collectContractTypes(declaration);
        }

        for (const program of programs) {
            for (const declaration of [...program.objects, ...program.libraries]) {
                this.declareContainer(declaration);
            }
        }
        for (const program of programs) {
            for (const declaration of [...program.objects, ...program.libraries]) {
                this.lowerContainer(declaration);
            }
        }

        const tests = programs.flatMap(program => program.libraries.filter(declaration => declaration.isTest));
        if (tests.length) this.lowerTestRunner(tests);

        return this.program;
    }

    generateFile(filePath, loaderOptions = {}) {
        return this.generate(new SemanticAnalyzer().analyzeFile(filePath, loaderOptions));
    }

    declareContainer(declaration) {
        const symbol = declaration.semanticSymbol;
        if (declaration.kind === 'ObjectDeclaration') {
            const fields = this.inheritedFields(symbol);
            this.program.types.push({
                kind: 'IrType',
                name: symbol.type,
                displayName: symbol.qualifiedName,
                base: symbol.base?.type ?? null,
                virtualMethods: this.virtualMethods(symbol),
                contracts: this.contractEntries(symbol),
                initializer: declaration.members.some(member => member.kind === 'FieldDeclaration' && member.initializer)
                    ? `${symbol.type}.$initialize`
                    : null,
                fields: fields
                    .map((field, index) => ({
                        name: field.name,
                        symbol: `${field.semanticSymbol.owner.type}.${field.name}`,
                        type: field.semanticSymbol.type,
                        ownership: field.semanticSymbol.ownership,
                        index
                    }))
            });
        }
        for (const member of declaration.members) {
            if (member.kind === 'ObjectDeclaration') this.declareContainer(member);
        }
    }

    collectContractTypes(declaration) {
        const symbol = declaration.semanticSymbol;
        for (const contract of symbol?.contracts ?? []) this.contractTypes.add(contract.type);
        for (const member of declaration.members) {
            if (member.kind === 'ObjectDeclaration') this.collectContractTypes(member);
        }
    }

    contractEntries(symbol) {
        const contracts = new Map();
        if (symbol.base) {
            for (const entry of this.contractEntries(symbol.base)) contracts.set(entry.name, entry);
        }
        if (this.contractTypes.has(symbol.type)) contracts.set(symbol.type, this.contractEntry(symbol, symbol));
        for (const contract of symbol.contracts) {
            let current = contract;
            while (current) {
                contracts.set(current.type, this.contractEntry(symbol, current));
                current = current.base;
            }
        }
        return [...contracts.values()];
    }

    contractEntry(implementation, contract) {
        const methods = [...this.contractMethodsFor(contract)].map(required => {
            const actual = this.lookupMethodFor(implementation, required.name, required.parameters);
            return {name: required.name, target: this.functionName(actual)};
        });
        return {name: contract.type, methods};
    }

    contractMethodsFor(contract) {
        const methods = new Map();
        if (contract.base) for (const method of this.contractMethodsFor(contract.base)) methods.set(this.methodKey(method), method);
        for (const method of [...contract.methodOverloads.values()].flat()) if (method.name !== '__' && method.visibility !== 'private') methods.set(this.methodKey(method), method);
        return methods.values();
    }

    lookupMethodFor(symbol, name, parameters) {
        let current = symbol;
        while (current) {
            const method = (current.methodOverloads.get(name) ?? []).find(candidate =>
                candidate.visibility !== 'private' && candidate.parameters.length === parameters.length &&
                candidate.parameters.every((parameter, index) => parameter.type === parameters[index].type));
            if (method && name !== '__') return method;
            current = current.base;
        }
        return null;
    }

    inheritedFields(symbol) {
        const fields = symbol.base ? this.inheritedFields(symbol.base) : [];
        return fields.concat([...symbol.fields.values()].map(field => field.declaration));
    }

    virtualMethods(symbol) {
        const methods = symbol.base ? this.virtualMethods(symbol.base) : [];
        for (const method of [...symbol.methodOverloads.values()].flat()) {
            if (method.name === '__' || method.visibility === 'private') continue;
            const key = this.methodKey(method);
            const slot = methods.findIndex(entry => entry.name === key);
            const entry = {name: key, target: this.functionName(method)};
            if (slot < 0) methods.push(entry);
            else methods[slot] = entry;
        }
        return methods;
    }

    lowerContainer(declaration) {
        if (declaration.kind === 'ObjectDeclaration') this.lowerFieldInitializers(declaration);
        for (const member of declaration.members) {
            if (member.kind === 'MethodDeclaration') this.lowerMethod(member, declaration);
            else if (member.kind === 'ObjectDeclaration') this.lowerContainer(member);
        }
    }

    lowerFieldInitializers(declaration) {
        const fields = declaration.members.filter(member => member.kind === 'FieldDeclaration' && member.initializer);
        if (fields.length === 0) return;
        const owner = declaration.semanticSymbol;
        this.function = {
            kind: 'IrFunction',
            name: `${owner.type}.$initialize`,
            displayName: `${owner.qualifiedName}.$initialize`,
            owner: owner.type,
            parameters: [{name: 'self', type: owner.type}],
            returnType: 'void',
            blocks: [{label: 'entry', instructions: []}]
        };
        this.block = this.function.blocks[0];
        this.locals = new Map();
        this.nextLocal = 0;
        this.nextTemporary = 0;
        this.nextBlock = 0;
        this.loopStack = [];
        this.lifetimeScopes = [];
        const instance = {kind: 'parameter', name: 'self', type: owner.type};
        for (const field of fields) {
            const value = this.lowerExpression(field.initializer);
            this.emit('store_field', {
                object: instance,
                field: `${owner.type}.${field.name}`,
                value
            });
        }
        this.emit('return', {});
        this.program.functions.push(this.function);
    }

    lowerMethod(declaration, ownerDeclaration) {
        const symbol = declaration.semanticSymbol;
        const owner = ownerDeclaration.semanticSymbol;
        if (declaration.isNative) {
            const foreignLibrary = declaration.foreignLibrary;
            if (foreignLibrary && !this.program.foreignLibraries.includes(foreignLibrary)) {
                this.program.foreignLibraries.push(foreignLibrary);
            }
            const runtimeSymbol = foreignLibrary ? declaration.foreignSymbol : this.runtimeSymbol(symbol);
            if (runtimeSymbol === 'valen_Operations_threadStart') {
                for (const library of ['pthread', 'c']) {
                    if (!this.program.foreignLibraries.includes(library)) this.program.foreignLibraries.push(library);
                }
            }
            this.program.externals.push({
                kind: 'IrExternalFunction',
                name: this.functionName(symbol),
                displayName: symbol.qualifiedName,
                parameters: symbol.parameters.map(parameter => ({
                    name: parameter.name,
                    type: parameter.type
                })),
                returnType: symbol.returnType,
                runtimeSymbol,
                foreignLibrary
            });
            return;
        }
        this.function = {
            kind: 'IrFunction',
            name: this.functionName(symbol),
            displayName: symbol.qualifiedName,
            owner: owner.type,
            parameters: [],
            returnType: symbol.returnType,
            blocks: [{label: 'entry', instructions: []}]
        };
        this.block = this.function.blocks[0];
        this.locals = new Map();
        this.nextLocal = 0;
        this.nextTemporary = 0;
        this.nextBlock = 0;
        this.loopStack = [];
        this.lifetimeScopes = [];

        if (owner.kind === 'Object') {
            this.function.parameters.push({name: 'self', type: owner.type});
        }
        for (const parameter of symbol.parameters) {
            this.function.parameters.push({name: parameter.name, type: parameter.type});
            this.locals.set(parameter, {kind: 'parameter', name: parameter.name, type: parameter.type});
        }

        this.lowerBlock(declaration.body);
        const instructions = this.block.instructions;
        if (symbol.returnType === 'void' && instructions.at(-1)?.op !== 'return') {
            this.emit('return', {});
        }

        this.program.functions.push(this.function);
        if (ownerDeclaration.name === 'entry' && declaration.name === '__') {
            this.program.entry = this.function.name;
        }
    }

    lowerBlock(block) {
        const lifetimeScope = [];
        this.lifetimeScopes.push(lifetimeScope);
        for (const statement of block.statements) {
            if (this.isTerminated()) break;
            this.lowerStatement(statement);
        }
        if (!this.isTerminated()) this.destroyLifetimeScope(lifetimeScope);
        this.lifetimeScopes.pop();
    }

    lowerStatement(statement) {
        switch (statement.kind) {
            case 'BlockStatement':
                this.lowerBlock(statement);
                break;
            case 'UnsafeStatement':
                this.lowerBlock(statement.body);
                break;
            case 'LocalDeclaration': {
                const value = statement.initializer ? this.lowerExpression(statement.initializer) : null;
                const local = {
                    kind: 'local',
                    name: `${statement.name}#${this.nextLocal++}`,
                    type: statement.inferredType,
                    value
                };
                this.locals.set(statement.semanticSymbol, local);
                this.emit('declare_local', {name: local.name, type: local.type, value});
                if (statement.semanticSymbol.declaredOwnership === 'owned' && this.isObjectLifetimeType(local.type)) {
                    local.lifetimeActive = true;
                    this.lifetimeScopes.at(-1).push(local);
                }
                break;
            }
            case 'IfStatement':
                this.lowerIf(statement);
                break;
            case 'WhileStatement':
                this.lowerWhile(statement);
                break;
            case 'ForStatement':
                this.lowerFor(statement);
                break;
            case 'BreakStatement': {
                const loop = this.loopStack.at(-1);
                this.emit('jump', {target: loop.breakTarget});
                break;
            }
            case 'ContinueStatement': {
                const loop = this.loopStack.at(-1);
                this.emit('jump', {target: loop.continueTarget});
                break;
            }
            case 'ReturnStatement': {
                const value = statement.expression ? this.lowerExpression(statement.expression) : null;
                if (statement.ownership === 'transfer') this.consumeLifetime(statement.expression);
                this.destroyAllLifetimeScopes();
                this.emit('return', {value});
                break;
            }
            case 'ExpressionStatement':
                this.lowerExpression(statement.expression);
                break;
            default:
                throw new Error(`Cannot lower statement ${statement.kind}`);
        }
    }

    lowerIf(statement) {
        const condition = this.lowerExpression(statement.condition);
        const thenBlock = this.newBlock('if_then');
        const elseBlock = statement.alternate ? this.newBlock('if_else') : null;
        const endBlock = this.newBlock('if_end');
        this.emit('branch', {
            condition,
            thenTarget: thenBlock.label,
            elseTarget: elseBlock?.label ?? endBlock.label
        });

        this.block = thenBlock;
        this.lowerBlock(statement.consequent);
        if (!this.isTerminated()) this.emit('jump', {target: endBlock.label});

        if (elseBlock) {
            this.block = elseBlock;
            this.lowerBlock(statement.alternate);
            if (!this.isTerminated()) this.emit('jump', {target: endBlock.label});
        }
        this.block = endBlock;
    }

    lowerWhile(statement) {
        const conditionBlock = this.newBlock('while_condition');
        const bodyBlock = this.newBlock('while_body');
        const endBlock = this.newBlock('while_end');
        this.emit('jump', {target: conditionBlock.label});

        this.block = conditionBlock;
        const condition = this.lowerExpression(statement.condition);
        this.emit('branch', {
            condition,
            thenTarget: bodyBlock.label,
            elseTarget: endBlock.label
        });

        this.block = bodyBlock;
        this.loopStack.push({breakTarget: endBlock.label, continueTarget: conditionBlock.label});
        this.lowerBlock(statement.body);
        this.loopStack.pop();
        if (!this.isTerminated()) this.emit('jump', {target: conditionBlock.label});
        this.block = endBlock;
    }

    lowerFor(statement) {
        const iterable = this.lowerExpression(statement.iterable);
        const iterableName = `$iterable#${this.nextLocal++}`;
        const indexName = `$index#${this.nextLocal++}`;
        this.emit('declare_local', {name: iterableName, type: iterable.type, value: iterable});
        if (!statement.iteratorHasNext) {
            const zero = this.result('constant', 'i64', {value: 0});
            this.emit('declare_local', {name: indexName, type: 'i64', value: zero});
        }
        const conditionBlock = this.newBlock('for_condition');
        const bodyBlock = this.newBlock('for_body');
        const incrementBlock = this.newBlock('for_increment');
        const endBlock = this.newBlock('for_end');
        this.emit('jump', {target: conditionBlock.label});

        this.block = conditionBlock;
        const collection = this.result('load_local', iterable.type, {name: iterableName});
        let condition;
        if (statement.iteratorHasNext) {
            condition = this.result('call', 'bool', {target: this.functionName(statement.iteratorHasNext), arguments: [collection], slot: -1});
        } else {
            const index = this.result('load_local', 'i64', {name: indexName});
            const length = this.result(iterable.type === 'string' ? 'string_length' : 'array_length', 'i64',
                iterable.type === 'string' ? {string: collection} : {array: collection});
            condition = this.result('binary', 'bool', {operator: '<', left: index, right: length});
        }
        this.emit('branch', {condition, thenTarget: bodyBlock.label, elseTarget: endBlock.label});

        this.block = bodyBlock;
        const currentCollection = this.result('load_local', iterable.type, {name: iterableName});
        let value;
        if (statement.iteratorNext) {
            value = this.result('call', statement.inferredType, {target: this.functionName(statement.iteratorNext), arguments: [currentCollection], slot: -1});
        } else {
            const currentIndex = this.result('load_local', 'i64', {name: indexName});
            value = iterable.type === 'string'
                ? this.result('string_load', 'u8', {array: currentCollection, index: currentIndex})
                : this.result('array_load', statement.inferredType, {array: currentCollection, index: currentIndex,
                    elementType: statement.inferredType, elementOwnership: this.arrayElementOwnership(iterable.type)});
        }
        const local = {kind: 'local', name: `${statement.name}#${this.nextLocal++}`, type: statement.inferredType};
        this.locals.set(statement.semanticSymbol, local);
        this.emit('declare_local', {name: local.name, type: local.type, value});
        this.loopStack.push({breakTarget: endBlock.label, continueTarget: incrementBlock.label});
        this.lowerBlock(statement.body);
        this.loopStack.pop();
        if (!this.isTerminated()) this.emit('jump', {target: incrementBlock.label});

        this.block = incrementBlock;
        if (!statement.iteratorHasNext) {
            const oldIndex = this.result('load_local', 'i64', {name: indexName});
            const one = this.result('constant', 'i64', {value: 1});
            const nextIndex = this.result('binary', 'i64', {operator: '+', left: oldIndex, right: one});
            this.emit('store_local', {name: indexName, type: 'i64', value: nextIndex});
        }
        this.emit('jump', {target: conditionBlock.label});
        this.block = endBlock;
    }

    lowerExpression(expression) {
        switch (expression.kind) {
            case 'IntegerLiteral':
                return this.result('constant', expression.inferredType, {value: expression.lexeme});
            case 'FloatLiteral':
                return this.result('float_constant', expression.inferredType, {value: expression.lexeme});
            case 'BooleanLiteral':
                return this.result('constant', expression.inferredType, {value: expression.value ? 1 : 0});
            case 'StringLiteral':
                return this.result('string_constant', expression.inferredType, {value: expression.value});
            case 'NullLiteral':
                return this.result('constant', expression.inferredType, {value: 0});
            case 'IdentifierExpression':
                return this.lowerIdentifier(expression);
            case 'MemberExpression':
                return this.lowerMember(expression);
            case 'IndexExpression': {
                const array = this.lowerExpression(expression.object);
                const index = this.lowerExpression(expression.index);
                const operation = expression.semanticSymbol.kind === 'StringElement' ? 'string_load' : 'array_load';
                return this.result(operation, expression.inferredType, {
                    array, index, elementType: expression.inferredType,
                    elementOwnership: expression.semanticSymbol.elementOwnership
                });
            }
            case 'UnaryExpression': {
                const operand = this.lowerExpression(expression.operand);
                if (expression.operator === 'copy') {
                    return this.result('structural_copy', expression.inferredType, {value: operand, valueType: expression.inferredType});
                }
                if (expression.operator === 'delete') {
                    this.emit('destroy_object', {value: operand});
                    this.consumeLifetime(expression.operand);
                    return {kind: 'void', type: 'void'};
                }
                return this.result('unary', expression.inferredType, {operator: expression.operator, operand});
            }
            case 'BinaryExpression': {
                if (expression.operator === 'is') {
                    const value = this.lowerExpression(expression.left);
                    return this.result('type_test', 'bool', {value, targetType: expression.runtimeType});
                }
                if (expression.operator === '&&' || expression.operator === '||') {
                    return this.lowerShortCircuit(expression);
                }
                let left = this.lowerExpression(expression.left);
                let right = this.lowerExpression(expression.right);
                if (expression.numericType) {
                    if (left.type !== expression.numericType) left = this.result('convert', expression.numericType, {value: left, fromType: left.type});
                    if (right.type !== expression.numericType && expression.operator !== '<<' && expression.operator !== '>>') {
                        right = this.result('convert', expression.numericType, {value: right, fromType: right.type});
                    }
                }
                if (left.type === 'string' && expression.operator !== '===' && expression.operator !== '!==') {
                    return this.result(
                        expression.operator === '+' ? 'string_concat' : 'string_equal',
                        expression.inferredType,
                        {left, right, negate: expression.operator === '!='}
                    );
                }
                if ((expression.operator === '==' || expression.operator === '!=') && this.isReferenceType(left.type)) {
                    return this.result('structural_equal', 'bool', {
                        left, right, valueType: left.type, negate: expression.operator === '!='
                    });
                }
                return this.result('binary', expression.inferredType, {operator: expression.operator, left, right});
            }
            case 'AssignmentExpression':
                return this.lowerAssignment(expression);
            case 'ConversionExpression': {
                const value = this.lowerExpression(expression.expression);
                if (expression.conversionKind === 'reference') return value;
                if (expression.conversionKind === 'checked_reference') {
                    return this.result('checked_cast', expression.inferredType, {
                        value,
                        targetType: this.optionalBaseTypeName(expression.inferredType)
                    });
                }
                return this.result('convert', expression.inferredType, {value, fromType: value.type});
            }
            case 'UnwrapExpression': {
                const value = this.lowerExpression(expression.expression);
                return this.result('unwrap', expression.inferredType, {value});
            }
            case 'PropagateExpression':
                return this.lowerPropagation(expression);
            case 'CallExpression':
                return this.lowerCall(expression);
            case 'NewExpression':
                return this.lowerNew(expression);
            default:
                throw new Error(`Cannot lower expression ${expression.kind}`);
        }
    }

    lowerShortCircuit(expression) {
        const left = this.lowerExpression(expression.left);
        const name = `$short#${this.nextLocal++}`;
        this.emit('declare_local', {name, type: 'bool', value: left});
        const rightBlock = this.newBlock('short_right');
        const endBlock = this.newBlock('short_end');
        this.emit('branch', {
            condition: left,
            thenTarget: expression.operator === '&&' ? rightBlock.label : endBlock.label,
            elseTarget: expression.operator === '&&' ? endBlock.label : rightBlock.label
        });
        this.block = rightBlock;
        const right = this.lowerExpression(expression.right);
        this.emit('store_local', {name, type: 'bool', value: right});
        if (!this.isTerminated()) this.emit('jump', {target: endBlock.label});
        this.block = endBlock;
        return this.result('load_local', 'bool', {name});
    }

    optionalBaseTypeName(type) {
        return type.endsWith('?') ? type.slice(0, -1) : type;
    }

    lowerIdentifier(expression) {
        if (expression.semanticSymbol?.kind === 'Self') {
            return {kind: 'parameter', name: 'self', type: expression.inferredType};
        }
        if (expression.semanticSymbol?.kind === 'Field') {
            const symbol = expression.semanticSymbol;
            return this.result('load_field', expression.inferredType, {
                object: {kind: 'parameter', name: 'self', type: symbol.owner.type},
                field: `${symbol.owner.type}.${symbol.name}`
            });
        }
        const local = this.locals.get(expression.semanticSymbol);
        if (local?.kind === 'parameter') return {kind: 'parameter', name: local.name, type: expression.inferredType};
        if (local) return this.result('load_local', expression.inferredType, {name: local.name});
        throw new Error(`Identifier '${expression.name}' does not produce an IR value`);
    }

    lowerMember(expression) {
        const symbol = expression.semanticSymbol;
        if (symbol?.kind === 'ArrayLength') {
            const array = this.lowerExpression(expression.object);
            return this.result('array_length', 'i64', {array});
        }
        if (symbol?.kind === 'StringLength') {
            const string = this.lowerExpression(expression.object);
            return this.result('string_length', 'i64', {string});
        }
        if (symbol?.kind === 'StringBuilderLength') {
            const builder = this.lowerExpression(expression.object);
            return this.result('builder_length', 'i64', {builder});
        }
        if (symbol?.kind !== 'Field') {
            throw new Error(`Member '${expression.member}' does not produce an IR value`);
        }
        const object = this.lowerExpression(expression.object);
        return this.result('load_field', expression.inferredType, {
            object,
            field: `${symbol.owner.type}.${symbol.name}`
        });
    }

    lowerAssignment(expression) {
        const value = this.lowerExpression(expression.value);
        if (expression.value.ownership === 'consume') this.consumeLifetime(expression.value);
        const target = expression.target;
        const symbol = target.semanticSymbol;

        if (symbol.kind === 'Field') {
            const object = target.kind === 'MemberExpression'
                ? this.lowerExpression(target.object)
                : {kind: 'parameter', name: 'self', type: symbol.owner.type};
            this.emit('store_field', {object, field: `${symbol.owner.type}.${symbol.name}`, value});
        } else if (symbol.kind === 'ArrayElement') {
            const array = this.lowerExpression(target.object);
            const index = this.lowerExpression(target.index);
            this.emit('array_store', {array, index, value, elementType: symbol.type, elementOwnership: symbol.elementOwnership});
        } else {
            const local = this.locals.get(symbol);
            if (!local) throw new Error(`Local '${symbol.name}' does not have an IR slot`);
            this.emit('store_local', {name: local.name, value});
            if (local) {
                local.kind = 'local';
                local.value = value;
            }
        }
        return value;
    }

    lowerCall(expression) {
        const method = expression.callee.semanticSymbol;
        const args = expression.arguments.map(argument => this.lowerExpression(argument));
        for (const argument of expression.arguments) {
            if (argument.ownership === 'consume') this.consumeLifetime(argument);
        }

        if (method.kind === 'TestExpect') {
            this.emit('test_expect', {condition: args[0]});
            return {kind: 'void', type: 'void'};
        }

        if (method.kind === 'SuperCall') {
            if (method.constructor) {
                args.unshift({kind: 'parameter', name: 'self', type: method.owner.type});
                this.emit('call', {target: this.functionName(method.constructor), arguments: args});
            }
            return {kind: 'void', type: 'void'};
        }

        if (method.kind === 'ArrayAppend') {
            const array = this.lowerExpression(expression.callee.object);
            this.emit('array_append', {array, value: args[0], elementType: method.elementType, elementOwnership: method.elementOwnership});
            return {kind: 'void', type: 'void'};
        }
        if (method.kind === 'StringSlice') {
            const string = this.lowerExpression(expression.callee.object);
            return this.result('string_slice', 'string', {
                string,
                start: args[0],
                length: args[1]
            });
        }
        if (method.kind === 'IntegerToString') {
            const value = this.lowerExpression(expression.callee.object);
            return this.result('integer_to_string', 'string', {value, integerType: value.type});
        }
        if (method.kind === 'StringBuilderAppend') {
            const builder = this.lowerExpression(expression.callee.object);
            let value = args[0];
            if (value.type !== 'string') {
                value = this.result('integer_to_string', 'string', {value, integerType: value.type});
            }
            this.emit('builder_append_string', {builder, value});
            return {kind: 'void', type: 'void'};
        }
        if (method.kind === 'StringBuilderAppendByte') {
            const builder = this.lowerExpression(expression.callee.object);
            this.emit('builder_append_byte', {builder, value: args[0]});
            return {kind: 'void', type: 'void'};
        }
        if (method.kind === 'StringBuilderBuild') {
            const builder = this.lowerExpression(expression.callee.object);
            return this.result('builder_build', 'string', {builder});
        }
        if (method.kind === 'StructuralHash') {
            const value = this.lowerExpression(expression.callee.object);
            return this.result('structural_hash', 'i64', {value, valueType: method.valueType});
        }

        if (method.owner.kind === 'Object') {
            const receiver = expression.callee.isSuper
                ? {kind: 'parameter', name: 'self', type: this.function.owner}
                : expression.callee.kind === 'MemberExpression'
                ? this.lowerExpression(expression.callee.object)
                : {kind: 'parameter', name: 'self', type: method.owner.type};
            args.unshift(receiver);
        }

        const ownerType = method.owner.type;
        const virtualType = this.program.types.find(type => type.name === ownerType);
        const methodKey = this.methodKey(method);
        const virtualSlot = method.name === '__' ? -1 : virtualType?.virtualMethods.findIndex(entry => entry.name === methodKey) ?? -1;
        const fields = {target: this.functionName(method), arguments: args, slot: virtualSlot};
        const contractSlot = this.contractTypes.has(ownerType)
            ? [...this.contractMethodsFor(method.owner)].findIndex(entry => this.methodKey(entry) === methodKey)
            : -1;
        fields.contractType = ownerType;
        fields.slot = contractSlot >= 0 ? contractSlot : virtualSlot;
        const op = contractSlot >= 0 && !expression.callee.isSuper
            ? 'contract_call'
            : virtualSlot >= 0 && method.owner.kind === 'Object' && !expression.callee.isSuper ? 'virtual_call' : 'call';
        if (expression.inferredType === 'void') {
            this.emit(op, fields);
            return {kind: 'void', type: 'void'};
        }
        return this.result(op, expression.inferredType, fields);
    }

    lowerTestRunner(tests) {
        const owner = '$valen.test.runner';
        this.program.types.push({kind: 'IrType', name: owner, displayName: owner, base: null, virtualMethods: [], contracts: [], initializer: null, fields: []});
        const instructions = [];
        for (const suite of tests) {
            for (const method of suite.members.filter(member => member.kind === 'MethodDeclaration')) {
                instructions.push({op: 'call', target: this.functionName(method.semanticSymbol), arguments: []});
            }
        }
        instructions.push({op: 'test_failures', result: '%0', type: 'i64'});
        instructions.push({op: 'return', value: {kind: 'temporary', name: '%0', type: 'i64'}});
        const runner = {kind: 'IrFunction', name: '$valen.test.run', displayName: '$valen.test.run', owner,
            parameters: [{name: 'self', type: owner}], returnType: 'i64',
            blocks: [{label: 'entry', instructions}], temporaryCount: 1, localCount: 0};
        this.program.functions.push(runner);
        this.program.entry = runner.name;
    }

    lowerNew(expression) {
        const object = expression.semanticSymbol;
        if (object.kind === 'StringBuilderType') {
            return this.result('builder_new', object.type, {});
        }
        if (object.kind === 'ArrayType') {
            const length = this.lowerExpression(expression.arguments[0]);
            return this.result('array_new', object.type, {length, elementType: object.elementType});
        }
        const instance = this.result('allocate', object.type, {objectType: object.type});
        this.lowerInitializers(object, instance);
        const constructor = expression.constructor;
        if (constructor) {
            const args = [instance, ...expression.arguments.map(argument => this.lowerExpression(argument))];
            this.emit('call', {target: this.functionName(constructor), arguments: args});
        }
        return instance;
    }

    consumeLifetime(expression) {
        const local = this.locals.get(expression?.semanticSymbol);
        if (local) {
            local.lifetimeActive = false;
        }
    }

    destroyLifetimeScope(scope) {
        for (let index = scope.length - 1; index >= 0; index--) {
            const local = scope[index];
            if (!local.lifetimeActive) continue;
            const value = this.result('load_local', local.type, {name: local.name});
            const elementType = this.arrayElementTypeName(local.type);
            if (elementType) this.emit('destroy_array', {value, arrayType: local.type, elementType});
            else this.emit('destroy_object', {value});
            local.lifetimeActive = false;
        }
    }

    destroyAllLifetimeScopes() {
        const active = this.lifetimeScopes.flat().map(local => [local, local.lifetimeActive]);
        for (let index = this.lifetimeScopes.length - 1; index >= 0; index--) {
            this.destroyLifetimeScope(this.lifetimeScopes[index]);
        }
        for (const [local, lifetimeActive] of active) local.lifetimeActive = lifetimeActive;
    }

    isObjectLifetimeType(type) {
        const base = type?.endsWith('?') ? type.slice(0, -1) : type;
        return this.program.types.some(item => item.name === base);
    }

    arrayElementTypeName(type) {
        return type?.startsWith('Array<') && type.endsWith('>') ? type.slice(6, -1) : null;
    }

    arrayElementOwnership(type) {
        const element = this.arrayElementTypeName(type);
        return element?.startsWith('ref ') ? 'ref' : element?.startsWith('weak ') ? 'weak' : 'owned';
    }

    lowerInitializers(object, instance) {
        if (object.base) this.lowerInitializers(object.base, instance);
        const initializer = this.program.types.find(type => type.name === object.type)?.initializer;
        if (initializer) this.emit('call', {target: initializer, arguments: [instance]});
    }

    lowerPropagation(expression) {
        const value = this.lowerExpression(expression.expression);
        let condition = value;
        if (expression.propagationKind === 'result') {
            condition = this.result('load_field', 'bool', {
                object: value,
                field: `${expression.validField.owner.type}.${expression.validField.name}`
            });
        }
        const nullBlock = this.newBlock('propagate_null');
        const valueBlock = this.newBlock('propagate_value');
        this.emit('branch', {
            condition,
            thenTarget: valueBlock.label,
            elseTarget: nullBlock.label
        });

        this.block = nullBlock;
        this.emit('return', {value});
        this.block = valueBlock;
        if (expression.propagationKind === 'result') {
            return this.result('load_field', expression.inferredType, {
                object: value,
                field: `${expression.valueField.owner.type}.${expression.valueField.name}`
            });
        }
        return {...value, type: expression.inferredType};
    }

    result(op, type, fields) {
        const result = `%${this.nextTemporary++}`;
        this.emit(op, {...fields, result, type});
        return {kind: 'temporary', name: result, type};
    }

    emit(op, fields) {
        this.block.instructions.push({op, ...fields});
    }

    newBlock(prefix) {
        const block = {label: `${prefix}_${this.nextBlock++}`, instructions: []};
        this.function.blocks.push(block);
        return block;
    }

    isTerminated() {
        return ['return', 'jump', 'branch'].includes(this.block.instructions.at(-1)?.op);
    }

    functionName(method) {
        return `${method.owner.type}.${method.irName ?? method.name}`;
    }

    methodKey(method) {
        return `${method.name}(${method.parameters.map(parameter => parameter.type).join(',')})`;
    }

    isReferenceType(type) {
        return type === 'string' || type?.startsWith('Array<') || this.program.types.some(item => item.name === type);
    }

    runtimeSymbol(method) {
        return `valen_${method.owner.name}_${method.name}`.replace(/[^A-Za-z0-9_]/g, '_');
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const filePath = process.argv[2];
    if (!filePath) throw new Error('Usage: node ir.js <source-file>');
    try {
        console.log(JSON.stringify(new IrGenerator().generateFile(filePath), null, 2));
    } catch (error) {
        const result = new SemanticAnalyzer().analyzeFile(filePath);
        for (const diagnostic of result.diagnostics) {
            console.error(formatDiagnostic(diagnostic));
        }
        if (result.diagnostics.length === 0) console.error(error.message);
        process.exitCode = 1;
    }
}
