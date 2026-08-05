# Floating-point rules

Valen provides IEEE 754 binary32 (`f32`) and binary64 (`f64`) value types.
Decimal literals, including exponent notation, default to `f64`; `as f32`
performs an explicit narrowing conversion. Floating values may be stored in
locals, members, arrays, and passed through direct, virtual, contract, native,
and foreign calls.

`+`, `-`, `*`, `/`, unary `-`, and the ordinary comparison operators operate at
the operands' declared width. Valen does not implicitly mix `f32`, `f64`, or
integer operands. Numeric conversions must be explicit. Integer-to-float
conversion rounds according to the active IEEE round-to-nearest mode.
Float-to-integer conversion truncates toward zero; NaN and values outside the
target integer range terminate through runtime error status 76.

Floating division follows IEEE behavior and does not use the integer
division-by-zero trap. Thus nonzero divided by signed zero produces an infinity,
and zero divided by zero produces NaN. NaN is unequal to every value, including
itself, and all ordered comparisons with NaN are false. `!=` with NaN is true.
Signed zero compares equal.

On x86-64 Linux, floating arguments use the independent SysV SSE argument class
(`xmm0` through `xmm7`), while integer and reference arguments use the general
register class. Overflow arguments use eight-byte stack slots in source order.
`f32` and `f64` results are returned in `xmm0`. The same convention applies at
the C FFI boundary.
