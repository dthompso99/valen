# Static documentation root

`index.html` is the minimal static root served by the native HTTP example and the starting point for
the website tracked by #81. The website should render example navigation and pages from
[`../catalog.json`](../catalog.json); do not duplicate that metadata in this directory.

From the repository root:

```sh
./valen examples/http-native/server.ar -o valen-http
VALEN_REQUEST_LIMIT=1 ./valen-http
curl http://127.0.0.1:18080/
```

Set `VALEN_DOCUMENT_ROOT` to serve a different directory containing an `index.html` file. This
example serves only the root document; general static-file routing and deployment belong to #81.
