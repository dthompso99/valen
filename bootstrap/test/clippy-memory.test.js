import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Clippy returns to a stable managed heap after connection churn', () => {
    const run = spawnSync(process.execPath, ['scripts/clippy-memory-soak.mjs', '--cycles', '4'], {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.stableTrackedFloor, true);
    assert.equal(report.rootDelta, 0);
    assert.equal(report.handleDelta, 0);
    assert.equal(report.last.nativeHandlesFinalized, 284);
    assert.ok(report.rssGrowthBytes <= 32768, `RSS grew by ${report.rssGrowthBytes} bytes`);
    assert.ok(report.last.mappings - report.first.mappings <= 4, `mapping count grew from ${report.first.mappings} to ${report.last.mappings}`);
});
