#!/usr/bin/env node
// =============================================================================
// Prepare the headless Ask evaluation's database host (issue #608)
// =============================================================================
//
// Builds, at BUILD time, the Prisma schema, the migration history and the client
// the in-process PGlite of `kvox-eval ask` runs on, into `host/` (shipped in the
// package, git-ignored in the repository):
//
//   1. `platform db sync`     installs the platform migrations (byte copies),
//                             stamped 2024-01-01 so they sort BEFORE the domain's
//                             September-2026 ids on a fresh database.
//   2. `platform db compose`  composes the platform schema; the domain installer
//                             refuses a host without `User`, `StorageObject`, `Job`.
//   3. `kvox-db sync`         installs the domain fragments and migrations under
//                             `--names stable`: names that are a pure function of
//                             the migration id, never of build time.
//   4. `platform db compose`  again, now with the domain fragments.
//   5. the generator output is pointed at `host/generated/`, so this client never
//      overwrites another one in `node_modules/.prisma/client`.
//   6. `prisma generate`.
//
// It needs no database: composing a schema, installing migration files and
// generating a client do not connect. The run itself (`src/ask-run/host/db.ts`)
// applies `host/prisma/migrations/*/migration.sql` in order, in process.
//
// UP-TO-DATE CHECK. `build`, `typecheck` and `test` all run this first (pre-
// scripts), so it skips the work when `host/.stamp` matches a hash of what the
// output is made from (this script, the two installers' versions, the domain
// package's schema and migrations, the prisma version). `--force` rebuilds.
//
// Modelled on packages/kvox-api/test/host/prepare.mjs (not copied verbatim).
// =============================================================================

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = join(packageDir, 'host');
const stampPath = join(hostDir, '.stamp');
const require = createRequire(join(packageDir, 'package.json'));

/** The manifest path of an installed package. */
function manifestOf(pkg) {
  return require.resolve(`${pkg}/package.json`);
}

/** The `bin` script of an installed package. */
function binOf(pkg, name) {
  const manifestPath = manifestOf(pkg);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
  return join(dirname(manifestPath), rel);
}

/** Every file under `dir`, relative and sorted (empty when it does not exist). */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** The hash of everything the output is made from. */
function inputsHash() {
  const hash = createHash('sha256');
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  hash.update(readFileSync(join(hostDir, 'prisma.config.ts')));
  for (const pkg of ['@marinoscar/platform-db', '@marinoscar/kvox-db', 'prisma', '@prisma/client']) {
    hash.update(`${pkg}@${JSON.parse(readFileSync(manifestOf(pkg), 'utf8')).version}\n`);
  }
  // The domain package is a workspace: its files change without a version bump.
  const kvoxDbDir = dirname(manifestOf('@marinoscar/kvox-db'));
  for (const sub of ['schema', 'migrations', 'raw-sql-indexes.json', 'extensions.json', 'schema-objects.json']) {
    const target = join(kvoxDbDir, sub);
    const files = existsSync(target) && statSync(target).isFile() ? [target] : filesUnder(target);
    for (const file of files) {
      hash.update(relative(kvoxDbDir, file));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex');
}

/** Runs a node script in the host directory; stops the whole preparation on failure. */
function run(label, script, args) {
  console.log(`kvox-eval host: ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: hostDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`kvox-eval host: "${label}" failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

const force = process.argv.includes('--force');
const wanted = inputsHash();
const ready =
  existsSync(join(hostDir, 'generated', 'index.js')) &&
  existsSync(join(hostDir, 'prisma', 'migrations')) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8').trim() === wanted;
if (ready && !force) {
  console.log('kvox-eval host: up to date');
  process.exit(0);
}

const platform = binOf('@marinoscar/platform-db', 'platform');
const kvoxDb = binOf('@marinoscar/kvox-db', 'kvox-db');
const prisma = binOf('prisma', 'prisma');

rmSync(join(hostDir, 'prisma'), { recursive: true, force: true });
rmSync(join(hostDir, 'generated'), { recursive: true, force: true });
rmSync(stampPath, { force: true });

run('install the platform migrations', platform, ['db', 'sync', '--root', hostDir, '--timestamp', '2024-01-01T00:00:00Z']);
run('compose the platform schema', platform, ['db', 'compose', '--root', hostDir]);
run('install the domain fragments and migrations (stable names)', kvoxDb, ['sync', '--root', hostDir, '--names', 'stable']);
run('compose the platform and domain schema', platform, ['db', 'compose', '--root', hostDir]);

const basePath = join(hostDir, 'prisma', 'schema', 'platform.base.prisma');
const base = readFileSync(basePath, 'utf8');
const generator = 'provider = "prisma-client-js"';
if (!base.includes(generator)) {
  console.error(`kvox-eval host: ${basePath} has no ${generator}; the platform's generator block changed.`);
  process.exit(1);
}
writeFileSync(basePath, base.replace(generator, `${generator}\n  output   = "../../generated"`));

run('generate the client', prisma, ['generate', '--config', join(hostDir, 'prisma.config.ts')]);

writeFileSync(stampPath, `${wanted}\n`);
console.log('kvox-eval host: ready (host/prisma/migrations, host/generated)');
