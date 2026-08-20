import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const specificationDirectory = path.join(projectRoot, 'docs/specification');

test('normative specification has unique rule identifiers and valid local links', () => {
    const files = fs.readdirSync(specificationDirectory).filter(name => name.endsWith('.md'))
        .map(name => path.join(specificationDirectory, name));
    const definitions = new Map();
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\*\*((?:LEX|MOD|NAM|TYP|OWN|COMP)-\d{3})\b/g)) {
            assert.equal(definitions.has(match[1]), false, `duplicate normative rule ${match[1]}`);
            definitions.set(match[1], file);
        }
        for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
            if (/^[a-z]+:/i.test(match[1])) continue;
            assert.equal(fs.existsSync(path.resolve(path.dirname(file), match[1])), true,
                `${path.relative(projectRoot, file)} has missing link ${match[1]}`);
        }
    }
    assert.ok(definitions.size >= 55, 'normative surface unexpectedly shrank');
    const conformance = fs.readFileSync(path.join(specificationDirectory, 'conformance.md'), 'utf8');
    for (const identifier of conformance.matchAll(/`((?:LEX|MOD|NAM|TYP|OWN|COMP)-\d{3})`/g)) {
        assert.ok(definitions.has(identifier[1]), `conformance map references unknown rule ${identifier[1]}`);
    }
});
