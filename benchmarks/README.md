# Argon benchmarks

Run the standard benchmark from the repository root:

```sh
node scripts/benchmark.mjs
```

Produce CI artifacts and enforce resource ceilings:

```sh
node scripts/benchmark.mjs \
  --json benchmark-results.json \
  --markdown benchmark-results.md \
  --check-budgets
```

The standard run measures:

- generation-0/JavaScript compilation of the native generation-1 compiler
- generation-1 compilation of a fixed Argon workload
- assembly and executable sizes
- median runtime and peak RSS of the Argon workload
- the same workload compiled as C with `-O0` and `-O2`

The C programs are comparison anchors, not claims that Argon should match C at its current maturity. `-O0` helps expose backend/code-generation overhead; `-O2` shows the scale of mature optimization work still available.

Timing values are reported but do not fail CI because shared-runner speed varies. `budgets.json` contains deliberately generous peak-memory ceilings that catch runaway compiler behavior and OOM regressions without treating small machine differences as failures.

## Generation 2

Generation-2 compiler construction remains opt-in for local benchmark runs:

```sh
node scripts/benchmark.mjs --generation2 --json generation2-results.json
```

This records generation 1 building generation 2, then uses generation 2 to compile and execute the workload. CI enforces the supported 3 GiB peak-RSS ceiling; ordinary local runs omit it for speed.

## Benchmark rules

- Workloads must be deterministic and validate identical output across implementations.
- A workload change is a benchmark-definition change and should be reviewed explicitly.
- Results from different hardware are not directly comparable.
- Performance claims should include commit, platform, CPU, and Node version from the JSON metadata.
- Optimization tickets should record before/after results from the same machine.
