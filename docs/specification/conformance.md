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
| `COMP-002` | retained `artifacts-v1` fuzz corpus and metadata/interface parser tests |
| `COMP-003` | deterministic interface, metadata, manifest, and lockfile tests |
| `COMP-005` | `bootstrap/test/library-metadata.test.js` |
| `COMP-007` | generation diagnostic-equivalence suite in `bootstrap/test/generation1.test.js` |

Future conformance metadata may move these mappings beside fixture declarations. Until then, this table is the authoritative index.
