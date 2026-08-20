#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const compilerIndex = args.indexOf('--compiler'), backendIndex = args.indexOf('--backend');
const compiler = path.resolve(compilerIndex < 0 ? path.join(root, 'bootstrap/compiler.js') : args[compilerIndex + 1]);
const backend = backendIndex < 0 ? 'native' : args[backendIndex + 1];
if (!['native', 'llvm'].includes(backend)) throw new Error('--backend must be native or llvm');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-metrics-soak-'));
try {
    const output = path.join(directory, 'soak');
    const source = path.join(root, 'bootstrap/test/fixtures/runtime-metrics-soak.ar');
    const command = compiler.endsWith('.js') ? process.execPath : compiler;
    const compileArgs = compiler.endsWith('.js') ? [compiler, '--runtime-metrics', '--source-root', root, source, output]
        : ['--runtime-metrics', '--source-root', root, '--backend', backend, source, '-o', output];
    const built = spawnSync(command, compileArgs, {encoding: 'utf8', cwd: root, maxBuffer: 16 * 1024 * 1024});
    if (built.status !== 0) throw new Error(built.stderr || `compiler exited ${built.status}`);
    const ran = spawnSync(output, [], {encoding: 'utf8'});
    if (ran.status !== 0) throw new Error(ran.stderr || `soak exited ${ran.status}`);
    const names = ['phase', 'trackedBytes', 'trackedAllocatedBytes', 'heapObjects', 'roots', 'peakRoots', 'collections',
        'reclaimedObjects', 'trackedReclaimedBytes', 'weakReferencesCleared', 'weakReferencesRetained', 'nativeHandlesOpen', 'nativeHandlesFinalized'];
    const values = ran.stdout.trim().split(/\s+/).map(Number);
    if (values.length % names.length !== 0 || values.some(value => !Number.isSafeInteger(value))) throw new Error('invalid soak sample stream');
    const samples = [];
    for (let offset = 0; offset < values.length; offset += names.length) samples.push(Object.fromEntries(names.map((name, index) => [name, values[offset + index]])));
    for (let index = 1; index < samples.length; index++) {
        for (const field of ['trackedAllocatedBytes', 'peakRoots', 'collections', 'reclaimedObjects', 'trackedReclaimedBytes', 'weakReferencesCleared', 'weakReferencesRetained', 'nativeHandlesFinalized']) {
            if (samples[index][field] < samples[index - 1][field]) throw new Error(`${field} decreased`);
        }
    }
    fs.writeSync(1, `${JSON.stringify({format: 1, backend, samples})}\n`);
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
