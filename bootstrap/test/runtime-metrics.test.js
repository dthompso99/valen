import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('runtime metrics soak emits deterministic structured phases and invariants', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/runtime-metrics-soak.mjs')], {encoding: 'utf8', cwd: root});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.format, 1);
    assert.equal(report.samples.length, 9);
    assert.deepEqual(report.samples.map(sample => sample.phase), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(report.samples.at(-1).collections >= 4, true);
    assert.equal(report.samples.at(-1).reclaimedObjects > 0, true);
});
