# Ownership and lifetime boundaries

This section is normative for managed references and explicit native-resource ownership. Storage reclamation strategy is not itself observable except through documented runtime instrumentation.

## Owning and borrowed values

**OWN-001 — New ownership.** `new T(...)` produces an owning reference to the constructed object. An ordinary managed-reference local or field holds ownership unless its declaration explicitly says `ref` or `weak`.

**OWN-002 — Borrowing calls.** Passing a managed reference to an ordinary parameter borrows the value for the duration of the call. The call must not transfer ownership, and the caller's binding remains usable afterward.

**OWN-003 — Owning calls.** Passing a managed reference to an `own` parameter transfers ownership. The consumed local, parameter, field, or array element must not be used again unless a new value is assigned to that storage.

**OWN-004 — Return ownership.** Returning a managed reference transfers ownership to the caller by default. A `ref` return is borrowed and must be rejected when its source cannot outlive the returned borrow.

**OWN-005 — Borrow validity.** A borrow is valid only while the binding from which it was derived still holds the same live value. Reassignment, ownership transfer, or destruction of that source invalidates the borrow; a later use must be diagnosed.

## Explicit reference policies

**OWN-010 — Reference members and elements.** `ref` members and `Array<ref T>` elements are non-owning references. Storing into them does not consume the source value, and their validity remains constrained by `OWN-005`.

**OWN-011 — Weak references.** `weak` members and `Array<weak T?>` elements are non-owning and nullable. A weak reference must become `null` when its referent is logically destroyed or reclaimed. A weak array element type must be optional.

**OWN-012 — Owning containers.** Inserting an owned managed reference into an owning array or owning generic collection transfers ownership into the container. Removing an owned element transfers ownership to the caller.

## Copy, deletion, and collection

**OWN-020 — Structural copy.** `copy value` creates an independent owning structural copy. Copying must terminate for cyclic graphs and preserve repeated-reference aliasing within the copied graph.

**OWN-021 — Deterministic deletion.** `delete value` performs logical destruction immediately and invalidates aliases and weak references according to their policies. A value already consumed or destroyed must not be deleted or used again.

**OWN-022 — Tracing reclamation.** Managed storage not deterministically deleted may be reclaimed after it becomes unreachable from precise roots. Reclamation timing is not a source-language guarantee.

**OWN-023 — Root safety.** A conforming backend must keep every live managed reference discoverable across calls and collection safe points. Optimization must not remove a required root or extend source-level ownership after transfer.

## Native resources

**OWN-030 — Native-resource handles.** A native resource handle is linear and owning unless its API explicitly documents another policy. It cannot be structurally copied or deleted as a managed object; ownership must move into the matching cleanup operation.

**OWN-031 — Cleanup transfer.** Passing a native handle to its owning close or cleanup parameter consumes it. Reusing or closing the consumed handle again must be rejected when statically visible or fail through the documented native error path otherwise.
