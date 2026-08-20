# Build identity

Generation-zero and self-hosted executable builds write a deterministic `<output>.vbuild` sidecar. The sidecar records the compatibility-relevant inputs used to produce the executable and fingerprints the resulting artifact.

Inspect and validate a sidecar without recompiling:

```sh
node bootstrap/compiler.js --inspect-build build/app.vbuild
```

Compare two validated builds and explain whether the earlier artifact was reusable:

```sh
node bootstrap/compiler.js --explain-build previous/app.vbuild current/app.vbuild
```

The comparison prints format-1 JSON and exits zero when the previous artifact is reusable, or one when a rebuild was required. Its stable reason codes cover compiler, target, ABI, optimization, backend, linker, instrumentation, foreign-library, project, lock, entry-interface, module-implementation, module-interface, dependency-binding, and module-graph changes. A body-only dependency change has `module-only` impact; a public-interface, dependency, or graph change has `importers` impact. Human wording is intentionally excluded from the schema.

Inspection verifies that the build identifier matches the recorded inputs before printing normalized JSON. The current format is `1` and contains:

- compiler-interface epoch;
- target and native ABI;
- optimization level, backend, selected linker, and runtime-instrumentation state;
- selected foreign-library names;
- entry interface fingerprint;
- stable root-relative module identities, implementation/interface fingerprints, and dependency bindings for every loaded module;
- normalized project-manifest and lockfile fingerprints when those files exist at the source root;
- executable artifact fingerprint;
- deterministic build identifier over all preceding fields.

Module source and interface fingerprints participate in identity, but filesystem locations do not. Identical projects therefore retain the same identity after moving to another checkout path. Timestamps, usernames, temporary paths, and hostnames are excluded.

The JavaScript generation-zero compiler includes normalized project-manifest and lockfile fingerprints. Direct self-hosted compilation records those fields as `null` because project builds are currently driven by the generation-zero project tool.

The adjacent identity is the inspectable artifact metadata contract; embedding duplicate ELF notes is unnecessary while the sidecar is required and validated against the executable. Project metadata reaches identities through manifest-driven builds. Direct self-hosted source-file compilation remains intentionally independent of project manifests.
