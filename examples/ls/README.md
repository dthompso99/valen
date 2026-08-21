# ls

Lists a directory in deterministic byte order. Directories receive a `/` suffix and symbolic links an
`@` suffix. It demonstrates typed directory enumeration, metadata, arguments, and error handling.

```sh
./valen examples/ls/ls.ar -o valen-ls
./valen-ls examples
```

The example accepts zero or one directory. It intentionally omits permissions, ownership, timestamps,
recursive traversal, locale-aware sorting, and command-line flags.

