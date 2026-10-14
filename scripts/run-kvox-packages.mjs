#!/usr/bin/env node
// =============================================================================
// Run an npm script in every @marinoscar/kvox-* workspace package
// =============================================================================
//
// Usage:  node scripts/run-kvox-packages.mjs <script> [--if-present]
//
// Lists the workspaces (root `workspaces` globs: `apps/*`, `packages/*`, ...)
// whose package.json `name` starts with `@marinoscar/kvox-`, then runs
// `npm run <script> -w <name> ...` for all of them in ONE npm call.
//
// Until Phase 2 (Epic 5, issue 5.1) adds the first such package there is
// nothing to run: the script prints
//   no @marinoscar/kvox-* packages yet; nothing to <script>
// and exits 0, so `npm run build:packages` and friends are safe no-ops in CI.
//
// Exit code: npm's exit code when packages exist; 0 when none; 2 on bad usage.
// Node built-ins only.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '@marinoscar/kvox-';

const args = process.argv.slice(2);
const ifPresent = args.includes('--if-present');
const positional = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && a !== '--if-present');
if (positional.length !== 1 || unknown.length > 0) {
  console.error('usage: node scripts/run-kvox-packages.mjs <script> [--if-present]');
  process.exit(2);
}
const script = positional[0];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Expands one `workspaces` entry: a literal directory or a `dir/*` glob. */
function expandWorkspace(pattern) {
  const clean = pattern.replace(/\/+$/, '');
  if (!clean.includes('*')) return [clean];
  if (!clean.endsWith('/*')) {
    console.error(`unsupported workspace glob '${pattern}' (only 'dir/*' is supported)`);
    process.exit(2);
  }
  const base = join(ROOT, clean.slice(0, -2));
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((entry) => statSync(join(base, entry)).isDirectory())
    .map((entry) => `${clean.slice(0, -2)}/${entry}`);
}

const rootPkg = readJson(join(ROOT, 'package.json'));
const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages ?? []);

const names = [];
for (const pattern of patterns) {
  for (const dir of expandWorkspace(pattern)) {
    const manifest = join(ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = readJson(manifest).name;
    if (typeof name === 'string' && name.startsWith(PREFIX)) names.push(name);
  }
}

if (names.length === 0) {
  console.log(`no ${PREFIX}* packages yet; nothing to ${script}`);
  process.exit(0);
}

const npmArgs = ['run', script, ...(ifPresent ? ['--if-present'] : []), ...names.flatMap((n) => ['-w', n])];
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
