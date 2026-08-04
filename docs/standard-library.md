# Standard library architecture

Valen's standard library is a set of capability-oriented modules, not one inseparable runtime.
Applications should pay only for the facilities they import, and a fully static executable must
always remain a supported output. This preserves single-file deployment, `from:scratch` containers,
reproducible builds, and future freestanding targets.

## Library layers

- `core` contains compiler-coupled primitives such as strings, arrays, optionals, conversions, and
  the minimum tracing-runtime contracts. It is available without an explicit import.
- `std.collections` contains reusable maps, sets, queues, slices, and iterators without platform
  dependencies.
- `std.io` contains streams, files, paths, buffering, and standard input/output/error.
- `std.net` contains addresses and sockets, with protocols such as HTTP and WebSocket layered above
  the transport API.
- `std.concurrent` contains operations, executors, synchronization, atomics, and event loops.
- `std.system` contains process, environment, time, and platform-capability APIs.

Platform-independent APIs must remain separate from their native implementations. A collection-only
program must not acquire networking, threading, libc, or another hosted dependency.

## Installed layout and resolution

A Valen toolchain distribution should install the compiler beside a versioned, target-specific
sysroot:

```text
bin/valen
lib/valen/<release>/<target>/
    interfaces/
    objects/
    metadata/
    source/
```

The compiler resolves `std/...` imports from its own trusted sysroot without requiring
`VALEN_LIBRARY_PATH`. Project imports remain confined to their project root. `VALEN_LIBRARY_PATH`
continues to locate additional libraries anywhere on the filesystem and may explicitly override
non-core packages when the build policy permits it.

Installed modules carry a `.vmi` public interface, a relocatable `.o` implementation, and `.vmeta`
compatibility, dependency, target, and integrity information. Source ships alongside these artifacts
for diagnostics, debugging, and rebuilding, but ordinary non-generic consumers should not need to
parse implementation source.

## Static and shared policy

The initial stdlib distribution uses modular relocatable objects and static linking. The linker
selects only imported modules, and later section-level or function-level elimination may reduce them
further. Static linking is a permanent deployment choice rather than a bootstrap limitation.

Shared ELF libraries are a later, optional hosted mode for installations running multiple Valen
applications or loading plugins. Adding `.so` output requires an explicitly versioned Valen ABI,
position-independent code, dynamic symbol policy, and runtime coordination for type descriptors,
GC roots, worker safepoints, ownership, and finalizers. Static and shared builds must use the same
source imports; artifact selection is build policy.

## Generic modules

Generic stdlib APIs such as `StringMap<T>` cannot be distributed as an ordinary closed object alone:
the consuming application may instantiate them with a type unknown when the stdlib was built. Their
package interface must therefore retain enough template representation for deterministic
cross-module monomorphization, such as typed generic IR or the required source body. Concrete
specializations can then be cached and linked like other objects.

The first collection target is `StringMap<T>`, followed by `StringSet` built on a small concrete map
specialization. A fully generic `HashMap<K, V>` should wait until hashing and equality contracts,
generic ownership, and cross-module specialization have been exercised by these real uses.

## Delivery sequence

1. Define stable `std/...` module names and separate platform-neutral APIs from implementations.
2. Add a compiler-relative sysroot while retaining `VALEN_LIBRARY_PATH` for external packages.
3. Resolve compatible `.vmi`, `.vmeta`, and `.o` artifacts and feed selected objects to the linker.
4. Preserve generic templates across module boundaries and cache concrete specializations.
5. Introduce `StringMap<T>` and `StringSet`, then migrate compiler indexing code where appropriate.
6. Package compiler, interfaces, objects, metadata, and source as one versioned toolchain.
7. Rebuild the Clippy service from the installed toolchain as the end-to-end static-distribution proof.
8. Define the dynamic ABI and optional `.so` mode only after the static package boundary is proven.
