import fs from 'node:fs';
import path from 'node:path';
import {Compiler} from './compiler.js';
import {ProjectLock, ProjectManifest} from './project-manifest.js';

export class ProjectBuild {
    static build(manifestPath, {locked = false, target} = {}) {
        const selectedManifest = path.resolve(manifestPath);
        const root = path.dirname(selectedManifest);
        const manifest = ProjectManifest.read(selectedManifest);
        const resolution = ProjectLock.update(selectedManifest, {locked, target});
        const lock = JSON.parse(resolution.content);
        const sourcePath = path.resolve(root, resolution.manifest.executable.source);
        const outputPath = path.resolve(root, resolution.manifest.executable.output);
        fs.mkdirSync(path.dirname(outputPath), {recursive: true});
        const compiledArtifacts = new Map();
        const libraryRoots = new Set();
        for (const dependency of resolution.manifest.dependencies) {
            if (dependency.source === null) throw new Error(`Project dependency '${dependency.name}' requires a source path for builds`);
            const dependencySource = path.resolve(root, dependency.source);
            const metadataPath = path.resolve(root, dependency.metadata);
            compiledArtifacts.set(fs.realpathSync(dependencySource), {
                objectPath: metadataPath.slice(0, -6), metadataPath, interfacePath: `${metadataPath.slice(0, -6)}.vmi`
            });
            libraryRoots.add(path.dirname(dependencySource));
        }
        const result = new Compiler().compile(sourcePath, outputPath, {
            sourceRoot: root,
            libraryPath: [...libraryRoots].join(path.delimiter),
            compiledArtifacts,
            optimizationLevel: resolution.manifest.executable.optimization,
            target: lock.target
        });
        return {manifest: resolution.manifest, lockPath: resolution.lockPath, outputPath, result};
    }
}
