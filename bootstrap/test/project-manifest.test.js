import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {LibraryMetadata} from '../library-metadata.js';
import {ProjectLock, ProjectManifest} from '../project-manifest.js';

const writeDependency = (root, name, version, contents) => {
    const objectPath = path.join(root, `${name}.o`);
    const metadataPath = `${objectPath}.vmeta`;
    fs.writeFileSync(objectPath, contents);
    const metadata = LibraryMetadata.create({name, version, interfaceFingerprint: `${name}-interface`,
        implementationFingerprint: `${name}-implementation`, object: contents, target: 'x86_64-linux'});
    fs.writeFileSync(metadataPath, LibraryMetadata.serialize(metadata));
    return path.basename(metadataPath);
};

test('project manifests validate and normalize their deterministic schema', () => {
    const parsed = ProjectManifest.parse(JSON.stringify({format: 1, package: {name: 'sample-app', version: '1.2.3'},
        executable: {source: 'src/main.ar'}, dependencies: [
            {name: 'Zulu', version: '2.0.0', metadata: 'deps/Zulu.o.vmeta'},
            {name: 'Alpha', version: '1.0.0', metadata: 'deps/Alpha.o.vmeta'}
        ]}));
    assert.equal(parsed.executable.output, 'build/app');
    assert.equal(parsed.executable.optimization, 1);
    assert.deepEqual(parsed.dependencies.map(item => item.name), ['Alpha', 'Zulu']);
    assert.throws(() => ProjectManifest.parse(JSON.stringify({...parsed, typo: true})), /Unknown project manifest field 'typo'/);
    assert.throws(() => ProjectManifest.parse(JSON.stringify({format: 1, package: parsed.package,
        executable: {source: parsed.executable.source}, dependencies: [parsed.dependencies[0], parsed.dependencies[0]]})),
        /Duplicate project dependency 'Alpha'/);
});

test('project lockfiles resolve exact local artifacts deterministically and support locked mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-project-'));
    try {
        const zulu = writeDependency(root, 'Zulu', '2.0.0', Buffer.from('zulu-object'));
        const alpha = writeDependency(root, 'Alpha', '1.0.0', Buffer.from('alpha-object'));
        const manifestPath = path.join(root, 'valen.project.json');
        fs.writeFileSync(manifestPath, JSON.stringify({format: 1, package: {name: 'sample', version: '0.1.0'},
            executable: {source: 'src/main.ar', target: 'amd64-linux', optimization: 0}, dependencies: [
                {name: 'Zulu', version: '2.0.0', metadata: zulu},
                {name: 'Alpha', version: '1.0.0', metadata: alpha}
            ]}, null, 2));

        const first = ProjectLock.update(manifestPath);
        assert.equal(first.changed, true);
        const second = ProjectLock.update(manifestPath);
        assert.equal(second.changed, false);
        const lock = JSON.parse(second.content);
        assert.equal(lock.target, 'x86_64-linux');
        assert.deepEqual(lock.dependencies.map(item => item.name), ['Alpha', 'Zulu']);
        assert.equal(ProjectLock.update(manifestPath, {locked: true}).changed, false);

        fs.appendFileSync(path.join(root, 'Alpha.o'), 'changed');
        assert.throws(() => ProjectLock.update(manifestPath, {locked: true}), /object fingerprint does not match metadata/);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
