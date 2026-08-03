# Project status

## Working today

- JavaScript generation-0 compiler
- compiler written in Argon
- native x86-64 Linux executables
- objects, nested objects, constructors, fields, and methods
- inheritance, virtual dispatch, contracts, and checked casts
- public-by-default and private members
- overloads and trailing default arguments
- fixed-width integers and IEEE `f32`/`f64`
- arrays, generic objects, byte-oriented strings, and builders
- optionals for references
- ownership transfer, borrowed/weak references, `copy`, and `delete`
- tracing garbage collection and cycle-safe equality/hashing
- modules loaded from source and `ARGON_LIBRARY_PATH`
- source-level tests and native test execution
- native/C FFI boundaries
- inline operations, single-worker native execution, mutexes, conditions, and atomics

## WIP: language ergonomics

- **WIP:** array literals, insertion/removal, capacity controls, and slices
- **WIP:** Unicode code-point and grapheme-aware strings
- **WIP:** string interpolation and richer formatting
- **WIP:** optional primitive values and flow-sensitive optional narrowing
- **WIP:** generic constraints and generic methods
- **WIP:** implicit numeric promotion rules
- **WIP:** `else if`, expression-valued conditionals, and matching
- **WIP:** generalized safe `Result` propagation

## WIP: runtime and concurrency

- **WIP:** thread pools
- **WIP:** event-loop executors for files and networking
- **WIP:** additional operating systems and architectures
- x86-64 Linux executables own their `_start` adapter, link without an implicit C runtime, and
  reject target-native symbols that the backend cannot provide.
- **WIP:** general freestanding capability manifests, runtime hooks, and non-Linux code generation
- **WIP:** broader platform capability discovery for native facilities

Platforms without native threads are intended to use `InlineExecutor`; only x86-64 Linux native threading is currently implemented.

Blocking IPv4 TCP listen, accept, receive, send, and close are implemented directly with x86-64
Linux syscalls. The native HTTP example uses no external libraries. Nonblocking networking, DNS,
TLS, and production HTTP parsing remain **WIP**.

The freestanding language/runtime capability profile is defined for future kernels, firmware,
and embedded targets.

## WIP: compiler and tooling

- Generation 1 builds a working generation-2 compiler within the supported 3 GiB peak-RSS budget.
- Generation 1 and generation 2 produce equivalent normalized IR across the shared conformance corpus.
- Generation 1 and generation 2 report identical diagnostics for the shared invalid-program corpus.
- JavaScript generation 0 is intentionally retained as the stable path from zero; generated native compilers run without JavaScript.
- **WIP:** formatter and language server
- **WIP:** richer diagnostics with notes, fixes, and multiple spans
- **WIP:** package metadata, versioning, and compiled libraries
- **WIP:** optimization levels, register allocation, and peephole optimization
- **WIP:** direct ELF object emission and an integrated linker
- Repeatable compiler and generated-code benchmarks report compile time, memory, executable size, and runtime speed; expanding the workload corpus remains **WIP**.

## Maturity

Argon is ready for language experiments, compiler development, small native examples, and demonstrating a complete self-hosting toolchain. It is not yet ready to promise stable syntax, binary compatibility, production performance, security hardening, or cross-platform application deployment.

The authoritative active work is tracked in Gitea. The repository’s [language checklist](../language_checklist.md) is a readable roadmap snapshot.
