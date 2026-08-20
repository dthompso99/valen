import fs from 'node:fs';
import path from 'node:path';
import {Compiler} from './compiler.js';
import {ProjectLock, ProjectManifest} from './project-manifest.js';

export class ProjectBuild {
    static build(manifestPath, {locked = false, target} = {}) {
        const selectedManifest = path.resolve(manifestPath);
        const root = path.dirname(selectedManifest);
        const manifest = ProjectManifest.read(selectedManifest);
        if (manifest.dependencies.length > 0) {
            throw new Error('Manifest-driven compiled dependency routing is not implemented yet');
        }
        const resolution = ProjectLock.update(selectedManifest, {locked, target});
        const lock = JSON.parse(resolution.content);
        const sourcePath = path.resolve(root, resolution.manifest.executable.source);
        const outputPath = path.resolve(root, resolution.manifest.executable.output);
        fs.mkdirSync(path.dirname(outputPath), {recursive: true});
        const result = new Compiler().compile(sourcePath, outputPath, {
            sourceRoot: root,
            optimizationLevel: resolution.manifest.executable.optimization,
            target: lock.target
        });
        return {manifest: resolution.manifest, lockPath: resolution.lockPath, outputPath, result};
    }
}
