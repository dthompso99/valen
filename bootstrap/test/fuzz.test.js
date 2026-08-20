import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadCorpus, runFuzz} from '../fuzz.js';

const corpusDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fuzz-corpus', 'syntax-v1');
const artifactCorpusDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fuzz-corpus', 'artifacts-v1');
const boundaryCorpusDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fuzz-corpus', 'boundaries-v1');

test('retained syntax corpus replays through tokenizer and parser', () => {
    const corpus = loadCorpus(corpusDirectory);
    assert.ok(corpus.length > 0);
    assert.equal(runFuzz({target: 'tokenizer', iterations: 0, corpus}), null);
    assert.equal(runFuzz({target: 'parser', iterations: 0, corpus}), null);
});

test('bounded fuzzing is deterministic for a seed', () => {
    const options = {target: 'parser', seed: 412, iterations: 200, corpus: loadCorpus(corpusDirectory)};
    assert.equal(runFuzz(options), null);
    assert.equal(runFuzz(options), null);
});

test('synthetic crash is discovered and minimized for replay', () => {
    const failure = runFuzz({iterations: 0, corpus: ['prefix CRASH suffix'], evaluate(source) {
        if (source.includes('CRASH')) throw new RangeError('synthetic defect');
    }});
    assert.equal(failure.error.message, 'synthetic defect');
    assert.equal(failure.source, 'CRASH');
});

test('retained compiler-artifact corpus replays through VMI, VMeta, and ELF parsers', () => {
    const [vmi, vmeta, elf, truncatedElf, invalidSymbolLink] = loadCorpus(artifactCorpusDirectory);
    assert.equal(runFuzz({target: 'vmi', iterations: 0, corpus: [vmi]}), null);
    assert.equal(runFuzz({target: 'vmeta', iterations: 0, corpus: [vmeta]}), null);
    assert.equal(runFuzz({target: 'elf', iterations: 0, corpus: [elf, truncatedElf, invalidSymbolLink]}), null);
});

test('retained boundary corpus replays through module, HTTP, and WebSocket parsers', t => {
    const corpus = loadCorpus(boundaryCorpusDirectory);
    assert.equal(runFuzz({target: 'module', iterations: 0, corpus}), null);
    const http = runFuzz({target: 'http', iterations: 0, corpus});
    if (http?.error?.message.includes('EPERM')) { t.skip('process sandbox does not allow generated protocol harness execution'); return; }
    assert.equal(http, null);
    assert.equal(runFuzz({target: 'websocket', iterations: 0, corpus}), null);
});
