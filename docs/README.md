# Valen documentation

If you are new to the project, read these in order:

1. [Quickstart](quickstart.md) — build the compiler and run a small program.
2. [Language guide](language-guide.md) — learn the syntax and current semantics.
3. [Project status](project-status.md) — see what works and what remains **WIP**.
4. [HTTP service friction report](service-friction/http-health-config.md) — see what the first real service taught us.
5. [File-backed service friction report](service-friction/file-backed-value.md) — see what atomic persistence added.
6. [Concurrent service friction report](service-friction/concurrent-http.md) — see how readiness, cancellation, and backpressure behaved.
7. [SQLite FFI friction report](service-friction/sqlite-ffi.md) — see how an explicit native dependency behaved.
8. [Clippy service friction report](service-friction/clippy.md) — see what the first long-running scratch deployment exposed.
9. [Language server](language-server.md) — connect editor diagnostics and semantic navigation through standard LSP.
10. [Standard library architecture](standard-library.md) — understand module boundaries, static distribution, and the future shared-library path.
11. [Project manifests and lockfiles](project-manifests.md) — describe and verify deterministic local dependency graphs.
12. [Runtime metrics](runtime-metrics.md) — inspect managed allocation, root, collection, and reclamation counters.

For compiler contributors:

- [Compiler developer guide](compiler-guide.md) explains the bootstrap, self-hosted pipeline, repository layout, and tests.
- [Contributor and agent guide](agent-guide.md) records the project’s working conventions.
- [Freestanding profile](freestanding.md) defines the capability boundary for kernels, firmware, and embedded targets.

Focused technical references:

- [Operation model](reference/operation-model.md)
- [Generic objects](reference/generics.md)
- [Floating-point rules](reference/floating-point.md)
- [Native and C FFI](reference/ffi.md)
- [Unsafe boundary](reference/unsafe-boundary.md)
- [x86-64 ABI](reference/x86-64-abi.md)

Planned work belongs in the [issue tracker](https://gitea.hallrd.click/dthompson/valen/issues). Documentation describes implemented behavior in the present tense and marks incomplete behavior as **WIP**.
