# Valen language server

Valen includes an editor-neutral Language Server Protocol implementation:

```sh
node scripts/valen-lsp.mjs
```

The server communicates through standard `Content-Length` framed JSON-RPC on stdin/stdout. Editors should launch it with the workspace root as `rootUri` and configure `VALEN_LIBRARY_PATH` when the project uses libraries outside the workspace.

## Capabilities

- Full-document synchronization with unsaved in-memory module overlays
- Parse and semantic diagnostics on open and change
- Error, warning, and note severity mapping
- Secondary source locations through diagnostic related information
- Structured replacement hints exposed as quick-fix code actions
- Hover information for bound symbols, types, ownership, and method signatures
- Go-to-definition across modules
- Find references across open modules and unsaved overlays
- Safe semantic rename with collision detection and workspace-root enforcement
- Hierarchical document symbols for objects, libraries, methods, and fields

The server reuses the compiler's parser, module loader, semantic analyzer, and source spans. It does not maintain a separate understanding of Valen syntax or types.

## Scope

This first implementation intentionally avoids editor-specific packaging. Issue #66 tracks the optional VS Code extension that can launch this server and associate it with `.ar` files. Future work may add completion, semantic tokens, and finer-grained incremental analysis without changing the protocol boundary.
