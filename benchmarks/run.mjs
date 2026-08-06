#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(benchmarkRoot, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-language-benchmark-'));
const option = name => {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
};
const requested = new Set((option('--languages') ?? 'valen,c,cpp,rust,go,java,node').split(',').filter(Boolean));
const repetitions = Number(option('--repetitions') ?? 5);
const outputPath = option('--output');
const keep = process.argv.includes('--keep');
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer');

const commandExists = command => spawnSync('sh', ['-c', `command -v "$1" >/dev/null 2>&1`, 'benchmark', command]).status === 0;
const version = (command, args = ['--version']) => {
    const result = spawnSync(command, args, {encoding: 'utf8'});
    return `${result.stdout}${result.stderr}`.trim().split('\n')[0] || 'unknown';
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const memory = kib => kib == null ? 'unavailable' : kib < 1024 ? `${kib} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
const environment = {...process.env, VALEN_LIBRARY_PATH: path.join(root, 'lib')};

async function measure(command, args, options = {}) {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, {cwd: root, env: environment, ...options});
    let stdout = '';
    let stderr = '';
    let maxRssKiB = null;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const sample = () => {
        if (process.platform !== 'linux' || child.pid == null) return;
        try {
            const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
            const match = status.match(/^VmHWM:\s+(\d+) kB$/m) ?? status.match(/^VmRSS:\s+(\d+) kB$/m);
            if (match) maxRssKiB = Math.max(maxRssKiB ?? 0, Number(match[1]));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    };
    sample();
    const sampler = setInterval(sample, 2);
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => resolve({status, signal}));
    }).finally(() => clearInterval(sampler));
    const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}):\n${stderr || stdout}`);
    return {wallSeconds, maxRssKiB, stdout, stderr};
}

async function repeated(runtime, expectedOutput) {
    await measure(runtime.command, runtime.args, runtime.options);
    const samples = [];
    for (let index = 0; index < repetitions; index++) {
        const result = await measure(runtime.command, runtime.args, runtime.options);
        if (result.stdout !== expectedOutput) throw new Error(`${runtime.name} produced ${JSON.stringify(result.stdout)}; expected ${JSON.stringify(expectedOutput)}`);
        samples.push(result);
    }
    return {
        medianSeconds: median(samples.map(sample => sample.wallSeconds)),
        minimumSeconds: Math.min(...samples.map(sample => sample.wallSeconds)),
        maximumSeconds: Math.max(...samples.map(sample => sample.wallSeconds)),
        peakRssKiB: Math.max(...samples.map(sample => sample.maxRssKiB ?? 0)) || null
    };
}

const stage1 = path.join(temporary, 'valen');
const languages = {
    valen: {
        tools: ['node'], version: () => `Valen generation 1 (${version('node')} bootstrap)`,
        prepare: async () => measure(process.execPath, [path.join(root, 'bootstrap/compiler.js'), path.join(root, 'src/valen.ar'), stage1]),
        compile: source => ({command: stage1, args: [source, '-O1', '-o', path.join(temporary, 'integer-loop-valen')]}),
        runtime: () => ({name: 'valen', command: path.join(temporary, 'integer-loop-valen'), args: []}), artifact: () => path.join(temporary, 'integer-loop-valen')
    },
    c: {
        tools: ['cc'], version: () => version('cc'), compile: source => ({command: 'cc', args: ['-std=c11', '-O2', source, '-o', path.join(temporary, 'integer-loop-c')]}),
        runtime: () => ({name: 'c', command: path.join(temporary, 'integer-loop-c'), args: []}), artifact: () => path.join(temporary, 'integer-loop-c')
    },
    cpp: {
        tools: ['c++'], version: () => version('c++'), compile: source => ({command: 'c++', args: ['-std=c++20', '-O2', source, '-o', path.join(temporary, 'integer-loop-cpp')]}),
        runtime: () => ({name: 'cpp', command: path.join(temporary, 'integer-loop-cpp'), args: []}), artifact: () => path.join(temporary, 'integer-loop-cpp')
    },
    rust: {
        tools: ['rustc'], version: () => version('rustc'), compile: source => ({command: 'rustc', args: ['-C', 'opt-level=3', source, '-o', path.join(temporary, 'integer-loop-rust')]}),
        runtime: () => ({name: 'rust', command: path.join(temporary, 'integer-loop-rust'), args: []}), artifact: () => path.join(temporary, 'integer-loop-rust')
    },
    go: {
        tools: ['go'], version: () => version('go', ['version']), compile: source => ({command: 'go', args: ['build', '-o', path.join(temporary, 'integer-loop-go'), source]}),
        runtime: () => ({name: 'go', command: path.join(temporary, 'integer-loop-go'), args: []}), artifact: () => path.join(temporary, 'integer-loop-go')
    },
    java: {
        tools: ['java', 'javac'], version: () => version('java'), compile: source => ({command: 'javac', args: ['-d', temporary, source]}),
        runtime: () => ({name: 'java', command: 'java', args: ['-cp', temporary, 'IntegerLoop']}), artifact: () => path.join(temporary, 'IntegerLoop.class')
    },
    node: {
        tools: ['node'], version: () => version('node'), compile: source => ({command: 'node', args: ['--check', source]}),
        runtime: source => ({name: 'node', command: 'node', args: [source]}), artifact: source => source
    }
};
const extensions = {valen: 'valen.ar', c: 'c.c', cpp: 'cpp.cpp', rust: 'rust.rs', go: 'go.go', java: 'IntegerLoop.java', node: 'node.js'};
const report = {
    schemaVersion: 1,
    metadata: {
        commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim(),
        timestamp: new Date().toISOString(), platform: os.platform(), release: os.release(), arch: os.arch(),
        cpu: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem()
    },
    configuration: {repetitions, warmupRuns: 1, workload: 'integer-loop', iterations: 1000000000},
    skipped: [], results: []
};

try {
    for (const name of requested) {
        const language = languages[name];
        if (!language) throw new Error(`Unknown language '${name}'`);
        const missing = language.tools.filter(tool => !commandExists(tool));
        if (missing.length) {
            report.skipped.push({language: name, reason: `missing ${missing.join(', ')}`});
            continue;
        }
        try {
            const source = path.join(benchmarkRoot, 'workloads/integer-loop', extensions[name]);
            const preparation = language.prepare ? await language.prepare() : null;
            const command = language.compile(source);
            const compilation = await measure(command.command, command.args);
            const runtime = language.runtime(source);
            const execution = await repeated(runtime, '124999999686\n');
            const artifact = language.artifact(source);
            const dynamic = ['valen', 'c', 'cpp', 'rust', 'go'].includes(name)
                ? spawnSync('readelf', ['-d', artifact], {encoding: 'utf8'}).stdout.match(/NEEDED[^\[]*\[([^\]]+)\]/g)?.map(item => item.slice(item.indexOf('[') + 1, -1)) ?? []
                : [];
            report.results.push({language: name, version: language.version(), preparation: preparation ? {
                seconds: preparation.wallSeconds, peakRssKiB: preparation.maxRssKiB
            } : null, compile: {seconds: compilation.wallSeconds, peakRssKiB: compilation.maxRssKiB}, execution,
            artifact: {bytes: fs.statSync(artifact).size, dynamicDependencies: dynamic}});
        } catch (error) {
            report.skipped.push({language: name, reason: error.message.split('\n').filter(Boolean).slice(0, 2).join(' — ')});
        }
    }
    const lines = ['# Valen comparative benchmark', '', `CPU: ${report.metadata.cpu}`, `Commit: ${report.metadata.commit}`, '',
        '| Language | Compile | Runtime median | Peak RSS | Artifact | Dynamic dependencies |', '| --- | ---: | ---: | ---: | ---: | --- |'];
    for (const result of report.results) lines.push(`| ${result.language} | ${result.compile.seconds.toFixed(3)} s | ${result.execution.medianSeconds.toFixed(3)} s | ${memory(result.execution.peakRssKiB)} | ${(result.artifact.bytes / 1024).toFixed(1)} KiB | ${result.artifact.dynamicDependencies.join(', ') || 'none'} |`);
    for (const skipped of report.skipped) lines.push(`| ${skipped.language} | skipped: ${skipped.reason} | | | | |`);
    const rendered = `${lines.join('\n')}\n`;
    process.stdout.write(rendered);
    if (outputPath) fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
} finally {
    if (keep) process.stderr.write(`Benchmark artifacts retained at ${temporary}\n`);
    else fs.rmSync(temporary, {recursive: true, force: true});
}
