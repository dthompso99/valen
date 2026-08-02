# Next session

## Verified baseline

- The JavaScript bootstrap compiler and Argon compiler both support inheritance, contracts, inherited fields, constructor chaining, subtyping, runtime type checks, checked downcasts, virtual dispatch, and direct `super.method()` calls.
- `cd bootstrap && npm test` passes 22 tests; one executable test is skipped when Node cannot spawn `cc` in the sandbox.
- Executables generated through both the bootstrap and native Argon compiler pass the inheritance and subtype fixtures with exit status 0.

## Start here

1. Define contract-typed references and dispatch so an implementing object can be passed through a contract type:

   ```argon
   local printable:Printable = new Report()
   printable.print()
   ```

   Decide the hidden representation first. A contract reference must preserve object identity, runtime casts, ownership, fields, parameters, returns, and collection storage while locating the concrete implementation of each required method.

2. Define the standard object contract for unfinished work: completion, failure, cancellation, and explicit waiting. Ordinary calls remain synchronous; do not introduce implicit async behavior.

3. Continue the object-model roadmap with visibility only after the contract-reference ABI is stable.

## Useful checks

```sh
cd bootstrap
npm test
```

The native end-to-end fixtures are:

- `bootstrap/test/fixtures/inheritance.ar`
- `bootstrap/test/fixtures/subtypes.ar`
- `bootstrap/test/fixtures/missing-implementation.ar`
