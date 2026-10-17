#!/usr/bin/env node
// =============================================================================
// Prepare the kvox-api test host (issue #492, epic #491)
// =============================================================================
//
// Builds, from scratch, the Prisma host the real-database specs run against:
//
//   1. `platform db sync`     installs the platform migrations (byte copies).
//   2. `platform db compose`  composes the platform schema (the domain installer
//                             refuses a host without `User`, `StorageObject`, `Job`).
//   3. `kvox-db sync`         installs the domain fragments and migrations under
//                             `--names after-host`: a host with no domain history
//                             would otherwise sort the September-dated domain
//                             migrations before the platform tables they reference.
//   4. `platform db compose`  again, now with the domain fragments.
//   5. the generator output is pointed at `generated/`, so this client never
//      overwrites the application's own in `node_modules/.prisma/client`.
//   6. `prisma generate`.
//
// Everything it writes (`prisma/`, `generated/`) is git-ignored and removed first,
// so a run is the same on a fresh checkout and on a developer's machine. It needs
// no database: generating a client does not connect. `db.ts` creates and migrates
// the throwaway database per run.
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim).
// =============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const hostDir = dirname(fileURLToPath(import.meta.url));

/** The `bin` script of an installed package. */
function binOf(pkg, name) {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
  return join(dirname(manifestPath), rel);
}

/** Runs a node script in the host directory; stops the whole preparation on failure. */
function run(label, script, args) {
  console.log(`test host: ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], { cwd: hostDir, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`test host: "${label}" failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

const platform = binOf('@marinoscar/platform-db', 'platform');
const kvoxDb = binOf('@marinoscar/kvox-db', 'kvox-db');
const prisma = binOf('prisma', 'prisma');

rmSync(join(hostDir, 'prisma'), { recursive: true, force: true });
rmSync(join(hostDir, 'generated'), { recursive: true, force: true });

run('install platform migrations', platform, ['db', 'sync', '--root', hostDir]);
run('compose the platform schema', platform, ['db', 'compose', '--root', hostDir]);
run('install the domain fragments and migrations', kvoxDb, ['sync', '--root', hostDir, '--names', 'after-host']);
run('compose the platform and domain schema', platform, ['db', 'compose', '--root', hostDir]);

const basePath = join(hostDir, 'prisma', 'schema', 'platform.base.prisma');
const base = readFileSync(basePath, 'utf8');
const generator = 'provider = "prisma-client-js"';
if (!base.includes(generator)) {
  console.error(`test host: ${basePath} has no ${generator}; the platform's generator block changed.`);
  process.exit(1);
}
writeFileSync(basePath, base.replace(generator, `${generator}\n  output   = "../../generated"`));

run('generate the client', prisma, ['generate', '--config', join(hostDir, 'prisma.config.ts')]);

console.log('test host: ready (client in test/host/generated)');
