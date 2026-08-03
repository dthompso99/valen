# Compiler developer guide

## The bootstrap model

Valen is developed through two compiler implementations:

1. `bootstrap/` is generation 0, written in JavaScript.
2. `src/` is the compiler written in Valen.
3. Generation 0 compiles `src/valen.ar` into a native generation-1 compiler.
4. Generation 1 compiles and executes the conformance programs.

The JavaScript bootstrap is intentionally retained as Valen's stable path from zero. It does not need every language feature: it needs the subset required to compile the current native compiler source. If `src/` begins using a new feature, generation 0 must understand that feature before the bootstrap remains valid.

Generation 1 builds a working generation-2 compiler within a 3.25 GiB peak-RSS budget. The shared conformance corpus also verifies that generations 1 and 2 emit identical normalized target-independent IR.

## Compilation pipeline

Both implementations follow the same broad stages:

```text
source -> tokens -> AST -> module graph -> semantic symbols
       -> IR -> validation/canonicalization -> x86-64 assembly
       -> x86-64 encoding -> ELF object -> linker -> executable
```

- Tokenization records source spans for diagnostics.
- Structured diagnostics retain a primary span, secondary labeled spans, notes, and replacement hints. Generation 0 and the self-hosted compiler render the same stable text form.
- Parsing constructs object, member, statement, and expression nodes.
- Module loading resolves relative imports and `VALEN_LIBRARY_PATH`.
- Semantic analysis binds names, checks types/contracts, and enforces ownership.
- IR lowering produces target-independent blocks and instructions.
- Canonicalization folds integer and boolean constants, simplifies constant branches, removes unreachable blocks, and eliminates unused side-effect-free SSA values. Potentially trapping and stateful operations are retained.
- Validation rejects malformed IR before backend generation.
- The x86-64 backend emits a controlled Intel-syntax subset. Both generation 0 and the self-hosted
  compiler encode that subset and write ELF64 relocatable objects directly; the system toolchain is
  invoked only for linking.

Native executable builds can reuse validated backend artifacts by setting
`VALEN_CACHE_PATH` to an existing writable directory. Cache keys include every loaded module's
canonical path and source text plus the cache format and target. A changed entry point or
dependency therefore produces a cold build; a matching build skips semantic analysis, IR
lowering and validation, and backend generation. Set `VALEN_CACHE_TRACE=1` to report cache hits,
misses, and writes. Missing, unwritable, or invalid entries fall back to an ordinary build.

Object emission and linking are separate policy choices. Direct ELF emission does not imply a
freestanding executable: the emitted object may be linked without foreign libraries for the
self-contained Linux runtime, or passed to the hosted system linker with the explicit libraries
collected from `native ... from` declarations. The future integrated linker will be an additional
provider, not the removal of hosted linking. Generation 0 can stop after object emission with
`node bootstrap/compiler.js --emit-object <source> <output.o>`.

The self-hosted compiler can stop at the same boundary with
`valen --emit-object <source> -o <output.o>`.

`-O0` retains mandatory IR cleanup and validation while disabling optional optimizations. `-O1` is the default and enables constant folding, dead/unreachable elimination, conservative linear-scan register allocation, immediate selection, and peepholes. Unsupported levels are rejected instead of silently aliasing another mode. An integrated linker remains **WIP**.

## Repository map

| Path | Purpose |
| --- | --- |
| `bootstrap/` | JavaScript generation-0 compiler and tests |
| `src/` | Self-hosted compiler and standard runtime source |
| `lib/` | Libraries resolved through `VALEN_LIBRARY_PATH` |
| `examples/` | Small runnable Valen programs |
| `docs/` | User and contributor documentation |
| `docker/` | Multi-stage bootstrap proof |
| `language_checklist.md` | Detailed feature roadmap snapshot |

The main parallel files are intentionally easy to recognize: for example, `bootstrap/semantic.js` corresponds to `src/libSemantic.ar`, and `bootstrap/x86-64.js` corresponds to `src/libX86_64.ar`.

## Useful commands

Build generation 1:

```sh
node bootstrap/compiler.js src/valen.ar /tmp/valen-stage1
```

Run bootstrap tests:

```sh
node bootstrap/test/pipeline.test.js
```

Run native generation-1 conformance:

```sh
node bootstrap/test/generation1.test.js
```

Inspect the deterministic target-independent IR emitted by a native compiler:

```sh
./valen --emit-ir examples/simple/simple.ar
```

This length-delimited form includes types, fields, dispatch tables, functions, blocks,
instructions, operands, externals, and foreign libraries. The conformance suite compares it
across generations 1 and 2. The same suite runs its invalid-program corpus through both
generations and requires identical exit statuses and diagnostics.

Run compiler and generated-code benchmarks:

```sh
node scripts/benchmark.mjs
```

CI stores the JSON and Markdown results as build artifacts. See `benchmarks/README.md` for comparison rules and the optional generation-2 measurement.

Check JavaScript after modifying the bootstrap:

```sh
node --check bootstrap/x86-64.js
```

## Adding a language feature

The usual implementation order is:

1. Define observable syntax and semantics.
2. Decide whether generation 0 needs the feature for self-hosting.
3. Add parser/AST representation where necessary.
4. Add semantic validation and diagnostics.
5. Lower target-independent IR.
6. Implement runtime/backend behavior.
7. Add a focused bootstrap test and, when supported by generation 1, a conformance fixture.
8. Update docs and the tracked Gitea issue.

Do not duplicate a feature in generation 0 merely for symmetry. Do update generation 0 before using an otherwise unsupported feature in the compiler written in Valen.

## Native runtime boundary

Compiler-provided native symbols are emitted and validated by the backend. Ordinary x86-64 Linux
executables provide their own `_start` adapter and link with `-nostdlib`. Foreign C symbols and
hosted capabilities are linked only from explicitly named libraries. The current backend and
runtime implement the x86-64 System V ABI on Linux.

Additional targets, a freestanding runtime, and a stable plugin/package ABI are **WIP**.
