#!/usr/bin/env node
'use strict';

// =============================================================================
// Jest, launched with the one Node flag the notes slice's specs need (issue #495, epic #491)
// =============================================================================
//
// Modelled on `apps/api/scripts/jest.js` (marinoscar/enterpriseappbase, not copied verbatim).
//
// WHY THIS FILE EXISTS. The notes slice reads PDFs through `unpdf`, which loads Mozilla's pdf.js
// from an ESM-only bundle via a dynamic `import()`. Jest runs every test inside a `vm` context,
// and a dynamic import from inside one is refused outright unless Node was started with
// `--experimental-vm-modules` (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`). The flag is a
// startup flag, so nothing inside `jest.config.js` can set it; it has to be on the command line
// that starts Node. A wrapper rather than `NODE_OPTIONS=... jest` because the `VAR=value cmd` form
// is not a portable npm script. Every script of the package that runs jest goes through this file.
// =============================================================================

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

/** Absolute path to jest's CLI entry point, derived from the package's MAIN entry (its `exports` map hides `bin`). */
function resolveJestEntry() {
  const main = require.resolve('jest');
  const entry = join(dirname(dirname(main)), 'bin', 'jest.js');

  return existsSync(entry) ? entry : null;
}

const jestEntry = resolveJestEntry();

if (!jestEntry) {
  console.error('Could not resolve jest. Run `npm ci` from the repository root first.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning', jestEntry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);

    return;
  }

  process.exit(code === null ? 1 : code);
});
