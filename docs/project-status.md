# Project status

## Working today

- JavaScript generation-0 compiler
- compiler written in Valen
- native x86-64 Linux executables
- objects, nested objects, constructors, fields, and methods
- inheritance, virtual dispatch, contracts, and checked casts
- public-by-default and private members
- overloads and trailing default arguments
- fixed-width integers and IEEE `f32`/`f64`
- dynamic arrays with insertion/removal, invariant generic objects with contract constraints, byte-oriented strings, bulk byte/string conversion, and builders
- optionals for references and primitives, with flow-sensitive narrowing and propagation
- ownership transfer, borrowed/weak references, `copy`, and `delete`
- tracing garbage collection and cycle-safe equality/hashing
- deterministic importer-relative, project-root, and external `VALEN_LIBRARY_PATH` source modules with owning-root confinement
- source-level tests and native test execution
- native/C FFI boundaries
- inline operations, single-worker native execution, mutexes, conditions, and atomics

## WIP: language ergonomics

- Array literals infer homogeneous owned element types, including numeric promotion and nested arrays.
- Array insertion/removal and explicit capacity controls are implemented; slices remain **WIP**.
- **WIP:** Unicode code-point and grapheme-aware strings
- String and integer expression interpolation is implemented; float, boolean, alignment, precision, and radix formatting remain **WIP**.
- flow-sensitive optional narrowing for stable locals and parameters
- **WIP:** generic methods
- lossless mixed-width integer promotion and predictable floating-point promotion
- **WIP:** `else if`, expression-valued conditionals, and matching
- safe `?` propagation for optionals and result objects exposing public `valid:bool` and `value` fields

## WIP: runtime and concurrency

- **WIP:** thread pools
- Poll-backed readiness operations and an event-loop executor for files and networking
- **WIP:** additional operating systems and architectures
- x86-64 Linux executables own their `_start` adapter, link without an implicit C runtime, and
  reject target-native symbols that the backend cannot provide.
- **WIP:** general freestanding capability manifests, runtime hooks, and non-Linux code generation
- **WIP:** broader platform capability discovery for native facilities

Platforms without native threads are intended to use `InlineExecutor`; only x86-64 Linux native threading is currently implemented.

IPv4 TCP listen, accept, receive, send, descriptor access, and nonblocking mode are implemented
directly with x86-64 Linux syscalls. The native HTTP example uses a persistent readiness loop,
serves health, configuration, and file-backed value routes, and atomically replaces synchronized
state files. Its readiness-driven connection loop provides monotonic timeouts, disconnect
cancellation, bounded request/response buffering, and partial nonblocking writes without requiring
threads. It has live generation-1/generation-2 concurrency and restart coverage without external
libraries. DNS, TLS, concurrent persistence, graceful shutdown, and production HTTP parsing remain **WIP**.

The SQLite service demonstrates opaque foreign resources, transactional prepared statements, native
error conversion, and explicit dynamic dependency provisioning. SQLite is optional: ordinary Valen
executables do not acquire a C runtime or SQLite dependency unless they import that foreign boundary.
Static foreign-library selection and a vendored SQLite deployment remain **WIP**.

The freestanding language/runtime capability profile is defined for future kernels, firmware,
and embedded targets.

## WIP: compiler and tooling

- Generation 1 builds a working generation-2 compiler within the supported 3.25 GiB peak-RSS budget.
- Generation 1 and generation 2 produce equivalent normalized IR across the shared conformance corpus.
- Generation 1 and generation 2 report identical diagnostics for the shared invalid-program corpus.
- JavaScript generation 0 is intentionally retained as the stable path from zero; generated native compilers run without JavaScript.
- The editor-neutral language server provides live diagnostics, quick fixes, hover, go-to-definition, and document symbols; editor packaging and the formatter remain **WIP**.
- Diagnostics have named error/warning/note severities, primary and secondary source labels, explanatory notes, and precise replacement hints with generation parity.
- Compiled libraries are emitted as relocatable objects with SemVer `.vmeta` manifests containing compiler-interface, target, ABI, dependency-interface, and integrity fingerprints. Registry resolution and lockfiles remain **WIP** package tooling.
- Primitive SSA temporaries use conservative linear-scan allocation across `r12`-`r15`, with stack spills and GC-visible managed references.
- IR canonicalization folds integer/boolean constants, simplifies constant branches, removes unreachable blocks, and eliminates unused pure SSA values without suppressing runtime traps or state changes.
- Integer instruction selection uses signed 32-bit immediates for arithmetic, bitwise, shift, and comparison operations; generated-function peepholes remove redundant moves and neutral operations.
- `-O0` performs only mandatory IR cleanup and validation; `-O1` is the default and enables constant folding, dead/unreachable elimination, register allocation, immediate selection, and peepholes. Unsupported levels are rejected.
- Generation 0 and the self-hosted compiler emit ELF64 relocatable objects without a system assembler.
- The integrated x86-64 ELF linker handles freestanding executables; `--linker system` remains available for foreign libraries.
- Cold freestanding builds emit versioned module interfaces and dependency-fingerprinted module objects, lower implementations in bounded chunks, and retain importers when only a dependency body changes.
- Repeatable compiler and generated-code benchmarks report compile time, memory, executable size, and runtime speed; expanding the workload corpus remains **WIP**.

## Maturity

Valen is ready for language experiments, compiler development, small native examples, and demonstrating a complete self-hosting toolchain. It is not yet ready to promise stable syntax, binary compatibility, production performance, security hardening, or cross-platform application deployment.

The authoritative active work is tracked in Gitea. The repository’s [language checklist](../language_checklist.md) is a readable roadmap snapshot.
