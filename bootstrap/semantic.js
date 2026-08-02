import fs from 'fs';
import {fileURLToPath} from 'url';
import {Parser} from './parser.js';
import {ModuleLoader} from './module-loader.js';

const I64 = 'i64';
const VOID = 'void';
const BOOL = 'bool';
const STRING = 'string';
const STRING_BUILDER = 'StringBuilder';
const UNKNOWN = '<unknown>';
const NULL = '<null>';
const integerTypes = new Set(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64']);
const integerRanges = {
    u8: [0n, 255n],
    i8: [-128n, 127n],
    u16: [0n, 65535n],
    i16: [-32768n, 32767n],
    u32: [0n, 4294967295n],
    i32: [-2147483648n, 2147483647n],
    u64: [0n, 18446744073709551615n],
    i64: [-9223372036854775808n, 9223372036854775807n]
};

export class SemanticAnalyzer {
    analyze(program) {
        this.initialize();
        this.program = program;
        for (const declaration of program.imports) this.declareImport(declaration);
        for (const declaration of program.objects) this.declareObject(declaration, null, this.globals);
        for (const declaration of program.libraries) this.declareObject(declaration, null, this.globals, 'Library');
        for (const declaration of program.objects) this.declareMembers(declaration);
        for (const declaration of program.libraries) this.declareMembers(declaration);
        for (const declaration of program.objects) this.analyzeObject(declaration);
        for (const declaration of program.libraries) this.analyzeObject(declaration);

        return {
            program,
            diagnostics: this.diagnostics,
            success: this.diagnostics.every(diagnostic => diagnostic.severity !== 'error')
        };
    }

    analyzeFile(filePath, loaderOptions = {}) {
        const graph = new ModuleLoader(loaderOptions).load(filePath);
        return this.analyzeModules(graph);
    }

    initialize() {
        this.diagnostics = [];
        this.globals = new Scope(null, 'builtins');
        this.objectSymbols = new Map();
        for (const name of [...integerTypes, VOID, BOOL, STRING, STRING_BUILDER]) {
            this.globals.define(name, {kind: 'BuiltinType', name, type: name}, null, this.diagnostics);
        }
    }

    analyzeModules(graph) {
        this.initialize();
        this.diagnostics.push(...graph.diagnostics);
        this.moduleScopes = new Map();

        for (const module of graph.modules.values()) {
            this.moduleScopes.set(module, new Scope(this.globals, `module ${module.id}`, module.id));
        }
        for (const module of graph.modules.values()) {
            const scope = this.moduleScopes.get(module);
            for (const declaration of module.program.objects) this.declareObject(declaration, null, scope);
            for (const declaration of module.program.libraries) this.declareObject(declaration, null, scope, 'Library');
        }
        for (const module of graph.modules.values()) this.resolveModuleImports(module);
        for (const module of graph.modules.values()) {
            for (const declaration of [...module.program.objects, ...module.program.libraries]) {
                this.declareMembers(declaration);
            }
        }
        for (const module of graph.modules.values()) {
            for (const declaration of [...module.program.objects, ...module.program.libraries]) {
                this.analyzeObject(declaration);
            }
        }

        return {
            program: graph.entry?.program ?? null,
            modules: graph.modules,
            diagnostics: this.diagnostics,
            success: this.diagnostics.every(diagnostic => diagnostic.severity !== 'error')
        };
    }

    resolveModuleImports(module) {
        const scope = this.moduleScopes.get(module);
        for (const [name, imported] of module.imports) {
            const importedScope = this.moduleScopes.get(imported.module);
            const target = importedScope?.symbols.get(name);
            if (target?.kind !== 'Library') {
                this.report(imported.declaration.span, `Module '${imported.module.path}' does not declare library '${name}'`);
                continue;
            }
            if (scope.define(name, target, imported.declaration.span, this.diagnostics)) {
                this.annotate(imported.declaration, target.type, target);
            }
        }
    }

    declareImport(declaration) {
        const symbol = {
            kind: 'Import',
            name: declaration.name,
            qualifiedName: declaration.name,
            path: declaration.path,
            type: `module:${declaration.name}`,
            declaration
        };
        if (this.globals.define(declaration.name, symbol, declaration.span, this.diagnostics)) {
            this.annotate(declaration, symbol.type, symbol);
        }
    }

    declareObject(declaration, parent, scope, kind = 'Object') {
        const qualifiedName = parent ? `${parent.qualifiedName}.${declaration.name}` : declaration.name;
        const type = parent
            ? `${parent.type}.${declaration.name}`
            : scope.moduleId ? `${scope.moduleId}::${declaration.name}` : declaration.name;
        const symbol = {
            kind,
            name: declaration.name,
            qualifiedName,
            type,
            declaration,
            parent,
            fields: new Map(),
            methods: new Map(),
            objects: new Map(),
            moduleScope: parent?.moduleScope ?? scope
        };
        if (parent?.objects.has(declaration.name)) {
            this.report(declaration.span, `Duplicate member '${declaration.name}' in ${parent.qualifiedName}`);
            return;
        }
        if (!scope.define(declaration.name, symbol, declaration.span, this.diagnostics)) return;
        if (parent) parent.objects.set(declaration.name, symbol);
        this.objectSymbols.set(declaration, symbol);
        this.annotate(declaration, qualifiedName, symbol);

        for (const member of declaration.members) {
            if (member.kind === 'ObjectDeclaration') this.declareObject(member, symbol, new ObjectScope(symbol, symbol.moduleScope));
        }
    }

    declareMembers(declaration) {
        const object = this.objectSymbols.get(declaration);
        if (!object) return;

        for (const member of declaration.members) {
            if (member.kind === 'FieldDeclaration') {
                this.defineMember(object, object.fields, member, 'Field');
            } else if (member.kind === 'MethodDeclaration') {
                this.defineMember(object, object.methods, member, 'Method');
            } else if (member.kind === 'ObjectDeclaration') {
                this.declareMembers(member);
            }
        }

        for (const field of object.fields.values()) {
            field.type = this.resolveTypeReference(field.declaration.fieldType, object);
            this.annotate(field.declaration, field.type, field);
        }
        for (const method of object.methods.values()) {
            method.returnType = this.resolveTypeReference(method.declaration.returnType, object);
            method.isNative = method.declaration.isNative;
            method.parameters = method.declaration.parameters.map(parameter => ({
                kind: 'Parameter',
                name: parameter.name,
                type: this.resolveTypeReference(parameter.parameterType, object),
                declaration: parameter
            }));
            if (method.name === '__') {
                const isEntry = object.kind === 'Object' && object.parent === null && object.name === 'entry';
                if (object.kind === 'Library') {
                    this.report(method.declaration.span, `Library '${object.qualifiedName}' cannot declare a constructor`);
                } else if (isEntry && method.returnType !== VOID && !integerTypes.has(method.returnType)) {
                    this.report(method.declaration.returnType.span, `Entry constructor must return void or an integer, got '${method.returnType}'`);
                } else if (!isEntry && method.returnType !== VOID) {
                    this.report(method.declaration.returnType.span, `Constructor '${method.qualifiedName}' must return void`);
                }
            }
            this.annotate(method.declaration, method.returnType, method);
        }
    }

    defineMember(object, collection, declaration, kind) {
        if (
            object.fields.has(declaration.name) ||
            object.methods.has(declaration.name) ||
            object.objects.has(declaration.name)
        ) {
            this.report(declaration.span, `Duplicate member '${declaration.name}' in ${object.qualifiedName}`);
            return;
        }
        collection.set(declaration.name, {
            kind,
            name: declaration.name,
            qualifiedName: `${object.qualifiedName}.${declaration.name}`,
            declaration,
            owner: object,
            type: UNKNOWN
        });
    }

    analyzeObject(declaration) {
        const object = this.objectSymbols.get(declaration);
        if (!object) return;

        for (const member of declaration.members) {
            if (member.kind === 'FieldDeclaration' && member.initializer) {
                const scope = this.objectScope(object);
                if (object.kind === 'Object') {
                    scope.define('self', {kind: 'Self', name: 'self', type: object.type, owner: object}, member.span, this.diagnostics);
                }
                const actual = this.analyzeExpression(member.initializer, scope, object);
                const expected = object.fields.get(member.name)?.type ?? UNKNOWN;
                this.requireAssignable(actual, expected, member.initializer.span, member.initializer);
            } else if (member.kind === 'MethodDeclaration') {
                this.analyzeMethod(member, object);
            } else if (member.kind === 'ObjectDeclaration') {
                this.analyzeObject(member);
            }
        }
    }

    analyzeMethod(declaration, object) {
        const method = object.methods.get(declaration.name);
        if (!method) return;
        if (declaration.isNative) {
            if (object.kind !== 'Library') {
                this.report(declaration.span, 'Native methods can only be declared in libraries');
            }
            if (declaration.body) this.report(declaration.span, `Native method '${method.qualifiedName}' cannot have a body`);
            return;
        }
        if (!declaration.body) {
            this.report(declaration.span, `Method '${method.qualifiedName}' requires a body`);
            return;
        }
        const scope = new Scope(this.objectScope(object), `method ${method.qualifiedName}`);
        if (object.kind === 'Object') {
            scope.define('self', {kind: 'Self', name: 'self', type: object.type, owner: object}, declaration.span, this.diagnostics);
        }
        this.loopDepth = 0;
        for (const parameter of method.parameters) {
            scope.define(parameter.name, parameter, parameter.declaration.span, this.diagnostics);
            this.annotate(parameter.declaration, parameter.type, parameter);
        }

        const previousMethod = this.currentMethod;
        this.currentMethod = method;
        const returns = this.analyzeBlock(declaration.body, scope, object, method);
        this.currentMethod = previousMethod;
        if (method.returnType !== VOID && !returns) {
            this.report(declaration.span, `Method '${method.qualifiedName}' may exit without returning ${method.returnType}`);
        }
    }

    analyzeBlock(block, parentScope, object, method) {
        const scope = new Scope(parentScope, 'block');
        let definitelyReturns = false;
        for (const statement of block.statements) {
            if (definitelyReturns) {
                this.report(statement.span, 'Unreachable statement', 'warning');
                continue;
            }
            definitelyReturns = this.analyzeStatement(statement, scope, object, method) || definitelyReturns;
        }
        return definitelyReturns;
    }

    analyzeStatement(statement, scope, object, method) {
        switch (statement.kind) {
            case 'BlockStatement':
                return this.analyzeBlock(statement, scope, object, method);
            case 'LocalDeclaration': {
                const declared = statement.variableType
                    ? this.resolveTypeReference(statement.variableType, object)
                    : null;
                const inferred = statement.initializer
                    ? this.analyzeExpression(statement.initializer, scope, object)
                    : null;
                if (declared && inferred) {
                    this.requireAssignable(inferred, declared, statement.initializer.span, statement.initializer);
                } else if (!declared && inferred === NULL) {
                    this.report(statement.span, `Local '${statement.name}' initialized with null requires an optional type annotation`);
                }
                const type = declared ?? inferred ?? UNKNOWN;
                const symbol = {kind: 'Local', name: statement.name, type, declaration: statement};
                scope.define(statement.name, symbol, statement.span, this.diagnostics);
                this.annotate(statement, type, symbol);
                return false;
            }
            case 'IfStatement': {
                const condition = this.analyzeExpression(statement.condition, scope, object);
                this.requireAssignable(condition, BOOL, statement.condition.span, statement.condition);
                const consequentReturns = this.analyzeBlock(statement.consequent, scope, object, method);
                const alternateReturns = statement.alternate
                    ? this.analyzeBlock(statement.alternate, scope, object, method)
                    : false;
                return consequentReturns && alternateReturns;
            }
            case 'WhileStatement': {
                const condition = this.analyzeExpression(statement.condition, scope, object);
                this.requireAssignable(condition, BOOL, statement.condition.span, statement.condition);
                this.loopDepth++;
                this.analyzeBlock(statement.body, scope, object, method);
                this.loopDepth--;
                return false;
            }
            case 'BreakStatement':
            case 'ContinueStatement':
                if (this.loopDepth === 0) {
                    this.report(statement.span, `'${statement.kind === 'BreakStatement' ? 'break' : 'continue'}' can only be used inside a loop`);
                }
                return false;
            case 'ReturnStatement': {
                const actual = statement.expression
                    ? this.analyzeExpression(statement.expression, scope, object)
                    : VOID;
                this.requireAssignable(actual, method.returnType, statement.span, statement.expression);
                return true;
            }
            case 'ExpressionStatement':
                this.analyzeExpression(statement.expression, scope, object);
                return false;
            default:
                this.report(statement.span, `Unsupported statement ${statement.kind}`);
                return false;
        }
    }

    analyzeExpression(expression, scope, object) {
        let type = UNKNOWN;
        let symbol = null;

        switch (expression.kind) {
            case 'IntegerLiteral':
                type = I64;
                break;
            case 'BooleanLiteral':
                type = BOOL;
                break;
            case 'StringLiteral':
                type = STRING;
                break;
            case 'NullLiteral':
                type = NULL;
                break;
            case 'IdentifierExpression':
                symbol = scope.lookup(expression.name);
                if (!symbol) this.report(expression.span, `Unknown identifier '${expression.name}'`);
                type = symbol?.type ?? UNKNOWN;
                break;
            case 'MemberExpression': {
                const ownerType = this.analyzeExpression(expression.object, scope, object);
                if (integerTypes.has(ownerType)) {
                    if (expression.member === 'toString') {
                        symbol = {kind: 'IntegerToString', name: 'toString', type: STRING};
                        type = STRING;
                    } else this.report(expression.span, `Integer type '${ownerType}' has no member '${expression.member}'`);
                    break;
                }
                if (ownerType === STRING) {
                    if (expression.member === 'length') {
                        symbol = {kind: 'StringLength', name: 'length', type: I64};
                        type = I64;
                    } else if (expression.member === 'slice') {
                        symbol = {kind: 'StringSlice', name: 'slice', type: STRING};
                        type = STRING;
                    } else {
                        this.report(expression.span, `String has no member '${expression.member}'`);
                    }
                    break;
                }
                if (ownerType === STRING_BUILDER) {
                    const builderMembers = {
                        length: {kind: 'StringBuilderLength', name: 'length', type: I64},
                        append: {kind: 'StringBuilderAppend', name: 'append', type: VOID},
                        appendByte: {kind: 'StringBuilderAppendByte', name: 'appendByte', type: VOID},
                        build: {kind: 'StringBuilderBuild', name: 'build', type: STRING}
                    };
                    symbol = builderMembers[expression.member] ?? null;
                    if (!symbol) this.report(expression.span, `StringBuilder has no member '${expression.member}'`);
                    type = symbol?.type ?? UNKNOWN;
                    break;
                }
                const elementType = this.arrayElementType(ownerType);
                if (elementType) {
                    if (expression.member === 'length') {
                        symbol = {kind: 'ArrayLength', name: 'length', type: I64};
                        type = I64;
                    } else if (expression.member === 'append') {
                        symbol = {kind: 'ArrayAppend', name: 'append', type: UNKNOWN, elementType};
                    } else {
                        this.report(expression.span, `Array type '${ownerType}' has no member '${expression.member}'`);
                    }
                    break;
                }
                const owner = this.findObjectType(ownerType);
                if (owner) {
                    symbol = owner.fields.get(expression.member) ??
                        owner.methods.get(expression.member) ??
                        owner.objects.get(expression.member);
                    if (!symbol) this.report(expression.span, `Type '${ownerType}' has no member '${expression.member}'`);
                    type = symbol?.type ?? symbol?.qualifiedName ?? UNKNOWN;
                } else if (ownerType.startsWith('module:')) {
                    symbol = {kind: 'ExternalMember', name: expression.member, type: UNKNOWN};
                } else if (ownerType !== UNKNOWN) {
                    this.report(expression.span, `Type '${ownerType}' has no members`);
                }
                break;
            }
            case 'IndexExpression': {
                const arrayType = this.analyzeExpression(expression.object, scope, object);
                const elementType = arrayType === STRING ? 'u8' : this.arrayElementType(arrayType);
                const indexType = this.analyzeExpression(expression.index, scope, object);
                this.requireAssignable(indexType, I64, expression.index.span, expression.index);
                if (!elementType) {
                    this.report(expression.object.span, `Type '${arrayType}' cannot be indexed`);
                } else {
                    symbol = {
                        kind: arrayType === STRING ? 'StringElement' : 'ArrayElement',
                        name: '[]',
                        type: elementType
                    };
                    type = elementType;
                }
                break;
            }
            case 'AssignmentExpression': {
                const targetType = this.analyzeExpression(expression.target, scope, object);
                const targetSymbol = expression.target.semanticSymbol;
                if (!targetSymbol) {
                    this.report(expression.target.span, 'Assignment target is not declared');
                } else if (!['Local', 'Parameter', 'Field', 'ArrayElement'].includes(targetSymbol.kind)) {
                    this.report(expression.target.span, `Cannot assign to ${targetSymbol.kind.toLowerCase()} '${targetSymbol.name}'`);
                }
                const valueType = this.analyzeExpression(expression.value, scope, object);
                this.requireAssignable(valueType, targetType, expression.value.span, expression.value);
                type = targetType;
                break;
            }
            case 'ConversionExpression': {
                const sourceType = this.analyzeExpression(expression.expression, scope, object);
                const targetType = this.resolveTypeReference(expression.targetType, object);
                if (!integerTypes.has(sourceType) || !integerTypes.has(targetType)) {
                    this.report(expression.span, `Cannot convert '${sourceType}' to '${targetType}'; integer conversion requires integer types`);
                    type = UNKNOWN;
                } else type = targetType;
                break;
            }
            case 'UnwrapExpression': {
                const optionalType = this.analyzeExpression(expression.expression, scope, object);
                if (!this.isOptionalType(optionalType)) {
                    this.report(expression.span, `Cannot unwrap non-optional type '${optionalType}'`);
                } else type = this.optionalBaseType(optionalType);
                break;
            }
            case 'PropagateExpression': {
                const optionalType = this.analyzeExpression(expression.expression, scope, object);
                if (!this.isOptionalType(optionalType)) {
                    this.report(expression.span, `Cannot propagate non-optional type '${optionalType}'`);
                } else if (!this.isOptionalType(this.currentMethod?.returnType)) {
                    this.report(expression.span, "Optional propagation requires the enclosing method to return an optional type");
                    type = this.optionalBaseType(optionalType);
                } else type = this.optionalBaseType(optionalType);
                break;
            }
            case 'UnaryExpression': {
                const operand = this.analyzeExpression(expression.operand, scope, object);
                if (expression.operator === '!') {
                    this.requireAssignable(operand, BOOL, expression.operand.span, expression.operand);
                    type = BOOL;
                } else if (!integerTypes.has(operand)) {
                    this.report(expression.operand.span, `Unary '-' requires an integer, got '${operand}'`);
                } else if (operand.startsWith('u')) {
                    this.report(expression.span, `Unary '-' cannot be applied to unsigned type '${operand}'`);
                    type = operand;
                } else type = operand;
                break;
            }
            case 'BinaryExpression': {
                let left = this.analyzeExpression(expression.left, scope, object);
                let right = this.analyzeExpression(expression.right, scope, object);
                const logical = expression.operator === '&&' || expression.operator === '||';
                const identity = expression.operator === '===' || expression.operator === '!==';
                const comparison = identity || ['==', '!=', '<', '<=', '>', '>='].includes(expression.operator);
                if (identity) {
                    const leftBase = this.isOptionalType(left) ? this.optionalBaseType(left) : left;
                    const rightBase = this.isOptionalType(right) ? this.optionalBaseType(right) : right;
                    const compatible = leftBase === rightBase && this.isReferenceType(leftBase) ||
                        left === NULL && this.isOptionalType(right) ||
                        right === NULL && this.isOptionalType(left);
                    if (!compatible) {
                        this.report(expression.span, `Reference identity requires compatible reference operands, got '${left}' and '${right}'`);
                    }
                    type = BOOL;
                } else if (this.isOptionalType(left) || this.isOptionalType(right) || left === NULL || right === NULL) {
                    const compatible = (left === NULL && this.isOptionalType(right)) ||
                        (right === NULL && this.isOptionalType(left)) || left === right;
                    if (!compatible || !['==', '!='].includes(expression.operator)) {
                        this.report(expression.span, `Operator '${expression.operator}' is not supported between '${left}' and '${right}'`);
                    }
                    type = BOOL;
                } else if (left === STRING || right === STRING) {
                    if (left !== STRING || right !== STRING || !['+', '==', '!='].includes(expression.operator)) {
                        this.report(expression.span, `Operator '${expression.operator}' is not supported for strings`);
                    } else type = expression.operator === '+' ? STRING : BOOL;
                } else if (logical) {
                    this.requireAssignable(left, BOOL, expression.left.span, expression.left);
                    this.requireAssignable(right, BOOL, expression.right.span, expression.right);
                    type = BOOL;
                } else if (!integerTypes.has(left) || !integerTypes.has(right)) {
                    this.report(expression.span, `Operator '${expression.operator}' requires integer operands`);
                } else {
                    if (this.isIntegerLiteral(expression.left) && !this.isIntegerLiteral(expression.right)) {
                        this.requireAssignable(left, right, expression.left.span, expression.left);
                        left = right;
                    } else if (this.isIntegerLiteral(expression.right) && !this.isIntegerLiteral(expression.left)) {
                        this.requireAssignable(right, left, expression.right.span, expression.right);
                        right = left;
                    } else this.requireAssignable(right, left, expression.right.span, expression.right);
                    type = comparison ? BOOL : left;
                }
                break;
            }
            case 'CallExpression': {
                this.analyzeExpression(expression.callee, scope, object);
                const callee = expression.callee.semanticSymbol;
                const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                if (callee?.kind === 'Method') {
                    this.checkArguments(callee, argumentTypes, expression.arguments, expression.span);
                    type = callee.returnType;
                } else if (callee?.kind === 'ExternalMember') {
                    type = UNKNOWN;
                } else if (callee?.kind === 'ArrayAppend') {
                    if (argumentTypes.length !== 1) {
                        this.report(expression.span, `Array.append expects 1 argument, got ${argumentTypes.length}`);
                    } else {
                        this.requireAssignable(argumentTypes[0], callee.elementType, expression.arguments[0].span, expression.arguments[0]);
                    }
                    type = VOID;
                } else if (callee?.kind === 'StringSlice') {
                    if (argumentTypes.length !== 2) {
                        this.report(expression.span, `String.slice expects 2 arguments, got ${argumentTypes.length}`);
                    } else {
                        for (let i = 0; i < 2; i++) {
                            this.requireAssignable(argumentTypes[i], I64, expression.arguments[i].span, expression.arguments[i]);
                        }
                    }
                    type = STRING;
                } else if (callee?.kind === 'IntegerToString') {
                    if (argumentTypes.length !== 0) this.report(expression.span, 'Integer.toString expects no arguments');
                    type = STRING;
                } else if (callee?.kind === 'StringBuilderAppend') {
                    if (argumentTypes.length !== 1) {
                        this.report(expression.span, `StringBuilder.append expects 1 argument, got ${argumentTypes.length}`);
                    } else if (argumentTypes[0] !== STRING && !integerTypes.has(argumentTypes[0])) {
                        this.report(expression.arguments[0].span, `StringBuilder.append requires a string or integer, got '${argumentTypes[0]}'`);
                    }
                    type = VOID;
                } else if (callee?.kind === 'StringBuilderAppendByte') {
                    if (argumentTypes.length !== 1) {
                        this.report(expression.span, `StringBuilder.appendByte expects 1 argument, got ${argumentTypes.length}`);
                    } else this.requireAssignable(argumentTypes[0], 'u8', expression.arguments[0].span, expression.arguments[0]);
                    type = VOID;
                } else if (callee?.kind === 'StringBuilderBuild') {
                    if (argumentTypes.length !== 0) this.report(expression.span, 'StringBuilder.build expects no arguments');
                    type = STRING;
                } else {
                    this.report(expression.callee.span, 'Expression is not callable');
                }
                break;
            }
            case 'NewExpression': {
                if (expression.callee.kind === 'IdentifierExpression' && expression.callee.name === STRING_BUILDER) {
                    if (expression.typeArguments.length !== 0 || expression.arguments.length !== 0) {
                        this.report(expression.span, 'StringBuilder construction expects no arguments or type arguments');
                    }
                    type = STRING_BUILDER;
                    symbol = {kind: 'StringBuilderType', name: STRING_BUILDER, type};
                    break;
                }
                if (expression.callee.kind === 'IdentifierExpression' && expression.callee.name === 'Array') {
                    if (expression.typeArguments.length !== 1) {
                        this.report(expression.span, 'Array construction requires exactly one element type');
                        break;
                    }
                    const elementType = this.resolveTypeReference(expression.typeArguments[0], object);
                    if (expression.arguments.length !== 1) {
                        this.report(expression.span, `Array construction expects an initial length, got ${expression.arguments.length} arguments`);
                    } else {
                        const lengthType = this.analyzeExpression(expression.arguments[0], scope, object);
                        this.requireAssignable(lengthType, I64, expression.arguments[0].span, expression.arguments[0]);
                    }
                    type = `Array<${elementType}>`;
                    symbol = {kind: 'ArrayType', name: 'Array', type, elementType};
                    break;
                }
                const constructed = this.resolveConstructedType(expression.callee, scope, object);
                const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                if (constructed) {
                    const constructor = constructed.methods.get('__');
                    if (constructor) this.checkArguments(constructor, argumentTypes, expression.arguments, expression.span);
                    else if (argumentTypes.length) this.report(expression.span, `Type '${constructed.type}' has no constructor`);
                    type = constructed.type;
                    symbol = constructed;
                }
                break;
            }
            default:
                this.report(expression.span, `Unsupported expression ${expression.kind}`);
        }

        this.annotate(expression, type, symbol);
        return type;
    }

    resolveConstructedType(expression, scope, currentObject) {
        if (expression.kind === 'IdentifierExpression') {
            let owner = currentObject;
            while (owner) {
                if (owner.name === expression.name && owner.kind === 'Object') return owner;
                const nested = owner.objects.get(expression.name);
                if (nested?.kind === 'Object') return nested;
                owner = owner.parent;
            }
            const symbol = scope.lookup(expression.name);
            if (symbol?.kind === 'Object') return symbol;
            this.report(expression.span, `'${expression.name}' is not an object type`);
            return null;
        }
        if (expression.kind === 'MemberExpression') {
            const ownerType = this.analyzeExpression(expression.object, scope, currentObject);
            const owner = this.findObjectType(ownerType);
            const nested = owner?.objects.get(expression.member);
            if (nested) return nested;
            this.report(expression.span, `'${expression.member}' is not a nested object type of '${ownerType}'`);
            return null;
        }
        this.report(expression.span, 'Expected an object type after new');
        return null;
    }

    resolveTypeReference(reference, currentObject) {
        let type;
        let resolvedSymbol = null;
        if (reference.name === 'Array') {
            if (reference.typeArguments.length !== 1) {
                this.report(reference.span, `Array type requires exactly one type argument`);
                return this.annotate(reference, UNKNOWN, null);
            }
            const elementType = this.resolveTypeReference(reference.typeArguments[0], currentObject);
            type = `Array<${elementType}>`;
            resolvedSymbol = {
                kind: 'ArrayType', name: 'Array', type: `Array<${elementType}>`, elementType
            };
        } else if (reference.typeArguments.length > 0) {
            this.report(reference.span, `Type '${reference.name}' does not accept type arguments`);
            return this.annotate(reference, UNKNOWN, null);
        } else {
            if (reference.name.includes('.')) {
                const parts = reference.name.split('.');
                let qualified = (currentObject.moduleScope ?? this.globals).lookup(parts[0]);
                for (let index = 1; qualified && index < parts.length; index++) {
                    qualified = qualified.objects?.get(parts[index]) ?? null;
                }
                if (qualified?.kind === 'Object') {
                    type = qualified.type;
                    resolvedSymbol = qualified;
                }
            }
            let symbol = currentObject;
            while (!type && symbol) {
                if (symbol.name === reference.name) {
                    type = symbol.type;
                    resolvedSymbol = symbol;
                    break;
                }
                const nested = symbol.objects.get(reference.name);
                if (nested) {
                    type = nested.type;
                    resolvedSymbol = nested;
                    break;
                }
                symbol = symbol.parent;
            }
            if (!type) {
                const global = (currentObject.moduleScope ?? this.globals).lookup(reference.name);
                if (global?.kind === 'BuiltinType' || global?.kind === 'Object') {
                    type = global.type;
                    resolvedSymbol = global;
                }
            }
        }
        if (!type) {
            this.report(reference.span, `Unknown type '${reference.name}'`);
            return this.annotate(reference, UNKNOWN, null);
        }
        if (reference.optional) {
            if (!this.isReferenceType(type)) {
                this.report(reference.span, `Optional bootstrap values require a reference type, got '${type}'`);
                return this.annotate(reference, UNKNOWN, null);
            }
            type = `${type}?`;
        }
        return this.annotate(reference, type, resolvedSymbol);
    }

    objectScope(object) {
        return new ObjectScope(object, object.moduleScope ?? this.globals);
    }

    findObjectType(type) {
        for (const symbol of this.objectSymbols.values()) {
            if (symbol.type === type) return symbol;
        }
        return null;
    }

    arrayElementType(type) {
        return type?.startsWith('Array<') && type.endsWith('>') ? type.slice(6, -1) : null;
    }

    isReferenceType(type) {
        return type === STRING || type === STRING_BUILDER || this.arrayElementType(type) !== null || this.findObjectType(type) !== null;
    }

    isOptionalType(type) {
        return type?.endsWith('?') ?? false;
    }

    optionalBaseType(type) {
        return type.slice(0, -1);
    }

    checkArguments(method, actualTypes, expressions, callSpan) {
        if (actualTypes.length !== method.parameters.length) {
            this.report(callSpan, `Method '${method.qualifiedName}' expects ${method.parameters.length} arguments, got ${actualTypes.length}`);
            return;
        }
        for (let i = 0; i < actualTypes.length; i++) {
            this.requireAssignable(actualTypes[i], method.parameters[i].type, expressions[i].span, expressions[i]);
        }
    }

    requireAssignable(actual, expected, span, expression = null) {
        if (this.isOptionalType(expected)) {
            if (actual === NULL || actual === expected || actual === this.optionalBaseType(expected)) return;
        }
        const integerLiteral = expression?.kind === 'IntegerLiteral'
            ? expression
            : expression?.kind === 'UnaryExpression' &&
              expression.operator === '-' &&
              expression.operand.kind === 'IntegerLiteral'
                ? expression.operand
                : null;
        if (integerLiteral && integerTypes.has(expected)) {
            const sign = expression.kind === 'UnaryExpression' ? -1n : 1n;
            const value = sign * BigInt(integerLiteral.lexeme);
            const [minimum, maximum] = integerRanges[expected];
            if (value < minimum || value > maximum) {
                this.report(span, `Integer literal '${value}' is outside the range of '${expected}'`);
            } else {
                expression.inferredType = expected;
                if (expression.kind === 'IntegerLiteral') integerLiteral.inferredType = expected;
            }
            return;
        }
        if (actual !== UNKNOWN && expected !== UNKNOWN && actual !== expected) {
            this.report(span, `Cannot use value of type '${actual}' where '${expected}' is required`);
        }
    }

    isIntegerLiteral(expression) {
        return expression?.kind === 'IntegerLiteral' || (
            expression?.kind === 'UnaryExpression' &&
            expression.operator === '-' &&
            expression.operand.kind === 'IntegerLiteral'
        );
    }

    annotate(node, type, symbol) {
        node.inferredType = type;
        if (symbol) {
            Object.defineProperty(node, 'semanticSymbol', {
                value: symbol,
                configurable: true,
                writable: true
            });
        }
        return type;
    }

    report(span, message, severity = 'error') {
        this.diagnostics.push({severity, message, span});
    }
}

class Scope {
    constructor(parent, name, moduleId = parent?.moduleId ?? null) {
        this.parent = parent;
        this.name = name;
        this.moduleId = moduleId;
        this.symbols = new Map();
    }

    define(name, symbol, span, diagnostics) {
        if (this.symbols.has(name)) {
            diagnostics.push({severity: 'error', message: `Duplicate declaration '${name}'`, span});
            return false;
        }
        this.symbols.set(name, symbol);
        return true;
    }

    lookup(name) {
        return this.symbols.get(name) ?? this.parent?.lookup(name) ?? null;
    }
}

class ObjectScope extends Scope {
    constructor(object, parent) {
        super(parent, `object ${object.qualifiedName}`);
        this.object = object;
    }

    lookup(name) {
        return this.object.fields.get(name) ??
            this.object.methods.get(name) ??
            this.object.objects.get(name) ??
            super.lookup(name);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const filePath = process.argv[2];
    if (!filePath) throw new Error('Usage: node semantic.js <source-file>');
    const result = new SemanticAnalyzer().analyzeFile(filePath);
    for (const diagnostic of result.diagnostics) {
        const {source, line, column} = diagnostic.span;
        console.error(`${source}:${line}:${column}: ${diagnostic.severity}: ${diagnostic.message}`);
    }
    if (!result.success) process.exitCode = 1;
}
