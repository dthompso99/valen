import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {BuildIdentity} from '../build-identity.js';
import {Compiler} from '../compiler.js';
import {LibraryMetadata} from '../library-metadata.js';
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

async function runHttpService(executable, environment, statePath, requests, phase = 'request sequence') {
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
                if (!stdout.includes('ready on http://')) return;
                clearTimeout(timeout);
                resolve();
            };
            child.stdout.on('data', inspect);
            child.once('exit', status => {
                if (!stdout.includes('ready on http://')) {
                    clearTimeout(timeout);
                    reject(new Error(`HTTP service exited before readiness with status ${status}\n${stderr || stdout}`));
                }
            });
            inspect();
        });

        const responses = [];
        for (let index = 0; index < requests.length; index++) {
            try {
                responses.push(await exchange(requests[index]));
            } catch (error) {
                const result = await Promise.race([
                    exited,
                    new Promise(resolve => setTimeout(() => resolve(null), 50))
                ]);
                const processState = result == null
                    ? 'service still running'
                    : `service exited with status ${result.status}, signal ${result.signal}`;
                throw new Error(`${phase}, request ${index + 1}: ${error.message}; ${processState}\n${stderr || stdout}`, {cause: error});
            }
        }

        const result = await exited;
        assert.equal(result.status, 0, stderr || stdout || `HTTP service terminated by ${result.signal}`);
        return responses;
    } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
}

async function runConcurrentHttpService(executable, environment, statePath) {
    const child = spawn(executable, [], {
        cwd: projectRoot,
        env: {...environment, VALEN_SERVICE_NAME: 'conformance', VALEN_STATE_PATH: statePath, VALEN_REQUEST_LIMIT: '6'}
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', (status, signal) => resolve({status, signal})));
    let slow = null;
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`concurrent HTTP service did not become ready\n${stderr || stdout}`)), 3000);
            const inspect = () => {
                if (!stdout.includes('ready on http://')) return;
                clearTimeout(timeout);
                resolve();
            };
            child.stdout.on('data', inspect);
            child.once('exit', status => {
                if (!stdout.includes('ready on http://')) {
                    clearTimeout(timeout);
                    reject(new Error(`concurrent HTTP service exited before readiness with status ${status}\n${stderr || stdout}`));
                }
            });
            inspect();
        });

        const checkedExchange = async (phase, request) => {
            try {
                return await exchange(request);
            } catch (error) {
                const result = await Promise.race([
                    exited,
                    new Promise(resolve => setTimeout(() => resolve(null), 50))
                ]);
                const processState = result == null
                    ? 'service still running'
                    : `service exited with status ${result.status}, signal ${result.signal}`;
                throw new Error(`concurrent HTTP ${phase}: ${error.message}; ${processState}\n${stderr || stdout}`, {cause: error});
            }
        };

        slow = net.createConnection({host: '127.0.0.1', port: 18080});
        await new Promise((resolve, reject) => {
            slow.once('connect', () => { slow.write('GET /health HTTP/1.1\r\nHost: slow'); resolve(); });
            slow.once('error', error => reject(new Error(`concurrent HTTP slow connection: ${error.message}`, {cause: error})));
        });
        const slowClosed = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('slow client was not timed out')), 2000);
            slow.once('close', () => { clearTimeout(timeout); resolve(); });
            slow.once('error', error => { clearTimeout(timeout); reject(error); });
        });

        const healthy = await checkedExchange('health request', 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
        assert.match(healthy, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok\n$/);

        const disconnected = net.createConnection({host: '127.0.0.1', port: 18080});
        await new Promise((resolve, reject) => {
            disconnected.once('connect', () => { disconnected.destroy(); resolve(); });
            disconnected.once('error', error => reject(new Error(`concurrent HTTP disconnected client: ${error.message}`, {cause: error})));
        });

        const oversized = await checkedExchange('oversized request', `GET /health HTTP/1.1\r\nX-Fill: ${'x'.repeat(5000)}\r\n\r\n`);
        assert.match(oversized, /^HTTP\/1\.1 413 Content Too Large\r\n/);
        assert.match(await checkedExchange('value request', 'GET /value HTTP/1.1\r\nHost: localhost\r\n\r\n'), /\r\n\r\n0\n$/);
        await slowClosed;
        assert.match(await checkedExchange('final health request', 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n'), /\r\n\r\nok\n$/);

        const result = await exited;
        assert.equal(result.status, 0, stderr || stdout || `concurrent HTTP service terminated by ${result.signal}`);
    } finally {
        slow?.destroy();
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }
}

test('generation 1 passes the native compiler conformance suite', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-generation1-'));
    const compilerPath = path.join(directory, 'valen');
    try {
        try {
            new Compiler().compile(path.join(projectRoot, 'src/valen.ar'), compilerPath,
                {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
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
        const nativeLibraryPath = path.join(directory, 'native');
        const adapter = spawnSync(path.join(projectRoot, 'scripts/build-sqlite-adapter.sh'), [nativeLibraryPath], {
            encoding: 'utf8', cwd: projectRoot
        });
        assert.equal(adapter.status, 0, adapter.stderr || adapter.stdout);
        const adapterDynamic = spawnSync('readelf', ['-d', path.join(nativeLibraryPath, 'libvalen_sqlite_adapter.so')], {encoding: 'utf8'});
        assert.equal(adapterDynamic.status, 0, adapterDynamic.stderr);
        assert.match(adapterDynamic.stdout, /NEEDED.*libsqlite3\.so/);
        environment.LIBRARY_PATH = nativeLibraryPath;
        environment.LD_LIBRARY_PATH = nativeLibraryPath;
        const compilerDynamic = spawnSync('readelf', ['-d', compilerPath], {encoding: 'utf8'});
        assert.equal(compilerDynamic.status, 0, compilerDynamic.stderr);
        assert.doesNotMatch(compilerDynamic.stdout, /NEEDED/, 'generation 1 unexpectedly requires a shared library');

        await t.test('native compiler normalizes and validates explicit targets', () => {
            const source = path.join(projectRoot, 'bootstrap/test/fixtures/runtime-foundation.ar');
            const defaultEnvironment = {...environment};
            delete defaultEnvironment.VALEN_TARGET;
            const defaulted = spawnSync(compilerPath,
                ['--emit-object', source, '-o', path.join(directory, 'default-output.o')],
                {encoding: 'utf8', env: defaultEnvironment, cwd: projectRoot});
            assert.equal(defaulted.status, 0, defaulted.stderr);
            const hostMachine = process.arch === 'arm64' ? 183 : 62;
            assert.equal(fs.readFileSync(path.join(directory, 'default-output.o')).readUInt16LE(18), hostMachine);

            const configured = spawnSync(compilerPath,
                ['--emit-object', source, '-o', path.join(directory, 'configured-output.o')],
                {encoding: 'utf8', env: {...defaultEnvironment, VALEN_TARGET: 'arm64-linux'}, cwd: projectRoot});
            assert.equal(configured.status, 0, configured.stderr);
            assert.equal(fs.readFileSync(path.join(directory, 'configured-output.o')).readUInt16LE(18), 183);

            const recognized = spawnSync(compilerPath,
                ['--target', 'arm64-linux', source, '-o', path.join(directory, 'arm64-output')],
                {encoding: 'utf8', env: {...environment, VALEN_TARGET: 'x86_64-linux'}, cwd: projectRoot});
            assert.equal(recognized.status, 0, recognized.stderr);
            assert.equal(fs.readFileSync(path.join(directory, 'arm64-output')).readUInt16LE(18), 183);

            const unsupported = spawnSync(compilerPath,
                ['--target', 'mips-linux', source, '-o', path.join(directory, 'mips-output')],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(unsupported.status, 64);
            assert.match(unsupported.stderr, /supported targets: x86_64-linux, aarch64-linux/);
        });

        await t.test('LLVM backend emits relocatable objects', t => {
            if (!fs.existsSync('/usr/bin/clang')) {
                t.skip('LLVM object emission requires /usr/bin/clang');
                return;
            }
            const source = path.join(projectRoot, 'bootstrap/test/fixtures/runtime-foundation.ar');
            const object = path.join(directory, 'llvm-output.o');
            const emitted = spawnSync(compilerPath,
                ['--backend', 'llvm', '--emit-object', source, '-o', object],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(emitted.status, 0, emitted.stderr);
            const header = spawnSync('readelf', ['-h', object], {encoding: 'utf8'});
            assert.equal(header.status, 0, header.stderr);
            assert.match(header.stdout, /Type:\s+REL/);
            assert.match(header.stdout, /Machine:\s+Advanced Micro Devices X86-64/);

            const sysroot = path.join(directory, 'llvm-object-sysroot');
            const sourceRoot = path.join(sysroot, 'source');
            const objects = path.join(sysroot, 'objects');
            const metadata = path.join(sysroot, 'metadata');
            const interfaces = path.join(sysroot, 'interfaces');
            for (const path of [sourceRoot, objects, metadata, interfaces]) fs.mkdirSync(path, {recursive: true});
            const supportSource = path.join(sourceRoot, 'Support.ar');
            const supportObject = path.join(objects, 'Support.o');
            fs.writeFileSync(supportSource, 'library Support {{ value() -> i64 { return 7 } }}\n');
            const library = spawnSync(compilerPath,
                ['--source-root', sourceRoot, '--library-version', '1.0.0', '--emit-library', supportSource, '-o', supportObject],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(library.status, 0, library.stderr);
            fs.copyFileSync(`${supportObject}.vmeta`, path.join(metadata, 'Support.o.vmeta'));
            fs.copyFileSync(`${supportObject}.vmi`, path.join(interfaces, 'Support.vmi'));
            const objectProjectRoot = path.join(directory, 'llvm-object-project');
            fs.mkdirSync(objectProjectRoot);
            const main = path.join(objectProjectRoot, 'main.ar');
            fs.writeFileSync(main, "import Support from 'Support.ar'\nentry {{ __() -> i64 { return Support.value() } }}\n");
            const importedObject = path.join(objectProjectRoot, 'main.o');
            const imported = spawnSync(compilerPath,
                ['--source-root', objectProjectRoot, '--backend', 'llvm', '--emit-object', main, '-o', importedObject],
                {encoding: 'utf8', env: {...environment, VALEN_SYSROOT: sysroot, VALEN_LIBRARY_PATH: sourceRoot}, cwd: projectRoot});
            assert.equal(imported.status, 0, imported.stderr);
            const importedIr = fs.readFileSync(`${importedObject}.ll`, 'utf8');
            const supportSymbol = 'valen_fn_83_117_112_112_111_114_116_46_118_97_108_117_101';
            assert.match(importedIr, new RegExp(`declare i64 @"${supportSymbol}"\\(\\)`));
            assert.doesNotMatch(importedIr, new RegExp(`define i64 @"${supportSymbol}"\\(`));
            const symbols = spawnSync('readelf', ['-Ws', importedObject], {encoding: 'utf8'});
            assert.equal(symbols.status, 0, symbols.stderr);
            assert.match(symbols.stdout, new RegExp(`UND ${supportSymbol}$`, 'm'));

            const llvmLibraryObject = path.join(directory, 'Support-llvm.o');
            const llvmLibrary = spawnSync(compilerPath,
                ['--source-root', sourceRoot, '--backend', 'llvm', '--library-version', '1.0.0', '--emit-library', supportSource, '-o', llvmLibraryObject],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(llvmLibrary.status, 0, llvmLibrary.stderr);
            for (const artifact of [llvmLibraryObject, `${llvmLibraryObject}.vmi`, `${llvmLibraryObject}.vmeta`]) {
                assert.equal(fs.existsSync(artifact), true, `LLVM library did not emit ${artifact}`);
            }
            const validated = spawnSync(compilerPath, ['--validate-library', `${llvmLibraryObject}.vmeta`],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(validated.status, 0, validated.stderr);
            assert.equal(validated.stdout, 'Support 1.0.0\n');

            const llvmConsumer = path.join(objectProjectRoot, 'llvm-consumer');
            const llvmLinked = spawnSync(compilerPath,
                ['--source-root', objectProjectRoot, '--backend', 'llvm', main, '-o', llvmConsumer],
                {encoding: 'utf8', env: {...environment, VALEN_SYSROOT: sysroot, VALEN_LIBRARY_PATH: sourceRoot}, cwd: projectRoot});
            assert.equal(llvmLinked.status, 0, llvmLinked.stderr);
            assert.equal(spawnSync(llvmConsumer).status, 7, 'LLVM executable did not consume the native compiled library');

            fs.copyFileSync(llvmLibraryObject, path.join(objects, 'Support.o'));
            fs.copyFileSync(`${llvmLibraryObject}.vmeta`, path.join(metadata, 'Support.o.vmeta'));
            fs.copyFileSync(`${llvmLibraryObject}.vmi`, path.join(interfaces, 'Support.vmi'));
            const nativeConsumer = path.join(objectProjectRoot, 'native-consumer');
            const nativeLinked = spawnSync(compilerPath,
                ['--source-root', objectProjectRoot, main, '-o', nativeConsumer],
                {encoding: 'utf8', env: {...environment, VALEN_SYSROOT: sysroot, VALEN_LIBRARY_PATH: sourceRoot}, cwd: projectRoot});
            assert.equal(nativeLinked.status, 0, nativeLinked.stderr);
            assert.equal(spawnSync(nativeConsumer).status, 7, 'native executable did not consume the LLVM compiled library');

            const recordsSource = path.join(sourceRoot, 'Records.ar');
            fs.writeFileSync(recordsSource, 'library Records {{ Child {{ member value:i64; __(value:i64) -> void { self.value = value }; get() -> i64 { return self.value } }}; Record {{ member child:Child; member label:string; member score:f64; __(child:Child, label:string, score:f64) -> void { self.child = child; self.label = label; self.score = score }; get() -> i64 { return self.child.get() }; name() -> string { return self.label } }}; WeakHolder {{ member weak child:Child?; watch(value:Child) -> void { self.child = value }; expired() -> bool { return self.child == null } }}; create(value:i64) -> Record { return new Record(new Child(value), "record", 1.5) }; weakExpires(value:i64) -> bool { local child = new Child(value); local holder = new WeakHolder(); holder.watch(child); delete child; return holder.expired() } }}\n');
            const recordsObject = path.join(objects, 'Records.o');
            const recordsLibrary = spawnSync(compilerPath,
                ['--source-root', sourceRoot, '--backend', 'llvm', '--library-version', '1.0.0', '--emit-library', recordsSource, '-o', recordsObject],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(recordsLibrary.status, 0, recordsLibrary.stderr);
            fs.copyFileSync(`${recordsObject}.vmeta`, path.join(metadata, 'Records.o.vmeta'));
            fs.copyFileSync(`${recordsObject}.vmi`, path.join(interfaces, 'Records.vmi'));
            const recordsMain = path.join(objectProjectRoot, 'records-main.ar');
            fs.writeFileSync(recordsMain, "import Records from 'Records.ar'\nentry {{ __() -> i64 { local value = Records.create(7); if value.name() == \"record\" && Records.weakExpires(1) { return value.get() }; return 1 } }}\n");
            const recordsConsumer = path.join(objectProjectRoot, 'records-consumer');
            const recordsLinked = spawnSync(compilerPath,
                ['--source-root', objectProjectRoot, recordsMain, '-o', recordsConsumer],
                {encoding: 'utf8', env: {...environment, VALEN_SYSROOT: sysroot, VALEN_LIBRARY_PATH: sourceRoot}, cwd: projectRoot});
            assert.equal(recordsLinked.status, 0, recordsLinked.stderr);
            assert.equal(spawnSync(recordsConsumer).status, 7, 'native executable did not consume LLVM object metadata');

            const ownedSource = path.join(sourceRoot, 'OwnedArray.ar');
            fs.writeFileSync(ownedSource, 'library OwnedArray {{ Holder {{ member values:Array<i64>; __(values:Array<i64>) -> void { self.values = values } }} }}\n');
            const ownedLibrary = spawnSync(compilerPath,
                ['--source-root', sourceRoot, '--backend', 'llvm', '--library-version', '1.0.0', '--emit-library', ownedSource, '-o', path.join(directory, 'OwnedReference.o')],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(ownedLibrary.status, 0, ownedLibrary.stderr);
        });

        await t.test('native compiler parses and validates project manifests', () => {
            const manifest = path.join(directory, 'valen.project.json');
            fs.writeFileSync(manifest, JSON.stringify({format: 1, package: {name: 'native-app', version: '0.1.0'},
                executable: {source: 'src/main.ar'}, dependencies: []}));
            const valid = spawnSync(compilerPath, ['--validate-project', manifest], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(valid.status, 0, valid.stderr);
            assert.equal(valid.stdout, 'native-app 0.1.0 src/main.ar\n');
            const lock = path.join(directory, 'valen.lock');
            fs.writeFileSync(lock, JSON.stringify({format: 1, package: {name: 'native-app', version: '0.1.0'},
                target: process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux', dependencies: []}));
            const locked = spawnSync(compilerPath, ['--validate-project', '--locked', manifest, lock],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(locked.status, 0, locked.stderr);
            const originalLock = fs.readFileSync(lock, 'utf8');
            fs.writeFileSync(lock, originalLock.replace('0.1.0', '0.2.0'));
            const stale = spawnSync(compilerPath, ['--validate-project', '--locked', manifest, lock],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(stale.status, 65);
            assert.match(stale.stderr, /lockfile is stale/);
            assert.equal(fs.readFileSync(lock, 'utf8'), originalLock.replace('0.1.0', '0.2.0'));
            fs.writeFileSync(manifest, JSON.stringify({format: 1, package: {name: 'native-app', version: '0.1.0'},
                executable: {source: '../main.ar'}, dependencies: []}));
            const invalid = spawnSync(compilerPath, ['--validate-project', manifest], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(invalid.status, 65);
            assert.match(invalid.stderr, /must stay within the project root/);
        });

        await t.test('compiled libraries carry validated version and ABI metadata', () => {
            const source = path.join(projectRoot, 'bootstrap/test/fixtures/compiled-library.ar');
            const object = path.join(directory, 'arithmetic-library.o');
            const emitted = spawnSync(compilerPath,
                ['--library-version', '1.2.3-beta.1+build.7', '--emit-library', source, '-o', object],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
            assert.equal(spawnSync('readelf', ['-h', object], {encoding: 'utf8'}).status, 0);
            const metadataPath = `${object}.vmeta`;
            const metadata = fs.readFileSync(metadataPath, 'utf8');
            assert.match(metadata, /^VALEN-LIBRARY-1\n/);
            assert.match(metadata, /name=Arithmetic\nversion=1\.2\.3-beta\.1\+build\.7\n/);
            assert.match(metadata, /dependency=Support\|[-0-9]+\n/);
            const valid = spawnSync(compilerPath, ['--validate-library', metadataPath], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(valid.status, 0, valid.stderr);
            assert.equal(valid.stdout, 'Arithmetic 1.2.3-beta.1+build.7\n');
            const objectBytes = fs.readFileSync(object);
            fs.writeFileSync(object, Buffer.concat([objectBytes, Buffer.from([0])]));
            const mismatched = spawnSync(compilerPath, ['--validate-library', metadataPath], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(mismatched.status, 65);
            assert.match(mismatched.stderr, /object fingerprint does not match/);
            fs.writeFileSync(object, objectBytes);
            fs.writeFileSync(metadataPath, metadata.replace('abi=valen-native-1', 'abi=valen-native-2'));
            const incompatible = spawnSync(compilerPath, ['--validate-library', metadataPath], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(incompatible.status, 65);
            assert.match(incompatible.stderr, /Incompatible library ABI/);
            const invalidVersion = spawnSync(compilerPath,
                ['--library-version', '01.2.3', '--emit-library', source, '-o', path.join(directory, 'invalid-library.o')],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(invalidVersion.status, 64);
            assert.match(invalidVersion.stderr, /Invalid semantic version/);
        });

        await t.test('native frozen projects verify exact dependency artifacts', () => {
            const source = path.join(directory, 'Support.ar');
            const object = path.join(directory, 'Support.o');
            fs.writeFileSync(source, 'library Support {{ value() -> i64 { return 7 } }}\n');
            const emitted = spawnSync(compilerPath,
                ['--source-root', directory, '--library-version', '1.0.0', '--emit-library', source, '-o', object],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(emitted.status, 0, emitted.stderr);
            const metadata = LibraryMetadata.parse(fs.readFileSync(`${object}.vmeta`, 'utf8'));
            const main = path.join(directory, 'artifact-main.ar');
            fs.writeFileSync(main, "import Support from 'Support.ar'\nentry {{ __() -> i64 { return Support.value() } }}\n");
            const manifestPath = path.join(directory, 'artifact-project.json');
            const lockPath = path.join(directory, 'artifact-project.lock');
            fs.writeFileSync(manifestPath, JSON.stringify({format: 1, package: {name: 'artifact-app', version: '0.1.0'},
                executable: {source: 'artifact-main.ar', output: 'artifact-app'}, dependencies: [
                    {name: 'Support', version: '1.0.0', source: 'Support.ar', metadata: 'Support.o.vmeta'}
                ]}));
            fs.writeFileSync(lockPath, JSON.stringify({format: 1, package: {name: 'artifact-app', version: '0.1.0'},
                target: metadata.target, dependencies: [{name: metadata.name, version: metadata.version,
                    source: 'Support.ar', metadata: 'Support.o.vmeta', compiler: metadata.compiler,
                    target: metadata.target, abi: metadata.abi, interfaceFingerprint: metadata.interfaceFingerprint,
                    implementationFingerprint: metadata.implementationFingerprint, objectFingerprint: metadata.objectFingerprint}]}));
            const verify = () => spawnSync(compilerPath,
                ['--validate-project', '--locked', manifestPath, lockPath], {encoding: 'utf8', env: environment, cwd: projectRoot});
            const verified = verify();
            assert.equal(verified.status, 0, verified.stderr);
            const built = spawnSync(compilerPath, ['--build-project', manifestPath, lockPath],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(built.status, 0, built.stderr);
            assert.equal(spawnSync(path.join(directory, 'artifact-app')).status, 7);
            const identity = BuildIdentity.inspect(path.join(directory, 'artifact-app.vbuild'));
            assert.notEqual(identity.projectFingerprint, null);
            assert.notEqual(identity.lockFingerprint, null);
            const objectBytes = fs.readFileSync(object);
            fs.writeFileSync(object, Buffer.concat([objectBytes, Buffer.from([0])]));
            const tamperedObject = verify();
            assert.equal(tamperedObject.status, 65);
            assert.match(tamperedObject.stderr, /object fingerprint does not match/);
            fs.writeFileSync(object, objectBytes);
            fs.appendFileSync(`${object}.vmi`, 'tampered');
            const tamperedInterface = verify();
            assert.equal(tamperedInterface.status, 65);
            assert.match(tamperedInterface.stderr, /interface fingerprint does not match/);
        });

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

            const interfaceEntries = fs.readdirSync(cachePath).filter(name => name.endsWith('.vmi'));
            assert.ok(interfaceEntries.length > 0, 'native compiler did not emit module interface artifacts');
            const cacheEntry = fs.readdirSync(cachePath).find(name => name.endsWith('.cache'));
            assert.ok(cacheEntry, 'native compiler did not emit a backend cache artifact');
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

            const chunkRoot = path.join(directory, 'chunked');
            fs.mkdirSync(chunkRoot);
            const librarySource = path.join(chunkRoot, 'math.ar');
            const stableSource = path.join(chunkRoot, 'stable.ar');
            const entrySource = path.join(chunkRoot, 'main.ar');
            fs.writeFileSync(entrySource, "import Math from './math.ar'\nimport Stable from './stable.ar'\nentry {{ __() -> i64 { return Math.value() + Stable.zero() } }}\n");
            fs.writeFileSync(librarySource, 'library Math {{ value() -> i64 { return 1 } }}\n');
            fs.writeFileSync(stableSource, 'library Stable {{ zero() -> i64 { return 0 } }}\n');
            const compileChunk = name => spawnSync(compilerPath,
                ['--source-root', chunkRoot, entrySource, '-o', path.join(directory, name)],
                {encoding: 'utf8', env: cacheEnvironment, cwd: projectRoot});
            const chunkCold = compileChunk('chunk-cold');
            assert.equal(chunkCold.status, 0, chunkCold.stderr);
            assert.match(chunkCold.stderr, /cache module miss/);
            fs.writeFileSync(librarySource, 'library Math {{ value() -> i64 { return 2 } }}\n');
            const chunkChanged = compileChunk('chunk-changed');
            assert.equal(chunkChanged.status, 0, chunkChanged.stderr);
            assert.match(chunkChanged.stderr, /cache interface changed/);
            assert.match(chunkChanged.stderr, /cache module hit/);
            assert.match(chunkChanged.stderr, /cache module miss/);
            assert.equal(spawnSync(path.join(directory, 'chunk-changed')).status, 2);

            const largeRoot = path.join(directory, 'large-modules');
            fs.mkdirSync(largeRoot);
            const moduleCount = 48;
            for (let index = 0; index < moduleCount; index += 1) {
                const imported = index === 0 ? '' : `import Module${index - 1} from './module-${index - 1}.ar'\n`;
                const value = index === 0 ? '1' : `Module${index - 1}.value() + 1`;
                fs.writeFileSync(path.join(largeRoot, `module-${index}.ar`),
                    `${imported}library Module${index} {{ value() -> i64 { return ${value} } }}\n`);
            }
            const largeEntry = path.join(largeRoot, 'main.ar');
            fs.writeFileSync(largeEntry,
                `import Module${moduleCount - 1} from './module-${moduleCount - 1}.ar'\nentry {{ __() -> i64 { return Module${moduleCount - 1}.value() } }}\n`);
            const largeOutput = path.join(directory, 'large-module-program');
            const bounded = spawnSync('bash', ['-c', 'ulimit -v 786432; exec "$@"', 'valen-bounded', compilerPath,
                '--source-root', largeRoot, largeEntry, '-o', largeOutput], {encoding: 'utf8', env: cacheEnvironment, cwd: projectRoot});
            assert.equal(bounded.status, 0, bounded.stderr || bounded.stdout);
            assert.equal(spawnSync(largeOutput).status, moduleCount);
        });

        await t.test('native optimization flags preserve behavior and reject unsupported levels', () => {
            const source = path.join(projectRoot, 'bootstrap/test/fixtures/instruction-selection.ar');
            for (const level of ['-O0', '-O1']) {
                const executable = path.join(directory, `optimization-${level.slice(2)}`);
                const compile = spawnSync(compilerPath, [level, source, '-o', executable], {
                    encoding: 'utf8', env: environment, cwd: projectRoot
                });
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                assert.equal(spawnSync(executable).status, 0);
            }
            const unsupported = spawnSync(compilerPath, ['-O2', source], {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(unsupported.status, 64);
            assert.match(unsupported.stderr, /unsupported optimization level '-O2'/);

            const optimizerSource = path.join(projectRoot, 'bootstrap/test/fixtures/optimizer-runtime.ar');
            for (const level of ['-O0', '-O1']) {
                const executable = path.join(directory, `optimizer-runtime-${level.slice(2)}`);
                const compile = spawnSync(compilerPath, [level, optimizerSource, '-o', executable], {
                    encoding: 'utf8', env: environment, cwd: projectRoot
                });
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                assert.equal(spawnSync(executable).status, 0);
            }
            const emitted = spawnSync(compilerPath, ['-O1', optimizerSource], {
                encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 16 * 1024 * 1024
            });
            assert.equal(emitted.status, 0, emitted.stderr);
            const constructor = emitted.stdout.match(/\.globl (valen_fn_[^\n]+)\n\1:\n[\s\S]*?\1__return:/)?.[0];
            assert.ok(constructor, 'could not isolate optimized entry constructor');
            assert.match(constructor, /mov rcx, 2351776136887273513\n    imul rcx/);
            assert.match(constructor, /cmp rax, 1000\n    jl .*__while_body_/);
            assert.doesNotMatch(constructor, /idiv rcx/);
            assert.doesNotMatch(constructor, /call valen_gc_safepoint/);
        });

        await t.test('native module resolution separates project and external library roots', () => {
            const fixtureRoot = path.join(projectRoot, 'bootstrap/test/fixtures/library-path');
            const moduleEnvironment = {...environment, VALEN_LIBRARY_PATH: path.join(fixtureRoot, 'lib')};
            const executable = path.join(directory, 'library-path');
            const compile = spawnSync(compilerPath, ['--source-root', path.join(fixtureRoot, 'app'), 'main.ar', '-o', executable], {
                encoding: 'utf8', env: moduleEnvironment, cwd: projectRoot
            });
            assert.equal(compile.status, 0, compile.stderr || compile.stdout);
            assert.equal(spawnSync(executable).status, 0, 'bare import resolved to the project-local shadow instead of VALEN_LIBRARY_PATH');

            const escaped = spawnSync(compilerPath, ['--source-root', path.join(fixtureRoot, 'app'), 'escape.ar'], {
                encoding: 'utf8', env: moduleEnvironment, cwd: projectRoot
            });
            assert.equal(escaped.status, 65);
            assert.match(escaped.stderr, /escapes its owning root/);
        });

        await t.test('command-line examples process files with native and LLVM output', async t => {
            const input = path.join(directory, 'example-input.txt');
            fs.writeFileSync(input, 'alpha beta\ngamma\n');
            const listingRoot = path.join(directory, 'example-listing');
            fs.mkdirSync(listingRoot);
            fs.writeFileSync(path.join(listingRoot, 'zeta'), '');
            fs.writeFileSync(path.join(listingRoot, 'alpha'), '');
            fs.mkdirSync(path.join(listingRoot, 'middle'));
            fs.symlinkSync('alpha', path.join(listingRoot, 'link'));
            const emptyListingRoot = path.join(directory, 'empty-listing');
            fs.mkdirSync(emptyListingRoot);
            const missingListingRoot = path.join(directory, 'missing-listing');
            const backends = [{name: 'native', arguments: []}];
            if (fs.existsSync('/usr/bin/clang')) backends.push({name: 'llvm', arguments: ['--backend', 'llvm']});
            for (const backend of backends) {
                await t.test(backend.name, () => {
                    const cat = path.join(directory, `example-cat-${backend.name}`);
                    const catCompile = spawnSync(compilerPath,
                        [...backend.arguments, path.join(projectRoot, 'examples/cat/cat.ar'), '-o', cat],
                        {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(catCompile.status, 0, catCompile.stderr || catCompile.stdout);
                    const catRun = spawnSync(cat, [input], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(catRun.status, 0, catRun.stderr);
                    assert.equal(catRun.stdout, 'alpha beta\ngamma\n');

                    const wc = path.join(directory, `example-wc-${backend.name}`);
                    const wcCompile = spawnSync(compilerPath,
                        [...backend.arguments, path.join(projectRoot, 'examples/wc/wc.ar'), '-o', wc],
                        {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(wcCompile.status, 0, wcCompile.stderr || wcCompile.stdout);
                    const wcRun = spawnSync(wc, [input], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(wcRun.status, 0, wcRun.stderr);
                    assert.equal(wcRun.stdout, `2 3 17 ${input}\n`);

                    const ls = path.join(directory, `example-ls-${backend.name}`);
                    const lsCompile = spawnSync(compilerPath,
                        [...backend.arguments, path.join(projectRoot, 'examples/ls/ls.ar'), '-o', ls],
                        {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(lsCompile.status, 0, lsCompile.stderr || lsCompile.stdout);
                    const lsRun = spawnSync(ls, [listingRoot], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(lsRun.status, 0, lsRun.stderr);
                    assert.equal(lsRun.stdout, 'alpha\nlink@\nmiddle/\nzeta\n');
                    const lsFileRun = spawnSync(ls, [input], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(lsFileRun.status, 1, lsFileRun.stderr);
                    assert.match(lsFileRun.stderr, /OS error 20/);
                    const lsEmptyRun = spawnSync(ls, [emptyListingRoot], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(lsEmptyRun.status, 0, lsEmptyRun.stderr);
                    assert.equal(lsEmptyRun.stdout, '');
                    const lsMissingRun = spawnSync(ls, [missingListingRoot], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(lsMissingRun.status, 1, lsMissingRun.stderr);
                    assert.match(lsMissingRun.stderr, /OS error 2/);

                    const jsonInput = path.join(directory, 'example-input.json');
                    fs.writeFileSync(jsonInput, ' { "name": "Valen", "values": [3, 2, 1] } \n');
                    const json = path.join(directory, `example-json-${backend.name}`);
                    const jsonCompile = spawnSync(compilerPath,
                        [...backend.arguments, path.join(projectRoot, 'examples/json-format/json-format.ar'), '-o', json],
                        {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(jsonCompile.status, 0, jsonCompile.stderr || jsonCompile.stdout);
                    const jsonRun = spawnSync(json, [jsonInput], {encoding: 'utf8', env: environment, cwd: projectRoot});
                    assert.equal(jsonRun.status, 0, jsonRun.stderr);
                    assert.equal(jsonRun.stdout, '{"name":"Valen","values":[3,2,1]}\n');

                    for (const example of [
                        {name: 'primes', output: 'primes through 10000: 1229\n'},
                        {name: 'tree-sum', output: 'tree nodes: 2047\n'}
                    ]) {
                        const executable = path.join(directory, `example-${example.name}-${backend.name}`);
                        const compile = spawnSync(compilerPath,
                            [...backend.arguments, path.join(projectRoot, `examples/${example.name}/${example.name}.ar`), '-o', executable],
                            {encoding: 'utf8', env: environment, cwd: projectRoot});
                        assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                        const run = spawnSync(executable, [], {encoding: 'utf8', env: environment, cwd: projectRoot});
                        assert.equal(run.status, 0, run.stderr);
                        assert.equal(run.stdout, example.output);
                    }
                });
            }
        });

        let sequence = 0;
        for (const fixture of validPrograms) {
            await t.test(fixture.name, () => {
                const executable = path.join(directory, `program-${sequence++}`);
                const compile = spawnSync(compilerPath, [...(fixture.compilerArguments ?? []), path.join(projectRoot, fixture.source), '-o', executable], {encoding: 'utf8', env: environment, cwd: projectRoot});
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

        await t.test('optional LLVM x86-64 backend matches representative native behavior', async t => {
            if (!fs.existsSync('/usr/bin/clang')) {
                t.skip('LLVM backend conformance requires /usr/bin/clang');
                return;
            }
            const llvmPrograms = [
                'examples/simple/simple.ar',
                'bootstrap/test/fixtures/for-loops.ar',
                'bootstrap/test/fixtures/floating-point.ar',
                'bootstrap/test/fixtures/array-slices.ar',
                'bootstrap/test/fixtures/unicode-strings.ar',
                'bootstrap/test/fixtures/inheritance.ar',
                'bootstrap/test/fixtures/contract-references.ar',
                'bootstrap/test/fixtures/method-named-hash.ar',
                'bootstrap/test/fixtures/optional-primitives.ar',
                'bootstrap/test/fixtures/collection-ownership.ar',
                'bootstrap/test/fixtures/garbage-collection.ar',
                'bootstrap/test/fixtures/threading.ar',
                'bootstrap/test/fixtures/native-tests.ar',
                'bootstrap/test/fixtures/foreign-libc.ar'
            ];
            for (const [index, source] of llvmPrograms.entries()) {
                await t.test(source, () => {
                    const executable = path.join(directory, `llvm-${index}`);
                    const compile = spawnSync(compilerPath,
                        ['--backend', 'llvm', '--target', 'x86_64-linux', path.join(projectRoot, source), '-O1', '-o', executable],
                        {encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024});
                    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                    const llvm = fs.readFileSync(`${executable}.ll`, 'utf8');
                    assert.match(llvm, /^target datalayout = /);
                    assert.match(llvm, /^target triple = "x86_64-unknown-linux-gnu"$/m);
                    assert.match(llvm, /^define /m);
                    const run = spawnSync(executable, [], {encoding: 'utf8', env: environment, cwd: projectRoot, timeout: 15000});
                    assert.equal(run.status, 0, `${source}\n${run.stderr || run.stdout || run.signal}`);
                });
            }

            for (const level of ['-O0', '-O1']) {
                const executable = path.join(directory, `llvm-${level.slice(1)}`);
                const compile = spawnSync(compilerPath,
                    ['--backend', 'llvm', '--target', 'x86_64-linux', level, path.join(projectRoot, 'bootstrap/test/fixtures/instruction-selection.ar'), '-o', executable],
                    {encoding: 'utf8', env: environment, cwd: projectRoot});
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                assert.equal(spawnSync(executable, [], {encoding: 'utf8', env: environment, cwd: projectRoot}).status, 0);
            }

            const llvmCompiler = path.join(directory, 'valen-llvm-selfhost');
            const selfhost = spawnSync(compilerPath,
                ['--backend', 'llvm', '--target', 'x86_64-linux', '-O1', path.join(projectRoot, 'src/valen.ar'), '-o', llvmCompiler],
                {encoding: 'utf8', env: environment, cwd: projectRoot, timeout: 60000, maxBuffer: 64 * 1024 * 1024});
            assert.equal(selfhost.status, 0, selfhost.stderr || selfhost.stdout || selfhost.signal);
            const selfhostProgram = path.join(directory, 'llvm-selfhost-simple');
            const selfhostCompile = spawnSync(llvmCompiler,
                [path.join(projectRoot, 'examples/simple/simple.ar'), '-o', selfhostProgram],
                {encoding: 'utf8', env: environment, cwd: projectRoot, timeout: 30000, maxBuffer: 64 * 1024 * 1024});
            assert.equal(selfhostCompile.status, 0, selfhostCompile.stderr || selfhostCompile.stdout || selfhostCompile.signal);
            assert.equal(spawnSync(selfhostProgram, [], {encoding: 'utf8', env: environment, cwd: projectRoot}).status, 0);
            const selfhostCollections = path.join(directory, 'llvm-selfhost-collections');
            const selfhostCollectionsCompile = spawnSync(llvmCompiler,
                [path.join(projectRoot, 'bootstrap/test/fixtures/stdlib-collections.ar'), '-o', selfhostCollections],
                {encoding: 'utf8', env: environment, cwd: projectRoot, timeout: 30000, maxBuffer: 64 * 1024 * 1024});
            assert.equal(selfhostCollectionsCompile.status, 0,
                selfhostCollectionsCompile.stderr || selfhostCollectionsCompile.stdout || selfhostCollectionsCompile.signal);
            assert.equal(spawnSync(selfhostCollections, [], {encoding: 'utf8', env: environment, cwd: projectRoot}).status, 0);

            const unsupportedTarget = spawnSync(compilerPath,
                ['--backend', 'llvm', '--target', 'aarch64-linux', path.join(projectRoot, 'examples/simple/simple.ar'), '-o', path.join(directory, 'llvm-aarch64')],
                {encoding: 'utf8', env: environment, cwd: projectRoot});
            assert.equal(unsupportedTarget.status, 64);
            assert.match(unsupportedTarget.stderr, /LLVM backend currently supports only x86_64-linux/);
        });

        const generation2Path = path.join(directory, 'valen-generation2');
        const build = spawnSync(compilerPath, [path.join(projectRoot, 'src/valen.ar'), '-o', generation2Path], {
            encoding: 'utf8', env: environment, cwd: projectRoot, maxBuffer: 64 * 1024 * 1024
        });
        assert.equal(build.status, 0, build.stderr || build.stdout || `generation 2 build terminated by ${build.signal ?? 'an unknown signal'}`);
        assert.equal(fs.existsSync(`${generation2Path}.o`), true, 'generation 2 was not built from a native object');
        assert.equal(fs.existsSync(`${generation2Path}.s`), false, 'generation 2 unexpectedly required an assembler');

        await t.test('native compilers emit inspectable deterministic build identities', () => {
            const sourcePath = path.join(projectRoot, 'bootstrap/test/fixtures/runtime-foundation.ar');
            const identities = [];
            for (const [generation, compiler] of [[1, compilerPath], [2, generation2Path]]) {
                const executable = path.join(directory, `identity-${generation}`);
                const compile = spawnSync(compiler, [sourcePath, '-o', executable], {
                    encoding: 'utf8', env: environment, cwd: projectRoot
                });
                assert.equal(compile.status, 0, compile.stderr || compile.stdout);
                const sidecar = `${executable}.vbuild`;
                assert.equal(fs.existsSync(sidecar), true);
                const identity = BuildIdentity.inspect(sidecar);
                assert.equal(identity.backend, 'native');
                assert.equal(identity.linker, 'native');
                identities.push(identity);
            }
            assert.equal(identities[1].id, identities[0].id);
            assert.equal(identities[1].artifactFingerprint, identities[0].artifactFingerprint);
        });

        await t.test('native compilers emit deterministic newline-delimited JSON diagnostics', () => {
            const sourcePath = path.join(projectRoot, invalidPrograms.find(fixture => fixture.name === 'multiple semantic errors').source);
            const generation1 = spawnSync(compilerPath, ['--diagnostic-format', 'json', '--check', sourcePath], {
                encoding: 'utf8', env: environment, cwd: projectRoot
            });
            const generation2 = spawnSync(generation2Path, ['--diagnostic-format', 'json', '--check', sourcePath], {
                encoding: 'utf8', env: environment, cwd: projectRoot
            });
            assert.equal(generation1.status, 65, generation1.stderr || generation1.stdout);
            assert.equal(generation2.status, 65, generation2.stderr || generation2.stdout);
            assert.equal(generation2.stderr, generation1.stderr);
            const diagnostics = generation1.stderr.trim().split('\n').map(line => JSON.parse(line));
            assert.ok(diagnostics.length > 1);
            for (const diagnostic of diagnostics) {
                assert.equal(diagnostic.severity, 'error');
                assert.equal(typeof diagnostic.message, 'string');
                assert.equal(typeof diagnostic.span.path, 'string');
                assert.equal(typeof diagnostic.span.start, 'number');
                assert.equal(typeof diagnostic.span.end, 'number');
                assert.equal(typeof diagnostic.span.line, 'number');
                assert.equal(typeof diagnostic.span.column, 'number');
                assert.ok(Array.isArray(diagnostic.labels));
                assert.ok(Array.isArray(diagnostic.notes));
                assert.ok(Array.isArray(diagnostic.fixes));
            }
        });

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
                        if (fixture.foreignDependency) {
                            assert.match(dynamic.stdout, new RegExp(`NEEDED.*${fixture.foreignDependency.replaceAll('.', '\\.')}`));
                        } else {
                            assert.doesNotMatch(dynamic.stdout, /NEEDED/, `${fixture.source} unexpectedly requires a shared library`);
                        }
                        if (fixture.live === 'file') {
                            const statePath = path.join(directory, `state-${generation}`);
                            const get = target => `GET ${target} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
                            const put = value => `PUT /value HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${value.length}\r\n\r\n${value}`;

                            const initial = await runHttpService(executable, environment, statePath, [
                                get('/'), get('/health'), get('/config'), put('42')
                            ], `generation ${generation} initial HTTP run`);
                            assert.match(initial[0], /^HTTP\/1\.1 200 OK\r\nContent-Type: text\/html; charset=utf-8\r\n[\s\S]*<h1>Valen<\/h1>[\s\S]*$/);
                            assert.match(initial[1], /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok\n$/);
                            assert.match(initial[2], /\r\n\r\nservice=conformance\n$/);
                            assert.match(initial[3], /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n42\n$/);
                            assert.equal(fs.readFileSync(statePath, 'utf8'), '42\n');

                            const restarted = await runHttpService(executable, environment, statePath, [
                                get('/value'), put('invalid'), get('/missing'), put('-7')
                            ], `generation ${generation} restarted HTTP run`);
                            assert.match(restarted[0], /\r\n\r\n42\n$/);
                            assert.match(restarted[1], /^HTTP\/1\.1 400 Bad Request\r\n[\s\S]*\r\n\r\ninvalid value\n$/);
                            assert.match(restarted[2], /^HTTP\/1\.1 404 Not Found\r\n[\s\S]*\r\n\r\nnot found\n$/);
                            assert.match(restarted[3], /\r\n\r\n-7\n$/);
                            assert.equal(fs.readFileSync(statePath, 'utf8'), '-7\n');

                            const verified = await runHttpService(executable, environment, statePath, [
                                get('/value'), 'not http', get('/missing'), get('/health.json')
                            ], `generation ${generation} verification HTTP run`);
                            assert.match(verified[0], /\r\n\r\n-7\n$/);
                            assert.match(verified[1], /^HTTP\/1\.1 400 Bad Request\r\n[\s\S]*\r\n\r\nbad request\n$/);
                            assert.match(verified[2], /^HTTP\/1\.1 404 Not Found\r\n/);
                            assert.match(verified[3], /^HTTP\/1\.1 200 OK\r\nContent-Type: application\/json\r\n[\s\S]*\r\n\r\n{"status":"ok","service":"conformance"}\n$/);

                            fs.writeFileSync(statePath, 'not an integer\n');
                            const corrupt = spawnSync(executable, [], {
                                encoding: 'utf8', cwd: projectRoot,
                                env: {...environment, VALEN_SERVICE_NAME: 'conformance', VALEN_STATE_PATH: statePath}
                            });
                            assert.equal(corrupt.status, 78, corrupt.stderr || corrupt.stdout);
                            assert.match(corrupt.stderr, /invalid or unreadable state/);
                            fs.rmSync(statePath, {force: true});
                            await runConcurrentHttpService(executable, environment, statePath);
                        }
                        if (fixture.live === 'sqlite') {
                            const databasePath = path.join(directory, `database-${generation}.sqlite`);
                            const sqliteEnvironment = {...environment, VALEN_DATABASE_PATH: databasePath};
                            const get = target => `GET ${target} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
                            const put = value => `PUT /value HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${value.length}\r\n\r\n${value}`;

                            const initial = await runHttpService(executable, sqliteEnvironment, databasePath, [
                                get('/health'), get('/config'), get('/value'), put('99')
                            ]);
                            assert.match(initial[0], /\r\n\r\nok\n$/);
                            assert.match(initial[1], /\r\n\r\nservice=conformance\n$/);
                            assert.match(initial[2], /\r\n\r\n0\n$/);
                            assert.match(initial[3], /\r\n\r\n99\n$/);
                            assert.equal(fs.existsSync(databasePath), true);

                            const restarted = await runHttpService(executable, sqliteEnvironment, databasePath, [
                                get('/value'), put('-11'), get('/missing'), get('/health')
                            ]);
                            assert.match(restarted[0], /\r\n\r\n99\n$/);
                            assert.match(restarted[1], /\r\n\r\n-11\n$/);
                            assert.match(restarted[2], /^HTTP\/1\.1 404 Not Found\r\n/);
                            assert.match(restarted[3], /\r\n\r\nok\n$/);

                            fs.writeFileSync(databasePath, 'not a sqlite database');
                            const corrupt = spawnSync(executable, [], {
                                encoding: 'utf8', cwd: projectRoot,
                                env: {...sqliteEnvironment, VALEN_REQUEST_LIMIT: '1'}
                            });
                            assert.equal(corrupt.status, 78, corrupt.stderr || corrupt.stdout);
                            assert.match(corrupt.stderr, /database initialization failed; SQLite error/);
                            assert.match(corrupt.stderr, /not a database/i);

                            fs.rmSync(databasePath, {force: true});
                            await runConcurrentHttpService(executable, sqliteEnvironment, databasePath);
                        }
                    }
                });
            }
        });
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
