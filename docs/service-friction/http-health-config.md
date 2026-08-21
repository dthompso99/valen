# HTTP health and configuration service friction report

This report covers the first real-service milestone from issue #72. The service provides:

- `GET /health`
- `GET /`, serving the catalog-declared static documentation root
- `GET /config`, configured through `VALEN_SERVICE_NAME`
- explicit `404 Not Found` and `400 Bad Request` responses
- an unlimited deployment lifetime by default, with `VALEN_REQUEST_LIMIT` providing deterministic
  shutdown for integration testing

Both self-hosted compiler generations build the service as a self-contained executable without shared-library dependencies. The conformance suite starts each executable and verifies all four responses over a real TCP connection.

## Findings

### Library deficiencies

The original example mixed request parsing, response formatting, routing, and socket handling in one object. A small local `Http` module now owns request-line parsing and response serialization. This was a library-boundary problem; it did not require language syntax.

The service exposes both `GET /health` as plain text and `GET /health.json` as a deterministic JSON response. The JSON route uses the standard quoting implementation for configured service names and gives the example corpus a small request-throughput and RSS target with stable output.

The service loads `examples/site/index.html` when `/` is requested. `VALEN_DOCUMENT_ROOT` can select
another directory, while a 3 KiB bound keeps the example response within its deliberately small fixed
response limit. Other service routes remain available when the optional document root is absent.
General static-file routing remains part of the website work in #81.

The current network API still exposes listeners, connections, descriptor arrays, and readiness interests directly to the entrypoint. That is acceptable for this first transport example, but a reusable server library should eventually hide those mechanics from application orchestration.

Running the generation-1 and generation-2 services consecutively also showed that listeners could not immediately rebind after serving connections. The x86-64 networking runtime now sets `SO_REUSEADDR`; restart policy belongs in the transport boundary rather than in application sleeps or retry loops.

Configuring a port from text would require a reusable checked string-to-integer conversion. The first service therefore keeps port `18080` fixed and limits external configuration to a non-secret service name. This is a library gap, not evidence for new syntax.

### Tooling and diagnostic deficiencies

The first full service compile exposed two uninitialized reference-local backend defects. Generation zero emitted `QWORD PTR` twice around the stack slot. The self-hosted backend tried to derive the declaration type from its absent initializer instead of the declaration instruction. The native encoder then reported only `Expected register or memory operand`, which obscured the generated operand kind.

The backend defect was corrected in both compiler generations, and the encoder diagnostic now reports the received operand kind. Live service execution has also been added to the conformance harness; compile-only coverage was insufficient.

### Performance findings

No performance conclusion is justified by a four-request smoke service. Request parsing and response construction allocate immutable strings, but this milestone is too small to show whether those allocations are material.

### Language-design findings

No new language feature was needed. The route handler uses ordinary objects, optional checking, conditionals, strings, and returns. Native handles and readiness mechanics remain at the transport boundary, while `native`, `unsafe`, weak references, and explicit ownership operations do not appear in request routing.

## Deferred deliberately

Production HTTP parsing, partial reads/writes, configurable ports, concurrent connections, timeouts, cancellation, backpressure, signal handling, and graceful shutdown belong to later #72 milestones.
