# Valen language roadmap

The bootstrap compiler proves the language can compile native programs. This roadmap begins with language semantics and ergonomics; optimization and additional machine targets come after the object and type models are stable.

Active work is tracked in [Gitea issues](https://gitea.hallrd.click/dthompson/valen/issues?labels=1). The unchecked entries below are the roadmap snapshot from which those issues were created; update and close the corresponding Gitea issue as work progresses rather than maintaining status in two places.

## 1. Object model and contracts

- [x] Define single object inheritance through `Child inherits Parent {{ ... }}`
- [x] Define inherited field layout and construction order: parent fields first, then child fields, before `__`
- [x] Define optional constructor chaining through explicit `super()` calls
- [x] Define nominal subtype assignability, identity-preserving upcasts, optional checked downcasts, and runtime `is` checks
- [x] Keep overrides implicit: a compatible same-name child method automatically replaces the inherited method; no `override` modifier
- [x] Define runtime virtual dispatch for inherited overrides
- [x] Define direct non-constructor base-method calls through `super.method()`
- [x] Use ordinary objects as contracts rather than adding a separate interface declaration category
- [x] Define `implements` syntax: `Thing implements Printable, Disposable {{ ... }}`
- [x] Validate that every required contract method is implemented with a compatible signature
- [x] Define one-word contract-typed references and runtime descriptor dispatch while preserving object identity
- [x] Define default-public and owner-only `private` member visibility; private methods are non-virtual and cannot be overridden
- [x] Add method and constructor overload resolution
- [x] Add trailing default arguments with ambiguity diagnostics
- [x] Specify and implement identity separately from cycle-safe structural equality and hashing

## 2. Ownership, references, and lifetime

- [x] Specify owning member references and ownership transfer
- [x] Specify local and parameter borrowing rules
- [x] Add explicit non-owning `member ref name:Type` references without ownership transfer
- [x] Add nullable, non-owning `member weak name:Type?` references and preserve them in IR
- [x] Invalidate weak object references after logical destruction
- [x] Make reference returns owning by default, add explicit `-> ref Type`, and destroy untransferred object locals at scope exit
- [x] Make ordinary array insertion and replacement transfer ownership after element ownership is expressible
- [x] Preserve cycle-safe deep copying for ordinary owning arrays
- [x] Add `Array<ref T>` and `Array<weak T?>` policies before destroying replaced elements or recursively destroying arrays at scope exit
- [x] Add explicit `delete` with deterministic logical destruction (physical reclamation deferred)
- [x] Define native/external-resource ownership
- [x] Detect unconditional field-initializer cycles
- [x] Add precise stack-slot root tracking and explicit tracing garbage collection
- [x] Define cycle collection, weak-reference clearing, and internal runtime finalization behavior
- [x] Reserve an explicit unsafe/raw-memory boundary without exposing pointers in ordinary code

## 3. Type-system expansion

- [x] Add general-purpose generic objects beyond `Array<T>` using invariant monomorphized specializations
- [ ] Define generic constraints using interfaces or another contract mechanism
- [ ] Add optional value types for stack primitives
- [x] Add flow-sensitive optional narrowing
- [x] Generalize safe `Result` propagation
- [x] Add floating-point types, literals, conversions, arithmetic, NaN rules, and ABI support
- [x] Define numeric promotion and mixed-width arithmetic rules

## 4. Control flow and iteration

- [x] Define all method calls as synchronous; unfinished work must be represented explicitly by a returned object
- [x] Define the standard operation state, stable result objects, cooperative cancellation, optional progress, and explicit waiting
- [x] Define a `Work` contract with a synchronous `run()` entry point
- [x] Define an `Executor` contract whose `submit(work)` returns an operation object
- [x] Implement `InlineExecutor` as the deterministic reference execution policy and non-threaded fallback
- [x] Specify ownership transfer and retained references for submitted work and operation results
- [x] Implement a native single-worker `ThreadExecutor` with portable inline fallback
- [x] Add native mutex, condition, and atomic synchronization objects
- [ ] Add a thread-pool executor after single-worker correctness is established
- [x] Add event-loop executors for nonblocking file and network I/O
- [x] Implement short-circuit lowering for `&&` and `||`
- [x] Add iterators and `for` loops
- [ ] Add `else if` shorthand
- [ ] Evaluate expression-valued conditionals and richer control-flow expressions
- [ ] Define exhaustive matching if a sum type or enum model is introduced

## 5. Collections and strings

- [ ] Add array literals
- [ ] Add array removal and insertion
- [ ] Add explicit capacity reservation and shrinking
- [ ] Add array slices/views and multidimensional conveniences
- [ ] Add Unicode code-point and grapheme-aware string operations
- [ ] Add string interpolation and richer formatting
- [ ] Add bulk-copy builder optimizations and `Array<u8>` conversion APIs
- [x] Define array equality and hashing as ordered structural traversal

## 6. Modules, diagnostics, and tooling

- [ ] Finalize package and module search-path rules
- [ ] Define library versioning and compiled-library metadata
- [x] Define stable native and dynamic-library FFI boundaries
- [ ] Add diagnostic severity enums, notes, fix hints, and multi-span labels
- [x] Add source-level test syntax and a native test runner
- [ ] Add formatter rules while preserving optional condition parentheses
- [ ] Add a language-server protocol implementation

## 7. Compiler and generated-code efficiency

- [ ] Replace linear compiler symbol collections where profiling justifies it
- [x] Add a process-lifetime arena for compiler allocations
- [ ] Reduce temporary immutable-string allocation during assembly generation
- [x] Add IR validation and canonicalization passes
- [x] Add dead-block, dead-value, and constant-folding passes
- [x] Add register allocation
- [x] Add instruction selection and peephole optimization
- [ ] Add optimization-level flags with predictable semantics
- [x] Measure compile time, peak memory, executable size, and runtime performance
- [ ] Emit ELF objects directly without requiring the system assembler
- [ ] Add an integrated linker only after object emission is stable

## 8. Bootstrap proof and portability

- [x] JavaScript bootstrap builds compiler generation 0
- [x] Generation 0 compiles the example programs
- [x] Generation 0 compiles the Valen compiler source
- [x] Generation 1 passes the compiler test suite
- [x] Generation 1 builds generation 2 within the supported 3 GiB peak-RSS budget
- [x] Generations 1 and 2 produce semantically equivalent normalized IR
- [x] Invalid programs produce consistent diagnostics across generations
- [x] Retain JavaScript generation 0 as the stable path from zero; native generations have no JavaScript runtime dependency
- [x] Stabilize the x86-64 Linux ABI and runtime
- [ ] Add ARM64 and additional operating-system targets
- [x] Define the freestanding capability profile required for kernels and embedded systems
- [x] Remove implicit C-runtime startup dependencies and validate target-provided native facilities
- [x] Provide a syscall-only native HTTP service example on x86-64 Linux
