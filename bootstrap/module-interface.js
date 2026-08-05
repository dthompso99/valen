import fs from 'node:fs';
import path from 'node:path';

export const MODULE_INTERFACE_VERSION = 2;

const hash = value => {
    let result = 1469598103934665603n;
    for (const byte of Buffer.from(value)) {
        result ^= BigInt(byte);
        result = BigInt.asUintN(64, result * 1099511628211n);
    }
    return result.toString(16).padStart(16, '0');
};

const type = reference => reference ? {
    name: reference.name,
    arguments: (reference.typeArguments ?? reference.arguments ?? []).map(type),
    optional: reference.optional === true,
    ownership: reference.ownership ?? 'owned'
} : null;

const expression = node => {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(expression);
    if (typeof node !== 'object') return node;
    const result = {};
    for (const key of Object.keys(node).sort()) {
        if (['span', 'symbol', 'semanticSymbol', 'inferredType', 'ownership'].includes(key)) continue;
        result[key] = expression(node[key]);
    }
    return result;
};

const member = declaration => {
    if (declaration.kind === 'FieldDeclaration') return {
        kind: 'field', name: declaration.name, visibility: declaration.visibility,
        reference: declaration.reference === true, weak: declaration.weakReference === true,
        type: type(declaration.fieldType)
    };
    if (declaration.kind === 'MethodDeclaration') return {
        kind: 'method', name: declaration.name, visibility: declaration.visibility,
        native: declaration.isNative === true, unsafe: declaration.isUnsafe === true,
        foreignLibrary: declaration.foreignLibrary, foreignSymbol: declaration.foreignSymbol,
        returnReference: declaration.returnReference === true, returnType: type(declaration.returnType),
        parameters: declaration.parameters.map(parameter => ({
            name: parameter.name, owning: parameter.owning === true, type: type(parameter.parameterType),
            defaultValue: expression(parameter.defaultValue)
        }))
    };
    return container(declaration);
};

const container = declaration => {
    const result = {
        kind: declaration.kind === 'LibraryDeclaration' ? 'library' : declaration.kind === 'EnumDeclaration' ? 'enum' : 'object',
        name: declaration.name,
        visibility: declaration.visibility ?? 'public',
        typeParameters: declaration.typeParameters ?? [],
        typeConstraints: (declaration.typeConstraints ?? []).map(type),
        inherits: type(declaration.inheritedType),
        implements: (declaration.implementedTypes ?? []).map(type),
        members: declaration.kind === 'EnumDeclaration'
            ? declaration.cases.map(item => ({kind: 'enum-case', name: item.name, value: item.value}))
            : declaration.members.filter(item => item.visibility !== 'private').map(member)
    };
    if (declaration.typeParameters?.length) result.template = expression(declaration);
    return result;
};

export class ModuleInterface {
    static create(module) {
        const exports = [...module.program.objects, ...module.program.libraries]
            .filter(declaration => declaration.visibility !== 'private' && !declaration.genericArguments?.length).map(container);
        const summary = JSON.stringify({version: MODULE_INTERFACE_VERSION, module: module.id, exports});
        return {
            version: MODULE_INTERFACE_VERSION,
            moduleId: module.id,
            path: module.path,
            implementationFingerprint: hash(module.source),
            interfaceFingerprint: hash(summary),
            summary,
            imports: [...module.imports].map(([name, imported]) => ({name, moduleId: imported.module.id}))
        };
    }

    static serialize(artifact, dependencyFingerprints = new Map()) {
        return JSON.stringify({...artifact,
            dependencies: artifact.imports.map(item => ({...item, fingerprint: dependencyFingerprints.get(item.moduleId) ?? null}))
        }) + '\n';
    }

    static parse(source) {
        const artifact = JSON.parse(source);
        if (artifact.version !== MODULE_INTERFACE_VERSION || typeof artifact.summary !== 'string') {
            throw new Error(`Unsupported module interface version '${artifact.version}'`);
        }
        return artifact;
    }
}

export const moduleInterfaceHash = hash;

export class ModuleInterfaceCache {
    constructor(directory, trace = false) {
        this.directory = directory;
        this.trace = trace;
    }

    prepare(graph) {
        if (!this.directory) return [];
        const artifacts = [...graph.modules.values()].map(ModuleInterface.create);
        const fingerprints = new Map(artifacts.map(artifact => [artifact.moduleId, artifact.interfaceFingerprint]));
        return artifacts.map(artifact => {
            const filePath = path.join(this.directory, `module-js-${moduleInterfaceHash(artifact.path)}.vmi`);
            const content = ModuleInterface.serialize(artifact, fingerprints);
            let status = 'miss';
            try { status = fs.readFileSync(filePath, 'utf8') === content ? 'hit' : 'changed'; } catch {}
            if (status !== 'hit') fs.writeFileSync(filePath, content);
            if (this.trace) process.stderr.write(`valen: cache interface ${status} ${filePath}\n`);
            return {artifact, path: filePath, status};
        });
    }
}
