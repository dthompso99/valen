import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../compiler.js';
import {expectedFailures, validPrograms} from './conformance-manifest.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('generation 1 passes the native compiler conformance suite', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'argon-generation1-'));
    const compilerPath = path.join(directory, 'argon');
    try {
        try {
            new Compiler().compile(path.join(projectRoot, 'src/argon.ar'), compilerPath, {sourceRoot: projectRoot});
        } catch (error) {
            if (error?.code === 'EPERM') {
                t.skip('process sandbox does not allow Node to spawn the system compiler');
                return;
            }
            throw error;
        }

        const environment = {...process.env, ARGON_LIBRARY_PATH: path.join(projectRoot, 'lib')};
        let sequence = 0;
        for (const fixture of validPrograms) {
            await t.test(fixture.name, () => {
                const executable = path.join(directory, `program-${sequence++}`);
                const compile = spawnSync(compilerPath, [path.join(projectRoot, fixture.source), '-o', executable], {encoding: 'utf8', env: environment, cwd: projectRoot});
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                const run = spawnSync(executable, [], {encoding: 'utf8', env: environment, cwd: projectRoot});
                assert.equal(run.status, 0, `${fixture.source}\n${run.stderr || run.stdout}`);
            });
        }
        for (const fixture of expectedFailures) {
            await t.test(fixture.name, () => {
                const executable = path.join(directory, `program-${sequence++}`);
                const compile = spawnSync(compilerPath, [path.join(projectRoot, fixture.source), '-o', executable], {encoding: 'utf8', env: environment, cwd: projectRoot});
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                const run = spawnSync(executable, [], {encoding: 'utf8', env: environment, cwd: projectRoot});
                assert.equal(run.status, fixture.status, run.stderr || run.stdout);
                assert.match(run.stderr, fixture.stderr);
            });
        }
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
