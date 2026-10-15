#!/usr/bin/env node
// Single-instance dependency check (issue #695), run by the `single-instance`
// job in .github/workflows/packages.yml and by `npm run check:single-instance`.
//
// WHY
// -----------------------------------------------------------------------------
// Some libraries hold module-level state that must be shared by every module
// that imports them: Nest's DI container and decorator metadata, React's
// dispatcher (hooks), MUI/Emotion theme context, Zod's classes (`instanceof
// ZodError`), the OpenTelemetry global API, and the platform packages' own
// module-level singletons. Two copies on disk do not fail the install; they
// fail at run time with a confusing error ("Nest can't resolve dependencies",
// "Invalid hook call", a theme that silently does not apply). Declaring them
// as `peerDependencies` is necessary but not sufficient: a range mismatch, an
// `overrides` entry or `npm link` still produces a second copy. This script
// fails the build instead.
//
// TWO CHECKS
// -----------------------------------------------------------------------------
// 1. Lockfile (no install needed): every `package-lock.json` `packages` key
//    equal to `node_modules/<name>` or ending in `/node_modules/<name>` is an
//    installed copy. More than one copy of a guarded name fails. A workspace
//    link (`"link": true`) and the entry it resolves to count as one instance.
// 2. Resolution (after `npm ci`): from every workspace directory (root
//    `workspaces` globs) resolve `<name>/package.json` the way Node does and
//    `realpath` it. Two workspaces resolving one name to different real paths
//    fails. A name a workspace cannot resolve is skipped for that workspace.
//    A root without `workspaces` (a consumer app, `--root <dir>`) is resolved
//    from itself; `--guard <name>` adds the platform packages it installs
//    (tests/consumer-smoke/run.mjs passes the six), which are then guarded and
//    checked as origins like the monorepo's own `packages/platform-*`.
//    The real directory of every resolved platform package outside the
//    workspaces (an `npm link`ed checkout) is checked as an origin too.
//
// Usage: node scripts/check-single-instance.mjs [--lockfile-only] [--json]
//          [--lockfile <path>] [--root <dir>] [--guard <name>]...
// Exit:  0 clean, 1 duplicates or splits found, 2 usage error.
//
// Node built-ins only. Importing this module runs nothing: `main()` is behind
// `isDirectExecution`, so apps/cli/src/single-instance-script.test.ts imports
// the pure functions directly (same pattern as rename.mjs).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Libraries that must resolve to exactly one copy. Every
 * `packages/platform-*` workspace is added to this list at run time
 * (`discoverPlatformPackages`), so a new platform package is guarded without
 * editing this file.
 */
export const SINGLE_INSTANCE_PACKAGES = Object.freeze([
  // API: Nest DI container and decorator metadata, the HTTP server, the
  // Prisma client, schemas and the telemetry global.
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/swagger',
  '@nestjs/config',
  'fastify',
  '@prisma/client',
  'zod',
  'nestjs-zod',
  'reflect-metadata',
  '@opentelemetry/api',
  // Web: hooks dispatcher, router context, theme and style caches.
  'react',
  'react-dom',
  'react-router-dom',
  '@mui/material',
  '@mui/system',
  '@mui/icons-material',
  '@mui/x-charts',
  '@emotion/react',
  '@emotion/styled',
  // CLI: ink renders through its own React reconciler instance.
  'ink',
]);

const USAGE = `Usage: node scripts/check-single-instance.mjs [--lockfile-only] [--json] [--lockfile <path>] [--root <dir>] [--guard <name>]...

  --lockfile-only    Scan package-lock.json only (no node_modules needed).
  --json             Print a machine-readable report instead of text.
  --lockfile <path>  Lockfile to scan (default: <root>/package-lock.json).
  --root <dir>       Repository root (default: this script's parent directory).
                     A root without workspaces is checked from itself.
  --guard <name>     Also guard <name> (repeatable), e.g. the platform packages
                     a consumer project installs.

Exit codes: 0 clean, 1 duplicates found, 2 usage error.`;

class UsageError extends Error {}

const toPosix = (p) => p.split(sep).join('/');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

/**
 * Workspace directories (relative, POSIX) from the root `workspaces` field.
 * Supports literal paths and `<dir>/*` globs, which is all this repository
 * uses; anything else is a usage error rather than a silent skip. Only
 * directories that contain a `package.json` count.
 */
export function discoverWorkspaces(rootDir) {
  const manifestPath = join(rootDir, 'package.json');
  if (!existsSync(manifestPath)) throw new UsageError(`no package.json in ${rootDir}`);
  const manifest = readJson(manifestPath);
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const found = new Set();
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/+$/, '');
    if (clean.endsWith('/*') && !clean.slice(0, -2).includes('*')) {
      const parent = clean.slice(0, -2);
      const parentAbs = join(rootDir, parent);
      if (!isDirectory(parentAbs)) continue;
      for (const entry of readdirSync(parentAbs).sort()) {
        if (existsSync(join(parentAbs, entry, 'package.json'))) found.add(`${parent}/${entry}`);
      }
    } else if (!clean.includes('*')) {
      if (existsSync(join(rootDir, clean, 'package.json'))) found.add(clean);
    } else {
      throw new UsageError(
        `unsupported workspaces pattern "${pattern}" (only "<dir>/*" and literal paths)`
      );
    }
  }
  return [...found];
}

/** Package names of every `packages/platform-*` workspace, from its package.json. */
export function discoverPlatformPackages(rootDir) {
  const packagesDir = join(rootDir, 'packages');
  if (!isDirectory(packagesDir)) return [];
  const names = [];
  for (const entry of readdirSync(packagesDir).sort()) {
    if (!entry.startsWith('platform-')) continue;
    const manifestPath = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const { name } = readJson(manifestPath);
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * The guarded list: the fixed libraries, every discovered platform package
 * and the `extra` names (`--guard`).
 */
export function guardedNames(rootDir, extra = []) {
  return [...new Set([...SINGLE_INSTANCE_PACKAGES, ...discoverPlatformPackages(rootDir), ...extra])];
}

// -----------------------------------------------------------------------------
// Check 1: the lockfile
// -----------------------------------------------------------------------------

/** The directory that owns a nested install: `apps/cli/node_modules/react` -> `apps/cli`. */
function ownerOf(location, name) {
  const suffix = `node_modules/${name}`;
  const prefix = location.slice(0, location.length - suffix.length).replace(/\/$/, '');
  return prefix;
}

/**
 * Every installed instance of each name in a lockfile (v2/v3 `packages` map).
 * Returns `Map<name, Instance[]>` where an Instance is
 * `{ id, locations: string[], version, link?: string }`. A `"link": true`
 * entry is keyed by its `resolved` target, so a workspace link and the
 * workspace it points at, or two links to one target, are one instance.
 */
export function collectLockfileInstances(lock, names) {
  const packages = lock && typeof lock === 'object' ? lock.packages : undefined;
  if (!packages || typeof packages !== 'object') {
    throw new UsageError('lockfile has no "packages" map (lockfileVersion 2 or 3 required)');
  }
  const wanted = new Set(names);
  const byName = new Map(names.map((n) => [n, new Map()]));
  for (const [location, entry] of Object.entries(packages)) {
    const marker = location.lastIndexOf('node_modules/');
    if (marker === -1) continue;
    const name = location.slice(marker + 'node_modules/'.length);
    if (!wanted.has(name)) continue;
    const isLink = entry?.link === true;
    const target = isLink ? String(entry.resolved ?? location) : undefined;
    const id = isLink ? `link:${target}` : location;
    const version = isLink ? (packages[target]?.version ?? entry.version) : entry?.version;
    const instances = byName.get(name);
    const existing = instances.get(id);
    if (existing) existing.locations.push(location);
    else
      instances.set(id, {
        id,
        locations: [location],
        version: version ?? null,
        ...(isLink ? { link: target } : {}),
      });
  }
  return new Map([...byName].map(([n, m]) => [n, [...m.values()]]));
}

/**
 * Names with more than one installed instance in the lockfile.
 * `Duplicate = { name, instances: [{ location, locations, version, link? }] }`.
 */
export function findLockfileDuplicates(lock, names) {
  const duplicates = [];
  for (const [name, instances] of collectLockfileInstances(lock, names)) {
    if (instances.length <= 1) continue;
    duplicates.push({
      name,
      instances: instances.map(({ locations, version, link }) => ({
        location: locations[0],
        locations,
        version,
        ...(link ? { link } : {}),
      })),
    });
  }
  return duplicates;
}

// -----------------------------------------------------------------------------
// Check 2: real resolution
// -----------------------------------------------------------------------------

/**
 * The real directory `name` resolves to from `fromDir`, or null when it does
 * not resolve. `<name>/package.json` first, as Node's own resolver sees it;
 * a package whose `exports` map hides `./package.json` (or is ESM-only) falls
 * back to the same `node_modules` lookup chain Node walks.
 */
export function resolvePackageDir(fromDir, name) {
  const req = createRequire(join(fromDir, 'package.json'));
  try {
    return dirname(realpathSync(req.resolve(`${name}/package.json`)));
  } catch {
    for (const base of req.resolve.paths(name) ?? []) {
      const candidate = join(base, name, 'package.json');
      if (existsSync(candidate)) return dirname(realpathSync(candidate));
    }
    return null;
  }
}

function versionAt(dir) {
  try {
    return readJson(join(dir, 'package.json')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve each name from each workspace. Returns
 * `{ resolved: Map<name, Instance[]>, splits: Split[] }` where an Instance is
 * `{ realPath, version, origins: string[] }` and a Split is a name with more
 * than one Instance. `realPath` is relative to `rootDir` when inside it.
 */
export function resolveInstances(rootDir, workspaces, names, originNames = discoverPlatformPackages(rootDir)) {
  const rootReal = realpathSync(rootDir);
  const display = (abs) => {
    const rel = relative(rootReal, abs);
    return rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? toPosix(abs) : toPosix(rel);
  };
  const origins = workspaces.map((ws) => ({ label: ws, dir: join(rootReal, ws) }));
  const workspaceReals = new Set(
    origins.map((o) => (existsSync(o.dir) ? realpathSync(o.dir) : o.dir))
  );
  const resolved = new Map(names.map((n) => [n, new Map()]));

  const record = (origin) => {
    for (const name of names) {
      const dir = resolvePackageDir(origin.dir, name);
      if (!dir) continue;
      const instances = resolved.get(name);
      const existing = instances.get(dir);
      if (existing) {
        if (!existing.origins.includes(origin.label)) existing.origins.push(origin.label);
      } else {
        instances.set(dir, {
          realPath: display(dir),
          version: versionAt(dir),
          origins: [origin.label],
        });
      }
    }
  };

  for (const origin of origins) record(origin);

  // A platform package (or a `--guard` name) resolved to a directory that is
  // not one of the workspaces (an `npm link`ed or `file:` checkout, or an
  // installed tarball in a consumer) resolves its own peers from there; check
  // it as an origin too.
  const platformNames = new Set(originNames);
  const extra = [];
  for (const name of platformNames) {
    for (const dir of resolved.get(name)?.keys() ?? []) {
      if (!workspaceReals.has(dir)) extra.push({ label: `${name} (at ${display(dir)})`, dir });
    }
  }
  for (const origin of extra) record(origin);

  const out = new Map([...resolved].map(([n, m]) => [n, [...m.values()]]));
  const splits = [...out]
    .filter(([, instances]) => instances.length > 1)
    .map(([name, instances]) => ({ name, instances }));
  return { resolved: out, splits };
}

/** Names two workspaces resolve to different real paths. */
export function findResolutionSplits(rootDir, workspaces, names) {
  return resolveInstances(rootDir, workspaces, names).splits;
}

// -----------------------------------------------------------------------------
// Fix hints and the report
// -----------------------------------------------------------------------------

/** One line telling the reader what to change for a duplicate's location. */
export function fixHint(name, location) {
  const owner = ownerOf(location, name);
  if (owner === '') return null;
  if (!owner.startsWith('node_modules/') && !owner.includes('/node_modules/')) {
    return `align the "${name}" range in ${owner}/package.json with the root copy, then run \`npm dedupe\``;
  }
  const dependent = owner.slice(owner.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return `${dependent} asks for an incompatible "${name}" range; align the range in the workspace that depends on it (or upgrade ${dependent}), then run \`npm dedupe\``;
}

function parseArgs(argv) {
  const opts = { lockfileOnly: false, json: false, lockfile: null, root: null, guard: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lockfile-only') opts.lockfileOnly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--guard') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts.guard.push(value);
      i += 1;
    } else if (arg === '--lockfile' || arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new UsageError(`unknown argument "${arg}"`);
  }
  return opts;
}

/**
 * Runs the checks and returns `{ code, report }`. `report` is what `--json`
 * prints. Throws UsageError for bad input.
 */
export function run(opts) {
  const rootDir = resolve(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  if (!existsSync(join(rootDir, 'package.json')))
    throw new UsageError(`no package.json in ${rootDir}`);
  const lockfilePath = resolve(opts.lockfile ?? join(rootDir, 'package-lock.json'));
  if (!existsSync(lockfilePath)) throw new UsageError(`lockfile not found: ${lockfilePath}`);
  let lock;
  try {
    lock = readJson(lockfilePath);
  } catch (err) {
    throw new UsageError(`cannot parse ${lockfilePath}: ${err.message}`);
  }

  const extra = opts.guard ?? [];
  const names = guardedNames(rootDir, extra);
  const lockInstances = collectLockfileInstances(lock, names);
  const duplicates = findLockfileDuplicates(lock, names);

  const report = {
    ok: true,
    root: toPosix(rootDir),
    guarded: names,
    lockfile: {
      path: toPosix(lockfilePath),
      duplicates: duplicates.map((d) => ({
        ...d,
        instances: d.instances.map((i) => ({ ...i, fix: fixHint(d.name, i.location) })),
      })),
      packages: Object.fromEntries(
        [...lockInstances].map(([n, instances]) => [
          n,
          instances.map(({ locations, version, link }) => ({
            locations,
            version,
            ...(link ? { link } : {}),
          })),
        ])
      ),
    },
    resolution: null,
  };

  if (!opts.lockfileOnly) {
    // A project with no `workspaces` (a plain consumer app) is its own one
    // origin.
    const discovered = discoverWorkspaces(rootDir);
    const workspaces = discovered.length > 0 ? discovered : ['.'];
    const { resolved, splits } = resolveInstances(rootDir, workspaces, names, [
      ...discoverPlatformPackages(rootDir),
      ...extra,
    ]);
    const anyResolved = [...resolved.values()].some((instances) => instances.length > 0);
    if (!anyResolved) {
      throw new UsageError(
        'no guarded package resolves from any workspace; run `npm ci` first, or pass --lockfile-only'
      );
    }
    report.resolution = {
      workspaces,
      splits,
      packages: Object.fromEntries(resolved),
    };
  }

  report.ok =
    report.lockfile.duplicates.length === 0 && (report.resolution?.splits.length ?? 0) === 0;
  return { code: report.ok ? 0 : 1, report };
}

/** Human-readable text for a report. */
export function formatReport(report) {
  const lines = [];
  const resolution = report.resolution;
  if (report.ok) {
    lines.push(
      `Single-instance check passed: ${report.guarded.length} guarded packages, ` +
        (resolution
          ? `lockfile and resolution from ${resolution.workspaces.length} workspaces.`
          : 'lockfile only.')
    );
    const width = Math.max(...report.guarded.map((n) => n.length));
    for (const name of report.guarded) {
      const fromLock = report.lockfile.packages[name] ?? [];
      const fromResolution = resolution?.packages[name] ?? [];
      const version = fromResolution[0]?.version ?? fromLock[0]?.version ?? null;
      let detail;
      if (fromLock.length === 0 && fromResolution.length === 0) detail = 'not installed';
      else {
        detail = version ?? '(no version)';
        if (fromLock[0]?.link) detail += ` (workspace ${fromLock[0].link})`;
        if (resolution && fromResolution.length > 0) {
          const used = fromResolution[0].origins.length;
          detail += `, resolved by ${used} workspace${used === 1 ? '' : 's'}`;
        }
      }
      lines.push(`  ${name.padEnd(width)}  ${detail}`);
    }
    return lines.join('\n');
  }

  lines.push('Single-instance check FAILED: these packages must resolve to exactly one copy.');
  for (const dup of report.lockfile.duplicates) {
    lines.push('', `${dup.name}: ${dup.instances.length} copies in ${report.lockfile.path}`);
    for (const inst of dup.instances) {
      const where = inst.link
        ? `${inst.locations.join(', ')} -> ${inst.link}`
        : inst.locations.join(', ');
      lines.push(`  - ${where}  version ${inst.version ?? '(unknown)'}`);
      if (inst.fix) lines.push(`    fix: ${inst.fix}`);
    }
  }
  for (const split of resolution?.splits ?? []) {
    lines.push('', `${split.name}: workspaces resolve ${split.instances.length} different copies`);
    for (const inst of split.instances) {
      lines.push(
        `  - ${inst.realPath}  version ${inst.version ?? '(unknown)'}  from ${inst.origins.join(', ')}`
      );
    }
    const nonRoot = split.instances.flatMap((i) => i.origins).filter((o) => !o.includes(' (at '));
    lines.push(
      `    fix: align the "${split.name}" range in ${nonRoot.map((w) => `${w}/package.json`).join(' / ') || 'the workspaces'}, ` +
        'then run `npm dedupe`; replace any `npm link` with `yalc` or a `next` pre-release'
    );
  }
  lines.push(
    '',
    'Why: a second copy breaks Nest DI, React hooks, theme context and `instanceof` checks. See docs/DEVELOPMENT.md#single-instance-dependencies.'
  );
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check-single-instance: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    const { code, report } = run(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else (code === 0 ? console.log : console.error)(formatReport(report));
    process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
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
