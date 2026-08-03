export const validPrograms = [
    {name: 'simple example', source: 'examples/simple/simple.ar'},
    {name: 'nested modules', source: 'examples/nested/nested.ar'},
    {name: 'inheritance and contracts', source: 'bootstrap/test/fixtures/inheritance.ar'},
    {name: 'subtypes and checked casts', source: 'bootstrap/test/fixtures/subtypes.ar'},
    {name: 'contract references', source: 'bootstrap/test/fixtures/contract-references.ar'},
    {name: 'contract ABI arguments', source: 'bootstrap/test/fixtures/abi-contract-arguments.ar'},
    {name: 'foreign libc call', source: 'bootstrap/test/fixtures/foreign-libc.ar'},
    {name: 'integer bitwise operators', source: 'bootstrap/test/fixtures/bitwise.ar'},
    {name: 'WebSocket handshake', source: 'bootstrap/test/fixtures/websocket-handshake.ar'},
    {name: 'WebSocket framing', source: 'bootstrap/test/fixtures/websocket-frames.ar'},
    {name: 'HTTP header parsing', source: 'bootstrap/test/fixtures/http-headers.ar'},
    {name: 'floating point', source: 'bootstrap/test/fixtures/floating-point.ar'},
    {name: 'default arguments', source: 'bootstrap/test/fixtures/default-arguments.ar'},
    {name: 'collection ownership', source: 'bootstrap/test/fixtures/collection-ownership.ar'},
    {name: 'garbage collection', source: 'bootstrap/test/fixtures/garbage-collection.ar'},
    {name: 'repeated garbage collection', source: 'bootstrap/test/fixtures/garbage-collection-repeated.ar'},
    {name: 'optional diagnostics', source: 'bootstrap/test/fixtures/diagnostics.ar'},
    {name: 'operation state', source: 'bootstrap/test/fixtures/operation-state.ar'},
    {name: 'native synchronization and threading', source: 'bootstrap/test/fixtures/threading.ar'},
    {name: 'readiness event loop', source: 'bootstrap/test/fixtures/event-loop.ar'},
    {name: 'iterators and for loops', source: 'bootstrap/test/fixtures/for-loops.ar'},
    {name: 'short-circuit control flow', source: 'bootstrap/test/fixtures/short-circuit.ar'},
    {name: 'checked integer parsing', source: 'bootstrap/test/fixtures/integer-parsing.ar'},
    {name: 'native test runner', source: 'bootstrap/test/fixtures/native-tests.ar'},
    {name: 'self-hosted x86 object parser', source: 'bootstrap/test/fixtures/x86-object-parser.ar'}
];

export const expectedFailures = [
    {name: 'native test failure status', source: 'bootstrap/test/fixtures/native-tests-failing.ar', status: 1, stderr: /test failed/},
    {name: 'invalid float conversion status', source: 'bootstrap/test/fixtures/float-conversion-failing.ar', status: 76, stderr: /^$/}
];

export const targetFailures = [
    {
        name: 'unsupported target native',
        source: 'bootstrap/test/fixtures/unsupported-native.ar',
        status: 69,
        stderr: /valen: target: x86_64-linux runtime does not provide valen_Missing_value/
    }
];

export const compileOnlyPrograms = [
    {name: 'native HTTP service', source: 'examples/http-native/server.ar', live: 'file'},
    {name: 'SQLite-backed native HTTP service', source: 'examples/sqlite-native/server.ar', live: 'sqlite', foreignDependency: 'libvalen_sqlite_adapter.so'}
];

export const invalidPrograms = [
    {name: 'invalid token', source: 'bootstrap/test/fixtures/invalid-token.ar', status: 65, stderr: /invalid-token\.ar:2:5: error: Unexpected byte 64/},
    {name: 'missing contract implementation', source: 'bootstrap/test/fixtures/missing-implementation.ar', status: 65, stderr: /missing-implementation\.ar:5:1: error: Object 'Broken' is missing method 'required'/},
    {name: 'invalid ownership transfer', source: 'bootstrap/test/fixtures/invalid-ownership.ar', status: 65, stderr: /invalid-ownership\.ar:12:21: error: Cannot pass borrowed reference 'engine'/},
    {name: 'multiple semantic errors', source: 'bootstrap/test/fixtures/native-semantic-errors.ar', status: 65, stderr: /Cannot use value of type 'i64'[\s\S]*Unknown name 'missing'/},
    {name: 'module import cycle', source: 'bootstrap/test/fixtures/module-cycle-a.ar', status: 65, stderr: /module-cycle-b\.ar:1:1: error: Circular import involving/}
];
