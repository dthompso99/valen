# Types, literals, and numeric operations

This section is normative for the implemented primitive type system, literal fitting, explicit numeric conversions, and binary numeric promotion.

## Primitive types and literals

**TYP-001 — Primitive types.** The primitive types are signed integers `i8`, `i16`, `i32`, and `i64`; unsigned integers `u8`, `u16`, `u32`, and `u64`; IEEE 754 binary floating types `f32` and `f64`; `bool`; `string`; and `void`.

**TYP-002 — Integer literal fitting.** An integer literal used where a concrete integer type is required must be accepted only when its mathematical value is within that type's inclusive range. A unary minus participates in this fitting check. An out-of-range literal must be rejected before code generation.

**TYP-003 — Floating literals.** A floating literal has type `f64` unless a required `f32` context accepts it. A literal required as `f32` must be finite after binary32 rounding; otherwise it is invalid.

## Assignment and conversion

**TYP-010 — Required-type boundaries.** Assignment, field initialization, return, and argument passing require the produced value to be assignable to the declared type. Object subtypes and implemented contracts are assignable to their declared parent or contract view. Unrelated nominal types are not assignable.

**TYP-011 — Explicit numeric conversion.** `value as T` performs a numeric conversion only when both the source and `T` are numeric types. Integer-to-float conversion uses the target floating width. Float-to-integer conversion truncates toward zero and must terminate through the runtime error path for NaN or a value outside the target range.

**TYP-012 — Literal contextual conversion.** Literal fitting under `TYP-002` and `TYP-003` is contextual typing, not a general implicit conversion between already typed values.

## Binary numeric promotion

**TYP-020 — Equal types.** Numeric operands of the same type retain that type.

**TYP-021 — Same-signedness integers.** Integer operands with equal signedness promote to the wider operand width and retain their signedness.

**TYP-022 — Mixed-signedness integers.** Mixed signed and unsigned operands promote to the smallest implemented signed integer type that can represent both operand types. If no such type exists, the expression is invalid and requires an explicit conversion.

**TYP-023 — Floating promotion.** If either numeric operand is floating, the common type is `f64` when either operand is `f64` or either operand is an integer. The common type is `f32` only when both operands are `f32`.

**TYP-024 — Promotion sites.** The common numeric type applies to arithmetic, ordered comparison, equality comparison, and bitwise operations that accept the operands. A shift expression retains the left operand's type.

## Runtime arithmetic failures

**TYP-030 — Integer division by zero.** Integer division by zero must terminate through the target's defined runtime error path. It must not inherit host-language undefined behavior.

**TYP-031 — Floating division.** Floating division follows IEEE 754 behavior. Division by signed zero may produce an infinity or NaN and does not use the integer division-by-zero path. NaN is unequal to every value, ordered comparisons with NaN are false, and signed zeroes compare equal.
