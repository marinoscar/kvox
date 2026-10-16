#!/usr/bin/env node
// =============================================================================
// Single-instance dependency check for the @marinoscar/kvox-* packages
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
//
// The checks themselves (lockfile duplicates; workspaces resolving one name to
// different real paths) live in scripts/check-single-instance.mjs, added by
// issue #461 and unit-tested there. This entry point is the one the packages
// pipeline runs, and adds what the packages need on top:
//
//   - `--guard` accepts a pattern with `*`, so one flag guards a whole scope:
//       --guard '@marinoscar/platform-*' --guard '@marinoscar/kvox-*'
//     A pattern expands to every package of that shape the lockfile, the
//     workspaces or node_modules/@marinoscar know about;
//   - every `@marinoscar/kvox-*` workspace package is guarded without a flag,
//     because two copies of the contract (one linked, one from the registry)
//     split `instanceof ZodError` checks and the error-code registry exactly
//     like two copies of a platform package.
//
// Usage: node scripts/kvox-packages/check-single-instance.mjs [--root <dir>]
//          [--lockfile-only] [--json] [--lockfile <path>] [--guard <name|pattern>]...
// Exit:  0 clean, 1 duplicates or splits found, 2 usage error.
//
// Node built-ins only. Importing this module runs nothing.
// =============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatReport, run } from '../check-single-instance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KVOX_PATTERN = '@marinoscar/kvox-*';

/** Regular expression for a `*` pattern (`*` matches any run of name characters). */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\w.-]*');
  return new RegExp(`^${escaped}$`);
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every package name the project knows about: lockfile `node_modules/<name>`
 * keys, `packages/*` workspace manifests and the folders of
 * `node_modules/<scope>/`.
 */
export function knownPackageNames(rootDir, lockfilePath) {
  const names = new Set();
  const lock = readJsonIfPresent(lockfilePath);
  for (const location of Object.keys(lock?.packages ?? {})) {
    const marker = location.lastIndexOf('node_modules/');
    if (marker !== -1) names.add(location.slice(marker + 'node_modules/'.length));
  }
  const packagesDir = join(rootDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      const manifest = readJsonIfPresent(join(packagesDir, entry, 'package.json'));
      if (typeof manifest?.name === 'string') names.add(manifest.name);
    }
  }
  const scopeDir = join(rootDir, 'node_modules', '@marinoscar');
  if (existsSync(scopeDir)) {
    for (const entry of readdirSync(scopeDir)) names.add(`@marinoscar/${entry}`);
  }
  return [...names].sort();
}

/**
 * Expands `*` patterns to concrete names; a name without `*` is kept as is.
 *
 * @param {string[]} guards Values of the `--guard` flags.
 * @param {string[]} known Package names the project knows about.
 * @returns {string[]} Concrete package names, without duplicates.
 */
export function expandGuards(guards, known) {
  const out = new Set();
  for (const guard of guards) {
    if (!guard.includes('*')) {
      out.add(guard);
      continue;
    }
    const matcher = patternToRegExp(guard);
    for (const name of known) if (matcher.test(name)) out.add(name);
  }
  return [...out];
}

function parseArgs(argv) {
  const opts = { lockfileOnly: false, json: false, lockfile: null, root: null, guard: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lockfile-only') opts.lockfileOnly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--guard' || arg === '--lockfile' || arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--guard') opts.guard.push(value);
      else opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `check-single-instance: ${err.message}\n\nUsage: node scripts/kvox-packages/check-single-instance.mjs [--root <dir>] [--lockfile-only] [--json] [--lockfile <path>] [--guard <name|pattern>]...`
    );
    process.exit(2);
  }
  const rootDir = resolve(opts.root ?? join(HERE, '..', '..'));
  const lockfilePath = resolve(opts.lockfile ?? join(rootDir, 'package-lock.json'));
  const known = knownPackageNames(rootDir, lockfilePath);
  const guard = expandGuards([...opts.guard, KVOX_PATTERN], known);
  try {
    const { code, report } = run({ ...opts, root: rootDir, lockfile: lockfilePath, guard });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else (code === 0 ? console.log : console.error)(formatReport(report));
    process.exit(code);
  } catch (err) {
    // The shared script throws its own usage error for a missing lockfile or an
    // uninstalled tree; report any such message and exit 2.
    if (err instanceof Error && err.constructor.name === 'UsageError') {
      console.error(`check-single-instance: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}
