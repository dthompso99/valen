# Next session

## Verified baseline

- The JavaScript bootstrap compiler and Argon compiler both support inheritance, contracts, inherited fields, constructor chaining, subtyping, runtime type checks, checked downcasts, virtual dispatch, and direct `super.method()` calls.
- `cd bootstrap && npm test` passes 22 tests; one executable test is skipped when Node cannot spawn `cc` in the sandbox.
- Executables generated through both the bootstrap and native Argon compiler pass the inheritance and subtype fixtures with exit status 0.
- The multi-module operation-contract stress fixture passes through both compilers and native execution. It covers inherited and multiple contracts, identity, runtime checks, checked recovery, fields, arrays, parameters, returns, cancellation state, progress, and explicit waiting.

## Start here

1. Build on the completed one-word contract-reference and dispatch model:

   ```argon
   local printable:Printable = new Report()
   printable.print()
   ```

   Contract views preserve object identity and work through fields, parameters, returns, arrays, runtime checks, and checked casts. Multiple contracts, inherited contracts, and module boundaries are now verified by `bootstrap/test/fixtures/contracts/contract-stress.ar`.

2. The standard operation state, stable result objects, cooperative cancellation, optional progress, and explicit waiting are defined in `src/libOperations.ar` and `operation_model.md`. Next define synchronous `Work.run()` and `Executor.submit(work) -> Operation`, then implement an inline executor before adding native threads.

   Threading is an optional execution policy, not a method modifier. Submission transfers a retained work reference to the executor; unrestricted shared mutation waits for explicit synchronization and ownership rules.

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
- `bootstrap/test/fixtures/contracts/contract-stress.ar`
