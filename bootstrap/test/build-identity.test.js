import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {BuildIdentity} from '../build-identity.js';
import {Compiler} from '../compiler.js';
import {ModuleLoader} from '../module-loader.js';
import {resolveTarget} from '../target.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const writeProject = (root, body = 'return Helper.value()') => {
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src/main.ar'), "import Helper from './helper.ar'\nentry {{ __() -> i64 { " + body + " } }}\n");
    fs.writeFileSync(path.join(root, 'src/helper.ar'), 'library Helper {{ value() -> i64 { return 0 } }}\n');
    fs.writeFileSync(path.join(root, 'valen.project.json'), JSON.stringify({format: 1, package: {name: 'identity', version: '0.1.0'},
        executable: {source: 'src/main.ar'}, dependencies: []}, null, 2));
    fs.writeFileSync(path.join(root, 'valen.lock'), JSON.stringify({format: 1, package: {name: 'identity', version: '0.1.0'}, target: 'x86_64-linux', dependencies: []}, null, 2));
};
const identity = (root, options = {}) => {
    const graph = new ModuleLoader({sourceRoot: root, target: 'x86_64-linux'}).load(path.join(root, 'src/main.ar'));
    return BuildIdentity.create(graph, {target: resolveTarget('x86_64-linux'), optimizationLevel: 1,
        backend: 'native', linker: 'native', sourceRoot: root, ...options});
};

test('build identity is deterministic, relocatable, and sensitive to compatibility inputs', () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-identity-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-identity-b-'));
    try {
        writeProject(firstRoot); writeProject(secondRoot);
        const first = identity(firstRoot), relocated = identity(secondRoot);
        assert.equal(first.id, relocated.id);
        assert.deepEqual(first, BuildIdentity.parse(BuildIdentity.serialize(first)));
        assert.notEqual(identity(firstRoot, {optimizationLevel: 0}).id, first.id);
        assert.notEqual(identity(firstRoot, {runtimeMetrics: true}).id, first.id);
        fs.writeFileSync(path.join(firstRoot, 'src/helper.ar'), 'library Helper {{ value() -> i64 { return 1 } }}\n');
        assert.notEqual(identity(firstRoot).id, first.id);
    } finally {
        fs.rmSync(firstRoot, {recursive: true, force: true}); fs.rmSync(secondRoot, {recursive: true, force: true});
    }
});

test('compiled executable emits an inspectable adjacent build identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-identity-output-'));
    try {
        writeProject(root);
        const output = path.join(root, 'app');
        new Compiler().compile(path.join(root, 'src/main.ar'), output, {sourceRoot: root});
        const sidecar = `${output}.vbuild`;
        assert.equal(fs.existsSync(sidecar), true);
        const inspect = spawnSync(process.execPath, [path.join(projectRoot, 'bootstrap/compiler.js'), '--inspect-build', sidecar], {encoding: 'utf8'});
        assert.equal(inspect.status, 0, inspect.stderr);
        assert.deepEqual(JSON.parse(inspect.stdout), BuildIdentity.parse(fs.readFileSync(sidecar, 'utf8')));
        fs.appendFileSync(output, 'tampered');
        const tampered = spawnSync(process.execPath, [path.join(projectRoot, 'bootstrap/compiler.js'), '--inspect-build', sidecar], {encoding: 'utf8'});
        assert.notEqual(tampered.status, 0);
        assert.match(tampered.stderr, /artifact fingerprint does not match/);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('build explanations distinguish implementation changes from public interface changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-identity-explain-'));
    try {
        writeProject(root);
        const firstOutput = path.join(root, 'first');
        new Compiler().compile(path.join(root, 'src/main.ar'), firstOutput, {sourceRoot: root});

        fs.writeFileSync(path.join(root, 'src/helper.ar'), 'library Helper {{ value() -> i64 { return 1 } }}\n');
        const bodyOutput = path.join(root, 'body');
        new Compiler().compile(path.join(root, 'src/main.ar'), bodyOutput, {sourceRoot: root});
        const body = BuildIdentity.explain(BuildIdentity.inspect(`${firstOutput}.vbuild`), BuildIdentity.inspect(`${bodyOutput}.vbuild`));
        assert.equal(body.rebuild, true);
        assert.deepEqual(body.reasons, [{code: 'module-implementation-changed', impact: 'module-only', count: 1}]);

        fs.writeFileSync(path.join(root, 'src/helper.ar'), 'library Helper {{ value(extra:i64=0) -> i64 { return 1 + extra } }}\n');
        const interfaceOutput = path.join(root, 'interface');
        new Compiler().compile(path.join(root, 'src/main.ar'), interfaceOutput, {sourceRoot: root});
        const explain = spawnSync(process.execPath, [path.join(projectRoot, 'bootstrap/compiler.js'), '--explain-build',
            `${bodyOutput}.vbuild`, `${interfaceOutput}.vbuild`], {encoding: 'utf8'});
        assert.equal(explain.status, 1, explain.stderr);
        const interfaceChange = JSON.parse(explain.stdout);
        assert.equal(interfaceChange.previousArtifactReusable, false);
        assert.equal(interfaceChange.selection, 'current');
        assert.deepEqual(interfaceChange.reasons, [
            {code: 'module-interface-changed', impact: 'importers', count: 1}
        ]);

        const unchanged = spawnSync(process.execPath, [path.join(projectRoot, 'bootstrap/compiler.js'), '--explain-build',
            `${interfaceOutput}.vbuild`, `${interfaceOutput}.vbuild`], {encoding: 'utf8'});
        assert.equal(unchanged.status, 0, unchanged.stderr);
        assert.deepEqual(JSON.parse(unchanged.stdout).reasons, []);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
