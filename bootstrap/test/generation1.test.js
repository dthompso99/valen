import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../compiler.js';
import {compileOnlyPrograms, expectedFailures, invalidPrograms, targetFailures, validPrograms} from './conformance-manifest.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const exchange = request => new Promise((resolve, reject) => {
    const socket = net.createConnection({host: '127.0.0.1', port: 18080});
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP service response timed out')));
    socket.once('connect', () => socket.end(request));
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
});

async function runHttpService(executable, environment, statePath, requests) {
    assert.equal(requests.length, 4, 'the deterministic service test requires exactly four requests');
    const child = spawn(executable, [], {
        cwd: projectRoot,
        env: {...environment, VALEN_SERVICE_NAME: 'conformance', VALEN_STATE_PATH: statePath}
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', (status, signal) => resolve({status, signal})));
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`HTTP service did not become ready\n${stderr || stdout}`)), 3000);
            const inspect = () => {
                if (!stdout.includes('valen-http: ready')) return;
                clearTimeout(timeout);
                resolve();
            };
            child.stdout.on('data', inspect);
            child.once('exit', status => {
                if (!stdout.includes('valen-http: ready')) {
                    clearTimeout(timeout);
                    reject(new Error(`HTTP service exited before readiness with status ${status}\n${stderr || stdout}`));
                }
            });
            inspect();
        });

        const responses = [];
        for (const request of requests) responses.push(await exchange(request));

        const result = await exited;
        assert.equal(result.status, 0, stderr || stdout || `HTTP service terminated by ${result.signal}`);
        return responses;
    } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
}

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
                await t.test(fixture.name, async () => {
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
                        if (fixture.live) {
                            const statePath = path.join(directory, `state-${generation}`);
                            const get = target => `GET ${target} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
                            const put = value => `PUT /value HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${value.length}\r\n\r\n${value}`;

                            const initial = await runHttpService(executable, environment, statePath, [
                                get('/health'), get('/config'), get('/value'), put('42')
                            ]);
                            assert.match(initial[0], /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok\n$/);
                            assert.match(initial[1], /\r\n\r\nservice=conformance\n$/);
                            assert.match(initial[2], /\r\n\r\n0\n$/);
                            assert.match(initial[3], /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n42\n$/);
                            assert.equal(fs.readFileSync(statePath, 'utf8'), '42\n');

                            const restarted = await runHttpService(executable, environment, statePath, [
                                get('/value'), put('invalid'), get('/missing'), put('-7')
                            ]);
                            assert.match(restarted[0], /\r\n\r\n42\n$/);
                            assert.match(restarted[1], /^HTTP\/1\.1 400 Bad Request\r\n[\s\S]*\r\n\r\ninvalid value\n$/);
                            assert.match(restarted[2], /^HTTP\/1\.1 404 Not Found\r\n[\s\S]*\r\n\r\nnot found\n$/);
                            assert.match(restarted[3], /\r\n\r\n-7\n$/);
                            assert.equal(fs.readFileSync(statePath, 'utf8'), '-7\n');

                            const verified = await runHttpService(executable, environment, statePath, [
                                get('/value'), 'not http', get('/missing'), get('/health')
                            ]);
                            assert.match(verified[0], /\r\n\r\n-7\n$/);
                            assert.match(verified[1], /^HTTP\/1\.1 400 Bad Request\r\n[\s\S]*\r\n\r\nbad request\n$/);
                            assert.match(verified[2], /^HTTP\/1\.1 404 Not Found\r\n/);
                            assert.match(verified[3], /\r\n\r\nok\n$/);

                            fs.writeFileSync(statePath, 'not an integer\n');
                            const corrupt = spawnSync(executable, [], {
                                encoding: 'utf8', cwd: projectRoot,
                                env: {...environment, VALEN_SERVICE_NAME: 'conformance', VALEN_STATE_PATH: statePath}
                            });
                            assert.equal(corrupt.status, 78, corrupt.stderr || corrupt.stdout);
                            assert.match(corrupt.stderr, /invalid or unreadable state/);
                        }
                    }
                });
            }
        });
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
