# SQLite foreign-library service friction report

Issue #77 runs the concurrent service against SQLite through an explicit foreign C adapter. Generation 1 and generation 2 tests cover schema creation, prepared reads and writes, transactional updates, restart persistence, corrupt database diagnostics, concurrent traffic, and cleanup.

## Dependency finding

The development host had the versioned SQLite runtime but no header, unversioned linker symlink, or `pkg-config` metadata. `scripts/build-sqlite-adapter.sh` therefore supports two honest paths: use the development package when present, or compile the adapter against the installed `libsqlite3.so.0` ABI using the stable declarations needed by this narrow boundary. If neither is available, it prints Fedora and Alpine package guidance and exits.

CI installs `libsqlite3-dev` explicitly. The Alpine compiler image installs `sqlite-dev`, builds the adapter, and verifies that the self-hosted compiler links the SQLite service. This avoids accidental reliance on runner state.

## FFI and ownership finding

Valen's foreign ABI correctly kept ordinary managed strings away from arbitrary C functions. The adapter accepts integers and returns an opaque `SQLite.Database`; it obtains the configured database path from `VALEN_DATABASE_PATH`, owns C-string translation internally, and exposes error text through bounded byte access. Prepared statements are finalized and transactions are committed or rolled back inside the adapter. `SQLite.Store` is the only Valen code containing `unsafe` calls.

Route code remains unchanged in shape: it reads `store.value`, calls `store.update`, and handles a boolean result. Opaque handles, SQLite result codes, statement cleanup, and C strings do not leak into the HTTP layer.

## Deployment finding

The SQLite service intentionally declares `libvalen_sqlite_adapter.so`, which in turn declares the platform SQLite and C runtimes. The original service remains freestanding. A vendored SQLite amalgamation can be compiled into a deployment-specific adapter later; static foreign-artifact selection in the compiler driver remains **WIP**, so this milestone does not pretend the dynamic build is self-contained.

## Classification

- Library: a focused SQLite store and adapter were required.
- Tooling: native dependency detection and explicit CI/container provisioning were required.
- Diagnostics: SQLite error codes and messages now cross the boundary without exposing raw pointers.
- Performance: no conclusion is justified by this functional service corpus.
- Language design: no new syntax was needed.
