# Language guide

This guide documents syntax implemented by the current compiler. Features marked **WIP** are planned or incomplete and should not be used as if they were stable.

## Files, imports, and libraries

Source files use the `.ar` extension. Import a named library from another source file:

```valen
import System from 'libSystem.ar'
```

Resolution checks the importing file’s directory and then directories in `VALEN_LIBRARY_PATH`.

```valen
library Tools {{
    useful() -> bool { return true }
}}
```

Package metadata, library versions, compiled modules, and finalized search-path rules are **WIP**.

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

The compiler verifies compatible method signatures and dispatches through the concrete object. Contract views preserve object identity. Abstract/final classes and a separate interface category are intentionally not planned; generic constraints are **WIP**.

## Primitive values

Implemented primitive types include:

- signed integers: `i8`, `i16`, `i32`, `i64`
- unsigned integers: `u8`, `u16`, `u32`, `u64`
- floating point: `f32`, `f64`
- `bool`, `string`, and `void`

Conversions are explicit:

```valen
local small:i32 = 10
local wide = small as i64
local decimal = wide as f64
```

Implicit mixed-width numeric promotion is **WIP**. Strings currently expose UTF-8 bytes; Unicode code-point and grapheme operations are **WIP**.

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

for value in values {
    total = total + value
}
```

`else if` shorthand, expression-valued conditionals, array literals, slices, insertion/removal, and exhaustive matching are **WIP**.

## Arrays, strings, and generic objects

Arrays are dynamically sized:

```valen
local names = new Array<string>(0)
names.append("valen")
local first = names[0]
local count = names.length
```

Generic objects are monomorphized:

```valen
Box<T> {{
    member value:T
    __(value:T) -> void { self.value = value }
}}

local box = new Box<i64>(42)
```

Specializations are invariant. Generic methods and constraints are **WIP**.

Strings support byte indexing, length, equality, concatenation, slicing, integer conversion, and `StringBuilder`. Interpolation and richer formatting are **WIP**.

## Optional references

Reference optionals use `?`:

```valen
local engine:Engine? = null
if engine != null {
    engine!.start()
}
```

`!` performs a checked unwrap. Safe propagation is available in optional-returning methods. Optional primitive values and flow-sensitive narrowing that removes the need for `!` are **WIP**.

## Ownership and lifetime

New objects and ordinary object fields are owning references. Passing an object normally borrows it; an `own` parameter transfers ownership:

```valen
Store {{
    member engine:Engine?
    keep(own engine:Engine) -> void { self.engine = engine }
}}
```

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
joinable single-worker `ThreadExecutor`, mutexes, conditions, atomics, and a poll-backed
`EventLoopExecutor`. Readiness-aware work implements `ReadyWork`, returning its descriptor and
interest, and is submitted with `submitReady()`. Thread pools and other platform implementations
are **WIP**.

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

A failing expectation produces a nonzero native process status. Richer diagnostic notes, fix hints, and multi-span labels are **WIP**.
