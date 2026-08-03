import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const valueAfter = option => {
    const index = process.argv.indexOf(option);
    return index >= 0 ? process.argv[index + 1] : null;
};
const jsonPath = valueAfter('--json');
const markdownPath = valueAfter('--markdown');
const checkBudgets = args.has('--check-budgets');
const includeGeneration2 = args.has('--generation2');
const keep = args.has('--keep');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'argon-benchmark-'));
const environment = {...process.env, ARGON_LIBRARY_PATH: path.join(root, 'lib')};
const metrics = [];

async function measured(name, command, commandArgs, options = {}) {
    const started = process.hrtime.bigint();
    const child = spawn(command, commandArgs, {
        cwd: root,
        env: environment,
        ...options
    });
    let stdout = '';
    let stderr = '';
    let maxRssKiB = null;
    const sampleMemory = () => {
        if (child.pid == null || process.platform !== 'linux') return;
        try {
            const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
            const match = status.match(/^VmHWM:\s+(\d+) kB$/m) ?? status.match(/^VmRSS:\s+(\d+) kB$/m);
            if (match) maxRssKiB = Math.max(maxRssKiB ?? 0, Number(match[1]));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    sampleMemory();
    const sampler = setInterval(sampleMemory, 5);
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => resolve({status, signal}));
    }).finally(() => clearInterval(sampler));
    const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${stderr || stdout}`);
    const metric = {
        name,
        wallSeconds: Number(wallSeconds.toFixed(6)),
        toolSeconds: null,
        maxRssKiB
    };
    metrics.push(metric);
    return {metric, stdout, stderr};
}

function fileSize(file) {
    return fs.statSync(file).size;
}

function median(values) {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
}

async function runRepeated(name, executable, expectedOutput, repetitions = 5) {
    const runs = [];
    for (let index = 0; index < repetitions; index++) {
        const result = await measured(`${name}_${index + 1}`, executable, []);
        if (result.stdout !== expectedOutput) {
            throw new Error(`${name} output mismatch: expected ${JSON.stringify(expectedOutput)}, received ${JSON.stringify(result.stdout)}`);
        }
        runs.push(result.metric);
    }
    const memorySamples = runs.map(run => run.maxRssKiB).filter(value => value != null);
    const summary = {
        name,
        wallSeconds: Number(median(runs.map(run => run.wallSeconds)).toFixed(6)),
        toolSeconds: median(runs.map(run => run.toolSeconds)),
        maxRssKiB: memorySamples.length ? Math.max(...memorySamples) : null
    };
    metrics.push(summary);
    return summary;
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${bytes} B`;
}

function markdown(report) {
    const lines = [
        '# Argon benchmark results', '',
        `Commit: \`${report.metadata.commit}\`  `,
        `Platform: ${report.metadata.platform} ${report.metadata.arch}  `,
        `CPU: ${report.metadata.cpu}  `,
        `Node: ${report.metadata.node}`, '',
        '| Metric | Wall seconds | Peak RSS |', '| --- | ---: | ---: |'
    ];
    for (const metric of report.metrics.filter(metric => !/_\d+$/.test(metric.name))) {
        const peakRss = metric.maxRssKiB == null ? 'unavailable' : `${(metric.maxRssKiB / 1024).toFixed(1)} MiB`;
        lines.push(`| ${metric.name} | ${metric.wallSeconds.toFixed(3)} | ${peakRss} |`);
    }
    lines.push('', '| Artifact | Size |', '| --- | ---: |');
    for (const [name, bytes] of Object.entries(report.artifacts)) lines.push(`| ${name} | ${formatBytes(bytes)} |`);
    if (report.budgetFailures.length) {
        lines.push('', '## Budget failures', '');
        for (const failure of report.budgetFailures) lines.push(`- ${failure}`);
    }
    return `${lines.join('\n')}\n`;
}

try {
    const stage1 = path.join(directory, 'argon-stage1');
    const argonProgram = path.join(directory, 'integer-loop-argon');
    const cO0Program = path.join(directory, 'integer-loop-c-o0');
    const cO2Program = path.join(directory, 'integer-loop-c-o2');
    const stage2 = path.join(directory, 'argon-stage2');
    const stage2Program = path.join(directory, 'integer-loop-stage2');
    const workloadAr = path.join(root, 'benchmarks/workloads/integer-loop.ar');
    const workloadC = path.join(root, 'benchmarks/workloads/integer-loop.c');

    await measured('bootstrap_compile_stage1', process.execPath, [path.join(root, 'bootstrap/compiler.js'), path.join(root, 'src/argon.ar'), stage1]);
    await measured('stage1_compile_workload', stage1, [workloadAr, '-o', argonProgram]);
    await measured('c_o0_compile_workload', 'cc', ['-std=c11', '-O0', workloadC, '-o', cO0Program]);
    await measured('c_o2_compile_workload', 'cc', ['-std=c11', '-O2', workloadC, '-o', cO2Program]);

    const expectedOutput = '1249999707\n';
    await runRepeated('argon_run_integer_loop', argonProgram, expectedOutput);
    await runRepeated('c_o0_run_integer_loop', cO0Program, expectedOutput);
    await runRepeated('c_o2_run_integer_loop', cO2Program, expectedOutput);

    if (includeGeneration2) {
        await measured('stage1_compile_stage2', stage1, [path.join(root, 'src/argon.ar'), '-o', stage2]);
        await measured('stage2_compile_workload', stage2, [workloadAr, '-o', stage2Program]);
        await runRepeated('stage2_run_integer_loop', stage2Program, expectedOutput);
    }

    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim() || 'unknown';
    const budgets = JSON.parse(fs.readFileSync(path.join(root, 'benchmarks/budgets.json'), 'utf8'));
    const budgetFailures = [];
    for (const [name, budget] of Object.entries(budgets)) {
        const metric = metrics.find(entry => entry.name === name);
        if (metric && budget.maxRssKiB != null && metric.maxRssKiB == null) {
            budgetFailures.push(`${name} peak RSS could not be measured on ${process.platform}`);
        }
        if (metric && budget.maxRssKiB != null && metric.maxRssKiB > budget.maxRssKiB) {
            budgetFailures.push(`${name} used ${metric.maxRssKiB} KiB RSS; budget is ${budget.maxRssKiB} KiB`);
        }
    }
    const report = {
        schemaVersion: 1,
        metadata: {
            commit,
            timestamp: new Date().toISOString(),
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpu: os.cpus()[0]?.model ?? 'unknown',
            cpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            node: process.version
        },
        configuration: {workload: 'integer-loop', iterations: 10000000, runtimeRepetitions: 5, generation2: includeGeneration2},
        metrics,
        artifacts: {
            stage1CompilerBytes: fileSize(stage1),
            argonAssemblyBytes: fileSize(`${argonProgram}.s`),
            argonExecutableBytes: fileSize(argonProgram),
            cO0ExecutableBytes: fileSize(cO0Program),
            cO2ExecutableBytes: fileSize(cO2Program),
            ...(includeGeneration2 ? {stage2CompilerBytes: fileSize(stage2), stage2ExecutableBytes: fileSize(stage2Program)} : {})
        },
        budgets,
        budgetFailures
    };
    const rendered = markdown(report);
    process.stdout.write(rendered);
    if (jsonPath) fs.writeFileSync(path.resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
    if (markdownPath) fs.writeFileSync(path.resolve(markdownPath), rendered);
    if (checkBudgets && budgetFailures.length) process.exitCode = 1;
} finally {
    if (keep) process.stderr.write(`Benchmark files retained at ${directory}\n`);
    else fs.rmSync(directory, {recursive: true, force: true});
}
