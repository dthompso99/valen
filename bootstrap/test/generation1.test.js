import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../compiler.js';
import {expectedFailures, invalidPrograms, targetFailures, validPrograms} from './conformance-manifest.js';

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
        const compilerDynamic = spawnSync('readelf', ['-d', compilerPath], {encoding: 'utf8'});
        assert.equal(compilerDynamic.status, 0, compilerDynamic.stderr);
        assert.doesNotMatch(compilerDynamic.stdout, /NEEDED/, 'generation 1 unexpectedly requires a shared library');
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

        const generation2Path = path.join(directory, 'argon-generation2');
        const build = spawnSync(compilerPath, [path.join(projectRoot, 'src/argon.ar'), '-o', generation2Path], {
            encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
        });
        assert.equal(build.status, 0, build.stderr || build.stdout);

        await t.test('generation 1 and 2 produce equivalent normalized IR', async t => {
            for (const fixture of validPrograms) {
                await t.test(fixture.name, () => {
                    const sourcePath = path.join(projectRoot, fixture.source);
                    const generation1 = spawnSync(compilerPath, ['--emit-ir', sourcePath], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    const generation2 = spawnSync(generation2Path, ['--emit-ir', sourcePath], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    assert.equal(generation1.status, 0, generation1.stderr || generation1.stdout);
                    assert.equal(generation2.status, 0, generation2.stderr || generation2.stdout);
                    assert.match(generation1.stdout, /^program\|/);
                    assert.match(generation1.stdout, /^instruction\|/m);
                    assert.equal(generation2.stdout, generation1.stdout, `normalized IR differs for ${fixture.source}`);
                });
            }
        });

        await t.test('generation 1 and 2 produce equivalent invalid-program diagnostics', async t => {
            for (const fixture of invalidPrograms) {
                await t.test(fixture.name, () => {
                    const sourcePath = path.join(projectRoot, fixture.source);
                    const generation1 = spawnSync(compilerPath, ['--check', sourcePath], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    const generation2 = spawnSync(generation2Path, ['--check', sourcePath], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    assert.equal(generation1.status, fixture.status, generation1.stderr || generation1.stdout);
                    assert.equal(generation2.status, fixture.status, generation2.stderr || generation2.stdout);
                    assert.match(generation1.stderr, fixture.stderr);
                    assert.equal(generation2.stderr, generation1.stderr, `diagnostics differ for ${fixture.source}`);
                });
            }
        });

        await t.test('generation 1 and 2 reject unsupported target-native facilities', async t => {
            for (const fixture of targetFailures) {
                await t.test(fixture.name, () => {
                    const sourcePath = path.join(projectRoot, fixture.source);
                    const generation1 = spawnSync(compilerPath, [sourcePath, '-o', path.join(directory, `target-failure-1-${sequence}`)], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    const generation2 = spawnSync(generation2Path, [sourcePath, '-o', path.join(directory, `target-failure-2-${sequence++}`)], {
                        encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                    });
                    assert.equal(generation1.status, fixture.status, generation1.stderr || generation1.stdout);
                    assert.equal(generation2.status, fixture.status, generation2.stderr || generation2.stdout);
                    assert.match(generation1.stderr, fixture.stderr);
                    assert.equal(generation2.stderr, generation1.stderr, `target diagnostics differ for ${fixture.source}`);
                });
            }
        });
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
