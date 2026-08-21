# cat

Copies one or more files to standard output. It demonstrates process arguments, bounded file reads,
error reporting, and deterministic resource cleanup.

```sh
./valen examples/cat/cat.ar -o valen-cat
./valen-cat README.md
```

The files are emitted in argument order. A missing or unreadable file is reported on standard error;
remaining files are still processed and the program exits with status `1`.

