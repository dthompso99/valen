# Clippy long-running service friction report

Clippy is Valen's first independently deployed, long-running application. It compiles through the immutable `valen-builder` image into a non-root `FROM scratch` container and runs as a single-replica Kubernetes service. It serves HTTP health, metrics, a browser client, and standard WebSockets without libc or another runtime dependency.

## Library findings

HTTP parsing and RFC 6455 WebSocket handshake, framing, fragmentation, ping/pong, and close handling belong in reusable libraries. Keeping those details out of the application left Clippy's main loop focused on connections, clipboard state, and broadcast policy.

The service required bounded pending output, configurable message and connection limits, reusable client slots, and operational counters. Those are service policies rather than new language features. The intentional defaults remain one process-local clipboard, one replica, private-network access, and a configurable 100 MB message limit.

## Runtime findings

Disconnect churn exposed unsafe and ineffective tracing collection. Issue #79 moved strings and native handles into managed layouts, added adaptive collection and safe finalization, hardened stale-root handling, and retained a process-lifetime arena for the self-hosted compiler. A 4,000-request local soak then showed bounded memory cycling instead of monotonic growth. Production follow-up is tracked in #80.

Graceful shutdown needed a minimal native signal boundary. `System.enableShutdownSignals()` installs handlers for SIGINT and SIGTERM; handlers only set a flag. `System.shutdownRequested()` lets the event loop observe that flag at a safe point, close clients and the listener, and exit successfully. Cleanup never runs in signal context.

## Compiler and tooling findings

The port exercised bitwise integer operations, variable-shift object encoding, native networking, configurable environment values, scratch linking, and generation parity. The most serious failures were runtime and compiler implementation defects, not missing application syntax.

Clippy's own CI builds the exact scratch image, starts it on a dynamic host port, verifies health, and runs malformed-frame, fragmentation, disconnect-churn, connection-cap, metrics, memory, and graceful-termination checks. Keeping this test in the consuming repository verifies the published builder rather than only the compiler checkout.

## Simplicity result

Valen's ordinary application code remained direct: initialize state, accept clients, service ready descriptors, and broadcast messages. Ownership, native handles, unsafe protocol machinery, and signal details stayed at library or runtime boundaries. The exercise did not justify additional language syntax.

The deployment path is now validated end to end:

`Valen source -> valen-builder -> native ELF -> non-root scratch image -> application CI -> registry -> Kubernetes`
