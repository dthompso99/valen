# Native and C foreign-function boundary

Valen's built-in `native` declarations continue to name compiler-provided runtime
facilities. A declaration with `from` instead names a C ABI function supplied by
a system or dynamic library:

```valen
library Posix {{
    unsafe native processId() -> i32 from "c" as "getpid"
}}
```

The library name becomes a deterministic `-l<name>` linker input. The optional
`as` name selects the external C symbol; without it the Valen method name is used.
Library names and symbols are restricted to non-shell linker names and C
identifiers respectively. Duplicate library inputs are removed while preserving
their first-use order.

Ordinary Valen programs link without libc. A shared-library dependency is introduced only by
an explicit foreign declaration or target capability that names it. Standard facilities should
therefore be implemented by Valen, supplied by the target, or exposed through an explicit
provider rather than silently assuming a package such as libc or OpenSSL is installed.

Foreign declarations are always `unsafe`, and calls therefore require an
`unsafe` block. This makes the source location that trusts foreign code explicit.
The supported ABI consists of `bool`, fixed-width integers, `f32`, `f64`, `void` returns, and
opaque native-resource object references. Optional native-resource returns map a
null pointer to `null`. Native resources follow Valen's existing transfer rules:
borrowed parameters do not transfer ownership, `own` parameters do, and cleanup
must be supplied by another native operation.

Strings, arrays, builders, ordinary managed objects, callbacks, variadic
functions and aggregates passed by value are rejected at
the boundary. A wrapper library must translate those representations until a
dedicated ABI rule is specified for them.

The SQLite service under `examples/sqlite-native` is the reference wrapper pattern. Its C adapter
accepts only integers and an opaque database handle, obtains its configured path through the native
environment, and returns error text through length and byte operations. This keeps C strings and
SQLite statement pointers out of ordinary Valen code.

Freestanding targets do not implicitly provide a C ABI or libc. A `from` declaration requires
the target's explicit `foreign-abi` capability; otherwise it is a compile-time error. Plain
`native` declarations may instead resolve to target runtime facilities or application hooks.
See [the freestanding profile](../freestanding.md).
