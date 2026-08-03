# Freestanding Argon profile

Freestanding Argon is the language and runtime contract for kernels, firmware, bootloaders,
and other targets that cannot assume an operating system or C library. It is a capability
profile, not a separate syntax or a permanently reduced version of Argon.

The current x86-64 Linux backend is hosted, but its ordinary executables own their `_start`
adapter and link without the C runtime. It does not yet emit fully freestanding binaries. This
document fixes the boundary that future targets and runtime work must implement.

## Required core

Every freestanding target must support:

- `bool`, `void`, and fixed-width signed and unsigned integers;
- local values, parameters, returns, calls, and lexical scopes;
- arithmetic, comparisons, short-circuit logic, conditionals, and loops;
- object and library declarations, methods, visibility, contracts, and compile-time ownership
  checks when their runtime values do not require an unavailable capability;
- deterministic zero initialization required by the language;
- a target ABI for calls and returns;
- a target-selected entry or exported-function boundary; and
- a non-returning trap facility for checked runtime failures such as division by zero.

The core makes no assumptions about a process, command-line arguments, files, clocks, threads,
standard streams, environment variables, dynamic libraries, or libc.

## Optional capabilities

Targets advertise capabilities independently. A compiler must reject a program when its IR
requires a capability that the selected target does not provide.

| Capability | Enables | Provider obligation |
| --- | --- | --- |
| `managed-memory` | `new`, managed objects, arrays, mutable builders, string-producing operations, GC, weak references, and `delete` | Zeroed aligned allocation, reclamation or a documented process/arena lifetime, root tracing, finalization, and allocation-failure trapping |
| `floating-point` | `f32`, `f64`, arithmetic, comparisons, and numeric conversion | Hardware instructions or semantically equivalent software routines |
| `atomics` | Atomic load, store, exchange, compare-exchange, and add | Target-correct ordering and atomic-width guarantees |
| `threads` | Thread executors, mutexes, and conditions | Thread creation/joining and synchronization; requires `atomics` |
| `io` | Target-defined byte input/output and diagnostic sinks | Platform library or application hooks; it does not imply files or standard streams |
| `filesystem` | File handles, paths, reads, writes, and filesystem errors | Platform-specific filesystem implementation; requires `io` |
| `network` | Network listeners, connections, reads, and writes | Target socket implementation or application-provided transport hooks; requires `io` |
| `readiness` | Event-loop executors and descriptor readiness waits | Native polling facility or an inline fallback; requires `io` |
| `process` | Arguments, environment, process exit, and current directory | Hosted process implementation |
| `foreign-abi` | `native ... from` declarations and automatic foreign-library link inputs | A named ABI and linker capable of resolving every requested symbol |

Read-only constants and compiler metadata may live in target static storage. Operations that
produce new strings or collections require `managed-memory`.

## Native declarations

Plain `native` declarations name facilities supplied by the selected Argon target runtime or
by explicit application hooks. Freestanding compilation must diagnose any unresolved native
symbol before linking.

Declarations using `from` are unavailable unless the target advertises `foreign-abi`. A
freestanding target never silently assumes library `c`, POSIX, Linux syscalls, pthreads, or a
system dynamic linker.

`System` is a hosted library, not part of the freestanding core. Freestanding libraries should
depend on narrow capability modules supplied by their target rather than import hosted
`System` APIs.

## Entry and failure behavior

A target chooses whether it constructs `entry`, exports named Argon functions, or uses a
platform adapter. The existing `entry.__` return rules remain valid when an entry adapter is
used, but a bare-metal target defines what happens to the returned status.

Checked failures call the target trap facility. A trap must not return. Diagnostic text is
optional because the core does not require I/O; targets with `io` may report the failure code
before trapping.

## Toolchain boundary

Freestanding describes the produced program's dependencies, not which linker produced it. Direct
object emission removes the assembler dependency while leaving link policy selectable. An Argon
object can be linked into a self-contained image, linked by the hosted system toolchain with
explicit libraries such as libc, or eventually linked by Argon's integrated linker. Supporting
one route must not remove the others.

## Current implementation status

- The parser, semantic model, ownership checks, and target-independent IR are reusable.
- Generation 0 and the self-hosted compiler directly encode ELF64 relocatable objects; executable
  linking remains a separate selectable policy.
- The only implemented executable target is hosted x86-64 Linux.
- Ordinary x86-64 Linux executables provide `_start`, link with `-nostdlib`, and have no implicit
  shared-library dependency. Target-native symbols are validated before linking.
- Foreign C calls and native threading add their libraries explicitly; an unavailable capability
  still requires an Argon implementation or an explicit target/application provider.
- General capability manifests, non-Linux startup, injectable runtime hooks, and fully
  freestanding linking are **WIP**.
- Additional architectures and operating systems remain tracked separately by issue #56.
