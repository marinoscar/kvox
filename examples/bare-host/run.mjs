#!/usr/bin/env node
// =============================================================================
// Bare-host smoke runner (issue #505, epic #498)
// =============================================================================
//
// Copies this project to a temporary directory OUTSIDE the repository, installs
// the packed @marinoscar/kvox-{contract,db,api} tarballs (never a workspace
// link), builds it, prepares the database layer, runs the end-to-end test and
// then proves what a workspace link would have hidden:
//
//   - a file missing from a package's `files` list, a dev-only dependency, a
//     wrong `exports` condition, a missing `.js` extension (the install and the
//     build fail instead of resolving through the monorepo);
//   - a duplicated singleton (`check-single-instance`);
//   - a platform package that came back in through the side door
//     (`node_modules/@marinoscar/platform-api` and `platform-web` must not exist);
//   - an app that uses a slice without listing the slice's peers
//     (`check-slice-peers --app`), except the four peers this host deliberately
//     leaves out because the feature that needs them is switched off.
//
// Usage:
//   node examples/bare-host/run.mjs [--from pack|tarballs <dir>|registry <tag>]
//                                   [--db service|pglite] [--keep] [--dir <dir>]
//
//   --from pack            `npm pack` the three workspace packages (build them
//                          first: `npm run build:kvox-packages`). The default.
//   --from tarballs <dir>  use the `marinoscar-kvox-{contract,db,api}-*.tgz`
//                          files already in <dir> (what CI does).
//   --from registry <tag>  install `@marinoscar/kvox-*@<tag>` from the registry.
//   --db service           PostgreSQL with pgvector named by DATABASE_URL (a
//                          role that may create databases and extensions). The
//                          default.
//   --db pglite            an in-process PGlite served on a loopback socket.
//   --keep                 keep the temporary directory (its path is printed).
//   --dir <dir>            use this (empty or new) directory instead of a
//                          fresh one under the system temp directory.
//
// Exit codes: 0 every step passed | 1 a step failed | 2 usage error.
//
// Modelled on marinoscar/enterpriseappbase tests/consumer-smoke/run.mjs (not
// copied verbatim). Node built-ins only.
// =============================================================================

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const KVOX_PACKAGES = ['contract', 'db', 'api'];
const FORBIDDEN_INSTALLS = [
  '@marinoscar/platform-api',
  '@marinoscar/platform-web',
  'pdfkit',
  'docx',
  'unpdf',
  '@nestjs/schedule',
];
/** Peers the slices list but this host leaves out on purpose (the feature is switched off in forRoot). */
const LEFT_OUT_PEERS = ['@nestjs/schedule', 'pdfkit', 'docx', 'unpdf'];
const COPY_EXCLUDE = new Set(['node_modules', 'dist', 'prisma', '.data', 'package-lock.json']);

const USAGE =
  'Usage: node examples/bare-host/run.mjs [--from pack|tarballs <dir>|registry <tag>] [--db service|pglite] [--keep] [--dir <dir>]';

function usage(message) {
  console.error(`run: ${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { from: 'pack', fromArg: null, db: 'service', keep: false, dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) usage(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--from') {
      opts.from = value();
      if (!['pack', 'tarballs', 'registry'].includes(opts.from)) usage(`--from must be pack, tarballs or registry, not '${opts.from}'`);
      if (opts.from !== 'pack') opts.fromArg = value();
    } else if (arg === '--db') {
      opts.db = value();
      if (!['service', 'pglite'].includes(opts.db)) usage(`--db must be service or pglite, not '${opts.db}'`);
    } else if (arg === '--keep') opts.keep = true;
    else if (arg === '--dir') opts.dir = resolve(value());
    else usage(`unknown argument '${arg}'`);
  }
  return opts;
}

/** True when `child` is `parent` or inside it (both resolved through symlinks). */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Runs a command, streaming its output; returns the exit status. */
function sh(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) console.error(`run: ${command} could not start: ${result.error.message}`);
  return result.status ?? 1;
}

function fail(step, status) {
  console.error(`\nrun: STEP FAILED: ${step} (exit ${status})`);
  process.exit(1);
}

function step(label, command, args, options) {
  const status = sh(label, command, args, options);
  if (status !== 0) fail(label, status);
}

const opts = parseArgs(process.argv.slice(2));

// -- The temporary project, never inside the repository ------------------------
let root;
if (opts.dir) {
  mkdirSync(opts.dir, { recursive: true });
  if (readdirSync(opts.dir).length > 0) usage(`--dir ${opts.dir} is not empty`);
  root = realpathSync(opts.dir);
} else {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kvox-bare-host-')));
}
if (isInside(realpathSync(REPO), root)) {
  rmSync(root, { recursive: true, force: true });
  console.error(
    `run: the temporary directory ${root} is inside the repository ${REPO}. A consumer test must run where no workspace link can resolve; set TMPDIR to a directory outside the repository.`,
  );
  process.exit(1);
}
const app = join(root, 'app');
const tarballDir = join(root, 'tarballs');
mkdirSync(tarballDir, { recursive: true });

function cleanup() {
  if (opts.keep) console.log(`\nrun: kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.on('exit', cleanup);

// -- 1. The three kvox specs ---------------------------------------------------
/** @type {Record<string, string>} */
const specs = {};
if (opts.from === 'pack') {
  for (const name of KVOX_PACKAGES) {
    if (!existsSync(join(REPO, 'packages', `kvox-${name}`, 'dist'))) {
      console.error(`run: packages/kvox-${name}/dist is missing. Build first: npm run build:kvox-packages`);
      process.exit(1);
    }
  }
  for (const name of KVOX_PACKAGES) {
    step(`npm pack @marinoscar/kvox-${name}`, 'npm', ['pack', '-w', `@marinoscar/kvox-${name}`, '--pack-destination', tarballDir], { cwd: REPO });
  }
}
if (opts.from === 'pack' || opts.from === 'tarballs') {
  const dir = opts.from === 'pack' ? tarballDir : resolve(opts.fromArg);
  if (!existsSync(dir)) usage(`tarball directory ${dir} does not exist`);
  const files = readdirSync(dir);
  for (const name of KVOX_PACKAGES) {
    const found = files.filter((f) => new RegExp(`^marinoscar-kvox-${name}-.*\\.tgz$`).test(f));
    if (found.length !== 1) {
      console.error(`run: expected exactly one marinoscar-kvox-${name}-*.tgz in ${dir}, found ${found.length}`);
      process.exit(1);
    }
    specs[`@marinoscar/kvox-${name}`] = `file:${join(dir, found[0])}`;
  }
} else {
  for (const name of KVOX_PACKAGES) specs[`@marinoscar/kvox-${name}`] = opts.fromArg;
}

// -- 2. Copy the project and rewrite its manifest --------------------------------
cpSync(HERE, app, {
  recursive: true,
  filter: (src) => {
    const rel = relative(HERE, src);
    return rel === '' || !COPY_EXCLUDE.has(rel.split(sep)[0]);
  },
});
const manifestPath = join(app, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The platform pin is the repository's, never a second opinion (check:platform-pin
// reads workspaces only, and this folder is not one).
const apiManifest = JSON.parse(readFileSync(join(REPO, 'apps', 'api', 'package.json'), 'utf8'));
const pin = apiManifest.dependencies?.['@marinoscar/platform-db'] ?? apiManifest.devDependencies?.['@marinoscar/platform-db'];
if (manifest.dependencies['@marinoscar/platform-db'] !== pin) {
  console.error(
    `run: examples/bare-host/package.json pins @marinoscar/platform-db ${manifest.dependencies['@marinoscar/platform-db']}, the repository pins ${pin}. Update the example (npm run check:platform-pin does not read it).`,
  );
  process.exit(1);
}

for (const [name, spec] of Object.entries(specs)) manifest.dependencies[name] = spec;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// -- 3. Install, build, prepare, test --------------------------------------------
step('npm install (packed tarballs)', 'npm', ['install', '--no-audit', '--no-fund'], { cwd: app });

for (const name of FORBIDDEN_INSTALLS) {
  if (existsSync(join(app, 'node_modules', ...name.split('/')))) {
    console.error(`\nrun: ${name} is installed in the temporary project. The bare host must not depend on it (directly or through a peer).`);
    process.exit(1);
  }
}
console.log('\nrun: none of platform-api, platform-web, pdfkit, docx, unpdf, @nestjs/schedule is installed');

step('npm run prepare:db', 'npm', ['run', 'prepare:db'], { cwd: app });
step('npm run build', 'npm', ['run', 'build'], { cwd: app });
step(`npm test -- --db ${opts.db}`, 'npm', ['test', '--', '--db', opts.db], { cwd: app, env: process.env });

// -- 4. The checks a workspace link would hide ------------------------------------
const kvoxScripts = join(REPO, 'scripts', 'kvox-packages');
step('check-single-instance', process.execPath, [
  join(kvoxScripts, 'check-single-instance.mjs'),
  '--root',
  app,
  '--guard',
  '@marinoscar/kvox-*',
  '--guard',
  '@marinoscar/platform-*',
]);
step('check-slice-peers --app', process.execPath, [
  join(kvoxScripts, 'check-slice-peers.mjs'),
  '--app',
  app,
  ...LEFT_OUT_PEERS.flatMap((name) => ['--without', name]),
]);

console.log(`\nrun: PASS (db leg: ${opts.db}, kvox packages: ${opts.from})`);
