import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {formatValen} from '../../scripts/valen-formatter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('formatter is idempotent and preserves optional condition parentheses', () => {
    const source = `entry{{\n__()->i32{\n// retain this comment\nif(value==1){return 0}\nif value==2 { return 1 }\nSystem.write("a // string")\n}\n}}`;
    const expected = `entry {{\n    __() -> i32 {\n        // retain this comment\n        if (value == 1) { return 0 }\n        if value == 2 { return 1 }\n        System.write("a // string")\n    }\n}}\n`;
    const formatted = formatValen(source);
    assert.equal(formatted, expected);
    assert.equal(formatValen(formatted), formatted);
});

test('formatter command supports check and write modes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-format-'));
    const file = path.join(directory, 'sample.ar');
    fs.writeFileSync(file, 'entry{{\n__()->i32{return 0}\n}}');
    const command = path.join(root, 'scripts/valen-format.mjs');
    assert.equal(spawnSync(process.execPath, [command, '--check', file]).status, 1);
    assert.equal(spawnSync(process.execPath, [command, '--write', file]).status, 0);
    assert.equal(spawnSync(process.execPath, [command, '--check', file]).status, 0);
    fs.rmSync(directory, {recursive: true});
});
