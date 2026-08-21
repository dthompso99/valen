# Optimization pipeline

Valen's `-O1` pipeline applies deterministic, target-independent IR cleanup before backend lowering.
`-O0` retains mandatory validation and structural cleanup but disables optional transformations so it remains
a predictable diagnostic and comparison path.

The current pipeline provides:

- constant folding and propagation, dead-value removal, unreachable-block cleanup, jump threading, and branch folding;
- block-local propagation of primitive values;
- conservative scalar replacement for non-escaping, block-local objects with primitive fields;
- exact-receiver devirtualization and inlining of small, ownership-safe leaf methods;
- deterministic predecessor discovery and critical-edge splitting;
- validated `loop_value` nodes and promotion of primitive locals in canonical loops; and
- backend lowering of loop values through native parallel copies or LLVM `phi` nodes.

Backend-specific `-O1` work remains downstream of that pipeline. The x86-64 backend performs immediate selection,
linear-scan allocation, peephole cleanup, and signed constant division/remainder strength reduction. These operations
are not represented as target-independent IR transformations.

## Measured attribution

The final x86-64 audit for issue #98 used a freshly bootstrapped compiler and three measured repetitions on an
AMD Ryzen 9 7950X. The most informative results were:

| Workload | Native median / RSS | LLVM median / RSS | Attribution |
| --- | ---: | ---: | --- |
| integer loop | 1.121 s / 40 KiB | 0.885 s / 32 KiB | Remaining gap is primarily native register allocation/instruction selection; loop-local traffic and constant division were reduced. |
| object dispatch | 0.139 s / 48 KiB | 0.093 s / 40 KiB | Exact-type devirtualization and tiny inlining removed the hot dispatch calls for both backends. |
| allocation and GC | 0.002 s / 44 KiB | 0.001 s / 32 KiB | Scalar replacement removed the benchmark's non-escaping allocation for both backends. |
| string builders | 1.302 s / 95.0 MiB | 1.302 s / 94.8 MiB | Matching results identify a shared runtime/allocation bottleneck, not native instruction selection. |
| file processing | 0.003 s / 252 KiB | 0.003 s / 204 KiB | Already low priority; both paths are effectively tied. |
| cold start | 0.001 s | 0.001 s | Both paths remain dependency-free with 24.4 KiB and 39.4 KiB artifacts. |

The collections row was unavailable in this audit because the freshly bootstrapped compiler rejected spaced generic
types in `libStringMap.ar`; Gitea issue #117 tracks that correctness regression. Benchmark harness metadata and the
string-builder checksum were corrected during the audit.

## Deferred work

The following work is intentionally outside issue #98:

- global value numbering, common-subexpression elimination, loop-invariant code motion, and proof-based redundant
  bounds/null-check elimination require dominator, effect, and alias analysis (#112);
- full liveness across control flow and backedges requires a CFG-aware register allocator (#113);
- escape analysis across blocks and calls must model ownership, identity, destruction, weak references, and GC roots
  before scalar replacement can safely expand (#114);
- transient string construction remains a runtime allocation problem (#115); and
- `StringMap` remains a linear data structure pending an ownership-aware hash-table implementation (#116).

AArch64 lowering and object encoding remain covered by cross-target conformance tests, but native execution and
performance validation are deferred to issue #97 until physical AArch64 hardware is available. Cross-compilation
results must not be presented as native performance evidence.
