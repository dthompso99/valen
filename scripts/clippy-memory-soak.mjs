#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const compilerAt = args.indexOf('--compiler'), backendAt = args.indexOf('--backend'), cyclesAt = args.indexOf('--cycles');
const healthAt = args.indexOf('--health'), websocketsAt = args.indexOf('--websockets');
const requestPathAt = args.indexOf('--request-path');
const compiler = path.resolve(compilerAt < 0 ? path.join(root, 'bootstrap/compiler.js') : args[compilerAt + 1]);
const backend = backendAt < 0 ? 'native' : args[backendAt + 1];
const cycles = cyclesAt < 0 ? 6 : Number(args[cyclesAt + 1]);
const healthRequests = healthAt < 0 ? 50 : Number(args[healthAt + 1]);
const websockets = websocketsAt < 0 ? 20 : Number(args[websocketsAt + 1]);
const requestPath = requestPathAt < 0 ? '/health' : args[requestPathAt + 1];
const includeSamples = args.includes('--samples');
const validWebsocket = !args.includes('--invalid-websocket');
const request = (port, target) => new Promise((resolve, reject) => {
    const value = http.get({host: '127.0.0.1', port, path: target}, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
        response.on('error', error => reject(new Error(`HTTP ${target}: ${error.message}`, {cause: error})));
        response.on('end', () => response.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    value.on('error', error => reject(new Error(`HTTP ${target}: ${error.message}`, {cause: error})));
});
const websocketChurn = port => new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1'); let input = ''; let complete = false;
    socket.once('error', error => { if (!complete) reject(new Error(`WebSocket handshake: ${error.message}`, {cause: error})); });
    socket.on('data', chunk => { input += chunk.toString('latin1'); if (input.includes('\r\n\r\n')) { complete = true; socket.destroy(); resolve(); } });
    socket.once('connect', () => socket.write(validWebsocket
        ? 'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
        : 'GET /ws HTTP/1.1\r\nHost: localhost\r\n\r\n'));
});
const processMemory = pid => {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const read = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))?.[1] ?? 0) * 1024;
    const mappings = fs.readFileSync(`/proc/${pid}/maps`, 'utf8').trim().split('\n');
    const anonymousMappingSizes = {};
    for (const mapping of mappings) {
        const parts = mapping.trim().split(/\s+/); if (parts.length !== 5 || parts[1] !== 'rw-p') continue;
        const [start, end] = parts[0].split('-').map(value => Number.parseInt(value, 16));
        const size = end - start; anonymousMappingSizes[size] = (anonymousMappingSizes[size] ?? 0) + 1;
    }
    return {rssBytes: read('VmRSS'), virtualBytes: read('VmSize'), anonymousRssBytes: read('RssAnon'), mappings: mappings.length, anonymousMappingSizes};
};
const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(error => error ? reject(error) : resolve(selected)); });
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-clippy-soak-'));
let server;
try {
    const executable = path.join(directory, 'clippy');
    const command = compiler.endsWith('.js') ? process.execPath : compiler;
    const compileArgs = compiler.endsWith('.js')
        ? [compiler, '--runtime-metrics', '--source-root', root, path.join(root, 'examples/clippy/server.ar'), executable]
        : ['--runtime-metrics', '--source-root', root, '--backend', backend, path.join(root, 'examples/clippy/server.ar'), '-o', executable];
    const built = spawnSync(command, compileArgs, {cwd: root, encoding: 'utf8', env: {...process.env, VALEN_LIBRARY_PATH: path.join(root, 'lib')}, maxBuffer: 64 * 1024 * 1024});
    if (built.status !== 0) throw new Error(built.stderr || `compiler exited ${built.status}`);
    server = spawn(executable, [], {env: {...process.env, PORT: `${port}`, VALEN_MAX_MESSAGE_BYTES: '4096', VALEN_RUNTIME_METRICS: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Clippy readiness timeout')), 5000);
        server.stdout.on('data', data => { if (data.toString().includes('ready')) { clearTimeout(timer); resolve(); } });
        server.once('exit', code => reject(new Error(`Clippy exited ${code}`)));
    });
    const fields = ['trackedBytes', 'heapObjects', 'roots', 'peakRoots', 'collections', 'reclaimedObjects', 'trackedReclaimedBytes', 'weakReferencesCleared', 'weakReferencesRetained', 'nativeHandlesOpen', 'nativeHandlesFinalized'];
    const samples = [];
    for (let cycle = 0; cycle <= cycles; cycle++) {
        if (cycle) {
            for (let index = 0; index < healthRequests; index++) await request(port, requestPath);
            for (let index = 0; index < websockets; index++) await websocketChurn(port);
        }
        const values = (await request(port, '/__runtime/collect')).trim().split(',').map(Number);
        samples.push({cycle, ...processMemory(server.pid), ...Object.fromEntries(fields.map((field, index) => [field, values[index]]))});
    }
    const floors = samples.map(sample => sample.trackedBytes);
    const steady = samples.slice(Math.min(2, samples.length - 1));
    const result = {format: 1, backend, workload: {cycles, requestPath, requestsPerCycle: healthRequests, websocketsPerCycle: websockets},
        first: samples[0], last: samples.at(-1), stableTrackedFloor: steady.every(sample => sample.trackedBytes === steady[0].trackedBytes),
        rootDelta: samples.at(-1).roots - samples[0].roots, handleDelta: samples.at(-1).nativeHandlesOpen - samples[0].nativeHandlesOpen,
        rssGrowthBytes: samples.at(-1).rssBytes - samples[0].rssBytes};
    if (includeSamples) result.samples = samples;
    fs.writeSync(1, `${JSON.stringify(result)}\n`);
} finally {
    if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
    fs.rmSync(directory, {recursive: true, force: true});
}
