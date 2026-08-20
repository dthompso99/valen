import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Parser} from './parser.js';
import {Tokenizer} from './tokenizer.js';
import {ModuleInterface} from './module-interface.js';
import {LibraryMetadata} from './library-metadata.js';
import {ElfObject} from './elf.js';

export const corpusVersion = 1;

const targets = {
    tokenizer(source) { new Tokenizer(source, '<fuzz>').parse(); },
    parser(source) { new Parser().parse(source, '<fuzz>'); },
    vmi(source) { ModuleInterface.parse(source); },
    vmeta(source) { LibraryMetadata.parse(source); },
    elf(source) { ElfObject.parse(Buffer.from(source, 'base64')); }
};

const randomGenerator = seed => {
    let state = seed >>> 0 || 0x9e3779b9;
    return maximum => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % maximum;
    };
};

const mutate = (source, random) => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_{}[]()<>+-*/=!&|^?:;,.\n \t\\\"'${}";
    const operation = random(3);
    const offset = source.length ? random(source.length) : 0;
    if (operation === 0 || source.length === 0) return source.slice(0, offset) + alphabet[random(alphabet.length)] + source.slice(offset);
    if (operation === 1) return source.slice(0, offset) + source.slice(offset + 1);
    return source.slice(0, offset) + alphabet[random(alphabet.length)] + source.slice(offset + 1);
};

const expectedRejection = (target, error) => target === 'tokenizer' || target === 'parser'
    ? error instanceof SyntaxError : error?.constructor === Error || error instanceof SyntaxError;

export const minimize = (source, fails) => {
    let result = source;
    let chunk = Math.max(1, Math.floor(result.length / 2));
    while (chunk > 0) {
        let reduced = false;
        for (let offset = 0; offset < result.length; offset += chunk) {
            const candidate = result.slice(0, offset) + result.slice(offset + chunk);
            if (fails(candidate)) { result = candidate; reduced = true; break; }
        }
        if (!reduced) chunk = Math.floor(chunk / 2);
    }
    return result;
};

export const runFuzz = ({target = 'parser', seed = 1, iterations = 1000, corpus = [], evaluate = targets[target]} = {}) => {
    if (!evaluate) throw new Error(`Unknown fuzz target '${target}'`);
    const random = randomGenerator(seed);
    const seeds = corpus.length ? corpus : ['', 'entry {{ __() -> i32 { return 0 } }}', '"${nested { value }}"'];
    const run = source => {
        try { evaluate(source); return null; }
        catch (error) { return expectedRejection(target, error) ? null : error; }
    };
    for (const source of seeds) {
        const error = run(source);
        if (error) return {source: minimize(source, candidate => run(candidate) !== null), error, iteration: -1};
    }
    for (let iteration = 0; iteration < iterations; iteration++) {
        const source = mutate(seeds[random(seeds.length)], random);
        const error = run(source);
        if (error) return {source: minimize(source, candidate => run(candidate) !== null), error, iteration};
    }
    return null;
};

export const loadCorpus = directory => {
    if (!directory) return [];
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'corpus.json'), 'utf8'));
    if (manifest.version !== corpusVersion) throw new Error(`Unsupported corpus version '${manifest.version}'`);
    return manifest.inputs.map(name => fs.readFileSync(path.join(directory, name), 'utf8'));
};

const parseArguments = args => {
    const value = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
    return {target: value('--target', 'parser'), seed: Number(value('--seed', '1')),
        iterations: Number(value('--iterations', '1000')), corpusDirectory: value('--corpus', null),
        failureDirectory: value('--failures', 'fuzz-failures')};
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const options = parseArguments(process.argv.slice(2));
    if (!Number.isInteger(options.seed) || !Number.isInteger(options.iterations) || options.iterations < 0) throw new Error('Seed and iterations must be non-negative integers');
    const failure = runFuzz({...options, corpus: loadCorpus(options.corpusDirectory)});
    if (failure) {
        fs.mkdirSync(options.failureDirectory, {recursive: true});
        const output = path.join(options.failureDirectory, `${options.target}-seed-${options.seed}-iteration-${failure.iteration}.txt`);
        fs.writeFileSync(output, failure.source);
        process.stderr.write(`${failure.error.stack ?? failure.error}\nReproduce: node bootstrap/fuzz.js --target ${options.target} --seed ${options.seed} --iterations ${options.iterations} --corpus ${options.corpusDirectory ?? '<none>'}\nMinimized input: ${output}\n`);
        process.exitCode = 1;
    } else process.stdout.write(`fuzz target=${options.target} seed=${options.seed} iterations=${options.iterations} ok\n`);
}
