import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ModuleLoader} from '../module-loader.js';
import {ModuleInterface} from '../module-interface.js';

const load = (directory, body) => {
    fs.writeFileSync(path.join(directory, 'library.ar'), body.library);
    fs.writeFileSync(path.join(directory, 'main.ar'), body.main);
    return new ModuleLoader({sourceRoot: directory}).load(path.join(directory, 'main.ar'));
};

test('module interfaces fingerprint API separately from implementation bodies', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-interface-'));
    try {
        const main = "import Math from './library.ar'\nentry {{ __() -> i64 { return Math.value(2) } }}\n";
        const first = load(directory, {main, library: 'library Math {{ value(input:i64) -> i64 { return input + 1 } }}\n'});
        const firstModule = [...first.modules.values()].find(module => module.path.endsWith('library.ar'));
        const firstArtifact = ModuleInterface.create(firstModule);

        const bodyChanged = load(directory, {main, library: 'library Math {{ value(input:i64) -> i64 { return input + 2 } }}\n'});
        const bodyArtifact = ModuleInterface.create([...bodyChanged.modules.values()].find(module => module.path.endsWith('library.ar')));
        assert.notEqual(bodyArtifact.implementationFingerprint, firstArtifact.implementationFingerprint);
        assert.equal(bodyArtifact.interfaceFingerprint, firstArtifact.interfaceFingerprint);

        const apiChanged = load(directory, {main, library: 'library Math {{ value(input:i32) -> i64 { return input as i64 } }}\n'});
        const apiArtifact = ModuleInterface.create([...apiChanged.modules.values()].find(module => module.path.endsWith('library.ar')));
        assert.notEqual(apiArtifact.interfaceFingerprint, firstArtifact.interfaceFingerprint);
        assert.deepEqual(ModuleInterface.parse(ModuleInterface.serialize(firstArtifact)), {...firstArtifact,
            dependencies: firstArtifact.imports.map(item => ({...item, fingerprint: null}))});
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('module interface dependencies record imported interface fingerprints', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-interface-dependency-'));
    try {
        const graph = load(directory, {
            main: "import Math from './library.ar'\nentry {{ __() -> i64 { return Math.value(2) } }}\n",
            library: 'library Math {{ value(input:i64) -> i64 { return input + 1 } }}\n'
        });
        const artifacts = [...graph.modules.values()].map(ModuleInterface.create);
        const fingerprints = new Map(artifacts.map(artifact => [artifact.moduleId, artifact.interfaceFingerprint]));
        const entry = artifacts.find(artifact => artifact.path.endsWith('main.ar'));
        const parsed = ModuleInterface.parse(ModuleInterface.serialize(entry, fingerprints));
        assert.equal(parsed.dependencies.length, 1);
        assert.equal(parsed.dependencies[0].fingerprint, fingerprints.get(parsed.dependencies[0].moduleId));
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
