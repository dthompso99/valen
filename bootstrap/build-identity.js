import fs from 'node:fs';
import path from 'node:path';
import {VALEN_COMPILER_INTERFACE} from './library-metadata.js';
import {ModuleInterface, moduleInterfaceHash} from './module-interface.js';
import {ProjectManifest} from './project-manifest.js';

export const BUILD_IDENTITY_VERSION = 1;

const fingerprintFile = (filePath, normalize = source => source) => {
    try { return moduleInterfaceHash(normalize(fs.readFileSync(filePath, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export class BuildIdentity {
    static create(graph, {target, optimizationLevel, backend = 'native', linker, runtimeMetrics = false, sourceRoot,
        foreignLibraries = [], artifact = null} = {}) {
        const modules = [...graph.modules.values()].map(module => {
            const artifact = ModuleInterface.create(module);
            return {module: module.id, implementationFingerprint: artifact.implementationFingerprint,
                interfaceFingerprint: artifact.interfaceFingerprint,
                dependencies: artifact.imports.map(item => item.name).sort()};
        }).sort((left, right) => left.interfaceFingerprint.localeCompare(right.interfaceFingerprint) ||
            left.implementationFingerprint.localeCompare(right.implementationFingerprint));
        const root = path.resolve(sourceRoot ?? path.dirname(graph.entry.path));
        const inputs = {compilerInterface: VALEN_COMPILER_INTERFACE, target: target.name, abi: target.abi,
            optimization: optimizationLevel, backend, linker, runtimeMetrics,
            foreignLibraries: [...foreignLibraries].sort(), artifactFingerprint: artifact === null ? null : moduleInterfaceHash(artifact),
            entryInterface: ModuleInterface.create(graph.entry).interfaceFingerprint,
            projectFingerprint: fingerprintFile(path.join(root, 'valen.project.json'), source => JSON.stringify(ProjectManifest.parse(source))),
            lockFingerprint: fingerprintFile(path.join(root, 'valen.lock'), source => JSON.stringify(JSON.parse(source))), modules};
        const identified = {format: BUILD_IDENTITY_VERSION, ...inputs};
        return {format: BUILD_IDENTITY_VERSION, id: moduleInterfaceHash(JSON.stringify(identified)), ...inputs};
    }

    static serialize(identity) { return `${JSON.stringify(identity, null, 2)}\n`; }

    static parse(source) {
        const identity = JSON.parse(source);
        if (identity.format !== BUILD_IDENTITY_VERSION || typeof identity.id !== 'string') throw new Error('Unsupported or malformed Valen build identity');
        const {id, ...withoutId} = identity;
        if (moduleInterfaceHash(JSON.stringify(withoutId)) !== id) throw new Error('Valen build identity fingerprint does not match its inputs');
        return identity;
    }

    static inspect(sidecarPath) {
        const identity = BuildIdentity.parse(fs.readFileSync(sidecarPath, 'utf8'));
        const artifactPath = sidecarPath.endsWith('.vbuild') ? sidecarPath.slice(0, -7) : null;
        if (!artifactPath || !fs.existsSync(artifactPath)) throw new Error('Valen build identity artifact is missing');
        if (moduleInterfaceHash(fs.readFileSync(artifactPath)) !== identity.artifactFingerprint) {
            throw new Error('Valen build identity artifact fingerprint does not match');
        }
        return identity;
    }

    static explain(previous, current) {
        const reasons = [];
        const changed = (field, code, impact = 'artifact') => {
            if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) reasons.push({code, impact});
        };
        changed('compilerInterface', 'compiler-interface-changed');
        changed('target', 'target-changed');
        changed('abi', 'abi-changed');
        changed('optimization', 'optimization-changed');
        changed('backend', 'backend-changed');
        changed('linker', 'linker-changed');
        changed('runtimeMetrics', 'instrumentation-changed');
        changed('foreignLibraries', 'foreign-libraries-changed');
        changed('projectFingerprint', 'project-changed');
        changed('lockFingerprint', 'lock-changed');
        changed('entryInterface', 'entry-interface-changed', 'importers');

        const moduleKey = module => module.module ?? module.interfaceFingerprint;
        const previousModules = new Map(previous.modules.map(module => [moduleKey(module), module]));
        const currentModules = new Map(current.modules.map(module => [moduleKey(module), module]));
        let implementationChanges = 0;
        let interfaceChanges = 0;
        let dependencyChanges = 0;
        for (const [key, module] of currentModules) {
            const old = previousModules.get(key);
            if (!old) continue;
            if (old.interfaceFingerprint !== module.interfaceFingerprint) interfaceChanges++;
            else if (old.implementationFingerprint !== module.implementationFingerprint) implementationChanges++;
            if (JSON.stringify(old.dependencies) !== JSON.stringify(module.dependencies)) dependencyChanges++;
        }
        if (implementationChanges) reasons.push({code: 'module-implementation-changed', impact: 'module-only', count: implementationChanges});
        if (interfaceChanges) reasons.push({code: 'module-interface-changed', impact: 'importers', count: interfaceChanges});
        if (dependencyChanges) reasons.push({code: 'module-dependencies-changed', impact: 'importers', count: dependencyChanges});
        const removedModules = [...previousModules.keys()].filter(item => !currentModules.has(item)).length;
        const addedModules = [...currentModules.keys()].filter(item => !previousModules.has(item)).length;
        if (removedModules || addedModules) reasons.push({code: 'module-graph-changed', impact: 'importers', removed: removedModules, added: addedModules});

        const rebuild = reasons.length > 0;
        return {format: 1, previousBuild: previous.id, currentBuild: current.id, rebuild,
            previousArtifactReusable: !rebuild, selection: rebuild ? 'current' : 'previous', reasons};
    }

    static write(outputPath, identity) { fs.writeFileSync(`${outputPath}.vbuild`, BuildIdentity.serialize(identity)); }
}
