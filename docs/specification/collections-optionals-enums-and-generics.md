# Collections, strings, optionals, enums, and generics

This section is normative for the implemented value containers and their type behavior. Planned associated-value enums, expression-valued matching, generic methods, and fully generic map keys remain non-normative.

## Arrays and strings

**VAL-001 — Array type.** `Array<T>` is a dynamically sized, zero-indexed, invariant sequence. Indexing requires `0 <= index < length`; an invalid index terminates with runtime status `70`.

**VAL-002 — Array literals.** A non-empty array literal infers one homogeneous element type, using ordinary numeric promotion where applicable. An empty literal has no inferred element type and requires an explicit `Array<T>` construction or required context.

**VAL-003 — Array mutation.** `append` inserts at `length`; `insert` accepts indices from zero through `length`; `remove` requires an existing index and shifts the following tail. Ownership transfer follows `OWN-010` through `OWN-012`.

**VAL-004 — Capacity.** `reserve(n)` must not change length or element order and must provide capacity of at least `n`; negative `n` terminates with status `70`. `shrinkToFit()` preserves elements and makes capacity equal length.

**VAL-005 — Array slices.** `slice(start, length)` accepts ranges fully contained in the source, including an empty slice at its end, and otherwise terminates with status `70`. The result owns independent storage; owned reference elements are structurally copied.

**VAL-010 — String storage.** A `string` is immutable UTF-8 byte storage. `length`, indexing, and `slice` are byte-oriented; invalid indexed access uses status `70`.

**VAL-011 — String conversion.** `toBytes()` and `Array<u8>.toString()` create independent storage. Malformed UTF-8 observed through scalar iteration consumes one byte and yields U+FFFD.

**VAL-012 — Unicode views.** `codePointLength` and `codePointAt` operate on Unicode scalar values. `graphemeLength` and `graphemeAt` apply Valen's documented compact segmentation policy, including CRLF, combining marks, variation selectors, emoji modifiers, ZWJ sequences, and regional-indicator pairs.

**VAL-013 — String building.** Concatenation, interpolation, and `StringBuilder` preserve source byte order. Double-quoted strings interpolate expressions; single-quoted strings do not.

## Optional values

**VAL-020 — Optional domain.** `T?` contains either `null` or one complete `T` value. Primitive optionals preserve every underlying value, including zero, false, NaN payloads, and signed zero.

**VAL-021 — Checked unwrap.** `value!` produces the contained value only after the compiler has established presence or the runtime check succeeds. Unwrapping `null` terminates through the optional runtime error path.

**VAL-022 — Propagation.** Optional propagation may return absence only from a method whose declared return type can represent that absence. Otherwise it is a compile-time error.

**VAL-023 — Flow narrowing.** Null comparisons narrow locals and parameters along valid `if`, `else`, `while`, short-circuit, and returning-guard paths. Assignment or ownership transfer invalidates a narrowing derived from the previous value.

## Enums and matching

**VAL-030 — Enum identity.** Each enum is a distinct nominal value type. Its payload-free cases receive consecutive `i64` tags in declaration order beginning at zero; equal tags from different enums are not assignable.

**VAL-031 — Enum operations.** Enum cases support equality, inequality, and structural hashing as allocation-free value operations. Duplicate case names are invalid.

**VAL-032 — Match cases.** A statement `match` on an enum may name each case at most once. A case from another enum is invalid.

**VAL-033 — Exhaustiveness.** A statement `match` must cover every case or provide `else`. If every reachable branch returns, the match satisfies return-path analysis.

## Generic objects

**VAL-040 — Specialization.** A generic object must be instantiated with exactly its declared number of type arguments. Each concrete specialization is monomorphized and invariant.

**VAL-041 — Constraints.** A type argument supplied for `T:Contract` must satisfy that contract under `OBJ-013`. Each type parameter's constraints are checked independently.

**VAL-042 — Cross-module identity.** A concrete imported generic specialization has the same semantic identity wherever the same template and type arguments are used in the consuming module. Equivalent specializations must not emit conflicting duplicate implementations.
