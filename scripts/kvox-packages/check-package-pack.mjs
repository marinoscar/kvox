#!/usr/bin/env node
// =============================================================================
// Pack check for the @marinoscar/kvox-* packages
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
//
// WHAT SHIPS IS NOT WHAT IS IN THE FOLDER. A package that builds and tests green
// can still publish broken: an `exports` target that the build never emitted, a
// `files` entry that drops the README, a stray `src/` or `.env` in the tarball.
// This script asks npm what it WOULD publish (`npm pack --dry-run --json`, which
// runs `prepack`, so LICENSE is copied) and checks the answer against the
// manifest. Run it after `npm run build:kvox-packages`.
//
// For every packages/kvox-* package:
//
//   manifest   name @marinoscar/<folder>; "license": "MIT"; engines.node >=24;
//              publishConfig.access "public" and provenance true;
//              repository.url the kvox repository and repository.directory
//              packages/<folder>; a version Changesets can move; `files`
//              names dist, README.md, CHANGELOG.md and LICENSE;
//              "./package.json" is exported.
//   present    the tarball holds package.json, README.md, LICENSE and every
//              file an `exports`, `main`, `module`, `types` or `bin` entry
//              points at. (CHANGELOG.md appears once Changesets writes it.)
//   only       the tarball holds nothing else: no src/, test/, docs-api/,
//              tsconfig*, typedoc.json, vitest config, tsbuildinfo, .env or
//              node_modules. Beyond the files above only dist/ and the package
//              folders `files` names (bin, schema, migrations) and the root
//              files it names (raw-sql-indexes.json, extensions.json).
//
// Usage: node scripts/kvox-packages/check-package-pack.mjs [--root <dir>] [--list]
//   --root <dir>  Repository root (default: this script's grandparent).
//   --list        Print every file of every tarball.
// Exit: 0 clean, 1 violations, 2 usage error.
//
// Node built-ins and npm only. Importing this module runs nothing.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listPackages } from './check-slice-peers.mjs';

/** Repository URL every package declares. */
export const REPOSITORY_URL = 'git+https://github.com/marinoscar/kvox.git';
/** Files every tarball must hold besides what `exports` points at. */
export const REQUIRED_FILES = Object.freeze(['package.json', 'README.md', 'LICENSE']);
/** Entries `files` must name. */
export const REQUIRED_FILES_ENTRIES = Object.freeze(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']);
/** Paths that never belong in a tarball, whatever `files` says. */
const FORBIDDEN = [
  /^src\//,
  /^test\//,
  /^docs-api\//,
  /^node_modules\//,
  /^tsconfig[^/]*\.json$/,
  /^typedoc\.json$/,
  /^vitest\.config\./,
  /\.tsbuildinfo$/,
  /^\.env/,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

const stripDot = (p) => p.replace(/^\.\//, '');

/** Every file path an `exports` value (string, conditions or nested) points at. */
export function exportTargets(value) {
  if (typeof value === 'string') return [stripDot(value)];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

/** The files a manifest promises: exports, main, module, types and bin targets. */
export function promisedFiles(manifest) {
  const out = new Set();
  for (const field of ['main', 'module', 'types']) {
    if (typeof manifest[field] === 'string') out.add(stripDot(manifest[field]));
  }
  const bin = manifest.bin;
  if (typeof bin === 'string') out.add(stripDot(bin));
  else if (bin) for (const target of Object.values(bin)) out.add(stripDot(target));
  for (const target of exportTargets(manifest.exports ?? {})) out.add(target);
  return [...out];
}

/** Manifest problems of one package (no tarball needed). */
export function checkManifest(dir, manifest) {
  const problems = [];
  const name = `@marinoscar/${dir}`;
  if (manifest.name !== name) problems.push(`name is '${manifest.name}', expected '${name}'`);
  if (manifest.license !== 'MIT') problems.push(`license is '${manifest.license}', expected 'MIT'`);
  if (manifest.private === true) problems.push('"private": true would make npm refuse to publish it');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) problems.push(`version '${manifest.version}' is not a semver`);
  if (!/^>=\s*24(?:\.|$)/.test(manifest.engines?.node ?? '')) problems.push(`engines.node is '${manifest.engines?.node}', expected '>=24'`);
  if (manifest.publishConfig?.access !== 'public') problems.push('publishConfig.access must be "public"');
  if (manifest.publishConfig?.provenance !== true) problems.push('publishConfig.provenance must be true');
  if (manifest.repository?.url !== REPOSITORY_URL) problems.push(`repository.url is '${manifest.repository?.url}', expected '${REPOSITORY_URL}'`);
  if (manifest.repository?.directory !== `packages/${dir}`) problems.push(`repository.directory is '${manifest.repository?.directory}', expected 'packages/${dir}'`);
  for (const entry of REQUIRED_FILES_ENTRIES) {
    if (!(manifest.files ?? []).includes(entry)) problems.push(`files does not name '${entry}'`);
  }
  if (!manifest.exports || !('./package.json' in manifest.exports)) problems.push('exports does not export "./package.json"');
  return problems;
}

/**
 * Checks a tarball's file list against the manifest.
 *
 * @param {object} manifest The package.json.
 * @param {string[]} files Paths in the tarball, relative to the package.
 * @returns {string[]} Problems (empty when clean).
 */
export function checkTarball(manifest, files) {
  const problems = [];
  const have = new Set(files);
  for (const file of [...REQUIRED_FILES, ...promisedFiles(manifest)]) {
    if (!have.has(file)) problems.push(`tarball is missing '${file}'${file.startsWith('dist/') ? ' (run the build first)' : ''}`);
  }
  const allowedTop = new Set(['package.json', ...(manifest.files ?? [])]);
  for (const file of files) {
    const top = file.split('/')[0];
    if (!allowedTop.has(top) && !allowedTop.has(file)) problems.push(`tarball holds '${file}', which no 'files' entry names`);
    else if (FORBIDDEN.some((pattern) => pattern.test(file))) problems.push(`tarball holds '${file}', which must never be published`);
  }
  return problems;
}

/** Runs `npm pack --dry-run --json` in a package folder; returns the file paths. */
export function npmPackFiles(packageDir) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed in ${packageDir}:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return parsed[0].files.map((f) => f.path).sort();
}

/**
 * Checks every package.
 *
 * @param {{ root: string, packFiles?: (dir: string) => string[] }} options `packFiles` is for tests.
 * @returns {{ package: string, problem: string }[]} Violations.
 */
export function checkPackages({ root, packFiles = npmPackFiles }) {
  const violations = [];
  for (const { dir, manifest } of listPackages(root)) {
    const add = (problem) => violations.push({ package: `@marinoscar/${dir}`, problem });
    for (const problem of checkManifest(dir, manifest)) add(problem);
    const folder = join(root, 'packages', dir);
    if (!existsSync(join(folder, 'dist'))) {
      add('dist/ does not exist; run `npm run build:kvox-packages` first');
      continue;
    }
    let files;
    try {
      files = packFiles(folder);
    } catch (err) {
      add(err.message);
      continue;
    }
    for (const problem of checkTarball(manifest, files)) add(problem);
  }
  return violations;
}

function main() {
  const argv = process.argv.slice(2);
  let root = null;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') list = true;
    else if (argv[i] === '--root' && argv[i + 1] !== undefined) {
      root = argv[i + 1];
      i += 1;
    } else {
      console.error(`check-package-pack: unknown argument '${argv[i]}'\nUsage: node scripts/kvox-packages/check-package-pack.mjs [--root <dir>] [--list]`);
      process.exit(2);
    }
  }
  const repoRoot = resolve(root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const packages = listPackages(repoRoot);
  if (packages.length === 0) {
    console.error('check-package-pack: no packages/kvox-* package found');
    process.exit(2);
  }
  const cache = new Map();
  const violations = checkPackages({
    root: repoRoot,
    packFiles: (dir) => {
      const files = npmPackFiles(dir);
      cache.set(dir, files);
      return files;
    },
  });
  if (list) for (const [dir, files] of cache) console.log(`${dir}\n${files.map((f) => `  ${f}`).join('\n')}`);
  if (violations.length === 0) {
    console.log(`Pack check passed (${packages.length} packages).`);
    process.exit(0);
  }
  for (const { package: name, problem } of violations) console.error(`[${name}] ${problem}`);
  console.error(`\nPack check FAILED: ${violations.length} problem${violations.length === 1 ? '' : 's'}.`);
  process.exit(1);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}
