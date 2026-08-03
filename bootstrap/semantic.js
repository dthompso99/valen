import fs from 'fs';
import {fileURLToPath} from 'url';
import {Parser} from './parser.js';
import {ModuleLoader} from './module-loader.js';
import {diagnostic, DiagnosticSeverity, formatDiagnostic} from './diagnostics.js';

const I64 = 'i64';
const VOID = 'void';
const BOOL = 'bool';
const STRING = 'string';
const STRING_BUILDER = 'StringBuilder';
const F32 = 'f32';
const F64 = 'f64';
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
        this.prepareGenericSpecializations(program);
        for (const declaration of program.imports) this.declareImport(declaration);
        for (const declaration of program.objects) this.declareObject(declaration, null, this.globals);
        for (const declaration of program.libraries) this.declareObject(declaration, null, this.globals, 'Library');
        for (const declaration of program.objects) this.declareMembers(declaration);
        for (const declaration of program.libraries) this.declareMembers(declaration);
        this.identifyExternalResources();
        for (const declaration of [...program.objects, ...program.libraries]) this.bindRelationships(declaration);
        for (const declaration of [...program.objects, ...program.libraries]) this.validateRelationships(declaration);
        for (const declaration of program.objects) this.analyzeObject(declaration);
        for (const declaration of program.libraries) this.analyzeObject(declaration);
        this.validateFieldInitializerCycles();

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
        this.unsafeDepth = 0;
        this.globals = new Scope(null, 'builtins');
        this.objectSymbols = new Map();
        this.contractTypes = new Set();
        for (const name of [...integerTypes, F32, F64, VOID, BOOL, STRING, STRING_BUILDER]) {
            this.globals.define(name, {kind: 'BuiltinType', name, type: name}, null, this.diagnostics);
        }
    }

    analyzeModules(graph) {
        this.initialize();
        this.diagnostics.push(...graph.diagnostics);
        this.moduleScopes = new Map();

        for (const module of graph.modules.values()) {
            this.moduleScopes.set(module, new Scope(this.globals, `module ${module.id}`, module.id));
            this.prepareGenericSpecializations(module.program);
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
        this.identifyExternalResources();
        for (const module of graph.modules.values()) {
            for (const declaration of [...module.program.objects, ...module.program.libraries]) this.bindRelationships(declaration);
        }
        for (const module of graph.modules.values()) {
            for (const declaration of [...module.program.objects, ...module.program.libraries]) this.validateRelationships(declaration);
        }
        for (const module of graph.modules.values()) {
            for (const declaration of [...module.program.objects, ...module.program.libraries]) {
                this.analyzeObject(declaration);
            }
        }
        this.validateFieldInitializerCycles();

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

    prepareGenericSpecializations(program) {
        const templates = new Map(program.objects.filter(item => item.typeParameters?.length).map(item => [item.name, item]));
        if (templates.size === 0) return;
        const concrete = new Map(program.objects.filter(item => !item.typeParameters?.length).map(item => [item.name, item]));
        const pending = [];
        const render = reference => {
            const argumentsText = reference.typeArguments?.length ? `<${reference.typeArguments.map(render).join(',')}>` : '';
            return `${reference.ownership && reference.ownership !== 'owned' ? `${reference.ownership} ` : ''}${reference.name}${argumentsText}${reference.optional ? '?' : ''}`;
        };
        const substitute = (node, bindings) => {
            if (!node || typeof node !== 'object') return;
            if (node.kind === 'TypeReference' && bindings.has(node.name) && node.typeArguments.length === 0) {
                const replacement = structuredClone(bindings.get(node.name));
                const span = node.span;
                Object.assign(node, replacement, {span});
                return;
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) for (const child of value) substitute(child, bindings);
                else substitute(value, bindings);
            }
        };
        const specialize = (template, argumentsList, span) => {
            if (argumentsList.length !== template.typeParameters.length) {
                this.report(span, `Generic type '${template.name}' requires ${template.typeParameters.length} type arguments, got ${argumentsList.length}`);
                return template.name;
            }
            const name = `${template.name}<${argumentsList.map(render).join(',')}>`;
            if (!concrete.has(name)) {
                const declaration = structuredClone(template);
                declaration.name = name;
                declaration.typeParameters = [];
                declaration.genericTemplateName = template.name;
                declaration.genericArguments = argumentsList.map(argument => structuredClone(argument));
                substitute(declaration, new Map(template.typeParameters.map((parameter, index) => [parameter, argumentsList[index]])));
                concrete.set(name, declaration);
                program.objects.push(declaration);
                pending.push(declaration);
            }
            return name;
        };
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (node.kind === 'ObjectDeclaration' && node.typeParameters?.length) return;
            if (node.kind === 'TypeReference' && templates.has(node.name)) {
                if (node.typeArguments.length === 0) this.report(node.span, `Generic type '${node.name}' requires type arguments`);
                else {
                    node.name = specialize(templates.get(node.name), node.typeArguments, node.span);
                    node.typeArguments = [];
                }
            } else if (node.kind === 'NewExpression' && node.callee?.kind === 'IdentifierExpression' && templates.has(node.callee.name)) {
                if (node.typeArguments.length === 0) this.report(node.span, `Generic type '${node.callee.name}' requires type arguments`);
                else {
                    node.callee.name = specialize(templates.get(node.callee.name), node.typeArguments, node.span);
                    node.typeArguments = [];
                }
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) for (const child of value) visit(child);
                else visit(value);
            }
        };
        for (const declaration of [...program.objects, ...program.libraries]) visit(declaration);
        while (pending.length) visit(pending.shift());
        program.objects = program.objects.filter(item => !item.typeParameters?.length);
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
            methodOverloads: new Map(),
            objects: new Map(),
            base: null,
            contracts: [],
            visibility: declaration.visibility ?? 'public',
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
            if (field.declaration.reference && !this.isOwnedReferenceType(field.type)) {
                this.report(field.declaration.span, `'ref' requires an object, array, or builder member`);
            }
            const weakBase = this.isOptionalType(field.type) ? this.optionalBaseType(field.type) : field.type;
            if (field.declaration.weakReference && (!this.isOptionalType(field.type) || !this.findObjectType(weakBase))) {
                this.report(field.declaration.span, `'weak' requires an optional object member`);
            }
            field.ownership = field.declaration.weakReference ? 'member-weak'
                : field.declaration.reference ? 'member-reference'
                    : this.isOwnedReferenceType(field.type) ? 'member-owned' : 'value';
            this.annotate(field.declaration, field.type, field);
        }
        for (const method of [...object.methodOverloads.values()].flat()) {
            method.returnType = this.resolveTypeReference(method.declaration.returnType, object);
            method.returnOwnership = method.declaration.returnReference ? 'borrowed' : 'owned';
            if (method.declaration.returnReference && !this.isOwnedReferenceType(method.returnType)) {
                this.report(method.declaration.returnType.span, `'ref' return requires an object, array, or builder type`);
            }
            method.isNative = method.declaration.isNative;
            method.isUnsafe = method.declaration.isUnsafe === true;
            method.parameters = method.declaration.parameters.map(parameter => ({
                kind: 'Parameter',
                name: parameter.name,
                type: this.resolveTypeReference(parameter.parameterType, object),
                defaultValue: parameter.defaultValue,
                declaration: parameter,
                owning: parameter.owning,
                ownership: parameter.owning ? 'owned' : 'borrowed',
                owner: method
            }));
            if (object.declaration.isTest) {
                if (method.parameters.length) this.report(method.declaration.span, `Test '${method.qualifiedName}' cannot declare parameters`);
                if (method.returnType !== VOID) this.report(method.declaration.returnType.span, `Test '${method.qualifiedName}' must return void`);
            }
            let sawDefault = false;
            for (const parameter of method.parameters) {
                if (parameter.owning && !this.isOwnedReferenceType(parameter.type)) {
                    this.report(parameter.declaration.span, `'own' requires an object, array, or builder parameter`);
                }
                if (parameter.owning && parameter.defaultValue) {
                    this.report(parameter.declaration.span, `Owning parameter '${parameter.name}' cannot have a default value`);
                }
                if (parameter.defaultValue) sawDefault = true;
                else if (sawDefault) this.report(parameter.declaration.span, `Required parameter '${parameter.name}' cannot follow a default parameter`);
            }
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
        for (const [name, overloads] of object.methodOverloads) {
            const signatures = new Set();
            for (const method of overloads) {
                const signature = method.parameters.map(parameter => parameter.type).join(',');
                if (signatures.has(signature)) this.report(method.declaration.span, `Duplicate overload '${object.qualifiedName}.${name}(${signature})'`);
                signatures.add(signature);
                if (overloads.length > 1) {
                    method.irName = `${name}#${signature}`;
                    method.qualifiedName = `${object.qualifiedName}.${method.irName}`;
                }
            }
        }
    }

    bindRelationships(declaration) {
        const object = this.objectSymbols.get(declaration);
        if (!object) return;

        if (object.kind === 'Object' && declaration.inheritedType) {
            const type = this.resolveTypeReference(declaration.inheritedType, object);
            object.base = this.findObjectType(type);
            if (!object.base || object.base.kind !== 'Object') {
                this.report(declaration.inheritedType.span, `'${declaration.inheritedType.name}' is not an inheritable object`);
                object.base = null;
            }
        }

        for (const reference of object.kind === 'Object' ? declaration.implementedTypes : []) {
            const type = this.resolveTypeReference(reference, object);
            const contract = this.findObjectType(type);
            if (!contract || contract.kind !== 'Object') {
                this.report(reference.span, `'${reference.name}' is not an implementable object`);
            } else {
                object.contracts.push(contract);
                this.contractTypes.add(contract.type);
            }
        }

        for (const member of declaration.members) {
            if (member.kind === 'ObjectDeclaration') this.bindRelationships(member);
        }
    }

    validateRelationships(declaration) {
        const object = this.objectSymbols.get(declaration);
        if (!object) return;

        if (object.kind === 'Object' && object.base && this.inheritanceContains(object.base, object)) {
            this.report(declaration.inheritedType.span, `Inheritance cycle involving '${object.qualifiedName}'`);
            object.base = null;
        }
        for (const method of object.kind === 'Object' ? [...object.methodOverloads.values()].flat() : []) {
            if (method.name === '__') continue;
            const privateAncestor = this.lookupMethodBySignature(object.base, method.name, method.parameters, true);
            if (privateAncestor?.visibility === 'private') {
                this.report(method.declaration.span, `Method '${method.qualifiedName}' cannot replace private method '${privateAncestor.qualifiedName}'`);
                continue;
            }
            const inherited = this.lookupMethodBySignature(object.base, method.name, method.parameters);
            if (inherited && !this.signaturesMatch(inherited, method)) {
                this.report(method.declaration.span, `Override '${method.qualifiedName}' is incompatible with '${inherited.qualifiedName}'`);
            }
        }
        for (const field of object.kind === 'Object' ? object.fields.values() : []) {
            const inherited = this.lookupField(object.base, field.name);
            if (inherited) this.report(field.declaration.span, `Field '${field.qualifiedName}' hides inherited field '${inherited.qualifiedName}'`);
        }
        if (object.kind === 'Object') for (const contract of object.contracts) this.validateContract(object, contract);
        for (const member of declaration.members) {
            if (member.kind === 'ObjectDeclaration') this.validateRelationships(member);
        }
    }

    inheritanceContains(object, target) {
        let current = object;
        while (current) {
            if (current === target) return true;
            current = current.base;
        }
        return false;
    }

    validateContract(object, contract) {
        for (const required of this.contractMethods(contract)) {
            const implementation = this.lookupMethodBySignature(object, required.name, required.parameters);
            if (!implementation) {
                this.report(object.declaration.span, `Object '${object.qualifiedName}' implements '${contract.qualifiedName}' but is missing method '${required.name}'`);
            } else if (!this.signaturesMatch(implementation, required)) {
                this.report(implementation.declaration.span, `Method '${implementation.qualifiedName}' does not match '${required.qualifiedName}' required by '${contract.qualifiedName}'`);
            }
        }
    }

    contractMethods(contract) {
        const methods = new Map();
        if (contract.base) {
            for (const method of this.contractMethods(contract.base)) methods.set(method.name, method);
        }
        for (const method of [...contract.methodOverloads.values()].flat()) {
            if (method.name !== '__' && method.visibility !== 'private') methods.set(`${method.name}(${method.parameters.map(parameter => parameter.type).join(',')})`, method);
        }
        return methods.values();
    }

    signaturesMatch(left, right) {
        return left.returnType === right.returnType &&
            left.returnOwnership === right.returnOwnership &&
            left.parameters.length === right.parameters.length &&
            left.parameters.every((parameter, index) => parameter.type === right.parameters[index].type &&
                parameter.owning === right.parameters[index].owning);
    }

    lookupMethod(object, name) {
        let current = object;
        while (current) {
            const method = current.methods.get(name);
            if (method && method.visibility !== 'private' && (current === object || name !== '__')) return method;
            current = current.base;
        }
        return null;
    }

    methodCandidates(object, name, {includePrivate = false, constructors = false} = {}) {
        const candidates = [];
        const signatures = new Set();
        let current = object;
        while (current) {
            for (const method of current.methodOverloads?.get(name) ?? []) {
                const signature = method.parameters.map(parameter => parameter.type).join(',');
                if (!signatures.has(signature) && (includePrivate || method.visibility !== 'private')) candidates.push(method);
                signatures.add(signature);
            }
            if (name === '__' || constructors) break;
            current = current.base;
        }
        return candidates;
    }

    lookupMethodBySignature(object, name, parameters, includePrivate = false) {
        return this.methodCandidates(object, name, {includePrivate}).find(method =>
            method.parameters.length === parameters.length && method.parameters.every((parameter, index) => parameter.type === parameters[index].type)) ?? null;
    }

    resolveOverload(object, name, argumentTypes, span, {constructors = false, includePrivate = false} = {}) {
        const candidates = this.methodCandidates(object, name, {constructors, includePrivate})
            .filter(method => argumentTypes.length <= method.parameters.length &&
                argumentTypes.length >= this.requiredParameterCount(method) &&
                argumentTypes.every((type, index) => this.isAssignable(type, method.parameters[index].type)));
        const exact = candidates.filter(method => argumentTypes.every((type, index) => method.parameters[index].type === type));
        const matches = exact.length ? exact : candidates;
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            const mostSpecific = matches.filter(candidate => matches.every(other => candidate === other ||
                candidate.parameters.length === other.parameters.length && candidate.parameters.every((parameter, index) => parameter.type === other.parameters[index].type ||
                    this.conformsTo(parameter.type, other.parameters[index].type))));
            if (mostSpecific.length === 1) return mostSpecific[0];
            this.report(span, `Call to '${name}' is ambiguous for (${argumentTypes.join(', ')})`);
        }
        else this.report(span, `No overload of '${name}' accepts (${argumentTypes.join(', ')})`);
        return null;
    }

    requiredParameterCount(method) {
        return method.parameters.findIndex(parameter => parameter.defaultValue) < 0
            ? method.parameters.length
            : method.parameters.findIndex(parameter => parameter.defaultValue);
    }

    applyDefaults(method, expressions, argumentTypes) {
        while (expressions.length < method.parameters.length) {
            const parameter = method.parameters[expressions.length];
            expressions.push(parameter.defaultValue);
            argumentTypes.push(parameter.type);
        }
    }

    isAssignable(actual, expected) {
        if (actual === expected || actual === UNKNOWN || expected === UNKNOWN) return true;
        if (integerTypes.has(actual) && integerTypes.has(expected)) return true;
        if (this.isOptionalType(expected)) {
            const expectedBase = this.optionalBaseType(expected);
            const actualBase = this.isOptionalType(actual) ? this.optionalBaseType(actual) : actual;
            return actual === NULL || actualBase === expectedBase || this.conformsTo(actualBase, expectedBase);
        }
        return this.conformsTo(actual, expected);
    }

    lookupPrivateMethod(object, name) {
        let current = object;
        while (current) {
            const method = current.methods.get(name);
            if (method?.visibility === 'private') return method;
            current = current.base;
        }
        return null;
    }

    lookupField(object, name) {
        let current = object;
        while (current) {
            const field = current.fields.get(name);
            if (field) return field;
            current = current.base;
        }
        return null;
    }

    defineMember(object, collection, declaration, kind) {
        if (
            object.fields.has(declaration.name) ||
            (kind !== 'Method' && object.methods.has(declaration.name)) ||
            object.objects.has(declaration.name)
        ) {
            this.report(declaration.span, `Duplicate member '${declaration.name}' in ${object.qualifiedName}`);
            return;
        }
        const symbol = {
            kind,
            name: declaration.name,
            qualifiedName: `${object.qualifiedName}.${declaration.name}`,
            declaration,
            owner: object,
            visibility: declaration.visibility ?? 'public',
            type: UNKNOWN
        };
        if (kind === 'Method') {
            const overloads = object.methodOverloads.get(declaration.name) ?? [];
            overloads.push(symbol);
            object.methodOverloads.set(declaration.name, overloads);
            if (!collection.has(declaration.name)) collection.set(declaration.name, symbol);
        } else collection.set(declaration.name, symbol);
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
        const method = declaration.semanticSymbol;
        if (!method) return;
        if (declaration.isNative) {
            if (object.kind !== 'Library') {
                this.report(declaration.span, 'Native methods can only be declared in libraries');
            }
            if (declaration.body) this.report(declaration.span, `Native method '${method.qualifiedName}' cannot have a body`);
            if (declaration.foreignLibrary) this.validateForeignMethod(declaration, method);
            return;
        }
        if (declaration.isUnsafe) this.report(declaration.span, "Only native library methods may be declared 'unsafe'");
        if (!declaration.body) {
            this.report(declaration.span, `Method '${method.qualifiedName}' requires a body`);
            return;
        }
        const scope = new Scope(this.objectScope(object), `method ${method.qualifiedName}`);
        if (object.kind === 'Object') {
            scope.define('self', {kind: 'Self', name: 'self', type: object.type, owner: object}, declaration.span, this.diagnostics);
        }
        this.loopDepth = 0;
        this.unsafeDepth = 0;
        for (const parameter of method.parameters) {
            scope.define(parameter.name, parameter, parameter.declaration.span, this.diagnostics);
            this.annotate(parameter.declaration, parameter.type, parameter);
        }

        for (const parameter of method.parameters) {
            if (!parameter.defaultValue) continue;
            const defaultType = this.analyzeExpression(parameter.defaultValue, this.objectScope(object), object);
            this.requireAssignable(defaultType, parameter.type, parameter.defaultValue.span, parameter.defaultValue);
        }

        const previousMethod = this.currentMethod;
        this.currentMethod = method;
        const returns = this.analyzeBlock(declaration.body, scope, object, method);
        this.currentMethod = previousMethod;
        if (method.returnType !== VOID && !returns) {
            this.report(declaration.span, `Method '${method.qualifiedName}' may exit without returning ${method.returnType}`);
        }
    }

    validateForeignMethod(declaration, method) {
        if (!declaration.isUnsafe) {
            this.report(declaration.span, `Foreign method '${method.qualifiedName}' must be declared unsafe`);
        }
        if (!/^[A-Za-z0-9_.+-]+$/.test(declaration.foreignLibrary)) {
            this.report(declaration.span, `Invalid foreign library name '${declaration.foreignLibrary}'`);
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(declaration.foreignSymbol)) {
            this.report(declaration.span, `Invalid foreign symbol name '${declaration.foreignSymbol}'`);
        }
        for (const parameter of method.parameters) {
            if (!this.isForeignAbiType(parameter.type, false)) {
                this.report(parameter.declaration.span, `Foreign parameter '${parameter.name}' has unsupported ABI type '${parameter.type}'`);
            }
        }
        if (!this.isForeignAbiType(method.returnType, true)) {
            this.report(declaration.returnType.span, `Foreign method '${method.qualifiedName}' has unsupported return ABI type '${method.returnType}'`);
        }
    }

    isForeignAbiType(type, allowVoid) {
        if (allowVoid && type === VOID) return true;
        if (integerTypes.has(type) || this.isFloat(type) || type === BOOL) return true;
        const base = this.isOptionalType(type) ? this.optionalBaseType(type) : type;
        return this.findObjectType(base)?.externalResource === true;
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
            case 'UnsafeStatement': {
                this.unsafeDepth++;
                const returns = this.analyzeBlock(statement.body, scope, object, method);
                this.unsafeDepth--;
                return returns;
            }
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
                symbol.ownership = this.localOwnership(statement.initializer, type);
                symbol.declaredOwnership = symbol.ownership;
                symbol.ownershipVersion = 0;
                this.bindBorrow(symbol, statement.initializer);
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
            case 'ForStatement': {
                const iterableType = this.analyzeExpression(statement.iterable, scope, object);
                let elementType = iterableType === STRING ? 'u8' : this.arrayElementType(iterableType);
                if (!elementType) {
                    const iterator = this.findObjectType(iterableType);
                    const hasNext = iterator ? this.resolveOverload(iterator, 'hasNext', [], statement.span) : null;
                    const next = iterator ? this.resolveOverload(iterator, 'next', [], statement.span) : null;
                    if (!hasNext || !next || hasNext.returnType !== BOOL || next.returnType === VOID) {
                        this.report(statement.iterable.span, `Type '${iterableType}' is not iterable; expected hasNext() -> bool and next() -> value`);
                    } else {
                        statement.iteratorHasNext = hasNext;
                        statement.iteratorNext = next;
                        elementType = next.returnType;
                    }
                }
                const loopScope = new Scope(scope, `for ${statement.name}`);
                const symbol = {kind: 'Local', name: statement.name, type: elementType ?? UNKNOWN,
                    declaration: statement, ownership: 'borrowed', declaredOwnership: 'borrowed', ownershipVersion: 0};
                loopScope.define(statement.name, symbol, statement.span, this.diagnostics);
                this.annotate(statement, symbol.type, symbol);
                this.loopDepth++;
                this.analyzeBlock(statement.body, loopScope, object, method);
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
                if (statement.expression && this.isOwnedReferenceType(method.returnType) && method.returnOwnership === 'owned') {
                    const source = statement.expression.semanticSymbol;
                    if (statement.expression.kind === 'NullLiteral' && this.isOptionalType(method.returnType)) {
                        statement.ownership = 'transfer';
                    } else if (this.isOwningExpression(statement.expression)) {
                        statement.ownership = 'transfer';
                    } else if (source && ['Local', 'Parameter'].includes(source.kind) && source.ownership === 'owned') {
                        statement.ownership = 'transfer';
                        source.ownership = 'borrowed';
                    } else {
                        this.report(statement.expression.span, `Returning '${method.returnType}' requires an owned value; use 'copy' for a borrowed reference`);
                    }
                }
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
            case 'FloatLiteral':
                type = F64;
                if (!Number.isFinite(expression.value)) this.report(expression.span, `Floating literal '${expression.lexeme}' is not finite`);
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
                else if (!expression.isAssignmentTarget) this.validateBorrow(symbol, expression.span);
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
                    } else if (expression.member === 'hash') {
                        symbol = {kind: 'StructuralHash', name: 'hash', type: I64, valueType: STRING};
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
                    const elementOwnership = this.arrayElementOwnership(ownerType);
                    if (expression.member === 'length') {
                        symbol = {kind: 'ArrayLength', name: 'length', type: I64};
                        type = I64;
                    } else if (expression.member === 'append') {
                        symbol = {kind: 'ArrayAppend', name: 'append', type: UNKNOWN, elementType, elementOwnership};
                    } else if (expression.member === 'hash') {
                        symbol = {kind: 'StructuralHash', name: 'hash', type: I64, valueType: ownerType};
                    } else {
                        this.report(expression.span, `Array type '${ownerType}' has no member '${expression.member}'`);
                    }
                    break;
                }
                const owner = this.findObjectType(ownerType);
                if (owner) {
                    symbol = this.lookupField(owner, expression.member) ?? owner.objects.get(expression.member);
                    if (!symbol) {
                        const methods = this.methodCandidates(owner, expression.member, {
                            includePrivate: this.currentMethod?.owner === owner
                        });
                        if (methods.length) symbol = {kind: 'OverloadSet', name: expression.member, owner, methods, type: UNKNOWN};
                        else {
                            const privateMethod = this.methodCandidates(owner, expression.member, {includePrivate: true})
                                .find(method => method.visibility === 'private');
                            if (privateMethod) this.report(expression.span, `Private method '${privateMethod.qualifiedName}' is not visible here`);
                        }
                    }
                    if (!symbol && expression.member === 'hash') symbol = {kind: 'StructuralHash', name: 'hash', type: I64, valueType: ownerType};
                    if (symbol?.kind === 'Field' && this.contractTypes.has(owner.type)) {
                        const selfAccess = expression.object.semanticSymbol?.kind === 'Self' && this.currentMethod?.owner === owner;
                        if (!selfAccess) {
                            this.report(expression.span, `Contract reference '${owner.qualifiedName}' does not expose field '${expression.member}'`);
                            symbol = null;
                        }
                    }
                    if (symbol?.visibility === 'private' && this.currentMethod?.owner !== symbol.owner) {
                        this.report(expression.span, `Private ${symbol.kind.toLowerCase()} '${symbol.qualifiedName}' is not visible here`);
                        symbol = null;
                    }
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
                const elementOwnership = arrayType === STRING ? 'value' : this.arrayElementOwnership(arrayType);
                const indexType = this.analyzeExpression(expression.index, scope, object);
                this.requireAssignable(indexType, I64, expression.index.span, expression.index);
                if (!elementType) {
                    this.report(expression.object.span, `Type '${arrayType}' cannot be indexed`);
                } else {
                    symbol = {
                        kind: arrayType === STRING ? 'StringElement' : 'ArrayElement',
                        name: '[]',
                        type: elementType,
                        elementOwnership
                    };
                    type = elementType;
                }
                break;
            }
            case 'AssignmentExpression': {
                expression.target.isAssignmentTarget = true;
                const targetType = this.analyzeExpression(expression.target, scope, object);
                const targetSymbol = expression.target.semanticSymbol;
                if (!targetSymbol) {
                    this.report(expression.target.span, 'Assignment target is not declared');
                } else if (!['Local', 'Parameter', 'Field', 'ArrayElement'].includes(targetSymbol.kind)) {
                    this.report(expression.target.span, `Cannot assign to ${targetSymbol.kind.toLowerCase()} '${targetSymbol.name}'`);
                }
                const valueType = this.analyzeExpression(expression.value, scope, object);
                this.requireAssignable(valueType, targetType, expression.value.span, expression.value);
                if (this.isOwnedReferenceType(targetType)) {
                    if (targetSymbol?.kind === 'Field' && targetSymbol.ownership === 'member-owned') {
                        expression.ownership = 'transfer';
                        this.transferOwnership(expression.value);
                    } else if (targetSymbol?.kind === 'Local') {
                        targetSymbol.ownershipVersion = (targetSymbol.ownershipVersion ?? 0) + 1;
                        targetSymbol.ownership = this.isOwningExpression(expression.value) ? 'owned' : 'borrowed';
                        this.bindBorrow(targetSymbol, expression.value);
                    } else if (targetSymbol?.kind === 'ArrayElement' && targetSymbol.elementOwnership === 'owned') {
                        expression.ownership = 'transfer';
                        this.consumeArrayElement(expression.value);
                    }
                }
                type = targetType;
                break;
            }
            case 'ConversionExpression': {
                const sourceType = this.analyzeExpression(expression.expression, scope, object);
                const targetType = this.resolveTypeReference(expression.targetType, object);
                const sourceObject = this.findObjectType(this.isOptionalType(sourceType) ? this.optionalBaseType(sourceType) : sourceType);
                const targetBase = this.isOptionalType(targetType) ? this.optionalBaseType(targetType) : targetType;
                const targetObject = this.findObjectType(targetBase);
                if (sourceObject && targetObject) {
                    if (this.conformsTo(sourceObject.type, targetObject.type)) expression.conversionKind = 'reference';
                    else if (this.isOptionalType(targetType) && this.conformsTo(targetObject.type, sourceObject.type)) expression.conversionKind = 'checked_reference';
                    else this.report(expression.span, `Downcast from '${sourceType}' to '${targetBase}' must produce an optional value`);
                    type = targetType;
                } else if ((!integerTypes.has(sourceType) && !this.isFloat(sourceType)) ||
                           (!integerTypes.has(targetType) && !this.isFloat(targetType))) {
                    this.report(expression.span, `Cannot convert '${sourceType}' to '${targetType}'; numeric conversion requires numeric types`);
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
                if (expression.operator === 'copy') {
                    if (!this.isReferenceType(operand)) this.report(expression.operand.span, `copy requires a reference value, got '${operand}'`);
                    if (this.isExternalResourceType(operand)) {
                        const resourceType = this.isOptionalType(operand) ? this.optionalBaseType(operand) : operand;
                        this.report(expression.span, `Native resource '${resourceType}' cannot be copied`);
                    }
                    type = operand;
                } else if (expression.operator === 'delete') {
                    const base = this.isOptionalType(operand) ? this.optionalBaseType(operand) : operand;
                    const source = expression.operand.semanticSymbol;
                    if (this.isOptionalType(operand) || !this.findObjectType(base)) {
                        this.report(expression.span, `delete requires a non-optional object reference`);
                    } else if (this.isExternalResourceType(base)) {
                        this.report(expression.span, `Native resource '${base}' must be passed to its owning cleanup operation`);
                    } else if (!source || !['Local', 'Parameter'].includes(source.kind) || source.ownership !== 'owned') {
                        this.report(expression.span, `delete requires an owned local or parameter`);
                    } else {
                        source.ownership = 'destroyed';
                        source.ownershipVersion = (source.ownershipVersion ?? 0) + 1;
                    }
                    type = VOID;
                } else if (expression.operator === '!') {
                    this.requireAssignable(operand, BOOL, expression.operand.span, expression.operand);
                    type = BOOL;
                } else if (!integerTypes.has(operand) && !this.isFloat(operand)) {
                    this.report(expression.operand.span, `Unary '-' requires a numeric value, got '${operand}'`);
                } else if (operand.startsWith('u')) {
                    this.report(expression.span, `Unary '-' cannot be applied to unsigned type '${operand}'`);
                    type = operand;
                } else type = operand;
                break;
            }
            case 'BinaryExpression': {
                let left = this.analyzeExpression(expression.left, scope, object);
                let right = this.analyzeExpression(expression.right, scope, object);
                if (expression.operator === 'is') {
                    const source = this.findObjectType(this.isOptionalType(left) ? this.optionalBaseType(left) : left);
                    const target = expression.right.semanticSymbol;
                    if (!source) this.report(expression.left.span, `'is' requires an object reference`);
                    if (!target || target.kind !== 'Object') this.report(expression.right.span, `'is' requires an object type`);
                    expression.runtimeType = target?.type ?? UNKNOWN;
                    type = BOOL;
                    break;
                }
                const logical = expression.operator === '&&' || expression.operator === '||';
                const bitwise = ['&', '|', '^', '<<', '>>'].includes(expression.operator);
                const identity = expression.operator === '===' || expression.operator === '!==';
                const comparison = identity || ['==', '!=', '<', '<=', '>', '>='].includes(expression.operator);
                if (identity) {
                    const leftBase = this.isOptionalType(left) ? this.optionalBaseType(left) : left;
                    const rightBase = this.isOptionalType(right) ? this.optionalBaseType(right) : right;
                    const compatible = this.isReferenceType(leftBase) && this.isReferenceType(rightBase) &&
                            (leftBase === rightBase || this.conformsTo(leftBase, rightBase) || this.conformsTo(rightBase, leftBase)) ||
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
                } else if (bitwise) {
                    if (!integerTypes.has(left) || !integerTypes.has(right)) {
                        this.report(expression.span, `Operator '${expression.operator}' requires integer operands`);
                    } else this.requireAssignable(right, left, expression.right.span, expression.right);
                    type = left;
                } else if (['==', '!='].includes(expression.operator) && this.isReferenceType(left) && this.isReferenceType(right)) {
                    const compatible = left === right || this.conformsTo(left, right) || this.conformsTo(right, left);
                    if (!compatible) this.report(expression.span, `Structural equality requires compatible references, got '${left}' and '${right}'`);
                    type = BOOL;
                } else if ((!integerTypes.has(left) && !this.isFloat(left)) || (!integerTypes.has(right) && !this.isFloat(right))) {
                    this.report(expression.span, `Operator '${expression.operator}' requires numeric operands`);
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
                if (expression.callee.kind === 'IdentifierExpression' && expression.callee.name === 'expect') {
                    const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                    if (!this.currentMethod?.owner?.declaration?.isTest) this.report(expression.span, "'expect' is only available inside a test suite");
                    if (argumentTypes.length !== 1) this.report(expression.span, "'expect' requires exactly one argument");
                    else this.requireAssignable(argumentTypes[0], BOOL, expression.arguments[0].span, expression.arguments[0]);
                    symbol = {kind: 'TestExpect', name: 'expect', type: VOID, returnType: VOID};
                    this.annotate(expression.callee, VOID, symbol);
                    type = VOID;
                    break;
                }
                if (expression.callee.kind === 'MemberExpression' &&
                    expression.callee.object.kind === 'IdentifierExpression' &&
                    expression.callee.object.name === 'super') {
                    const owner = this.currentMethod?.owner;
                    if (!owner?.base) {
                        this.report(expression.callee.span, "'super.method()' is only valid in a child method");
                        expression.arguments.forEach(argument => this.analyzeExpression(argument, scope, object));
                        type = UNKNOWN;
                        break;
                    }
                    const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                    const method = this.resolveOverload(owner.base, expression.callee.member, argumentTypes, expression.span);
                    if (!method || method.name === '__') {
                        this.report(expression.callee.span, `Parent type has no method '${expression.callee.member}'`);
                        type = UNKNOWN;
                        break;
                    }
                    this.applyDefaults(method, expression.arguments, argumentTypes);
                    this.checkArguments(method, argumentTypes, expression.arguments, expression.span);
                    expression.callee.isSuper = true;
                    this.annotate(expression.callee, method.returnType, method);
                    type = method.returnType;
                    break;
                }
                if (expression.callee.kind === 'IdentifierExpression' && expression.callee.name === 'super') {
                    const owner = this.currentMethod?.owner;
                    if (this.currentMethod?.name !== '__' || !owner?.base) {
                        this.report(expression.callee.span, "'super()' is only valid in a child constructor");
                        expression.arguments.forEach(argument => this.analyzeExpression(argument, scope, object));
                        type = VOID;
                        break;
                    }
                    const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                    const overloads = owner.base.methodOverloads.get('__') ?? [];
                    const constructor = overloads.length
                        ? this.resolveOverload(owner.base, '__', argumentTypes, expression.span, {constructors: true, includePrivate: true})
                        : null;
                    if (constructor) {
                        this.applyDefaults(constructor, expression.arguments, argumentTypes);
                        this.checkArguments(constructor, argumentTypes, expression.arguments, expression.span);
                    }
                    if (!constructor && overloads.length === 0 && argumentTypes.length !== 0) this.report(expression.span, 'Parent has no constructor accepting arguments');
                    symbol = {kind: 'SuperCall', name: 'super', type: VOID, returnType: VOID, owner: owner.base, constructor};
                    this.annotate(expression.callee, VOID, symbol);
                    type = VOID;
                    break;
                }
                this.analyzeExpression(expression.callee, scope, object);
                const callee = expression.callee.semanticSymbol;
                const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                if (callee?.kind === 'OverloadSet') {
                    const method = this.resolveOverload(callee.owner, callee.name, argumentTypes, expression.span, {
                        includePrivate: this.currentMethod?.owner === callee.owner
                    });
                    if (method) {
                        this.applyDefaults(method, expression.arguments, argumentTypes);
                        this.checkArguments(method, argumentTypes, expression.arguments, expression.span);
                        this.annotate(expression.callee, method.returnType, method);
                        if (method.isUnsafe && this.unsafeDepth === 0) {
                            this.report(expression.span, `Unsafe native method '${method.qualifiedName}' may only be called inside an unsafe block`);
                        }
                        type = method.returnType;
                    } else type = UNKNOWN;
                } else if (callee?.kind === 'Method') {
                    this.checkArguments(callee, argumentTypes, expression.arguments, expression.span);
                    if (callee.isUnsafe && this.unsafeDepth === 0) {
                        this.report(expression.span, `Unsafe native method '${callee.qualifiedName}' may only be called inside an unsafe block`);
                    }
                    type = callee.returnType;
                } else if (callee?.kind === 'ExternalMember') {
                    type = UNKNOWN;
                } else if (callee?.kind === 'ArrayAppend') {
                    if (argumentTypes.length !== 1) {
                        this.report(expression.span, `Array.append expects 1 argument, got ${argumentTypes.length}`);
                    } else {
                        this.requireAssignable(argumentTypes[0], callee.elementType, expression.arguments[0].span, expression.arguments[0]);
                        if (callee.elementOwnership === 'owned' && this.isOwnedReferenceType(callee.elementType)) {
                            this.consumeArrayElement(expression.arguments[0]);
                        }
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
                } else if (callee?.kind === 'StructuralHash') {
                    if (argumentTypes.length !== 0) this.report(expression.span, 'hash expects no arguments');
                    type = I64;
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
                    const elementReference = expression.typeArguments[0];
                    const elementType = this.resolveTypeReference(elementReference, object, true);
                    const elementOwnership = elementReference.ownership ?? 'owned';
                    this.validateArrayElementPolicy(elementType, elementOwnership, elementReference);
                    if (expression.arguments.length !== 1) {
                        this.report(expression.span, `Array construction expects an initial length, got ${expression.arguments.length} arguments`);
                    } else {
                        const lengthType = this.analyzeExpression(expression.arguments[0], scope, object);
                        this.requireAssignable(lengthType, I64, expression.arguments[0].span, expression.arguments[0]);
                    }
                    type = `Array<${elementOwnership === 'owned' ? '' : `${elementOwnership} `}${elementType}>`;
                    symbol = {kind: 'ArrayType', name: 'Array', type, elementType, elementOwnership};
                    break;
                }
                const constructed = this.resolveConstructedType(expression.callee, scope, object);
                const argumentTypes = expression.arguments.map(argument => this.analyzeExpression(argument, scope, object));
                if (constructed) {
                    const overloads = constructed.methodOverloads.get('__') ?? [];
                    const constructor = overloads.length
                        ? this.resolveOverload(constructed, '__', argumentTypes, expression.span, {
                            constructors: true,
                            includePrivate: this.currentMethod?.owner === constructed
                        })
                        : null;
                    if (constructor) {
                        this.applyDefaults(constructor, expression.arguments, argumentTypes);
                        this.checkArguments(constructor, argumentTypes, expression.arguments, expression.span);
                    }
                    if (constructor?.visibility === 'private' && this.currentMethod?.owner !== constructed) {
                        this.report(expression.span, `Private constructor '${constructor.qualifiedName}' is not visible here`);
                    } else if (!constructor && overloads.length === 0 && argumentTypes.length) this.report(expression.span, `Type '${constructed.type}' has no constructor`);
                    expression.constructor = constructor;
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

    resolveTypeReference(reference, currentObject, arrayElement = false) {
        let type;
        let resolvedSymbol = null;
        if (reference.name === 'Array') {
            if (reference.typeArguments.length !== 1) {
                this.report(reference.span, `Array type requires exactly one type argument`);
                return this.annotate(reference, UNKNOWN, null);
            }
            const elementReference = reference.typeArguments[0];
            const elementType = this.resolveTypeReference(elementReference, currentObject, true);
            const elementOwnership = elementReference.ownership ?? 'owned';
            this.validateArrayElementPolicy(elementType, elementOwnership, elementReference);
            type = `Array<${elementOwnership === 'owned' ? '' : `${elementOwnership} `}${elementType}>`;
            resolvedSymbol = {
                kind: 'ArrayType', name: 'Array', type, elementType, elementOwnership
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
        if (!arrayElement && reference.ownership !== 'owned') {
            this.report(reference.span, `'${reference.ownership}' is only valid on an Array element type`);
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
        const element = type?.startsWith('Array<') && type.endsWith('>') ? type.slice(6, -1) : null;
        return element?.startsWith('ref ') ? element.slice(4) : element?.startsWith('weak ') ? element.slice(5) : element;
    }

    arrayElementOwnership(type) {
        if (!type?.startsWith('Array<') || !type.endsWith('>')) return null;
        const element = type.slice(6, -1);
        return element.startsWith('ref ') ? 'ref' : element.startsWith('weak ') ? 'weak' : 'owned';
    }

    validateArrayElementPolicy(type, ownership, reference) {
        if (ownership === 'owned') return;
        if (!this.isReferenceType(type)) this.report(reference.span, `'${ownership}' array elements require a reference type`);
        if (ownership === 'weak' && !this.isOptionalType(type)) {
            this.report(reference.span, `Weak array elements must be optional; use 'weak ${type}?'`);
        }
    }

    consumeArrayElement(expression) {
        if (this.isOwningExpression(expression) || expression?.kind === 'CallExpression' || expression?.kind === 'NullLiteral') return;
        const source = expression?.semanticSymbol;
        if (source?.kind === 'Local' || source?.kind === 'Parameter') {
            if (source.ownership !== 'owned') {
                this.report(expression.span, `Cannot insert borrowed reference '${source.name}' into an owning array; use 'copy ${source.name}'`);
                return;
            }
            source.ownership = 'borrowed';
            expression.ownership = 'consume';
            return;
        }
        this.report(expression.span, `Owning array insertion requires an owned value; use 'copy' to create one`);
    }

    isReferenceType(type) {
        const base = this.isOptionalType(type) ? this.optionalBaseType(type) : type;
        return base === STRING || base === STRING_BUILDER || this.arrayElementType(base) !== null || this.findObjectType(base) !== null;
    }

    isOwningExpression(expression) {
        return expression?.kind === 'NewExpression' ||
            expression?.kind === 'UnaryExpression' && expression.operator === 'copy' ||
            expression?.kind === 'CallExpression' && expression.callee?.semanticSymbol?.returnOwnership === 'owned';
    }

    localOwnership(initializer, type) {
        if (!this.isOwnedReferenceType(type)) return 'value';
        return this.isOwningExpression(initializer) ? 'owned' : 'borrowed';
    }

    bindBorrow(target, expression) {
        target.borrowedFrom = null;
        const source = expression?.semanticSymbol;
        if (!source || !['Local', 'Parameter'].includes(source.kind) || this.isOwningExpression(expression)) return;
        target.borrowedFrom = source.borrowedFrom ?? source;
        target.borrowedVersion = target.borrowedFrom.ownershipVersion ?? 0;
    }

    validateBorrow(symbol, span) {
        if (symbol.ownership === 'destroyed') {
            this.report(span, `Reference '${symbol.name}' was already deleted`);
            return;
        }
        if (!symbol.borrowedFrom) return;
        if ((symbol.borrowedFrom.ownershipVersion ?? 0) !== symbol.borrowedVersion) {
            this.report(span, `Borrowed reference '${symbol.name}' outlives the value previously held by '${symbol.borrowedFrom.name}'`);
        }
    }

    isOwnedReferenceType(type) {
        const base = this.isOptionalType(type) ? this.optionalBaseType(type) : type;
        return base === STRING_BUILDER || this.arrayElementType(base) !== null || this.findObjectType(base) !== null;
    }

    transferOwnership(expression) {
        const source = expression?.semanticSymbol;
        if (!source || !['Local', 'Parameter'].includes(source.kind)) return;
        source.ownership = 'borrowed';
        expression.ownership = 'consume';
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
            if (method.parameters[i].owning) this.consumeOwnership(expressions[i], method.parameters[i]);
        }
    }

    consumeOwnership(expression, parameter) {
        if (this.isOwningExpression(expression) || expression?.kind === 'CallExpression') return;
        const source = this.ownershipSource(expression);
        if (source?.kind === 'Local' || source?.kind === 'Parameter') {
            if (source.ownership !== 'owned') {
                this.report(expression.span, `Cannot pass borrowed reference '${source.name}' to owning parameter '${parameter.name}'; use 'copy ${source.name}'`, DiagnosticSeverity.error, {
                    labels: [{span: parameter.declaration.span, message: `parameter '${parameter.name}' takes ownership`}],
                    notes: ['ordinary arguments borrow references unless ownership is transferred explicitly'],
                    fixes: [{span: expression.span, message: `create an independent owned value for '${parameter.name}'`, replacement: `copy ${source.name}`}]
                });
                return;
            }
            if (!this.isExternalResourceType(source.type) || !parameter.owner?.isNative) source.ownership = 'borrowed';
            expression.ownership = 'consume';
            return;
        }
        if (source?.kind === 'Field' && source.ownership === 'member-owned') {
            expression.ownership = 'consume';
            return;
        }
        this.report(expression.span, `Owning parameter '${parameter.name}' requires an owned value; use 'copy' to create one`);
    }

    ownershipSource(expression) {
        if (expression?.semanticSymbol) return expression.semanticSymbol;
        if (expression?.kind === 'UnwrapExpression' || expression?.kind === 'PropagateExpression') {
            return this.ownershipSource(expression.expression);
        }
        return null;
    }

    isExternalResourceType(type) {
        if (!type) return false;
        const base = this.isOptionalType(type) ? this.optionalBaseType(type) : type;
        return this.findObjectType(base)?.externalResource === true;
    }

    identifyExternalResources() {
        for (const object of this.objectSymbols.values()) {
            for (const methods of object.methodOverloads.values()) {
                for (const method of methods) {
                    if (!method.isNative) continue;
                    const base = this.isOptionalType(method.returnType) ? this.optionalBaseType(method.returnType) : method.returnType;
                    const returned = this.findObjectType(base);
                    if (returned) returned.externalResource = true;
                }
            }
        }
    }

    validateFieldInitializerCycles() {
        const state = new Map();
        const stack = [];
        const visit = object => {
            if (state.get(object) === 2) return;
            if (state.get(object) === 1) {
                const start = stack.indexOf(object);
                const cycle = [...stack.slice(start), object];
                this.report(object.declaration.span, `Unconditional field-initializer cycle: ${cycle.map(item => item.qualifiedName).join(' -> ')}`);
                return;
            }
            state.set(object, 1);
            stack.push(object);
            for (const field of object.fields.values()) {
                const dependency = this.fieldInitializerDependency(field.declaration.initializer);
                if (dependency) visit(dependency);
            }
            stack.pop();
            state.set(object, 2);
        };
        for (const object of this.objectSymbols.values()) if (object.kind === 'Object') visit(object);
    }

    fieldInitializerDependency(expression) {
        while (expression?.kind === 'ConversionExpression' || expression?.kind === 'UnwrapExpression') expression = expression.expression;
        return expression?.kind === 'NewExpression' && expression.semanticSymbol?.kind === 'Object'
            ? expression.semanticSymbol
            : null;
    }

    requireAssignable(actual, expected, span, expression = null) {
        if (this.isOptionalType(expected)) {
            const expectedBase = this.optionalBaseType(expected);
            const actualBase = this.isOptionalType(actual) ? this.optionalBaseType(actual) : actual;
            if (actual === NULL || actual === expected || actualBase === expectedBase || this.conformsTo(actualBase, expectedBase)) return;
        }
        const integerLiteral = expression?.kind === 'IntegerLiteral'
            ? expression
            : expression?.kind === 'UnaryExpression' &&
              expression.operator === '-' &&
              expression.operand.kind === 'IntegerLiteral'
                ? expression.operand
                : null;
        if (expression?.kind === 'FloatLiteral' && this.isFloat(expected)) {
            if (expected === F32 && !Number.isFinite(Math.fround(expression.value))) {
                this.report(span, `Floating literal '${expression.lexeme}' is outside the range of 'f32'`);
            } else expression.inferredType = expected;
            return;
        }
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
        if (actual !== UNKNOWN && expected !== UNKNOWN && actual !== expected && !this.conformsTo(actual, expected)) {
            this.report(span, `Cannot use value of type '${actual}' where '${expected}' is required`);
        }
    }

    isSubtype(actual, expected) {
        let object = this.findObjectType(actual);
        while (object?.base) {
            object = object.base;
            if (object.type === expected) return true;
        }
        return false;
    }

    conformsTo(actual, expected) {
        if (this.isSubtype(actual, expected)) return true;
        let object = this.findObjectType(actual);
        const contract = this.findObjectType(expected);
        while (object && contract) {
            if (object.contracts.some(candidate => this.inheritanceContains(candidate, contract))) return true;
            object = object.base;
        }
        return false;
    }

    isIntegerLiteral(expression) {
        return expression?.kind === 'IntegerLiteral' || (
            expression?.kind === 'UnaryExpression' &&
            expression.operator === '-' &&
            expression.operand.kind === 'IntegerLiteral'
        );
    }

    isFloat(type) {
        return type === F32 || type === F64;
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

    report(span, message, severity = DiagnosticSeverity.error, details = {}) {
        this.diagnostics.push(diagnostic(severity, message, span, details));
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
            diagnostics.push(diagnostic(DiagnosticSeverity.error, `Duplicate declaration '${name}'`, span));
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
        return this.lookupInheritedMember(name) ??
            this.object.objects.get(name) ??
            super.lookup(name);
    }

    lookupInheritedMember(name) {
        let object = this.object;
        while (object) {
            const field = object.fields.get(name);
            if (field && (object === this.object || field.visibility !== 'private')) return field;
            const method = object.methods.get(name);
            if (method && (object === this.object || method.visibility !== 'private') && (object === this.object || name !== '__')) return method;
            object = object.base;
        }
        return null;
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const filePath = process.argv[2];
    if (!filePath) throw new Error('Usage: node semantic.js <source-file>');
    const result = new SemanticAnalyzer().analyzeFile(filePath);
    for (const diagnostic of result.diagnostics) {
        const {source, line, column} = diagnostic.span;
        console.error(formatDiagnostic(diagnostic));
    }
    if (!result.success) process.exitCode = 1;
}
