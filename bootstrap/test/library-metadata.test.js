import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {LibraryMetadata} from '../library-metadata.js';

test('compiled library metadata is deterministic and validates compatibility', () => {
    const artifact = LibraryMetadata.create({name: 'Tools', version: '1.2.3-beta.1+build.7',
        interfaceFingerprint: '11', implementationFingerprint: '22', object: Buffer.from([1, 2, 3]),
        dependencies: [{name: 'System', interfaceFingerprint: '44'}]});
    const serialized = LibraryMetadata.serialize(artifact);
    assert.deepEqual(LibraryMetadata.parse(serialized, {name: 'Tools'}), artifact);
    assert.throws(() => LibraryMetadata.parse(serialized, {abi: 'valen-native-2'}), /Incompatible library abi/);
    assert.throws(() => LibraryMetadata.create({...artifact, version: '01.2.3', object: Buffer.alloc(0)}), /Invalid semantic version/);
});

test('bootstrap emits a relocatable compiled library and metadata sidecar', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-library-metadata-'));
    const object = path.join(directory, 'arithmetic.o');
    const result = spawnSync(process.execPath, [path.join(root, 'bootstrap/compiler.js'), '--library-version', '2.0.0',
        '--emit-library', path.join(root, 'bootstrap/test/fixtures/compiled-library.ar'), object],
    {encoding: 'utf8', cwd: root});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(object, null).subarray(0, 4).toString('hex'), '7f454c46');
    const metadata = LibraryMetadata.parse(fs.readFileSync(`${object}.vmeta`, 'utf8'));
    assert.equal(metadata.name, 'Arithmetic');
    assert.equal(metadata.version, '2.0.0');
    assert.deepEqual(metadata.dependencies.map(item => item.name), ['Support']);
});
