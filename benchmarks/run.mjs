#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(benchmarkRoot, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-language-benchmark-'));
const option = name => {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
};
const requested = new Set((option('--languages') ?? 'valen,valen-llvm,c,cpp,rust,go,java,node').split(',').filter(Boolean));
const requestedWorkloads = (option('--workloads') ?? 'integer-loop,object-dispatch,string-builders,allocation-gc,collections,file-processing,cold-start').split(',').filter(Boolean);
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
const valenCompiler = path.resolve(option('--valen') ?? path.join(root, 'valen'));
const fileFingerprint = filePath => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
const artifactPath = (workload, language) => path.join(temporary, `${workload}-${language}`);
const fileInput = path.join(temporary, 'deterministic-input.txt');
const fileContent = 'Valen benchmark line 0123456789\n'.repeat(2048);
fs.writeFileSync(fileInput, fileContent);
const fileChecksum = Buffer.from(fileContent).reduce((sum, byte) => sum + byte, 0);
const workloads = {
    'integer-loop': {expectedOutput: '124999999686\n', iterations: 1000000000, javaClass: 'IntegerLoop'},
    'object-dispatch': {expectedOutput: '1426395009\n', iterations: 50000000, javaClass: 'ObjectDispatch'},
    'string-builders': {expectedOutput: '650000\n', iterations: 50000, javaClass: 'StringBuilders'},
    'allocation-gc': {expectedOutput: '2146983647\n', iterations: 500000, javaClass: 'AllocationGc'},
    collections: {expectedOutput: '136345492\n', iterations: 10000, javaClass: 'CollectionsWorkload'},
    'file-processing': {expectedOutput: `${fileChecksum}\n`, iterations: fileContent.length, javaClass: 'FileProcessing', runtimeArgs: [fileInput]},
    'cold-start': {expectedOutput: '0\n', iterations: 1, javaClass: 'ColdStart'}
};
for (const name of requestedWorkloads) if (!workloads[name]) throw new Error(`Unknown workload '${name}'`);

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

const languages = {
    valen: {
        tools: [valenCompiler], missingHint: 'run ./scripts/bootstrap-valen.sh first',
        version: () => `Valen native compiler (sha256:${fileFingerprint(valenCompiler)})`,
        compile: (source, workload) => ({command: valenCompiler, args: [source, '-O1', '-o', artifactPath(workload, 'valen')]}),
        runtime: (source, workload) => ({name: 'valen', command: artifactPath(workload, 'valen'), args: []}), artifact: (source, workload) => artifactPath(workload, 'valen')
    },
    'valen-llvm': {
        tools: [valenCompiler, '/usr/bin/clang'], missingHint: 'run ./scripts/bootstrap-valen.sh and install clang first',
        version: () => `Valen LLVM backend (sha256:${fileFingerprint(valenCompiler)}; ${version('/usr/bin/clang')})`,
        compile: (source, workload) => ({command: valenCompiler, args: ['--backend', 'llvm', '--target', 'x86_64-linux', source, '-O1', '-o', artifactPath(workload, 'valen-llvm')]}),
        runtime: (source, workload) => ({name: 'valen-llvm', command: artifactPath(workload, 'valen-llvm'), args: []}), artifact: (source, workload) => artifactPath(workload, 'valen-llvm')
    },
    c: {
        tools: ['cc'], version: () => version('cc'), compile: (source, workload) => ({command: 'cc', args: ['-std=c11', '-O2', source, '-o', artifactPath(workload, 'c')]}),
        runtime: (source, workload) => ({name: 'c', command: artifactPath(workload, 'c'), args: []}), artifact: (source, workload) => artifactPath(workload, 'c')
    },
    cpp: {
        tools: ['c++'], version: () => version('c++'), compile: (source, workload) => ({command: 'c++', args: ['-std=c++20', '-O2', source, '-o', artifactPath(workload, 'cpp')]}),
        runtime: (source, workload) => ({name: 'cpp', command: artifactPath(workload, 'cpp'), args: []}), artifact: (source, workload) => artifactPath(workload, 'cpp')
    },
    rust: {
        tools: ['rustc'], version: () => version('rustc'), compile: (source, workload) => ({command: 'rustc', args: ['-C', 'opt-level=3', source, '-o', artifactPath(workload, 'rust')]}),
        runtime: (source, workload) => ({name: 'rust', command: artifactPath(workload, 'rust'), args: []}), artifact: (source, workload) => artifactPath(workload, 'rust')
    },
    go: {
        tools: ['go'], version: () => version('go', ['version']), compile: (source, workload) => ({command: 'go', args: ['build', '-o', artifactPath(workload, 'go'), source]}),
        runtime: (source, workload) => ({name: 'go', command: artifactPath(workload, 'go'), args: []}), artifact: (source, workload) => artifactPath(workload, 'go')
    },
    java: {
        tools: ['java', 'javac'], version: () => version('java'), compile: source => ({command: 'javac', args: ['-d', temporary, source]}),
        runtime: (source, workload) => ({name: 'java', command: 'java', args: ['-cp', temporary, workloads[workload].javaClass]}), artifact: (source, workload) => path.join(temporary, `${workloads[workload].javaClass}.class`)
    },
    node: {
        tools: ['node'], version: () => version('node'), compile: source => ({command: 'node', args: ['--check', source]}),
        runtime: source => ({name: 'node', command: 'node', args: [source]}), artifact: source => source
    }
};
const extensions = {valen: 'valen.ar', 'valen-llvm': 'valen.ar', c: 'c.c', cpp: 'cpp.cpp', rust: 'rust.rs', go: 'go.go', java: 'IntegerLoop.java', node: 'node.js'};
const report = {
    schemaVersion: 1,
    metadata: {
        commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim(),
        timestamp: new Date().toISOString(), platform: os.platform(), release: os.release(), arch: os.arch(),
        cpu: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem()
    },
    configuration: {repetitions, warmupRuns: 1, workloads: requestedWorkloads.map(name => ({name, iterations: workloads[name].iterations}))},
    skipped: [], results: []
};

try {
    for (const workloadName of requestedWorkloads) for (const name of requested) {
        const language = languages[name];
        if (!language) throw new Error(`Unknown language '${name}'`);
        const missing = language.tools.filter(tool => !commandExists(tool));
        if (missing.length) {
            const hint = language.missingHint ? `; ${language.missingHint}` : '';
            report.skipped.push({workload: workloadName, language: name, reason: `missing ${missing.join(', ')}${hint}`});
            continue;
        }
        try {
            const filename = name === 'java' ? `${workloads[workloadName].javaClass}.java` : extensions[name];
            const source = path.join(benchmarkRoot, 'workloads', workloadName, filename);
            const command = language.compile(source, workloadName);
            const compilation = await measure(command.command, command.args);
            const runtime = language.runtime(source, workloadName);
            runtime.args.push(...(workloads[workloadName].runtimeArgs ?? []));
            const execution = await repeated(runtime, workloads[workloadName].expectedOutput);
            const artifact = language.artifact(source, workloadName);
            const dynamic = ['valen', 'valen-llvm', 'c', 'cpp', 'rust', 'go'].includes(name)
                ? spawnSync('readelf', ['-d', artifact], {encoding: 'utf8'}).stdout.match(/NEEDED[^\[]*\[([^\]]+)\]/g)?.map(item => item.slice(item.indexOf('[') + 1, -1)) ?? []
                : [];
            report.results.push({workload: workloadName, language: name, version: language.version(),
            compile: {seconds: compilation.wallSeconds, peakRssKiB: compilation.maxRssKiB}, execution,
            artifact: {bytes: fs.statSync(artifact).size, dynamicDependencies: dynamic}});
        } catch (error) {
            report.skipped.push({workload: workloadName, language: name, reason: error.message.split('\n').filter(Boolean).slice(0, 2).join(' — ')});
        }
    }
    const lines = ['# Valen comparative benchmark', '', `CPU: ${report.metadata.cpu}`, `Commit: ${report.metadata.commit}`, '',
        '| Workload | Language | Compile | Runtime median | Peak RSS | Artifact | Dynamic dependencies |', '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
    for (const result of report.results) lines.push(`| ${result.workload} | ${result.language} | ${result.compile.seconds.toFixed(3)} s | ${result.execution.medianSeconds.toFixed(3)} s | ${memory(result.execution.peakRssKiB)} | ${(result.artifact.bytes / 1024).toFixed(1)} KiB | ${result.artifact.dynamicDependencies.join(', ') || 'none'} |`);
    for (const skipped of report.skipped) lines.push(`| ${skipped.workload} | ${skipped.language} | skipped: ${skipped.reason} | | | | |`);
    const rendered = `${lines.join('\n')}\n`;
    process.stdout.write(rendered);
    if (outputPath) fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
} finally {
    if (keep) process.stderr.write(`Benchmark artifacts retained at ${temporary}\n`);
    else fs.rmSync(temporary, {recursive: true, force: true});
}
