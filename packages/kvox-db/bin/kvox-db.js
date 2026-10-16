#!/usr/bin/env node
'use strict';

// The `kvox-db` command. The logic lives in src/bin (compiled to dist/bin) so
// it is typed and unit-tested; this file only wires it to the process.
const { runKvoxDb } = require('../dist/bin/index.js');

process.exitCode = runKvoxDb(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
