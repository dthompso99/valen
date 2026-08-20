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
| `COMP-002` | retained `artifacts-v1` fuzz corpus and metadata/interface parser tests |
| `COMP-003` | deterministic interface, metadata, manifest, and lockfile tests |
| `COMP-005` | `bootstrap/test/library-metadata.test.js` |
| `COMP-007` | structured diagnostic parsing and generation-equivalence suite in `bootstrap/test/generation1.test.js` |

Future conformance metadata may move these mappings beside fixture declarations. Until then, this table is the authoritative index.
