# File-backed value service friction report

Issue #75 extends the native HTTP example with a small persistent service. `GET /value` reads the current signed 64-bit value and `PUT /value` validates and replaces it. `VALEN_STATE_PATH` selects the state file.

Both self-hosted compiler generations build and run the service without shared-library dependencies. Live tests cover an absent state file, a valid update, restart and reload, rejected malformed input, negative values, malformed HTTP, and a corrupt state file at startup.

## Library and runtime gaps

Text configuration exposed the lack of checked integer parsing. `System.parseInteger` now returns an `IntegerParseResult`; this avoids inventing syntax or forcing optional primitive support into the milestone. Its conformance coverage includes both i64 limits, overflow, trailing whitespace, and invalid input.

Crash-safe replacement also needed three filesystem operations that were missing from the native boundary: file synchronization, atomic rename, and temporary-file removal. `State.Store` keeps those details outside the HTTP route code. A successful update writes a sibling `.tmp` file, synchronizes it, closes it, and atomically replaces the state path. Failed validation never changes memory or disk state, and failed persistence leaves the prior state file intact.

## Remaining WIP

This is deliberately a single-process service. Directory synchronization, advisory locking, recovery of abandoned temporary files, configurable listen addresses, concurrent requests, request-size limits, and production HTTP framing remain **WIP**. Those are concrete service/runtime follow-ups; the milestone did not reveal a need for new language syntax.
