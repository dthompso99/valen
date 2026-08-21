# wc

Counts newline bytes, whitespace-delimited words, and bytes for one or more files. It demonstrates
bounded input processing, byte-oriented text classification, aggregation, and explicit file cleanup.

```sh
./valen examples/wc/wc.ar -o valen-wc
./valen-wc README.md
```

Output columns are `lines words bytes path`. With multiple successful inputs, a `total` row follows.
The byte count is intentionally byte-oriented; Unicode display-width and grapheme counting are outside
this example's scope.

