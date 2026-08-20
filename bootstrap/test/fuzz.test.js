import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadCorpus, runFuzz} from '../fuzz.js';

const corpusDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fuzz-corpus', 'syntax-v1');

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
