# Compiler developer guide

## The bootstrap model

Argon is developed through two compiler implementations:

1. `bootstrap/` is generation 0, written in JavaScript.
2. `src/` is the compiler written in Argon.
3. Generation 0 compiles `src/argon.ar` into a native generation-1 compiler.
4. Generation 1 compiles and executes the conformance programs.

The bootstrap compiler does not need every language feature. It needs the subset required to compile the current native compiler source. If `src/` begins using a new feature, generation 0 must understand that feature before the bootstrap remains valid.

Building generation 2 within the target memory budget and comparing generation-1/2 output are **WIP**.

## Compilation pipeline

Both implementations follow the same broad stages:

```text
source -> tokens -> AST -> module graph -> semantic symbols
       -> IR -> validation/canonicalization -> x86-64 assembly -> executable
```

- Tokenization records source spans for diagnostics.
- Parsing constructs object, member, statement, and expression nodes.
- Module loading resolves relative imports and `ARGON_LIBRARY_PATH`.
- Semantic analysis binds names, checks types/contracts, and enforces ownership.
- IR lowering produces target-independent blocks and instructions.
- Validation rejects malformed IR before backend generation.
- The x86-64 backend emits assembly; the system C toolchain assembles and links it.

Direct object-file emission, an integrated linker, register allocation, and optimization levels are **WIP**.

## Repository map

| Path | Purpose |
| --- | --- |
| `bootstrap/` | JavaScript generation-0 compiler and tests |
| `src/` | Self-hosted compiler and standard runtime source |
| `lib/` | Libraries resolved through `ARGON_LIBRARY_PATH` |
| `examples/` | Small runnable Argon programs |
| `docs/` | User and contributor documentation |
| `docker/` | Multi-stage bootstrap proof |
| `language_checklist.md` | Detailed feature roadmap snapshot |

The main parallel files are intentionally easy to recognize: for example, `bootstrap/semantic.js` corresponds to `src/libSemantic.ar`, and `bootstrap/x86-64.js` corresponds to `src/libX86_64.ar`.

## Useful commands

Build generation 1:

```sh
node bootstrap/compiler.js src/argon.ar /tmp/argon-stage1
```

Run bootstrap tests:

```sh
node bootstrap/test/pipeline.test.js
```

Run native generation-1 conformance:

```sh
node bootstrap/test/generation1.test.js
```

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

Do not duplicate a feature in generation 0 merely for symmetry. Do update generation 0 before using an otherwise unsupported feature in the compiler written in Argon.

## Native runtime boundary

Compiler-provided native symbols are emitted by the backend. Foreign C symbols are linked from explicitly named libraries. The current backend and runtime implement the x86-64 System V ABI on Linux.

Additional targets, a freestanding runtime, and a stable plugin/package ABI are **WIP**.
