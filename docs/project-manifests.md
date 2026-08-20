# Project manifests and lockfiles

Project-aware tooling begins with a deliberately small, versioned JSON manifest. Direct source-file compilation remains supported.
JSON is used for this bootstrap slice because both compiler implementations already need deterministic JSON artifacts; optional YAML support remains a library concern.

```json
{
  "format": 1,
  "package": {"name": "sample", "version": "0.1.0"},
  "executable": {
    "source": "src/main.ar",
    "output": "build/sample",
    "target": "x86_64-linux",
    "optimization": 1
  },
  "dependencies": [
    {"name": "Support", "version": "1.0.0", "source": "deps/Support.ar", "metadata": "deps/Support.o.vmeta"}
  ]
}
```

Paths are relative to the manifest. Dependency metadata must describe adjacent compiled object and interface artifacts whose name, version, target, ABI, interface fingerprint, and object fingerprint validate successfully. The source supplies declarations for semantic analysis; its implementation is replaced by the validated object during linking.

Generate or update the canonical `valen.lock`:

```sh
node scripts/valen-project.mjs lock valen.project.json
```

Verify without writing:

```sh
node scripts/valen-project.mjs lock --locked valen.project.json
```

Build the declared executable, updating the lockfile when needed:

```sh
node scripts/valen-project.mjs build valen.project.json
```

For a reproducible build that refuses to create or update a missing or stale lockfile:

```sh
node scripts/valen-project.mjs build --locked valen.project.json
```

Manifest source, output, dependency source, and dependency metadata paths are confined to the project root. Local compiled dependencies are resolved in deterministic manifest order and linked from the exact artifacts recorded by the lockfile.

The lockfile sorts dependencies by name and records exact compiler-interface, target, ABI, interface, implementation, and object fingerprints. It contains no timestamps or absolute host paths. Registry and Git transport are intentionally separate future extensions; direct source-file compilation remains available without project metadata.
