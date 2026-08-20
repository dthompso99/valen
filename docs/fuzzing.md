# Bounded fuzzing

Valen's generation-zero fuzz runner exercises input boundaries without adding a long-running job to ordinary CI. Runs are deterministic and bounded by an explicit seed and iteration count.

```sh
node bootstrap/fuzz.js \
  --target parser \
  --seed 105 \
  --iterations 10000 \
  --corpus bootstrap/test/fuzz-corpus/syntax-v1
```

Supported targets are `tokenizer`, `parser`, `vmi`, `vmeta`, and `elf`. Syntax errors are expected rejection for source targets. Artifact targets expect deliberate validation errors but treat runtime exceptions such as `RangeError` as defects. ELF corpus inputs use base64 so retained binary cases remain portable text files. On failure, the runner minimizes the input, writes it beneath `fuzz-failures/` by default, and prints the exact seed/configuration needed to reproduce the run. Use `--failures <directory>` to select another output directory.

## Retained corpus

Each corpus directory contains a `corpus.json` manifest:

```json
{
  "version": 1,
  "inputs": ["minimal.ar", "malformed.ar"]
}
```

Input names are relative to the manifest. Corpus format version 1 stores source inputs verbatim. The ordinary `bootstrap/test/fuzz.test.js` suite replays every retained syntax input through both targets, so minimized defects can become permanent regression cases without running a fuzz campaign in CI.

The current mutator performs deterministic insertion, deletion, and replacement. Deeper structure-aware mutation and the module-path, HTTP, and WebSocket targets tracked by issue #105 remain **WIP**.
