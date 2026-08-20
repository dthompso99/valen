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

The native compiler shares the same format-1 schema boundary and can validate a manifest directly:

```sh
valen --validate-project valen.project.json
```

This validates and normalizes manifest semantics without writing files. Manifest-driven native build orchestration remains a subsequent slice; the generation-zero `valen-project` command remains the build driver until that is complete.

The native compiler can also enforce the frozen manifest/lock graph without modifying either file:

```sh
valen --validate-project --locked valen.project.json
```

An explicit lockfile path may follow the manifest. Frozen validation checks package identity, normalized target, deterministic dependency order, declared source and metadata routes, compiler interface, ABI, and required fingerprints. It also loads each dependency's metadata, interface, object, and declared source and verifies their exact locked fingerprints before accepting the graph.

The native compiler can build the frozen project graph directly:

```sh
valen --build-project valen.project.json
```

An explicit lockfile path may follow the manifest. The command never creates or updates a lockfile: it validates the exact graph, loads dependency declarations from their confined source routes, substitutes the verified locked objects during linking, and applies the manifest's target, optimization, source, and output settings. The output directory must already exist.

The lockfile sorts dependencies by name and records exact compiler-interface, target, ABI, interface, implementation, and object fingerprints. It contains no timestamps or absolute host paths. Registry and Git transport are intentionally separate future extensions; direct source-file compilation remains available without project metadata.
