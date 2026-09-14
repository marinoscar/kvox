#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';

// =============================================================================
// Jest, launched with the one Node flag this test suite needs (issue #51)
// =============================================================================
//
// WHY THIS FILE EXISTS. `notes/extraction/extract-pdf.ts` reads PDFs through
// `unpdf`, which loads Mozilla's pdf.js from an ESM-only bundle via a dynamic
// `import()`. Jest runs every test inside a `vm` context, and a dynamic import
// from inside one is refused outright unless Node was started with
// `--experimental-vm-modules`:
//
//     TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG]
//
// The flag is a V8/Node startup flag, so nothing inside `jest.config.js`,
// `test/setup.ts` or a `.env` file can set it — by the time any of those run,
// the process has already been configured. It has to be on the command line
// that starts Node, which is what this wrapper is for.
//
// WHY A WRAPPER RATHER THAN THE FLAG IN EACH npm SCRIPT. Two reasons:
//
//   1. `node --experimental-vm-modules <path-to-jest>` needs a PATH to jest's
//      entry point, and the only correct way to find it is `require.resolve`.
//      A hard-coded `../../node_modules/jest/bin/jest.js` is right for this
//      repository's hoisted layout today and wrong for any fork whose
//      installer hoists differently — a failure that would show up as "jest:
//      not found" with nothing to explain it.
//   2. `NODE_OPTIONS=--experimental-vm-modules jest` is shorter but is not a
//      portable npm script: the `VAR=value cmd` form is shell syntax that
//      Windows' `cmd.exe` does not understand, and this repository has no
//      `cross-env`.
//
// WHY NOT AVOID THE FLAG BY CHOOSING A DIFFERENT PDF LIBRARY. Tried, and the
// alternatives are worse — see `src/notes/extraction/extract-pdf.ts`'s header
// for the full comparison. Every maintained PDF text extractor in the Node
// ecosystem is pdf.js, and pdf.js has shipped ESM-only since v4.
//
// The precedent for a wrapper script that fixes a tool's environment before
// handing it its arguments is `scripts/prisma-env.js` next door.
// =============================================================================

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * Absolute path to jest's CLI entry point.
 *
 * ⚠ DERIVED FROM THE PACKAGE'S MAIN ENTRY, NOT REQUESTED BY SUBPATH.
 * `require.resolve('jest/bin/jest.js')` looks like the obvious call and fails:
 * jest's own `package.json` declares an `exports` map that does not publish
 * `./bin/jest.js`, so Node refuses the subpath (ERR_PACKAGE_PATH_NOT_EXPORTED)
 * even though the file is right there. Resolving the package's MAIN entry is
 * allowed, and the package root is two directories up from it — which also
 * keeps this correct under any hoisting layout, which was the whole point of
 * resolving rather than hard-coding.
 */
function resolveJestEntry() {
  const main = require.resolve('jest');
  const packageRoot = dirname(dirname(main));
  const entry = join(packageRoot, 'bin', 'jest.js');

  return existsSync(entry) ? entry : null;
}

const jestEntry = resolveJestEntry();

if (!jestEntry) {
  console.error('Could not resolve jest. Run `npm ci` from the repository root first.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    // The whole reason for this file. See the header.
    '--experimental-vm-modules',
    // Node prints an ExperimentalWarning for the flag above on every run. It is
    // expected, it is not actionable, and leaving it in makes every test run
    // start with a warning developers learn to ignore — which is how a REAL
    // warning gets ignored later.
    '--no-warnings=ExperimentalWarning',
    jestEntry,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);

    return;
  }

  process.exit(code === null ? 1 : code);
});

child.on('error', (error) => {
  console.error(`Could not start jest: ${error.message}`);
  process.exit(1);
});
