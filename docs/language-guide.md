# Language guide

This guide documents syntax implemented by the current compiler. Features marked **WIP** are planned or incomplete and should not be used as if they were stable.

## Files, imports, and libraries

Source files use the `.ar` extension. Import a named library from another source file:

```valen
import System from 'libSystem.ar'
```

Import spelling determines resolution without fallback between categories:

- `./module.ar` and `../module.ar` are relative to the importer and must remain inside that module's owning project or library root.
- `/src/module.ar` is relative to the configured project source root, never the filesystem root.
- `module.ar` and `package/module.ar` are library imports searched through `VALEN_LIBRARY_PATH` in declared order.

Every import includes its `.ar` extension. Library imports cannot contain `..`. Each
`VALEN_LIBRARY_PATH` entry may be anywhere accessible on the filesystem; relative imports made
inside that library remain confined to that library entry. The native compiler accepts
`--source-root <directory>` and otherwise uses its current working directory.

```valen
library Tools {{
    useful() -> bool { return true }
}}
```

Libraries can be published as a relocatable object plus versioned metadata:

```sh
valen --library-version 1.2.3 --emit-library src/tools.ar -o build/tools.o
valen --validate-library build/tools.o.vmeta
```

The source module must declare exactly one public `library`. The adjacent `.vmeta` records its
name and semantic version, compiler-interface version, target, native ABI, public-interface and
implementation fingerprints, object fingerprint, and the exact interface fingerprint required
from each imported library. Validation rejects malformed semantic versions, incompatible compiler,
target or ABI values, missing objects, and object/metadata mismatches before linking.

Versions follow SemVer syntax. Library authors increment patch for compatible fixes, minor for
backward-compatible additions, and major for incompatible public-interface changes. The compiler
records and verifies exact interfaces; it does not infer whether an API change deserves a major
version or resolve version ranges. A registry, dependency solver, lockfile, and compiled-library
import resolution remain package-manager concerns rather than source-language syntax.

## Native networking

`libNetwork.ar` provides blocking TCP sockets through the target runtime. On x86-64 Linux these
operations use kernel syscalls directly and do not require libc or another shared library:

```valen
local listener = Network.listen(8080, 16)
local connection = Network.accept(listener!)
local request = Network.receive(connection!, 4096)
Network.send(connection!, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
Network.closeConnection(connection!)
Network.closeListener(listener!)
```

Listeners and connections are owning native resources and must be closed. The current interface
is blocking, IPv4, and binds all local interfaces. Nonblocking sockets, address selection, DNS,
TLS and production protocol handling are **WIP**.

## Objects and constructors

Objects use doubled braces:

```valen
Engine {{
    member version:i64

    __(version:i64=1) -> void {
        self.version = version
    }

    start() -> bool { return true }
}}
```

Create an object with `new`:

```valen
local engine = new Engine()
```

Fields are allocated and zero-initialized before `__` runs. Members and methods are public by default. A `private` method or field is visible only to its owning object; private methods do not participate in virtual dispatch.

## Inheritance and contracts

`inherits` takes on a parent’s fields and methods. A compatible child method automatically overrides the parent method.

```valen
Animal {{
    describe() -> string { return "animal" }
}}

Dog inherits Animal {{
    describe() -> string { return "dog" }
    parentDescription() -> string { return super.describe() }
}}
```

Parent fields are laid out before child fields. `super()` optionally calls the parent constructor.

Valen uses ordinary object declarations as contracts:

```valen
Printable {{
    print() -> void {}
}}

Report implements Printable {{
    print() -> void {}
}}

local printable:Printable = new Report()
printable.print()
```

The compiler verifies compatible method signatures and dispatches through the concrete object. Contract views preserve object identity. Abstract/final classes and a separate interface category are intentionally not planned.

## Primitive values

Implemented primitive types include:

- signed integers: `i8`, `i16`, `i32`, `i64`
- unsigned integers: `u8`, `u16`, `u32`, `u64`
- floating point: `f32`, `f64`
- `bool`, `string`, and `void`

Conversions may be explicit:

```valen
local small:i32 = 10
local wide = small as i64
local decimal = wide as f64
```

Mixed-width operators first convert both operands to a common type. Equal signedness keeps that signedness and uses the wider width. Mixed signed/unsigned integers use a wider signed type capable of representing both inputs; combinations such as `u64` and `i64` that have no lossless built-in common type require an explicit conversion. Floating point dominates integers, mixed integer/float operations use `f64`, and `f32` is retained only when both operands are `f32`. Shift results retain the left operand's type.

These rules apply to arithmetic, comparisons, and bitwise operations. Assignment and method arguments remain explicit conversion boundaries.

## Locals and control flow

```valen
local total:i64 = 0

while total < 10 {
    total = total + 1
    if total == 3 { continue }
    if total == 8 { break }
}
```

Parentheses around conditions are optional. Statements may be separated by newlines or semicolons. `&&` and `||` short-circuit.

Arrays and strings support `for` iteration:

```valen
local values = new Array<i64>(0)
values.append(4)
values.append(8)
values.insert(1, 6)
local removed = values.remove(0)

for value in values {
    total = total + value
}
```

`else if` chains are ordinary conditionals and may mix parenthesized and unparenthesized conditions.
An `else` binds to the closest preceding `if`.

Conditionals may also produce values. Every branch must end with an expression, an `else` branch is
required, and branch values must have a common type. Numeric branches use ordinary lossless promotion;
each branch has its own scope and optional narrowing. Owned values created or selected inside a branch
transfer into the conditional result.

```valen
local label = if score >= 90 {
    "excellent"
} else if score >= 70 {
    "good"
} else {
    "needs work"
}
```

Enums and exhaustive matching remain **WIP**.

## Arrays, strings, and generic objects

Arrays are dynamically sized:

```valen
local names = ["valen", "argon"]
names.append("valen")
local first = names[0]
local count = names.length
```

Non-empty literals infer a homogeneous element type. Numeric elements use the ordinary lossless
promotion rules, nested literals are supported, and reference elements transfer ownership into the
new array. Empty literals do not guess their element type; use `new Array<T>(0)`.

`insert(index, value)` accepts positions from zero through `length`; inserting at `length` appends.
`remove(index)` requires an existing element and returns it after shifting the remaining tail. Owned
reference insertion transfers ownership into the array, while removal transfers ownership back to
the caller. `ref` and `weak` arrays remain non-owning.

Arrays expose their allocated storage through `capacity`. `reserve(minimumCapacity)` grows storage
without changing `length` or moving ownership out of the array, and does nothing when enough capacity
already exists. `shrinkToFit()` releases unused storage so `capacity == length`; later appends grow the
array normally. Reserving a negative capacity terminates through the array runtime error path.

`slice(start, length)` returns an independent array and accepts an empty slice at the end. Primitive,
`ref`, and `weak` elements are copied directly; ordinary owned reference elements are structurally
copied so both arrays retain valid independent ownership. Invalid ranges use runtime status 70.
Valen models multidimensional collections as nested arrays: slicing an outer array copies its rows,
and slicing an individual row copies its cells. There is intentionally no separate matrix or borrowed
array-view type with a second lifetime model.

Generic objects are monomorphized:

```valen
Box<T> {{
    member value:T
    __(value:T) -> void { self.value = value }
}}

local box = new Box<i64>(42)
```

Specializations are invariant. Type parameters may require a contract with `:`:

```valen
Box<T:Printable> {{
    print(value:T) -> void { value.print() }
}}
```

Every concrete type argument must implement the named contract. Multiple parameters carry their
own constraints, for example `Map<K:Hashable, V>`. Generic methods remain **WIP**.

## Enums

Enums define a closed set of payload-free named values. Cases use `Type.Case`, carry an allocation-free
64-bit tag in declaration order starting at zero, and support `==`, `!=`, and `hash()` as value operations.

```valen
enum Direction {{
    North
    East
    South
    West
}}

local direction:Direction = Direction.North
if direction != Direction.South { local tag:i64 = direction.hash() }
```

Cases may be comma-, semicolon-, or newline-separated. Enums may be top-level declarations or public/private
nested declarations inside objects and libraries. Different enum types are not assignable even when their tags
match. Associated-value cases remain **WIP**.

Enum values support exhaustive statement matching:

```valen
match direction {
    case Direction.North { System.write("north") }
    case Direction.East { System.write("east") }
    case Direction.South { System.write("south") }
    case Direction.West { System.write("west") }
}
```

Every branch must name a unique case from the matched enum. Omitting a case is a compile error unless an
`else` branch is present. When every branch returns, the match also satisfies the enclosing method's return
analysis. Expression-valued matching and associated-value destructuring remain **WIP**.

Strings support byte indexing, length, equality, concatenation, slicing, integer conversion, interpolation, and `StringBuilder`. `text.toBytes()` creates an independent `Array<u8>`, while `bytes.toString()` converts an `Array<u8>` back to an immutable string. `StringBuilder.appendBytes(bytes)` and ordinary string appends reserve once and bulk-copy their input.

String storage and the existing `length`, indexing, and `slice` APIs remain explicitly UTF-8 byte-oriented. Unicode-aware code uses `codePointLength` and `codePointAt(index)` for scalar values, or `graphemeLength` and `graphemeAt(index)` for user-perceived characters. `codePointAt` returns the scalar as an `i64`; malformed UTF-8 consumes one byte and returns U+FFFD. Both indexed Unicode APIs use the ordinary bounds-error status (70).

The compact native grapheme segmenter keeps CRLF, combining-mark sequences, variation selectors, emoji modifiers, emoji ZWJ sequences, and regional-indicator flag pairs together. This deliberately provides predictable common-case behavior without embedding the full Unicode property database; scripts requiring the complete evolving UAX #29 tables can layer that policy over `codePointAt`.

Double-quoted strings interpolate string and integer expressions with `${expression}`. Interpolation accepts full expressions and lowers through `StringBuilder`, so a string with several substitutions is built in linear time. Escape the dollar sign as `\${` to emit a literal interpolation marker. Single-quoted strings do not interpolate.

```argon
local name = "Valen"
local requests:i64 = 42
local summary = "${name} handled ${requests} requests"
```

Float, boolean, alignment, precision, and radix formatting remain **WIP**.

## Optional values

Reference and primitive optionals use `?`:

```valen
local engine:Engine? = null
if engine != null {
    engine!.start()
}
```

Primitive optionals preserve every underlying value, including integer zero, `false`, and all
floating-point bit patterns:

```valen
local count:i64? = 0
if count != null {
    local value:i64 = count!
}
```

At the native ABI boundary a present primitive optional is represented by a nullable, GC-managed
value box; `null` remains zero. This keeps optionals one machine word in locals, fields, parameters,
and returns. `!`, `?`, and flow-sensitive null narrowing behave identically for reference and
primitive optionals.

`!` performs a checked unwrap. Safe propagation is available in optional-returning methods. Locals and parameters are narrowed automatically after null checks inside `if`, `else`, `while`, short-circuit expressions, and after a returning guard clause. Assignment invalidates the narrowing.

## Ownership and lifetime

New objects and ordinary object fields are owning references. Passing an object normally borrows it; an `own` parameter transfers ownership:

```valen
Store {{
    member engine:Engine?
    keep(own engine:Engine) -> void { self.engine = engine }
}}
```

An owning field may likewise be passed to an `own` cleanup operation. Resource wrappers should immediately replace a consumed optional field with `null`; assigning `null` also retires an element in an owning optional array.

Use `copy` for a cycle-safe structural copy:

```valen
local second = copy engine
```

Non-owning members are explicit:

```valen
member ref observer:Observer?
member weak cached:Engine?
```

Weak references become `null` after logical destruction. `delete value` performs deterministic logical destruction; tracing garbage collection reclaims unreachable storage. Raw pointers are reserved for explicit unsafe/native boundaries.

## Equality

- `===` and `!==` compare reference identity.
- `==` and `!=` perform cycle-safe structural equality for objects and ordered arrays.
- Structural hashing follows the same object graph rules.

## Operations and threads

All ordinary method calls are synchronous. Work that may finish later returns an `Operations.Operation`:

```valen
local executor:Operations.Executor = new Operations.InlineExecutor()
local operation = executor.submit(new MyWork())
local result = operation.wait()
```

`InlineExecutor` is deterministic and is the portable fallback. x86-64 Linux also provides a
joinable single-worker `ThreadExecutor`, a fixed-size persistent-worker `ThreadPoolExecutor`, mutexes, conditions, atomics, and a poll-backed
`EventLoopExecutor`. Readiness-aware work implements `ReadyWork`, returning its descriptor and
interest, and is submitted with `submitReady()`.

The pool queues work in submission order. `shutdown()` drains the queue and joins its workers; later
submissions execute inline. Targets without native threads, and pools constructed with a non-positive
size, use inline execution automatically. Cancellation succeeds only before a worker claims an operation.
Native workers register their active frames in a synchronized tracing-root registry. Collection defers while
workers are active, then resumes when the last worker is joined and immediately reclaims unreachable worker
allocations. Calling `System.collectGarbage()` while work is active is safe and defers collection to that join.

## Native and unsafe code

Compiler-provided runtime methods use `native`. C ABI calls identify a library and must be called inside `unsafe`:

```valen
library Posix {{
    unsafe native processId() -> i32 from "c" as "getpid"
}}

local pid:i32 = 0
unsafe {
    pid = Posix.processId()
}
```

See the [FFI reference](../ffi.md) for supported boundary types.

## Tests

Valen has source-level tests:

```valen
test arithmetic {{
    addition() -> void {
        expect(2 + 2 == 4)
    }
}}
```

A failing expectation produces a nonzero native process status. Compiler diagnostics distinguish errors, warnings, and notes. A diagnostic may identify related source locations, explain the governing rule, and provide a precise replacement hint. The first line remains `path:line:column: severity: message` for editor and script compatibility.
