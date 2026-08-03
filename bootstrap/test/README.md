# Compiler test suites

`pipeline.test.js` checks the JavaScript bootstrap frontend, IR, and backend directly.

`generation1.test.js` builds the self-hosted compiler once, then uses it to compile and
execute every case in `conformance-manifest.js`. A valid case must compile and exit with
status zero. Expected-failure cases must compile and then produce their declared native
status and diagnostic output.

Add a fixture to the manifest when it becomes a stable end-to-end language regression.
Keep bootstrap-only structural assertions in `pipeline.test.js`. Future cross-generation
IR and invalid-diagnostic comparisons should extend the same manifest rather than create
independent fixture lists.
