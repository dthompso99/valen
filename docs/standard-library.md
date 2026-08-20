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

The current installed module names retain their transition-era filenames, such as
`std/libSystem.ar` and `std/libHttp.ar`. Stable capability-oriented names are still **WIP**. Build a
sysroot with either generation 0 or a native compiler:

```sh
node scripts/package-stdlib.mjs --output dist/lib/valen
node scripts/package-stdlib.mjs --compiler ./valen --output dist/lib/valen
```

Set `VALEN_SYSROOT` to select a nonstandard installation. Otherwise the native compiler searches
relative to itself at `../lib/valen/current/x86_64-linux`.

Installed modules carry a `.vmi` public interface, a relocatable `.o` implementation, and `.vmeta`
compatibility, dependency, target, and integrity information. Source ships alongside these artifacts
for diagnostics, interface validation, debugging, and rebuilding. Source-free interface hydration is
still **WIP**; ordinary consumers already omit verified implementation bodies from IR and link the
installed object instead.

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

Generic stdlib APIs may be instantiated with types unknown when the stdlib is built. Their `.vmi`
interfaces therefore fingerprint the complete generic template, and the packaged source supplies
the method bodies for deterministic consumer-side monomorphization. Each canonical specialization
is emitted once into the consuming module and follows that module's normal cache identity; generated
specializations do not become part of the library's public interface.

`std/libStringMap.ar` provides an owning `StringMap<T>` for object values. `set` transfers ownership
to the map, `get` returns a borrowed optional reference, and `remove` returns an independent owned
value. `Collections.StringSet` is built on a concrete map specialization, and the standard scope
library uses the same map for its set implementation. Primitive map values and a fully generic
`HashMap<K, V>` remain **WIP** until generic ownership and hashing/equality contracts can express
their policies without special cases.

`std/libJson.ar` provides the bootstrap-safe JSON value tree used by native compiler tooling. It
preserves object member order, rejects duplicate keys, reports deterministic byte offsets, decodes
Unicode escapes, and serializes supported values without insignificant whitespace. The initial
number contract is signed `i64`; fractional and exponent forms are rejected explicitly rather than
rounded. Project-manifest schema rules remain outside the syntax library.
