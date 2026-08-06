# Valen comparative benchmarks

This directory contains manually invoked, cross-language benchmarks. They do not run in ordinary CI:
performance results depend on hardware, host load, compiler versions, and thermal state, while some
language toolchains are intentionally optional.

Run the complete locally available suite from the repository root:

```sh
./scripts/bootstrap-valen.sh
node benchmarks/run.mjs
```

The benchmark runner deliberately does not bootstrap Valen. It uses the repository-root `./valen`
compiler produced by `scripts/bootstrap-valen.sh`, keeping bootstrap work outside the compilation and
runtime measurements. If `./valen` is absent, Valen is reported as skipped with the bootstrap command.

Select languages, change the measured repetition count, or preserve a machine-readable result:

```sh
node benchmarks/run.mjs --languages valen,c,cpp,rust,go
node benchmarks/run.mjs --repetitions 10
node benchmarks/run.mjs --output benchmarks/results/local.json
```

The runner discovers toolchains and reports unavailable languages as skipped. It uses one unmeasured
warmup followed by the requested measured repetitions. Every implementation must produce the same
deterministic output before its timing is accepted.

## Current workload

`integer-loop` performs one billion signed-integer iterations with multiplication, division, remainder
reconstruction, accumulation, and a deterministic checksum. Its duration is long enough for process RSS
sampling and reduces process-launch noise. It primarily measures instruction selection, register allocation,
integer division, loop branches, and JIT warmup where applicable; it does not represent whole-application
performance.

The report records:

- toolchain versions and exact host metadata
- compilation time and peak compiler RSS
- median, minimum, and maximum execution time
- peak runtime RSS
- primary artifact size
- ELF dynamic dependencies
- the fingerprint of the prebuilt native Valen compiler used for the run

Valen's self-contained executable size should not be compared naively with a dynamically linked executable.
The dependency column makes that distinction visible. Java and Node artifact sizes similarly exclude their
required runtimes.

## Comparison policy

- Treat C as the low-level native baseline, not an expected immediate tie.
- Compare C++, Rust, Go, Java, and Node as distinct runtime and productivity models.
- Keep equivalent algorithms recognizable across implementations.
- Use idiomatic language facilities where removing them would make the comparison artificial.
- Never compare results collected on different machines as if they were a speedup or regression.
- Record before and after results on the same quiet host for optimization work.
- Do not collapse unlike metrics into a single performance score.
- Review workload changes as benchmark-definition changes.

Expansion into object dispatch, allocation and garbage collection, strings, collections, file processing,
startup, and sustained HTTP service behavior is tracked in [Gitea #94](https://gitea.hallrd.click/dthompson/valen/issues/94).
