# x86-64 LLVM backend baseline

Recorded on 2026-08-07 from the issue #99 working tree based on commit `7c9b2b8`.
The host used an AMD Ryzen 9 7950X, Fedora Linux 7.1.5, Clang 22.1.8, and GCC
16.1.1. Each runtime result is the median of three measured runs after one warmup.

```sh
node benchmarks/run.mjs --languages valen,valen-llvm,c --repetitions 3 \
  --output benchmarks/results/x86_64-llvm-baseline.json
```

| Backend | Compile | Runtime median | Peak runtime RSS | Artifact | Dependencies |
| --- | ---: | ---: | ---: | ---: | --- |
| Valen native | 0.029 s | 1.246 s | 36 KiB | 20.3 KiB | none |
| Valen LLVM | 0.034 s | 0.685 s | 32 KiB | 37.2 KiB | none |
| C `-O2` | 0.026 s | 0.559 s | 1.4 MiB | 12.2 KiB | `libc.so.6` |

The LLVM result retains Valen's self-contained runtime and has no dynamic
dependencies. On this workload it runs about 45% faster than the native backend
and about 23% slower than the dynamically linked C baseline. This is a single
integer-loop workload, not a general language-performance claim.
