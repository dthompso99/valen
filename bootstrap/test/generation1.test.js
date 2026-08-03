import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../compiler.js';
import {compileOnlyPrograms, expectedFailures, invalidPrograms, targetFailures, validPrograms} from './conformance-manifest.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('generation 1 passes the native compiler conformance suite', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-generation1-'));
    const compilerPath = path.join(directory, 'valen');
    try {
        try {
            new Compiler().compile(path.join(projectRoot, 'src/valen.ar'), compilerPath, {sourceRoot: projectRoot});
        } catch (error) {
            if (error?.code === 'EPERM') {
                t.skip('process sandbox does not allow Node to spawn the system compiler');
                return;
            }
            throw error;
        }

        const compilerObject = spawnSync('readelf', ['-h', `${compilerPath}.o`], {encoding: 'utf8'});
        assert.equal(compilerObject.status, 0, compilerObject.stderr);
        assert.match(compilerObject.stdout, /Type:\s+REL/);

        const environment = {...process.env, VALEN_LIBRARY_PATH: path.join(projectRoot, 'lib')};
        const compilerDynamic = spawnSync('readelf', ['-d', compilerPath], {encoding: 'utf8'});
        assert.equal(compilerDynamic.status, 0, compilerDynamic.stderr);
        assert.doesNotMatch(compilerDynamic.stdout, /NEEDED/, 'generation 1 unexpectedly requires a shared library');

        await t.test('native compiler cache hits, invalidates, and preserves foreign libraries', () => {
            const cachePath = path.join(directory, 'cache');
            fs.mkdirSync(cachePath);
            const cacheEnvironment = {...environment, VALEN_CACHE_PATH: cachePath, VALEN_CACHE_TRACE: '1'};
            const sourcePath = path.join(directory, 'cached.ar');
            const writeProgram = status => fs.writeFileSync(sourcePath, `entry {{ __() -> i32 { return ${status} } }}\n`);
            const compile = (source, name) => spawnSync(compilerPath, [source, '-o', path.join(directory, name)], {
                encoding: 'utf8', env: cacheEnvironment, cwd: projectRoot
            });

            writeProgram(0);
            const cold = compile(sourcePath, 'cache-cold');
            assert.equal(cold.status, 0, cold.stderr);
            assert.match(cold.stderr, /valen: cache miss/);
            assert.match(cold.stderr, /valen: cache stored/);
            assert.equal(fs.existsSync(path.join(directory, 'cache-cold.o')), true, 'native compiler did not emit a relocatable object');
            assert.equal(fs.existsSync(path.join(directory, 'cache-cold.s')), false, 'native compiler unexpectedly fell back to assembly');

            const warm = compile(sourcePath, 'cache-warm');
            assert.equal(warm.status, 0, warm.stderr);
            assert.match(warm.stderr, /valen: cache hit/);
            assert.equal(spawnSync(path.join(directory, 'cache-warm')).status, 0);

            const [cacheEntry] = fs.readdirSync(cachePath);
            fs.writeFileSync(path.join(cachePath, cacheEntry), 'not a Valen cache artifact');
            const recovered = compile(sourcePath, 'cache-recovered');
            assert.equal(recovered.status, 0, recovered.stderr);
            assert.match(recovered.stderr, /valen: cache invalid/);
            assert.match(recovered.stderr, /valen: cache stored/);
            assert.equal(spawnSync(path.join(directory, 'cache-recovered')).status, 0);

            writeProgram(7);
            const changed = compile(sourcePath, 'cache-changed');
            assert.equal(changed.status, 0, changed.stderr);
            assert.match(changed.stderr, /valen: cache miss/);
            assert.equal(spawnSync(path.join(directory, 'cache-changed')).status, 7);

            const foreignSource = path.join(projectRoot, 'bootstrap/test/fixtures/foreign-libc.ar');
            const foreignCold = compile(foreignSource, 'cache-foreign-cold');
            assert.equal(foreignCold.status, 0, foreignCold.stderr);
            const foreignWarm = compile(foreignSource, 'cache-foreign-warm');
            assert.equal(foreignWarm.status, 0, foreignWarm.stderr);
            assert.match(foreignWarm.stderr, /valen: cache hit/);
            assert.equal(spawnSync(path.join(directory, 'cache-foreign-warm')).status, 0);
        });

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

        const generation2Path = path.join(directory, 'valen-generation2');
        const build = spawnSync(compilerPath, [path.join(projectRoot, 'src/valen.ar'), '-o', generation2Path], {
            encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
        });
        assert.equal(build.status, 0, build.stderr || build.stdout || `generation 2 build terminated by ${build.signal ?? 'an unknown signal'}`);
        assert.equal(fs.existsSync(`${generation2Path}.o`), true, 'generation 2 was not built from a native object');
        assert.equal(fs.existsSync(`${generation2Path}.s`), false, 'generation 2 unexpectedly required an assembler');

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

        await t.test('generation 1 and 2 build standalone native services', async t => {
            for (const fixture of compileOnlyPrograms) {
                await t.test(fixture.name, () => {
                    const sourcePath = path.join(projectRoot, fixture.source);
                    for (const [generation, compiler] of [[1, compilerPath], [2, generation2Path]]) {
                        const executable = path.join(directory, `service-${generation}-${sequence++}`);
                        const compile = spawnSync(compiler, [sourcePath, '-o', executable], {
                            encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
                        });
                        assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                        const dynamic = spawnSync('readelf', ['-d', executable], {encoding: 'utf8'});
                        assert.equal(dynamic.status, 0, dynamic.stderr);
                        assert.doesNotMatch(dynamic.stdout, /NEEDED/, `${fixture.source} unexpectedly requires a shared library`);
                    }
                });
            }
        });
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
