# Concurrent HTTP service friction report

Issue #76 extends the native service into a readiness-driven connection loop. A slow client may remain incomplete while other clients finish normally. Each connection has a monotonic deadline, bounded input and output, partial nonblocking writes, explicit disconnect cleanup, and one response per connection.

Generation 1 and generation 2 live tests hold an incomplete request open while completing healthy traffic, disconnect another peer, exceed the request limit, observe timeout cleanup, and then verify that later requests still succeed. The executable remains self-contained and does not require threads or shared libraries.

## Library findings

The existing poll boundary was sufficient to schedule multiple connections, but the runtime lacked monotonic time and a partial-send operation. `EventLoop.monotonicMilliseconds` now uses the Linux monotonic clock, and `Network.sendSome` exposes one bounded nonblocking write. `Service.Client` owns offsets and retry state; route methods still return an ordinary `Http.Response`.

Request accumulation is capped at 4096 bytes and oversized requests receive 413. Serialized responses are also capped at 4096 bytes. These bounds provide backpressure at the application boundary without requiring unbounded buffering.

## Compiler and language findings

The service exposed a self-hosted compiler defect in cross-module default arguments: copied default expressions lost their inferred type before IR generation. The self-hosted semantic analyzer now restores the declared parameter type on the copied expression.

It also exposed a genuine ownership gap. Ordinary fields own their references, but an owning native cleanup operation could not consume such a field, and an owning optional array could not retire a slot by assigning `null`. Both operations are now accepted. The connection wrapper immediately nulls a consumed handle, keeping repeated cleanup from application code.

## Simplicity result

No thread pool or new concurrency syntax was necessary. Descriptor arrays, deadlines, partial writes, and cancellation remain inside `Service.Loop` and `Service.Client`. The application route method remains synchronous and reads like domain code.

Production HTTP framing, fair scheduling under a continuously ready listener, configurable limits, graceful signal shutdown, directory-level resource limits, and long-duration leak testing remain **WIP**.
