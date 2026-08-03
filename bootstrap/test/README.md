# Compiler test suites

`pipeline.test.js` checks the JavaScript bootstrap frontend, IR, and backend directly.

`generation1.test.js` builds the self-hosted compiler once, then uses it to compile and
execute every case in `conformance-manifest.js`. A valid case must compile and exit with
status zero. Expected-failure cases must compile and then produce their declared native
status and diagnostic output.

Add a fixture to the manifest when it becomes a stable end-to-end language regression.
Keep bootstrap-only structural assertions in `pipeline.test.js`. Generation 1 and generation
2 emit deterministic, length-delimited IR snapshots for every valid manifest entry. Invalid
manifest entries cover tokenization, module loading, semantic analysis, ownership, and multiple
diagnostics; both generations must return the declared status and identical diagnostic text.
