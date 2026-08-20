# Conformance map

This map connects implemented rules to deterministic fixtures. A mapping means the fixture exercises the rule; it does not make unrelated behavior in that fixture normative.

| Rules | Fixture or test |
| --- | --- |
| `LEX-010`–`LEX-013`, `LEX-020`–`LEX-022` | `bootstrap/test/pipeline.test.js`, primitive and control-flow parser cases |
| `LEX-030`–`LEX-032` | `bootstrap/test/fixtures/string-interpolation.ar`, interpolation tests in `bootstrap/test/pipeline.test.js` |
| `LEX-040` | `bootstrap/test/fixtures/invalid-token.ar`, retained `syntax-v1` fuzz corpus |
| `MOD-001`, `MOD-002`, `MOD-010`–`MOD-015` | `bootstrap/test/fixtures/library-path/`, module-resolution tests in `bootstrap/test/pipeline.test.js` |
| `MOD-003` | `bootstrap/test/fixtures/module-cycle-a.ar` and `module-cycle-b.ar` |
| `NAM-001`, `NAM-002` | symbol/scope and duplicate-declaration tests in `bootstrap/test/pipeline.test.js` |
| `NAM-003`, `NAM-004` | visibility and private-dispatch tests in `bootstrap/test/pipeline.test.js` |
| `NAM-005` | `bootstrap/test/module-interface.test.js`, `bootstrap/test/library-metadata.test.js` |
| `TYP-001`–`TYP-003`, `TYP-010`–`TYP-012` | integer-width, literal-range, and conversion tests in `bootstrap/test/pipeline.test.js`; `bootstrap/test/fixtures/floating-point.ar` |
| `TYP-020`–`TYP-024` | `bootstrap/test/fixtures/numeric-promotion.ar`, `bootstrap/test/fixtures/floating-point.ar`, and mixed-width promotion tests |
| `TYP-030`, `TYP-031` | `bootstrap/test/fixtures/division-by-zero.ar`, `bootstrap/test/fixtures/floating-point.ar` |
| `OWN-001`–`OWN-005` | ownership parameter/return and borrow-lifetime tests in `bootstrap/test/pipeline.test.js` |
| `OWN-010`–`OWN-012` | `bootstrap/test/fixtures/collection-ownership.ar`, weak-reference and array insertion/removal tests |
| `OWN-020`–`OWN-023` | structural copy/hash/equality and managed-root tests in `bootstrap/test/pipeline.test.js`; `bootstrap/test/fixtures/garbage-collection.ar` |
| `OWN-030`, `OWN-031` | native-handle ownership tests in `bootstrap/test/pipeline.test.js`; networking and filesystem conformance fixtures |
| `OBJ-001`–`OBJ-004` | object construction, default-field, inheritance, subtype, and `super` tests in `bootstrap/test/pipeline.test.js`; `bootstrap/test/fixtures/inheritance.ar` |
| `OBJ-010`–`OBJ-012` | overload/default-argument and private-dispatch tests in `bootstrap/test/pipeline.test.js` |
| `OBJ-013`–`OBJ-015` | `bootstrap/test/fixtures/inheritance.ar`, `contract-references.ar`, `abi-contract-arguments.ar`, `subtypes.ar`, and invalid missing-implementation coverage |
| `EVAL-001`–`EVAL-004` | statement/expression lowering tests in `bootstrap/test/pipeline.test.js`; `bootstrap/test/fixtures/short-circuit.ar` and instruction-selection fixtures |
| `EVAL-010`–`EVAL-014` | `bootstrap/test/fixtures/else-if.ar`, `conditional-expressions.ar`, `for-loops.ar`, `short-circuit.ar`, and return-path invalid fixtures |
| `EVAL-015` | expected-failure entries in `bootstrap/test/conformance-manifest.js` and generation conformance execution |
| `EVAL-020`–`EVAL-022` | structural equality/hash tests and result-propagation tests in `bootstrap/test/pipeline.test.js`; native test runner fixtures |
| `VAL-001`–`VAL-005` | array literal, insertion/removal, capacity, slicing, nesting, ownership, and bounds fixtures in `bootstrap/test/fixtures/` |
| `VAL-010`–`VAL-013` | `bootstrap/test/fixtures/unicode-strings.ar`, `unicode-index-bounds.ar`, `byte-conversions.ar`, and `string-interpolation.ar` |
| `VAL-020`–`VAL-023` | `bootstrap/test/fixtures/optional-primitives.ar`, `optional-narrowing.ar`, `diagnostics.ar`, and optional/result propagation tests |
| `VAL-030`–`VAL-033` | `bootstrap/test/fixtures/enums.ar`, `enum-match.ar`, `enum-failing.ar`, and `enum-match-failing.ar` |
| `VAL-040`–`VAL-042` | generic specialization/constraint tests in `bootstrap/test/pipeline.test.js`; cross-module and standard-collection fixtures |
| `NAT-001`–`NAT-004` | native/unsafe semantic and symbol validation tests in `bootstrap/test/pipeline.test.js`; `bootstrap/test/fixtures/foreign-libc.ar` |
| `NAT-010`–`NAT-012` | foreign ABI boundary tests in `bootstrap/test/pipeline.test.js`; SQLite adapter and native-handle fixtures |
| `TGT-001`–`TGT-005` | target normalization/capability tests in `bootstrap/test/generation1.test.js`; `bootstrap/test/fixtures/unsupported-native.ar` and AArch64 target tests |
| `TGT-006` | production-runtime symbol-omission test in `bootstrap/test/pipeline.test.js`; instrumented native/LLVM generation conformance |
| `COMP-002` | retained `artifacts-v1` fuzz corpus and metadata/interface parser tests |
| `COMP-003` | deterministic interface, metadata, manifest, and lockfile tests |
| `COMP-005` | `bootstrap/test/library-metadata.test.js` |
| `COMP-007` | structured diagnostic parsing and generation-equivalence suite in `bootstrap/test/generation1.test.js` |

Future conformance metadata may move these mappings beside fixture declarations. Until then, this table is the authoritative index.
