#!/usr/bin/env node
import fs from 'node:fs';
import {formatValen} from './valen-formatter.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const write = args.includes('--write');
const files = args.filter(argument => argument !== '--check' && argument !== '--write');

if (!files.length || check && write) {
    console.error('Usage: valen-format [--check | --write] <file.ar>...');
    process.exit(64);
}

let changed = false;
for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const formatted = formatValen(source);
    if (formatted === source) continue;
    changed = true;
    if (check) console.error(`${file} is not formatted`);
    else if (write) fs.writeFileSync(file, formatted);
    else if (files.length === 1) process.stdout.write(formatted);
    else console.error('Formatting multiple files requires --check or --write');
}
if (!check && !write && files.length > 1) process.exit(64);
if (check && changed) process.exit(1);
