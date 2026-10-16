#!/usr/bin/env node
import { EXIT } from '@marinoscar/platform-cli';

import { describeError, runApp } from './run.js';

// =============================================================================
// Executable entry point
// =============================================================================
//
// The ONLY module in this package with side effects at import time, and it is
// deliberately almost empty: the CLI is the platform's `createCli` over
// `APP_CLI_OPTIONS` (app.ts), run by `runApp` (run.ts).
//
// The shebang is what makes the built file directly executable once npm links
// it as `bin`. `postbuild` chmods it: tsc does not preserve a mode it never
// set, and a bin without the execute bit fails with EACCES on install.
// =============================================================================

/**
 * Set `process.exitCode` and RETURN, never `process.exit()`: `process.exit()`
 * ends the process without waiting for pending writes, and writes to a pipe are
 * asynchronous, so the version that exits works by hand and silently truncates
 * its output the moment somebody appends `| jq`.
 */
async function main(): Promise<void> {
  process.exitCode = await runApp(process.argv.slice(2));
}

// An unhandled rejection is a bug in this CLI, and Node's default response is a
// stack trace the user cannot act on. Convert it into the one-line failure every
// other error gets.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${describeError(reason)}\n`);
  process.exitCode = EXIT.FAILURE;
});

void main();
