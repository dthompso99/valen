export const validPrograms = [
    {name: 'simple example', source: 'examples/simple/simple.ar'},
    {name: 'nested modules', source: 'examples/nested/nested.ar'},
    {name: 'inheritance and contracts', source: 'bootstrap/test/fixtures/inheritance.ar'},
    {name: 'subtypes and checked casts', source: 'bootstrap/test/fixtures/subtypes.ar'},
    {name: 'contract references', source: 'bootstrap/test/fixtures/contract-references.ar'},
    {name: 'contract ABI arguments', source: 'bootstrap/test/fixtures/abi-contract-arguments.ar'},
    {name: 'foreign libc call', source: 'bootstrap/test/fixtures/foreign-libc.ar'},
    {name: 'floating point', source: 'bootstrap/test/fixtures/floating-point.ar'},
    {name: 'default arguments', source: 'bootstrap/test/fixtures/default-arguments.ar'},
    {name: 'collection ownership', source: 'bootstrap/test/fixtures/collection-ownership.ar'},
    {name: 'garbage collection', source: 'bootstrap/test/fixtures/garbage-collection.ar'},
    {name: 'optional diagnostics', source: 'bootstrap/test/fixtures/diagnostics.ar'},
    {name: 'operation state', source: 'bootstrap/test/fixtures/operation-state.ar'},
    {name: 'native synchronization and threading', source: 'bootstrap/test/fixtures/threading.ar'},
    {name: 'iterators and for loops', source: 'bootstrap/test/fixtures/for-loops.ar'},
    {name: 'short-circuit control flow', source: 'bootstrap/test/fixtures/short-circuit.ar'},
    {name: 'native test runner', source: 'bootstrap/test/fixtures/native-tests.ar'}
];

export const expectedFailures = [
    {name: 'native test failure status', source: 'bootstrap/test/fixtures/native-tests-failing.ar', status: 1, stderr: /test failed/},
    {name: 'invalid float conversion status', source: 'bootstrap/test/fixtures/float-conversion-failing.ar', status: 76, stderr: /^$/}
];
