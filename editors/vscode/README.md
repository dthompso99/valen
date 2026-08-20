# Valen Language Support for VS Code

This extension associates `.ar` files with Valen and provides baseline syntax highlighting, comments, brackets, and editor integration through the repository's language server. The server supplies diagnostics, formatting, completion, hover, navigation, rename, references, symbols, quick fixes, and semantic highlighting.

## Development installation

From this directory, run `npm install`, then use VS Code's **Run Extension** launch flow or package the directory with `npx vsce package`.

From a repository checkout, the extension launches `scripts/valen-lsp.mjs`. Set `valen.server.path` to test another server location or implementation. `valen.libraryPath` configures imports outside the workspace.

The Node.js server and this checkout-oriented extension are development tooling; neither is part of compiled Valen applications. A future native, distributable implementation and corresponding packaged-extension transition are tracked separately by issue #110.
