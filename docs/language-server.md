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
- Contextual completion for visible names, locals, parameters, types, imported libraries, object members, and enum cases
- Semantic highlighting for declarations, references, types, ownership modifiers, and native/unsafe boundaries
- Hierarchical document symbols for objects, libraries, methods, and fields

The server reuses the compiler's parser, module loader, semantic analyzer, and source spans. It does not maintain a separate understanding of Valen syntax or types.

## Scope

The development VS Code extension in `editors/vscode` associates `.ar` files, provides baseline TextMate syntax highlighting, and launches this server. Its semantic editor features remain compiler-owned through LSP rather than being reimplemented in the extension. The extension accepts alternate server and library paths for development; issue #110 tracks replacing the bundled Node.js bootstrap server with a distributable native Valen implementation.

Deprecated-item highlighting requires a future language-level deprecation model. Finer-grained incremental analysis remains measurement-gated and can be added without changing the protocol boundary.
