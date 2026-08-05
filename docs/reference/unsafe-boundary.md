# Unsafe native boundary

Valen does not expose pointer types, pointer arithmetic, or arbitrary memory access to ordinary code. Native library operations that cannot preserve the language's memory-safety guarantees must be declared explicitly:

```valen
library Platform {{
    unsafe native performRawOperation(buffer:Array<u8>) -> i64
}}
```

Calls to an unsafe native operation are accepted only inside a lexical `unsafe` block:

```valen
unsafe {
    Platform.performRawOperation(buffer)
}
```

An `unsafe` block grants permission to call marked native operations; it does not change types or make pointer values available. Libraries should keep these blocks narrow and expose safe wrappers using checked arrays, strings, opaque native-resource objects, and ordinary Valen values.

The boundary is reserved now so future raw-memory and FFI work has an auditable location. Pointer representation, arithmetic, provenance, alignment, volatile access, and foreign ABI declarations remain separate design work.
