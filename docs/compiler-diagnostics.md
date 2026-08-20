# Compiler diagnostics

The native Valen compiler writes human-readable diagnostics to standard error by default. Tools can request a stable, machine-readable stream with:

```sh
valen --diagnostic-format json --check src/main.ar
```

The JSON format is newline-delimited: each line is one complete diagnostic object. Diagnostics retain their deterministic compiler order, and a failed check keeps the ordinary exit status of `65`.

Each object contains:

- `severity`: `error`, `warning`, or `note`
- `message`: the primary diagnostic message
- `span`: `path`, byte `start` and `end` offsets, and one-based `line` and `column`
- `labels`: primary and secondary messages with their spans
- `notes`: supporting text
- `fixes`: replacement hints with messages, replacement text, and spans

For example:

```json
{"severity":"error","message":"Unknown identifier 'missing'","span":{"path":"src/main.ar","start":42,"end":49,"line":3,"column":16},"labels":[{"message":"Unknown identifier 'missing'","primary":true,"span":{"path":"src/main.ar","start":42,"end":49,"line":3,"column":16}}],"notes":[],"fixes":[]}
```

The JSON stream is intended for build integrations and other non-LSP consumers. Editors should continue to use the language server, which publishes the same compiler-owned spans and diagnostic detail through LSP.
