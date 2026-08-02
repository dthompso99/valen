# Argon language roadmap

The bootstrap compiler proves the language can compile native programs. This roadmap begins with language semantics and ergonomics; optimization and additional machine targets come after the object and type models are stable.

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
- [ ] Define contract-typed reference representation and dispatch
- [ ] Define `public`, `private`, and module-level visibility
- [ ] Add method and constructor overload resolution
- [ ] Add default arguments without making call resolution ambiguous
- [ ] Specify object identity, deep structural equality, cycles, and hashing separately

## 2. Ownership, references, and lifetime

- [ ] Specify owning member references and ownership transfer
- [ ] Specify local and parameter borrowing rules
- [ ] Define non-owning and weak-reference escape hatches
- [ ] Define returned-reference and locally-created-object lifetimes
- [ ] Define ownership behavior for arrays and other collections
- [ ] Add explicit `delete` and deterministic disposal semantics
- [ ] Define native/external-resource ownership
- [ ] Detect unconditional field-initializer cycles
- [ ] Add precise root tracking and tracing garbage collection
- [ ] Define cycle collection and finalization behavior
- [ ] Reserve an explicit unsafe/raw-memory boundary without exposing pointers in ordinary code

## 3. Type-system expansion

- [ ] Add general-purpose generics beyond `Array<T>`
- [ ] Define generic constraints using interfaces or another contract mechanism
- [ ] Add optional value types for stack primitives
- [ ] Add flow-sensitive optional narrowing
- [ ] Generalize safe `Result` propagation
- [ ] Add floating-point types, literals, conversions, arithmetic, NaN rules, and ABI support
- [ ] Define numeric promotion and mixed-width arithmetic rules

## 4. Control flow and iteration

- [x] Define all method calls as synchronous; unfinished work must be represented explicitly by a returned object
- [ ] Define the standard contract for an unfinished operation, including completion, failure, cancellation, and explicit waiting
- [ ] Add native concurrency facilities capable of backing operation objects without changing ordinary call semantics
- [ ] Implement short-circuit lowering for `&&` and `||`
- [ ] Add iterators and `for` loops
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
- [ ] Define collection equality and hashing rules

## 6. Modules, diagnostics, and tooling

- [ ] Finalize package and module search-path rules
- [ ] Define library versioning and compiled-library metadata
- [ ] Define stable native and dynamic-library FFI boundaries
- [ ] Add diagnostic severity enums, notes, fix hints, and multi-span labels
- [ ] Add source-level test syntax and a native test runner
- [ ] Add formatter rules while preserving optional condition parentheses
- [ ] Add a language-server protocol implementation

## 7. Compiler and generated-code efficiency

- [ ] Replace linear compiler symbol collections where profiling justifies it
- [ ] Add a process-lifetime arena for compiler allocations
- [ ] Reduce temporary immutable-string allocation during assembly generation
- [ ] Add IR validation and canonicalization passes
- [ ] Add dead-block, dead-value, and constant-folding passes
- [ ] Add register allocation
- [ ] Add instruction selection and peephole optimization
- [ ] Add optimization-level flags with predictable semantics
- [ ] Measure compile time, peak memory, executable size, and runtime performance
- [ ] Emit ELF objects directly without requiring the system assembler
- [ ] Add an integrated linker only after object emission is stable

## 8. Bootstrap proof and portability

- [ ] JavaScript bootstrap builds compiler generation 0
- [ ] Generation 0 compiles the example programs
- [ ] Generation 0 compiles the Argon compiler source
- [ ] Generation 1 passes the compiler test suite
- [ ] Generation 1 builds generation 2 within the supported memory budget
- [ ] Generations 1 and 2 produce semantically equivalent IR
- [ ] Invalid programs produce consistent diagnostics across generations
- [ ] Remove the final JavaScript runtime dependency
- [ ] Stabilize the x86-64 Linux ABI and runtime
- [ ] Add ARM64 and additional operating-system targets
- [ ] Define the freestanding subset required for kernels and embedded systems
