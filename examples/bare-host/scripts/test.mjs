#!/usr/bin/env node
// =============================================================================
// `npm test -- --db service|pglite`
// =============================================================================
//
// Picks the database leg for the end-to-end test (the test reads BARE_HOST_DB),
// then runs Vitest. `--db` defaults to BARE_HOST_DB, then to `service`. Any other
// argument is passed through to Vitest.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectDir, 'package.json'));

const args = process.argv.slice(2);
let leg = process.env.BARE_HOST_DB || 'service';
const passthrough = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--db') {
    leg = args[i + 1];
    i += 1;
  } else passthrough.push(args[i]);
}
if (leg !== 'service' && leg !== 'pglite') {
  console.error(`test: --db must be service or pglite, not '${leg}'`);
  process.exit(2);
}

const manifestPath = require.resolve('vitest/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bin = join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest);

console.log(`test: database leg ${leg}`);
const result = spawnSync(process.execPath, [bin, 'run', ...passthrough], {
  cwd: projectDir,
  stdio: 'inherit',
  env: { ...process.env, BARE_HOST_DB: leg },
});
process.exit(result.status ?? 1);
