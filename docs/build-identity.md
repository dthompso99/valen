# Build identity

Generation-zero executable builds write a deterministic `<output>.vbuild` sidecar. The sidecar records the compatibility-relevant inputs used to produce the executable and fingerprints the resulting artifact.

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

The initial sidecar is emitted by the JavaScript generation-zero compiler. Self-hosted emission, embedded ELF notes, detailed cache-miss explanations, and a stable machine-readable explanation schema remain **WIP** under issue #107.
