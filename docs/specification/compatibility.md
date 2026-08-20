# Compatibility policy

Valen evolves through independent compatibility domains. A version change in one domain must not imply compatibility in another.

## Current epochs

| Domain | Current epoch | Present promise |
| --- | --- | --- |
| Source syntax and semantics | `valen-source-0` | Experimental; breaking changes are allowed when documented and covered by updated conformance rules. |
| Compiler command line | `valen-cli-0` | Experimental; automation should pin a compiler revision. |
| Module interface (`.vmi`) | format `2` | Internal cache/build artifact; exact format match required. |
| Library metadata (`.vmeta`) | format `1`, compiler `valen-interface-1` | Parsed strictly; incompatible compiler-interface values are rejected. |
| Native ABI | `valen-native-1` | Exact epoch and target match required for compiled libraries. |
| Whole-program and module cache | implementation-versioned | Disposable; deletion is always a valid recovery action. |
| Standard-library API | `valen-stdlib-0` | Experimental and source-version coupled. |
| Diagnostics | JSON schema `1`; text `valen-diagnostics-0` | Structured fields are the tool interface; human prose remains revision-coupled. |

## Change rules

**COMP-001 — Domain declaration.** Every compatibility-relevant artifact must identify its applicable format or epoch either within the artifact or through its containing build contract.

**COMP-002 — Exact internal formats.** A compiler must reject unsupported VMI, VMeta, compiler-interface, target, or native-ABI values. It must not guess compatibility from structural similarity.

**COMP-003 — Determinism.** Compatibility identifiers and artifact fingerprints must not contain timestamps, random values, or host-specific absolute paths.

**COMP-004 — Source changes.** While the source epoch is `valen-source-0`, a breaking source change requires: a revised normative rule, updated conformance fixtures, a project-status or release note, and an actionable diagnostic when practical. Silent reinterpretation of accepted syntax is disallowed.

**COMP-005 — Published library APIs.** Library versions use SemVer syntax. Authors must increment major for an incompatible public-interface change, minor for a backward-compatible addition, and patch for a compatible correction. The compiler verifies recorded interface identity; it does not infer whether the chosen SemVer increment is appropriate.

**COMP-006 — Deprecation.** Before a stable source or standard-library epoch exists, deprecation periods are recommended but not guaranteed. Once a domain advances to a stable epoch, removal must be preceded by at least one documented release that diagnoses or marks the deprecated behavior.

**COMP-007 — Diagnostics.** Tools must consume newline-delimited JSON from `--diagnostic-format json` rather than parse human prose. Schema `1` consists of severity, message, source span, labels, notes, and fixes as documented in [compiler diagnostics](../compiler-diagnostics.md). Adding optional fields is compatible; removing or changing existing field meanings requires a schema change. Exact generation parity remains required.

**COMP-008 — WIP behavior.** Behavior marked **WIP**, planned, optional without a declared capability, or absent from the normative specification carries no compatibility promise.
