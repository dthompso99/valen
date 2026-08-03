# Native and C foreign-function boundary

Argon's built-in `native` declarations continue to name compiler-provided runtime
facilities. A declaration with `from` instead names a C ABI function supplied by
a system or dynamic library:

```argon
library Posix {{
    unsafe native processId() -> i32 from "c" as "getpid"
}}
```

The library name becomes a deterministic `-l<name>` linker input. The optional
`as` name selects the external C symbol; without it the Argon method name is used.
Library names and symbols are restricted to non-shell linker names and C
identifiers respectively. Duplicate library inputs are removed while preserving
their first-use order.

Foreign declarations are always `unsafe`, and calls therefore require an
`unsafe` block. This makes the source location that trusts foreign code explicit.
The supported ABI consists of `bool`, fixed-width integers, `f32`, `f64`, `void` returns, and
opaque native-resource object references. Optional native-resource returns map a
null pointer to `null`. Native resources follow Argon's existing transfer rules:
borrowed parameters do not transfer ownership, `own` parameters do, and cleanup
must be supplied by another native operation.

Strings, arrays, builders, ordinary managed objects, callbacks, variadic
functions and aggregates passed by value are rejected at
the boundary. A wrapper library must translate those representations until a
dedicated ABI rule is specified for them.
