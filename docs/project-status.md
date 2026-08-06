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
- tracing garbage collection with cooperative native-worker safepoints, plus cycle-safe equality/hashing
- deterministic importer-relative, project-root, and external `VALEN_LIBRARY_PATH` source modules with owning-root confinement
- source-level tests and native test execution
- native/C FFI boundaries
- inline operations, single-worker and fixed-size pooled native execution, mutexes, conditions, and atomics
- synchronized cross-thread GC roots and reclamation at native worker join boundaries

## WIP: language ergonomics

- Array literals infer homogeneous owned element types, including numeric promotion and nested arrays.
- Array insertion/removal, explicit capacity controls, ownership-safe slices, and nested multidimensional arrays are implemented.
- Strings provide explicit UTF-8 byte, Unicode code-point, and practical grapheme-cluster operations.
- String and integer expression interpolation is implemented; float, boolean, alignment, precision, and radix formatting remain **WIP**.
- flow-sensitive optional narrowing for stable locals and parameters
- **WIP:** generic methods
- lossless mixed-width integer promotion and predictable floating-point promotion
- `else if` chains, expression-valued conditionals, payload-free enums, and exhaustive enum statement matching are implemented; associated-value sum types and expression-valued matching remain **WIP**.
- safe `?` propagation for optionals and result objects exposing public `valid:bool` and `value` fields

## WIP: runtime and concurrency

- Poll-backed readiness operations and an event-loop executor for files and networking
- **WIP:** the generation-0 `aarch64-linux` backend cross-compiles primitive integer and control-flow
  programs with full-width constants, conversions, checked division, loops, direct calls, and scalar
  floating-point arithmetic and comparisons into internally encoded, internally linked static ELF
  executables. Float-to-integer conversions reject NaN and out-of-range values with runtime status 76.
  Direct calls support AAPCS64 integer, floating, and overflow stack arguments. Basic objects share the
  x86-64 16-byte header and packed field layout, zero-initialize storage, run field initializers before
  constructors, and preserve reference identity. ABI-compatible type descriptors carry base links and
  virtual method slots, contract tables, and contract method tables, enabling inherited, overridden, and
  contract-typed dispatch. Runtime type tests and checked reference casts walk both base links and contract
  relationships. Arrays use the common 40-byte header and support allocation, length and capacity, checked
  indexing, replacement, append, insert, remove, reserve, and shrink-to-fit across scalar and reference-sized
  elements. The generation-0 allocator currently retains replaced buffers as anonymous mappings for process
  lifetime. Copied slices support value elements and explicit reference aliases; deep-copy slices of owned
  managed elements and weak-element slices remain WIP with structural hooks and tracing GC. AArch64 strings
  support UTF-8 literals, byte length and indexing, equality, concatenation, copied byte slices, and copied
  conversion to and from byte arrays. Unicode code-point length/index operations decode validated UTF-8
  and replace malformed bytes. Grapheme length/index operations share the x86-64 rules for combining
  marks, variation selectors, emoji modifiers, ZWJ sequences, regional-indicator pairs, and CRLF.
  Decimal formatting covers every signed and unsigned integer width. Builders/interpolation, native
  facilities, and self-hosting remain WIP on AArch64.
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
- The editor-neutral language server provides live diagnostics, quick fixes, hover, go-to-definition, document symbols, and deterministic document formatting; editor packaging remains **WIP**.
- Diagnostics use a first-class `DiagnosticSeverity` enum with exhaustive rendering, primary and secondary source labels, explanatory notes, and precise replacement hints with generation parity.
- The self-hosted tokenizer and parser exchange first-class `TokenKind` values while preserving source lexemes as strings.
- Compiled libraries are emitted as relocatable objects with SemVer `.vmeta` manifests containing compiler-interface, target, ABI, dependency-interface, and integrity fingerprints. The toolchain packages and resolves a versioned x86-64 sysroot containing source, `.vmi`, `.vmeta`, and static `.o` artifacts; source-free interface hydration, registry resolution, and lockfiles remain **WIP** package tooling.
- The standard-library boundary is defined as capability-oriented modules distributed through a compiler-relative sysroot. The packaged sysroot includes source, interfaces, metadata, and static objects, and compiled imports are linked from it automatically. Source-backed cross-module generic specialization provides owning `StringMap<T>` and `StringSet`; primitive map values, general `HashMap<K, V>`, and an optional future shared ABI remain **WIP**.
- Primitive SSA temporaries use conservative linear-scan allocation across `r12`-`r15`, with stack spills and GC-visible managed references.
- IR canonicalization folds integer/boolean constants, simplifies constant branches, removes unreachable blocks, and eliminates unused pure SSA values without suppressing runtime traps or state changes.
- Integer instruction selection uses signed 32-bit immediates for arithmetic, bitwise, shift, and comparison operations; generated-function peepholes remove redundant moves and neutral operations.
- `-O0` performs only mandatory IR cleanup and validation; `-O1` is the default and enables constant folding, dead/unreachable elimination, register allocation, immediate selection, and peepholes. Unsupported levels are rejected.
- Generation 0 emits x86-64 and the initial AArch64 subset as ELF64 relocatable objects without a
  system assembler; the self-hosted encoder remains x86-64-only.
- The integrated ELF linker handles x86-64 and AArch64 branch relocations and emits page-size-neutral
  AArch64 executables with 64 KiB segment alignment; `--linker system` remains available for foreign libraries.
- Cold freestanding builds emit versioned module interfaces and dependency-fingerprinted module objects, lower implementations in bounded chunks, and retain importers when only a dependency body changes.
- Repeatable compiler and generated-code benchmarks report compile time, memory, executable size, and runtime speed; expanding the workload corpus remains **WIP**.
- The self-hosted x86-64 backend indexes hot compiler lookups and streams common assembly fragments directly into its builder to avoid repeated linear scans and temporary concatenated strings.

## Maturity

Valen is ready for language experiments, compiler development, small native examples, and demonstrating a complete self-hosting toolchain. It is not yet ready to promise stable syntax, binary compatibility, production performance, security hardening, or cross-platform application deployment.

The authoritative active work is in the [issue tracker](https://gitea.hallrd.click/dthompson/valen/issues). This page summarizes the currently implemented surface and known gaps without maintaining a second task list.
