import fs from 'node:fs';
import path from 'node:path';
import {LibraryMetadata} from './library-metadata.js';
import {resolveTarget} from './target.js';

export const PROJECT_MANIFEST_VERSION = 1;
export const PROJECT_LOCK_VERSION = 1;

const semanticVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageName = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const object = (value, where) => {
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${where} must be an object`);
    return value;
};
const fields = (value, allowed, where) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${where} field '${key}'`);
};
const string = (value, where) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} must be a non-empty string`);
    return value;
};
const relativePath = (value, where) => {
    const selected = string(value, where);
    if (path.isAbsolute(selected) || selected.split(/[\\/]/).includes('..')) {
        throw new Error(`${where} must stay within the project root`);
    }
    return selected;
};
const version = (value, where) => {
    if (!semanticVersion.test(value)) throw new Error(`${where} must be a semantic version`);
    return value;
};
const portablePath = value => value.split(path.sep).join('/');

export class ProjectManifest {
    static parse(source) {
        let raw;
        try { raw = JSON.parse(source); } catch (error) { throw new Error(`Malformed Valen project manifest: ${error.message}`); }
        object(raw, 'Project manifest');
        fields(raw, ['format', 'package', 'executable', 'dependencies'], 'project manifest');
        if (raw.format !== PROJECT_MANIFEST_VERSION) throw new Error(`Unsupported project manifest version '${raw.format}'`);

        const package_ = object(raw.package, 'Project package');
        fields(package_, ['name', 'version'], 'project package');
        const name = string(package_.name, 'Project package name');
        if (!packageName.test(name)) throw new Error(`Invalid project package name '${name}'`);
        const packageVersion = version(package_.version, 'Project package version');

        const executable = object(raw.executable, 'Project executable');
        fields(executable, ['source', 'output', 'target', 'optimization'], 'project executable');
        const sourcePath = relativePath(executable.source, 'Project executable source');
        const output = executable.output === undefined ? 'build/app' : relativePath(executable.output, 'Project executable output');
        const target = executable.target === undefined ? null : resolveTarget(string(executable.target, 'Project executable target')).name;
        const optimization = executable.optimization ?? 1;
        if (optimization !== 0 && optimization !== 1) throw new Error('Project executable optimization must be 0 or 1');

        const dependencies = raw.dependencies ?? [];
        if (!Array.isArray(dependencies)) throw new Error('Project dependencies must be an array');
        const seen = new Set();
        const parsedDependencies = dependencies.map((dependency, index) => {
            object(dependency, `Project dependency ${index}`);
            fields(dependency, ['name', 'version', 'metadata'], `project dependency ${index}`);
            const dependencyName = string(dependency.name, `Project dependency ${index} name`);
            if (!packageName.test(dependencyName)) throw new Error(`Invalid project dependency name '${dependencyName}'`);
            if (seen.has(dependencyName)) throw new Error(`Duplicate project dependency '${dependencyName}'`);
            seen.add(dependencyName);
            const metadata = relativePath(dependency.metadata, `Project dependency '${dependencyName}' metadata`);
            return {name: dependencyName, version: version(dependency.version, `Project dependency '${dependencyName}' version`), metadata};
        }).sort((left, right) => left.name.localeCompare(right.name));

        return {format: PROJECT_MANIFEST_VERSION, package: {name, version: packageVersion},
            executable: {source: sourcePath, output, target, optimization}, dependencies: parsedDependencies};
    }

    static read(manifestPath) { return ProjectManifest.parse(fs.readFileSync(manifestPath, 'utf8')); }
}

export class ProjectLock {
    static resolve(manifest, manifestPath, selectedTarget) {
        const root = path.dirname(path.resolve(manifestPath));
        const target = resolveTarget(selectedTarget ?? manifest.executable.target ?? undefined);
        const dependencies = manifest.dependencies.map(dependency => {
            const metadataPath = path.resolve(root, dependency.metadata);
            const metadata = LibraryMetadata.parse(fs.readFileSync(metadataPath, 'utf8'), {
                name: dependency.name, version: dependency.version, target: target.name
            });
            const objectPath = metadataPath.endsWith('.vmeta') ? metadataPath.slice(0, -6) : null;
            if (!objectPath || !fs.existsSync(objectPath)) throw new Error(`Project dependency '${dependency.name}' object is missing`);
            const actual = LibraryMetadata.create({...metadata, object: fs.readFileSync(objectPath)}).objectFingerprint;
            if (actual !== metadata.objectFingerprint) throw new Error(`Project dependency '${dependency.name}' object fingerprint does not match metadata`);
            return {name: metadata.name, version: metadata.version, metadata: portablePath(path.relative(root, metadataPath)),
                compiler: metadata.compiler, target: metadata.target, abi: metadata.abi,
                interfaceFingerprint: metadata.interfaceFingerprint,
                implementationFingerprint: metadata.implementationFingerprint,
                objectFingerprint: metadata.objectFingerprint};
        }).sort((left, right) => left.name.localeCompare(right.name));
        return {format: PROJECT_LOCK_VERSION, package: manifest.package, target: target.name, dependencies};
    }

    static serialize(lock) { return `${JSON.stringify(lock, null, 2)}\n`; }

    static update(manifestPath, {lockPath = path.join(path.dirname(path.resolve(manifestPath)), 'valen.lock'), locked = false,
        target} = {}) {
        const manifest = ProjectManifest.read(manifestPath);
        const content = ProjectLock.serialize(ProjectLock.resolve(manifest, manifestPath, target));
        let existing = null;
        try { existing = fs.readFileSync(lockPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (locked && existing !== content) throw new Error('Valen project lockfile is missing or stale');
        if (!locked && existing !== content) fs.writeFileSync(lockPath, content);
        return {manifest, lockPath, content, changed: existing !== content};
    }
}
