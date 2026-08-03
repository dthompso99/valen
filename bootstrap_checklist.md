# Argon Bootstrap and Self-Hosting Checklist

The bootstrap is complete when the JavaScript compiler can build an Argon compiler, and that generated compiler can compile its own source again without using JavaScript at runtime.

## Current foundation

- [x] Whole-file tokenization with source locations
- [x] Objects, nested objects, methods, parameters, members, and locals
- [x] Newline and semicolon statement delimiters
- [x] Expressions, calls, member access, assignment, and construction
- [x] Imports, source-module loading, libraries, and native declarations
- [x] Semantic name resolution and basic type checking
- [x] Target-independent IR
- [x] Basic stack-based x86-64 Linux generation
- [x] Native integer printing and allocation
- [x] Executable assembly and linking

## Phase 1: Self-hosting language subset

### Control flow

- [x] Boolean literals
- [x] `if` and `else`
- [x] `while`
- [x] `break` and `continue`
- [x] Definite-return analysis across branches
- [x] IR basic blocks and branches
- [x] x86-64 branch generation

### Primitive types

- [x] `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, and `u64`
- [x] Integer literal range checking
- [x] Explicit integer conversions
- [x] Width-aware arithmetic, loads, and stores
- [x] Signed and unsigned comparisons and division
- [x] Stable size and alignment rules

### Arrays and indexing

- [x] Array or buffer representation
- [x] Index expressions and indexed assignment
- [x] Length access
- [x] Bounds checking
- [x] Allocation by element count
- [x] Append and growth
- [x] Array iteration using `while`

### Strings

- [x] Runtime string representation
- [x] Length and byte indexing
- [x] Equality, concatenation, and slicing
- [x] Integer-to-string conversion
- [x] String builder backed by a growable byte buffer
- [x] Escaped-string decoding
- [x] UTF-8 byte-oriented bootstrap policy

### Optional values and diagnostics

- [x] Null and reference optionals with checked unwrap
- [x] Safe null propagation for optional-returning methods
- [x] Diagnostic objects and collections
- [x] Nonzero compiler exit status on errors

### Collections and scopes

- [x] Dynamic arrays
- [x] Linear name lookup fallback
- [x] Parent-linked scopes
- [x] String-keyed hash maps for symbol lookup
- [x] String sets backed by the bootstrap hash map

### Object semantics

- [x] Final constructor rules: entry returns void or integer; object constructors return void
- [x] Default field initialization through zero-filled allocation
- [x] Field initializer lowering before constructor calls
- [x] Object and reference identity with `===` and `!==`
- [x] Bootstrap ownership: strong aliases with process-lifetime allocation
- [x] Recursive object layouts through pointer-sized references
- [x] Bootstrap visibility: all declarations visible with unique names
- [x] Runtime virtual dispatch, subtype checks, checked downcasts, and explicit base calls

## Phase 2: Native runtime

- [x] Basic allocation
- [x] Signed `i64` output
- [x] Process arguments and exit
- [x] Standard output and standard error string writes
- [x] File open, read, write, and close
- [x] Filesystem error reporting through `System.lastError`
- [x] Runtime path resolution and current-directory access
- [x] Allocation failure handling
- [x] Bounds-checked memory copy and comparison
- [x] Dynamic-buffer growth

## Phase 3: IR and backend completeness

- [x] Multiple basic blocks
- [x] Conditional and unconditional branches
- [x] Loop lowering
- [x] Global constant data and string literals
- [x] Arrays and strings
- [x] Null reference representation
- [x] Boolean representation
- [x] Stack-passed arguments beyond the first six
- [x] Centralized runtime error paths
- [x] Division-by-zero handling
- [x] Assembly-symbol collision tests
- [x] Register allocation and optimization explicitly deferred

## Phase 4: Rewrite the compiler in Argon

- [x] `SourceFile`, `SourceSpan`, and token types
- [x] Tokenizer
- [x] AST nodes and parser
- [x] Structured diagnostic reporting
- [x] Module loader
- [x] Scopes and symbols
- [x] Semantic analyzer
- [x] IR definitions and generator
- [x] x86-64 backend
- [x] Compiler command-line driver

The first checkpoint is an Argon tokenizer that reads a source file and prints its token stream.

## Deliberately deferred from the bootstrap subset

These features are not required to self-host, but should be reconsidered for the Argon compiler and standard library rather than accidentally omitted:

The active post-bootstrap roadmap is maintained in [`language_checklist.md`](language_checklist.md). In particular, the `inherits` and `implements` language constructs are explicit first-phase work there.

- [x] Floating-point types, literals, conversions, arithmetic, NaN rules, and ABI support
- [ ] Array literals
- [ ] Array removal, insertion, explicit capacity reservation, and shrinking
- [ ] Array slices/views and multidimensional conveniences
- [ ] General-purpose generics beyond the built-in `Array<T>`
- [ ] Iterators and `for` loops
- [ ] `else if` shorthand and richer control-flow expressions
- [ ] Short-circuit lowering for `&&` and `||`
- [ ] Method overloads and default arguments
- [ ] Visibility and encapsulation modifiers
- [ ] Fine-grained deallocation or garbage collection
- [ ] Optimization and register allocation
- [ ] Direct ELF emission without the system assembler/linker
- [ ] Unicode code-point and grapheme-aware string operations
- [ ] Bulk-copy builder optimizations and `Array<u8>` conversion APIs
- [ ] String interpolation and richer formatting
- [ ] Optional value types for stack primitives
- [ ] Flow-sensitive optional narrowing and general `Result` propagation
- [ ] Diagnostic severity enums, notes, and multi-span labels
- [ ] Deep structural equality for objects and arrays, including cycle and hashing rules
- [x] Explicit tracing garbage collection and precise stack-slot root tracking
- [ ] Explicit `delete`, deterministic disposal, and external-resource lifetime semantics
- [ ] Detect unconditional cycles between field initializers
- [ ] Process-lifetime arena allocator to batch native allocations
- [ ] Register allocation and IR/backend optimization passes
- [ ] `public`, `private`, and module-level visibility rules
- [ ] Method and constructor overload resolution
- [x] `inherits` object inheritance and subtype assignability
- [x] Method overriding, virtual dispatch, and explicit base calls
- [ ] Contract-typed references and dispatch for objects validated through `implements`

## Phase 5: Bootstrap proof

- [x] JavaScript bootstrap builds compiler generation 0
- [x] Generation 0 compiles the example programs
- [x] Generation 0 compiles the Argon compiler source
- [x] Generation 1 passes the compiler test suite
- [ ] Generation 1 builds generation 2
- [ ] Generations 1 and 2 produce semantically equivalent IR
- [ ] Invalid programs produce consistent diagnostics
- [ ] The resulting compiler has no JavaScript runtime dependency
