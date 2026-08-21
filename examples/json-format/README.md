# JSON formatter

Parses JSON and writes its deterministic canonical representation. It demonstrates standard-library
JSON parsing, nested owned values, diagnostics, and bounded file input.

```sh
./valen examples/json-format/json-format.ar -o valen-json
./valen-json document.json
```

Objects preserve source key order and insignificant whitespace is removed. The current JSON library
supports signed 64-bit integers but not fractional or exponent-form numbers. Invalid input reports its
byte offset and exits with status `1`.

