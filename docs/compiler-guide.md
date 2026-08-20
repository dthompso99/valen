# Compiler developer guide

Implementation work must preserve the [core specification](specification/README.md) or revise its rule and conformance mapping under the documented compatibility policy.

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
       -> IR -> validation/canonicalization -> target backend
       -> native encoding -> ELF object -> linker -> executable
```

- Tokenization records source spans for diagnostics. Token categories use the first-class `Compiler.TokenKind` enum while each token retains its original string lexeme.
- Structured diagnostics retain a primary span, secondary labeled spans, notes, and replacement hints. Generation 0 and the self-hosted compiler render the same stable text form.
- Parsing constructs object, member, statement, and expression nodes.
- Module loading separates importer-relative (`./` and `../`), project-root (`/`), and ordered `VALEN_LIBRARY_PATH` imports. Project and library-relative imports cannot escape their owning root.
- Semantic analysis binds names, checks types/contracts, and enforces ownership.
- IR lowering produces target-independent blocks and instructions.
- Canonicalization folds integer and boolean constants, simplifies constant branches, removes unreachable blocks, and eliminates unused side-effect-free SSA values. Potentially trapping and stateful operations are retained.
- Validation rejects malformed IR before backend generation.
- The x86-64 backend emits a controlled Intel-syntax subset. Both generation 0 and the self-hosted
  compiler encode that subset and write ELF64 relocatable objects directly.
- The optional LLVM backend translates the same validated Valen IR into textual LLVM IR for
  `x86_64-linux`. Clang verifies and optimizes that module, while Valen's existing freestanding
  runtime object and linker retain startup, ownership, garbage collection, native facilities,
  and static executable behavior. It is an additional backend, not a replacement for Valen's
  native encoders.
- The initial generation-0 AArch64 backend emits and directly encodes a deliberately restricted
  integer/control-flow subset, including full-width constants, integer conversions and normalization,
  division checks, loops, direct calls, scalar `f32`/`f64` arithmetic and comparisons, and checked
  numeric conversions. Direct calls follow the AAPCS64 integer, floating-register, and overflow-stack
  argument classes. Basic objects use the common 16-byte header and packed field layout, with zeroed
  allocation and constructor lowering. Their headers point to ABI-compatible type descriptors whose
  method slots drive inherited and overridden virtual dispatch. Descriptor-owned contract lists and method
  tables provide contract-typed dispatch, while base and contract walks implement runtime type tests and
  checked reference casts. Arrays preserve the common 40-byte header and provide allocation, length and
  capacity, width-correct loads and stores, checked indexing with runtime status 70, append, insert, remove,
  reserve, and shrink-to-fit. Buffer growth uses allocate-copy-update until tracing reclamation is available.
  Slices copy value elements into independent buffers and preserve aliases for explicit `ref` elements;
  deep-copy slices of owned managed elements await structural copy hooks. UTF-8 string literals use the
  common 24-byte data/length/capacity layout; the initial runtime provides byte length/indexing, equality,
  concatenation, copied byte slicing, copied conversion between strings and `Array<u8>`, validated UTF-8
  code-point length/index operations, the same initial grapheme segmentation rules as x86-64, decimal
  formatting for every signed and unsigned integer width, and capacity-growing string builders used by
  interpolation. It is the cross-compilation foothold for the full runtime and self-hosted backend, not yet
  a general AArch64 language target. Its first freestanding native facilities cover console/error output,
  signed-integer printing, process exit, garbage collection, and foundational file I/O with explicit error state.
  The startup adapter preserves `argc`, `argv`, and `envp` for managed argument arrays, current-directory
  discovery, and copied environment values.
  A freestanding linker adapter constructs `cc -nostdlib -no-pie` arguments, preserves library and direct
  object inputs, and reports normal or signal-derived child status without libc process helpers.
  Weak object fields and weak array elements/slices observe the shared
  object liveness word and become null after explicit destruction. Managed object, array, and dynamic-string
  descriptors carry the common hidden 48-byte GC allocation prefix, and functions publish precise managed
  stack slots through linked root records. Cycle-safe marking follows generated object and managed-array trace
  callbacks. Explicit collection sweeps unreachable descriptors, releases array and dynamic-string backing
  mappings, and clears weak references. Allocation pressure triggers collection at an adaptive threshold with
  a 1 MiB minimum.

Native executable builds can reuse validated backend artifacts by setting
`VALEN_CACHE_PATH` to an existing writable directory. Cache keys include every loaded module's
canonical path and source text plus the cache format and target. A changed entry point or
dependency therefore produces a cold build; a matching build skips semantic analysis, IR
lowering and validation, and backend generation. Set `VALEN_CACHE_TRACE=1` to report cache hits,
misses, and writes. Missing, unwritable, or invalid entries fall back to an ordinary build.

Cold freestanding builds also create versioned `.vmi` module-interface artifacts and linkable
per-module implementation chunks. Interface and implementation fingerprints are independent:
changing a method body rebuilds that module, while importers remain reusable until an exported
signature, type, contract, ownership rule, or native dependency changes. Modules are lowered and
encoded in dependency order. Once an implementation object is complete, its source text and method
bodies are released while declaration summaries remain available to later modules. This keeps the
function IR and implementation AST working set bounded by the active module instead of the entire
program. The whole-program cache remains the faster path for an exact warm build.

The interface and chunk formats are internal, versioned compiler artifacts, not a stable Valen ABI.
Deleting the cache directory is always safe.

The installed standard library uses the same modular static-object direction through a
compiler-relative sysroot. Verified `.vmi`, `.vmeta`, and `.o` artifacts suppress implementation
lowering and feed the selected object directly into the static link. Static linking remains permanently supported; optional shared-library
distribution waits for a versioned Valen ABI. Generic packages additionally retain a template
representation for cross-module specialization. See the [standard library architecture](standard-library.md).

Published compiled libraries use a separate boundary: `--emit-library` writes an ELF64 relocatable
object and a deterministic `.vmeta` sidecar. `--library-version` requires SemVer syntax. Metadata
format 1 identifies `valen-interface-1`, `x86_64-linux`, and `valen-native-1`, fingerprints the
exported interface, implementation and object bytes, and records each imported interface.
`--validate-library` checks those compatibility fields and confirms the adjacent object still
matches its manifest. These names are explicit compatibility epochs; changing the compiler
implementation alone does not invalidate a library, while a compiler-interface, target, or ABI
change does.

Generation-zero executable builds also write an adjacent `.vbuild` identity containing the compiler
interface, target/ABI, optimization/backend/linker choices, instrumentation state, module and dependency
fingerprints, optional project/lock fingerprints, and final executable fingerprint. Inspect it with
`node bootstrap/compiler.js --inspect-build <output>.vbuild`. See [build identity](build-identity.md).
Compare two identities with `--explain-build <previous.vbuild> <current.vbuild>` to obtain stable
machine-readable rebuild reasons, including whether a dependency change affects only its implementation
or requires importer rebuilds.

Object emission and linking are separate policy choices. Direct ELF emission does not imply a
freestanding executable: the emitted object may be linked without foreign libraries for the
self-contained Linux runtime, or passed to the hosted system linker with the explicit libraries
collected from `native ... from` declarations. The integrated linker handles freestanding x86-64
ELF executables, while `--linker system` preserves hosted linking. The default `--linker auto`
selects the system linker only for programs with foreign libraries. Generation 0 can stop after object emission with
`node bootstrap/compiler.js --emit-object <source> <output.o>`.

The self-hosted compiler can stop at the same boundary with
`valen --emit-object <source> -o <output.o>`.

`-O0` retains mandatory IR cleanup and validation while disabling optional optimizations. `-O1` is the default and enables constant folding, dead/unreachable elimination, conservative linear-scan register allocation, immediate selection, and peepholes. Unsupported levels are rejected instead of silently aliasing another mode.

## Repository map

| Path | Purpose |
| --- | --- |
| `bootstrap/` | JavaScript generation-0 compiler and tests |
| `src/` | Self-hosted compiler and standard runtime source |
| `lib/` | Libraries resolved through `VALEN_LIBRARY_PATH` |
| `examples/` | Small runnable Valen programs |
| `docs/` | User and contributor documentation |
| `docker/` | Multi-stage bootstrap proof |

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

Build through LLVM on x86-64 Linux:

```sh
./valen --backend llvm --target x86_64-linux examples/simple/simple.ar -O1 -o /tmp/simple-llvm
/tmp/simple-llvm
```

The LLVM path requires `/usr/bin/clang`; the ordinary native backend, bootstrap chain, Docker
builder, and scratch runtime do not. Both `-O0` and `-O1` are supported. The generated textual
module remains beside the executable as `<output>.ll`, with LLVM and runtime objects at
`<output>.llvm.o` and `<output>.runtime.o` for inspection. Library and standalone object emission
remain native-backend features for now.

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
8. Update the documentation and tracked issue.

Do not duplicate a feature in generation 0 merely for symmetry. Do update generation 0 before using an otherwise unsupported feature in the compiler written in Valen.

## Native runtime boundary

Compiler-provided native symbols are emitted and validated by the backend. Ordinary x86-64 Linux
executables provide their own `_start` adapter and link with `-nostdlib`. Foreign C symbols and
hosted capabilities are linked only from explicitly named libraries. The current backend and
runtime implement the x86-64 System V ABI on Linux.

Additional targets, a freestanding runtime, and a stable plugin/package ABI are **WIP**.
