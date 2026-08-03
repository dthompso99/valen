# Operation model

All ordinary Valen calls are synchronous. A method represents unfinished work by returning an object implementing `Operations.Operation`; threading, event loops, child processes, interrupts, or inline execution are hidden execution policies.

## State

`operation.result()` is the source of truth:

- `null` means the operation is not terminal.
- `Operations.Succeeded` means it completed successfully.
- `Operations.Failed` carries a nonzero implementation-defined code and optional detail.
- `Operations.Cancelled` means cancellation became the terminal outcome.

`complete()` must be equivalent to `result() != null`. A terminal result is immutable in meaning and stable: repeated `result()` and `wait()` calls return the same result object.

Exactly one of `succeeded()`, `failed()`, and `cancelled()` is true for every standard terminal result.

## Cancellation

`cancel()` requests cooperative cancellation:

- `true` means the executor accepted the request.
- `false` means it could not accept it, normally because the operation was already terminal or is not cancellable.
- Acceptance does not guarantee `Cancelled`; work may race to success or failure before observing the request.
- Repeated cancellation requests must be safe.

## Waiting

`wait()` is synchronous and blocks until the operation is terminal. It is safe and idempotent. It returns the same terminal result subsequently exposed by `result()`.

Executors must detect or prevent waiting arrangements that would deadlock their own sole worker. That is an executor rule rather than a change to method-call semantics.

## Readiness event loops

`Operations.ReadyWork` adds a native descriptor and readiness interest to ordinary `Work`.
`EventLoopExecutor.submitReady()` returns an operation immediately; `runOne(timeout)` executes one
ready item, while `operation.wait()` may synchronously pump that item itself. Interest `1` means
readable and `4` means writable, matching the portable subset of poll-style readiness events.

The caller owns the returned operation handle. The executor retains only weak scheduling
references, so dropping a handle also permits its queued work to be reclaimed. Cancellation is
terminal before dispatch; work already running remains cooperative.

Targets without readiness polling report the capability unavailable and execute readiness work
inline. On x86-64 Linux the runtime uses the `poll` syscall directly. Regular files may report
immediately ready on Linux; readiness does not promise that storage latency is asynchronous.

## Progress

Progress is an optional capability expressed by `Operations.ProgressOperation`:

- `completedUnits()` is monotonic.
- `totalUnits()` is stable when known.
- A total of `0` means the total is unknown; units are operation-defined rather than implicitly percentages.
- Completion state still comes exclusively from `result()`.

## Results with values

The initial operation model represents completion status, not a typed payload. Result-bearing operations should introduce specific `OperationResult` subtypes until general-purpose generics support a standard typed result container.
