'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const grammar = JSON.parse(fs.readFileSync(path.join(root, manifest.contributes.grammars[0].path), 'utf8'));
const language = manifest.contributes.languages[0];

assert.equal(language.id, 'valen');
assert.deepEqual(language.extensions, ['.ar']);
assert.equal(manifest.activationEvents[0], 'onLanguage:valen');
assert.equal(grammar.scopeName, 'source.valen');
assert.match(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), /scripts['"], ['"]valen-lsp\.mjs/);
assert.match(JSON.stringify(grammar), /keyword\.control\.valen/);
console.log('VS Code extension manifest: pass');
