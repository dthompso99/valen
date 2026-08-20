# Native, unsafe, FFI, and target capabilities

This section is normative for trusted boundaries and target-dependent compilation. It does not promise capabilities on targets that do not advertise them.

## Native and unsafe boundaries

**NAT-001 — Compiler native declarations.** A plain `native` declaration names a compiler/runtime or application-provided facility. The selected target must resolve the symbol or compilation must fail with a target diagnostic.

**NAT-002 — Foreign declarations.** `native ... from "library"` names a C ABI dependency. Its library becomes an explicit deterministic linker input; `as "symbol"` selects the external symbol, otherwise the Valen method name is used.

**NAT-003 — Unsafe requirement.** A foreign declaration must be `unsafe`, and every call to an unsafe method must occur in a lexically enclosing `unsafe` block. Unsafe syntax grants permission; it does not weaken ordinary type or ownership checks.

**NAT-004 — Foreign names.** Library names must satisfy the documented non-shell linker-name grammar and external symbols must be C identifiers. User text must never be interpreted as shell syntax.

**NAT-010 — Supported C ABI values.** The foreign boundary supports `bool`, fixed-width integers, `f32`, `f64`, `void` returns, and opaque native-resource references. An optional native-resource return maps a null pointer to `null`.

**NAT-011 — Rejected C ABI values.** Strings, arrays, builders, ordinary managed objects, callbacks, variadic functions, and aggregates passed by value must be rejected unless a later compatibility epoch explicitly defines them.

**NAT-012 — Foreign ownership.** Borrowed opaque-resource parameters do not transfer ownership; `own` parameters do. A foreign resource must follow `OWN-030` and `OWN-031` and expose an explicit cleanup operation.

## Targets and backends

**TGT-001 — Explicit target.** Compilation selects one normalized target profile. Unsupported target names must be rejected rather than silently mapped to the host.

**TGT-002 — Capability validation.** Before artifact emission, the backend must reject each used native, foreign-ABI, threading, networking, or runtime facility not supplied by the selected target. The diagnostic must identify the missing capability or symbol.

**TGT-003 — Backend equivalence.** Native and LLVM backends for the same target and compatibility epochs must preserve the source-level behavior defined by this specification. Backend choice may change artifacts and performance, not program semantics.

**TGT-004 — Freestanding imports.** A freestanding target does not implicitly supply libc or a C ABI. Foreign declarations require an explicit target `foreign-abi` capability.

**TGT-005 — Runtime status.** Target implementations must preserve documented Valen exit statuses for bounds, conversion, compiler, linker, and missing-runtime failures where the relevant capability exists.

**TGT-006 — Instrumentation policy.** Optional runtime instrumentation is enabled only by its explicit compiler option. Optimization level must not silently enable instrumentation, and an ordinary production build must omit optional counter storage and update operations.
