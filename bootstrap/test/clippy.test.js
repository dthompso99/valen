import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const availablePort = () => new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
        const {port} = listener.address();
        listener.close(error => error ? reject(error) : resolve(port));
    });
});

function clientFrame(payload, {opcode = 1, fin = true, masked = true} = {}) {
    const content = Buffer.from(payload);
    const extended = content.length < 126 ? 0 : content.length <= 65535 ? 2 : 8;
    const output = Buffer.alloc(2 + extended + (masked ? 4 : 0) + content.length);
    output[0] = (fin ? 0x80 : 0) | opcode;
    output[1] = (masked ? 0x80 : 0) | (extended === 0 ? content.length : extended === 2 ? 126 : 127);
    let offset = 2;
    if (extended === 2) { output.writeUInt16BE(content.length, offset); offset += 2; }
    if (extended === 8) { output.writeBigUInt64BE(BigInt(content.length), offset); offset += 8; }
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    if (masked) { mask.copy(output, offset); offset += 4; }
    for (let index = 0; index < content.length; index++) output[offset + index] = masked ? content[index] ^ mask[index & 3] : content[index];
    return output;
}

function serverFrame(buffer) {
    if (buffer.length < 2) return null;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    if (buffer.length < offset + length) return null;
    return {opcode: buffer[0] & 0xf, payload: buffer.subarray(offset, offset + length).toString(), consumed: offset + length};
}

function websocket(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(port, '127.0.0.1');
        let input = Buffer.alloc(0);
        const frames = [];
        const waiters = [];
        const drain = () => {
            while (true) {
                const frame = serverFrame(input);
                if (!frame) return;
                input = input.subarray(frame.consumed);
                const waiter = waiters.shift();
                if (waiter) waiter(frame); else frames.push(frame);
            }
        };
        socket.once('error', reject);
        socket.once('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
        const headers = data => {
            input = Buffer.concat([input, data]);
            const end = input.indexOf('\r\n\r\n');
            if (end < 0) return;
            const response = input.subarray(0, end + 4).toString();
            assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
            assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
            input = input.subarray(end + 4);
            socket.off('data', headers);
            socket.on('data', data => { input = Buffer.concat([input, data]); drain(); });
            drain();
            resolve({socket, send: (payload, options) => socket.write(clientFrame(payload, options)), next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => waiters.push(resolve))});
        };
        socket.on('data', headers);
    });
}

test('Valen Clippy upgrades, broadcasts, fragments, and rejects malformed clients', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-clippy-'));
    const executable = path.join(directory, 'clippy');
    const build = spawnSync(process.execPath, [path.join(root, 'bootstrap/compiler.js'), path.join(root, 'examples/clippy/server.ar'), executable], {cwd: root, encoding: 'utf8', env: {...process.env, VALEN_LIBRARY_PATH: path.join(root, 'lib')}});
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const port = await availablePort();
    const server = spawn(executable, [], {env: {...process.env, PORT: `${port}`, VALEN_MAX_MESSAGE_BYTES: '1024'}, stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => { if (server.exitCode == null) server.kill('SIGKILL'); fs.rmSync(directory, {recursive: true, force: true}); });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Clippy did not become ready')), 3000);
        server.stdout.on('data', data => { if (data.toString().includes('ready')) { clearTimeout(timeout); resolve(); } });
        server.once('exit', status => reject(new Error(`Clippy exited with ${status}`)));
    });

    const first = await websocket(port);
    const second = await websocket(port);
    assert.equal(JSON.parse((await first.next()).payload).data, '');
    assert.equal(JSON.parse((await second.next()).payload).data, '');
    const update = JSON.stringify({type: 'text', data: 'from Valen'});
    first.send(update);
    assert.equal((await first.next()).payload, update);
    assert.equal((await second.next()).payload, update);
    first.send('{"type":"text",', {fin: false});
    first.send('"data":"fragmented"}', {opcode: 0});
    assert.equal(JSON.parse((await second.next()).payload).data, 'fragmented');
    const malformed = await websocket(port);
    await malformed.next();
    malformed.send('unmasked', {masked: false});
    assert.equal((await malformed.next()).opcode, 8);
    first.socket.destroy(); second.socket.destroy(); malformed.socket.destroy();
});
