# Clippy long-running service friction report

Clippy is Valen's first independently deployed, long-running application. It compiles through the immutable `valen-builder` image into a non-root `FROM scratch` container and runs as a single-replica Kubernetes service. It serves HTTP health, metrics, a browser client, and standard WebSockets without libc or another runtime dependency.

## Library findings

HTTP parsing and RFC 6455 WebSocket handshake, framing, fragmentation, ping/pong, and close handling belong in reusable libraries. Keeping those details out of the application left Clippy's main loop focused on connections, clipboard state, and broadcast policy.

The service required bounded pending output, configurable message and connection limits, reusable client slots, and operational counters. Those are service policies rather than new language features. The intentional defaults remain one process-local clipboard, one replica, private-network access, and a configurable 100 MB message limit.

## Runtime findings

Disconnect churn exposed unsafe and ineffective tracing collection. Issue #79 moved strings and native handles into managed layouts, added adaptive collection and safe finalization, hardened stale-root handling, and retained a process-lifetime arena for the self-hosted compiler. A 4,000-request local soak then showed bounded memory cycling instead of monotonic growth. Production follow-up is tracked in #80.

Issue #102 added a bounded mixed-traffic reproducer in `scripts/clippy-memory-soak.mjs`. Each cycle sends 50 health requests and churns 20 successful WebSocket handshakes, forces two collections through an instrumentation-only endpoint, and records managed-heap, root, native-handle, RSS, virtual-memory, and mapping data. After warm-up, both native and LLVM x86_64 builds held a 1,984-byte/24-object managed floor, five roots, and two open native handles; 12 cycles finalized 852 transient handles without changing either live count.

The audit also corrected Clippy's connection table: retired slots were set to `null` but never reused, so the array and every event-loop descriptor scan grew with lifetime connection count. New accepts now fill the first retired slot before extending the array.

The remaining process-memory signal was outside the tracked managed heap. An isolated 150-request HTTP run grew RSS and virtual memory by only 16 KiB, and 60 rejected WebSocket upgrades behaved the same, but 60 successful upgrades added 256 KiB and left 52 additional 4 KiB anonymous mappings. Splitting the successful path showed handshake hashing/base64 remained flat while initial frame encoding reproduced the growth. The x86_64 `StringBuilder.append(string)` bulk-growth path allocated a replacement buffer and overwrote the old pointer without unmapping it; AArch64 already used the ownership-correct array reserve primitive. Routing x86_64 through that same primitive reduced both a 100-upgrade run and the 12-cycle mixed workload to a fixed 16-20 KiB warm-up in bootstrap, self-hosted native, and LLVM builds. Production redeployment and the multi-hour confirmation remain pending.

Graceful shutdown needed a minimal native signal boundary. `System.enableShutdownSignals()` installs handlers for SIGINT and SIGTERM; handlers only set a flag. `System.shutdownRequested()` lets the event loop observe that flag at a safe point, close clients and the listener, and exit successfully. Cleanup never runs in signal context.

## Compiler and tooling findings

The port exercised bitwise integer operations, variable-shift object encoding, native networking, configurable environment values, scratch linking, and generation parity. The most serious failures were runtime and compiler implementation defects, not missing application syntax.

Clippy's own CI builds the exact scratch image, starts it on a dynamic host port, verifies health, and runs malformed-frame, fragmentation, disconnect-churn, connection-cap, metrics, memory, and graceful-termination checks. Keeping this test in the consuming repository verifies the published builder rather than only the compiler checkout.

## Simplicity result

Valen's ordinary application code remained direct: initialize state, accept clients, service ready descriptors, and broadcast messages. Ownership, native handles, unsafe protocol machinery, and signal details stayed at library or runtime boundaries. The exercise did not justify additional language syntax.

The deployment path is now validated end to end:

`Valen source -> valen-builder -> native ELF -> non-root scratch image -> application CI -> registry -> Kubernetes`
