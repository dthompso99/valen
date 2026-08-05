import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {LibraryMetadata} from '../library-metadata.js';
import {Compiler} from '../compiler.js';

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

test('compiler resolves verified static libraries from an installed sysroot', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-static-sysroot-'));
    const sysroot = path.join(directory, 'sysroot');
    const source = path.join(sysroot, 'source', 'std');
    const objects = path.join(sysroot, 'objects', 'std');
    const metadata = path.join(sysroot, 'metadata', 'std');
    const interfaces = path.join(sysroot, 'interfaces', 'std');
    for (const item of [source, objects, metadata, interfaces]) fs.mkdirSync(item, {recursive: true});
    fs.writeFileSync(path.join(source, 'support.ar'), 'library Support {{ identity(value:i64) -> i64 { return value } }}\n');
    fs.writeFileSync(path.join(source, 'arithmetic.ar'),
        "import Support from './support.ar'\nlibrary Arithmetic {{ add(left:i64, right:i64) -> i64 { return Support.identity(left + right) } }}\n");
    const install = name => {
        const object = path.join(objects, `${name}.o`);
        new Compiler().emitLibrary(path.join(source, `${name}.ar`), object, '1.0.0', {sourceRoot: path.join(sysroot, 'source')});
        fs.renameSync(`${object}.vmeta`, path.join(metadata, `${name}.o.vmeta`));
        fs.renameSync(`${object}.vmi`, path.join(interfaces, `${name}.vmi`));
    };
    install('support');
    install('arithmetic');
    const application = path.join(directory, 'main.ar');
    const executable = path.join(directory, 'app');
    fs.writeFileSync(application,
        "import Arithmetic from 'std/arithmetic.ar'\nentry {{ __() -> i64 { return Arithmetic.add(20, 22) - 42 } }}\n");
    const previous = process.env.VALEN_SYSROOT;
    process.env.VALEN_SYSROOT = sysroot;
    try {
        const result = new Compiler().compile(application, executable, {sourceRoot: directory});
        assert.equal(result.graph.modules.get(path.join(source, 'arithmetic.ar')).compiledArtifact.metadata.version, '1.0.0');
        assert.equal(spawnSync(executable).status, 0);
        assert.equal(spawnSync('readelf', ['-d', executable], {encoding: 'utf8'}).stdout.includes('NEEDED'), false);
        fs.appendFileSync(path.join(objects, 'arithmetic.o'), Buffer.from([0]));
        assert.throws(() => new Compiler().compile(application, executable, {sourceRoot: directory}),
            /semantic errors|fingerprint does not match/);
    } finally {
        if (previous === undefined) delete process.env.VALEN_SYSROOT;
        else process.env.VALEN_SYSROOT = previous;
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
