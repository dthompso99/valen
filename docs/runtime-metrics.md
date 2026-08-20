# Runtime metrics

Runtime instrumentation is disabled by default. Pass `--runtime-metrics` when compiling to enable the counters and allow calls to `System.runtimeMetrics()`:

```sh
valen --runtime-metrics app.ar -o app
```

Without the flag, generated runtimes omit the optional counter storage and update instructions. Optional counters read as zero if application code takes a snapshot in such a build; `trackedBytes` and `arenaEnabled` remain available because their underlying state is required by normal allocation behavior. Optimization levels do not silently change this contract: instrumentation is controlled only by the explicit flag.

`System.runtimeMetrics()` returns a point-in-time `System.RuntimeMetrics` object for diagnosing managed-runtime behavior. The x86-64 native and LLVM-backed compilers expose the same fields:

| Field | Meaning |
| --- | --- |
| `trackedBytes` | Bytes in currently tracked managed heap mappings. |
| `trackedAllocatedBytes` | Cumulative bytes added to tracked managed heap mappings. |
| `heapObjects` | Managed heap objects currently tracked. |
| `roots` | Root frames currently registered with the collector. |
| `peakRoots` | Highest registered-root count observed by the process. |
| `collections` | Collection cycles started. |
| `reclaimedObjects` | Cumulative managed objects reclaimed. |
| `trackedReclaimedBytes` | Cumulative tracked mapping bytes reclaimed. |
| `weakReferencesCleared` | Cumulative non-null weak entries cleared during collection. |
| `weakReferencesRetained` | Cumulative non-null weak entries retained during collection. |
| `nativeHandlesOpen` | Native file/socket handles currently open through the tracked handle finalizer. |
| `nativeHandlesFinalized` | Cumulative tracked handles closed explicitly or by collection. |
| `arenaEnabled` | Whether process-arena allocation is enabled. |

Current-value counters (`trackedBytes`, `heapObjects`, and `roots`) may rise or fall. The allocation, peak, collection, and reclamation counters are monotonic for the life of the process. A snapshot is not an atomic transaction across threads, so individual fields can reflect adjacent runtime events in a concurrent program.

The word "tracked" is intentional. These byte counters describe the managed mappings already accounted for by the collector; they are not RSS, working set, total virtual memory, or complete accounting for every auxiliary backing buffer and native resource. Arena allocations bypass normal reclamation, and `arenaEnabled` makes that mode visible to diagnostics.

Creating the returned `RuntimeMetrics` object is itself a managed allocation. Its allocation happens after the native counters have been read, so it is not included in that same snapshot.

Example:

```argon
import System from '/src/libSystem.ar'

entry {{
    __() -> i32 {
        local metrics = System.runtimeMetrics()
        System.print(metrics.trackedBytes)
        System.print(metrics.heapObjects)
        System.print(metrics.collections)
        return 0
    }
}}
```

Run `node scripts/runtime-metrics-soak.mjs` for deterministic newline-free JSON samples from the bootstrap native backend. Pass `--compiler <native-valen> --backend native|llvm` to compare self-hosted backends. Samples cover fixed allocation churn before and after four explicit collections and validate monotonic counter invariants. RSS/working-set sampling remains an external operating-system observation rather than a Valen runtime counter.
