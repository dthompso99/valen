import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

test('self-hosted toolchain packages and statically consumes the installed standard library', {timeout: 30000}, () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-stdlib-package-'));
    try {
        const compiler = path.join(directory, 'valen');
        let result = spawnSync(process.execPath, [path.join(root, 'bootstrap/compiler.js'), path.join(root, 'src/valen.ar'), compiler],
            {cwd: root, encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
        const libraryRoot = path.join(directory, 'lib/valen');
        result = spawnSync(process.execPath, [path.join(root, 'scripts/package-stdlib.mjs'), '--compiler', compiler, '--output', libraryRoot],
            {cwd: root, encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
        const sysroot = path.join(libraryRoot, 'current/x86_64-linux');
        const executable = path.join(directory, 'consumer');
        result = spawnSync(compiler, [path.join(root, 'bootstrap/test/fixtures/installed-stdlib.ar'), '-o', executable],
            {cwd: root, encoding: 'utf8', env: {...process.env, VALEN_SYSROOT: sysroot, VALEN_LIBRARY_PATH: ''}});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(spawnSync(executable).status, 0);
        assert.equal(spawnSync('readelf', ['-d', executable], {encoding: 'utf8'}).stdout.includes('NEEDED'), false);
        for (const kind of ['source', 'objects', 'metadata', 'interfaces']) {
            assert.equal(fs.existsSync(path.join(sysroot, kind, 'std')), true, `missing ${kind}`);
        }
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
