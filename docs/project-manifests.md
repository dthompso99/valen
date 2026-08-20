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
    {"name": "Support", "version": "1.0.0", "metadata": "deps/Support.o.vmeta"}
  ]
}
```

Paths are relative to the manifest. Dependency metadata must describe an adjacent compiled object whose name, version, target, ABI, interface fingerprint, and object fingerprint validate successfully.

Generate or update the canonical `valen.lock`:

```sh
node scripts/valen-project.mjs lock valen.project.json
```

Verify without writing:

```sh
node scripts/valen-project.mjs lock --locked valen.project.json
```

The lockfile sorts dependencies by name and records exact compiler-interface, target, ABI, interface, implementation, and object fingerprints. It contains no timestamps or absolute host paths. Registry resolution, Git dependencies, multiple targets, compiler-driver integration, and the self-hosted parser remain follow-up work in issue #104.
