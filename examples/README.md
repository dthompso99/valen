# Valen examples

These programs are recognizable software written naturally in Valen. The controlled cross-language
performance workloads remain under `benchmarks/`; this directory favors readability and practical use.

`catalog.json` is the shared index for repository documentation and the future website tracked by #81.
Each entry has a stable slug, display order, capability tags, runnable source, and explanatory page.
Documentation should state what the program demonstrates, how to build and run it, expected behavior,
and important limitations.

## Command-line programs

- [cat](cat/README.md) copies files to standard output.
- [wc](wc/README.md) counts lines, words, and bytes.
- `ls` is planned, but requires a native directory-enumeration API that Valen does not yet expose.

## Services

- [Native HTTP](../docs/service-friction/http-health-config.md) is a self-contained event-driven service.
- [SQLite HTTP](sqlite-native/README.md) demonstrates a narrow foreign-library boundary.
- [Clippy](../docs/service-friction/clippy.md) is the independently deployed HTTP/WebSocket application.

The service examples demonstrate language and runtime capability. They are not presented as hardened
public-facing HTTP stacks; each linked page records its current operational limits.
