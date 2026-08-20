# Build identity

Generation-zero and self-hosted executable builds write a deterministic `<output>.vbuild` sidecar. The sidecar records the compatibility-relevant inputs used to produce the executable and fingerprints the resulting artifact.

Inspect and validate a sidecar without recompiling:

```sh
node bootstrap/compiler.js --inspect-build build/app.vbuild
```

Inspection verifies that the build identifier matches the recorded inputs before printing normalized JSON. The current format is `1` and contains:

- compiler-interface epoch;
- target and native ABI;
- optimization level, backend, selected linker, and runtime-instrumentation state;
- selected foreign-library names;
- entry interface fingerprint;
- implementation/interface fingerprints and dependency bindings for every loaded module;
- normalized project-manifest and lockfile fingerprints when those files exist at the source root;
- executable artifact fingerprint;
- deterministic build identifier over all preceding fields.

Module source and interface fingerprints participate in identity, but filesystem locations do not. Identical projects therefore retain the same identity after moving to another checkout path. Timestamps, usernames, temporary paths, and hostnames are excluded.

The JavaScript generation-zero compiler includes normalized project-manifest and lockfile fingerprints. Direct self-hosted compilation currently records those fields as `null` because it does not yet load project metadata.

Embedded ELF notes, project metadata in direct self-hosted builds, detailed cache-miss explanations, and a stable machine-readable explanation schema remain **WIP** under issue #107.
