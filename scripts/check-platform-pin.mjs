#!/usr/bin/env node
// =============================================================================
// Platform pin check: every @marinoscar/platform-* entry pins ONE exact version
// =============================================================================
//
// Usage:  node scripts/check-platform-pin.mjs [--root <dir>]
//         node scripts/check-platform-pin.mjs --self-test
//
// Reads the root package.json and every workspace package.json (root
// `workspaces` globs, e.g. `apps/*`, `packages/*`) and collects each
// `@marinoscar/platform-*` entry in `dependencies`, `devDependencies`,
// `peerDependencies` and `optionalDependencies`. It fails when:
//
//   - no entry exists anywhere ("no @marinoscar/platform-* entries found");
//   - a spec is neither an exact version (`0.1.0-next.5`) nor a GitHub release
//     tarball URL (`.../releases/download/platform-v<version>/<file>.tgz`),
//     so a caret, tilde, tag or range is rejected;
//   - two entries pin different versions;
//   - package-lock.json resolves any `node_modules/@marinoscar/platform-*`
//     entry, at any depth, to a version other than the pin;
//   - the root `overrides` has no `@marinoscar/platform-contract` entry (it is
//     what keeps the contract to a single copy), or has one that is neither the
//     `$@marinoscar/platform-contract` reference nor the pin.
//
// Exit codes: 0 ok | 1 check failed | 2 usage.
// `--self-test` runs three inline fixtures (ok, caret range, mismatch).
// Node built-ins only.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@marinoscar/platform-';
const CONTRACT = '@marinoscar/platform-contract';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TARBALL = /^https:\/\/[^\s]+\/releases\/download\/platform-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\/[^\s/]+\.tgz$/;

/** The version a spec pins, or null when the spec is not an exact pin. */
export function pinnedVersion(spec) {
  if (typeof spec !== 'string') return null;
  if (EXACT.test(spec)) return spec;
  const m = TARBALL.exec(spec);
  return m ? m[1] : null;
}

/**
 * Pure check. `manifests` is `[{ path, json }]` (root first), `lock` the parsed
 * package-lock.json or null. Returns `{ ok, pin, entries, errors }`.
 */
export function checkPin({ manifests, lock }) {
  const errors = [];
  const entries = [];
  for (const { path, json } of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(json?.[field] ?? {})) {
        if (name.startsWith(SCOPE)) entries.push({ path, field, name, spec });
      }
    }
  }
  if (entries.length === 0) {
    return { ok: false, pin: null, entries: 0, errors: ['no @marinoscar/platform-* entries found'] };
  }

  const versions = new Set();
  for (const e of entries) {
    const v = pinnedVersion(e.spec);
    if (v === null) {
      errors.push(`${e.path}: ${e.field}.${e.name} is '${e.spec}'; pin an exact version or a release tarball URL (no ranges, tags or carets)`);
    } else {
      e.version = v;
      versions.add(v);
    }
  }
  if (versions.size > 1) {
    const detail = entries
      .filter((e) => e.version)
      .map((e) => `${e.path} ${e.field}.${e.name}=${e.version}`)
      .join('; ');
    errors.push(`platform packages pin different versions (${[...versions].join(', ')}): ${detail}`);
  }
  const pin = versions.size === 1 ? [...versions][0] : null;

  const root = manifests[0]?.json ?? {};
  const override = root.overrides?.[CONTRACT];
  if (override === undefined) {
    errors.push(`root package.json overrides has no ${CONTRACT} entry (it keeps the contract to a single copy)`);
  } else if (typeof override !== 'string' || (override !== `$${CONTRACT}` && (pin === null || pinnedVersion(override) !== pin))) {
    errors.push(`root overrides ${CONTRACT} is '${JSON.stringify(override)}'; use '$${CONTRACT}' or the pin`);
  }

  if (!lock) {
    errors.push('package-lock.json not found or unreadable');
  } else if (pin !== null) {
    let seen = 0;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const m = /(?:^|\/)node_modules\/(@marinoscar\/platform-[^/]+)$/.exec(key);
      if (!m || entry?.link) continue;
      seen += 1;
      if (entry?.version !== pin) {
        errors.push(`package-lock.json ${key} resolves to ${entry?.version ?? '(no version)'}, pin is ${pin}`);
      }
    }
    if (seen === 0) errors.push('package-lock.json has no node_modules/@marinoscar/platform-* entry; run npm install');
  }

  return { ok: errors.length === 0, pin, entries: entries.length, errors };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function expandWorkspace(root, pattern) {
  const clean = pattern.replace(/\/+$/, '');
  if (!clean.includes('*')) return [clean];
  if (!clean.endsWith('/*')) return [];
  const base = join(root, clean.slice(0, -2));
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((entry) => statSync(join(base, entry)).isDirectory())
    .map((entry) => `${clean.slice(0, -2)}/${entry}`);
}

/** Loads the root manifest, every workspace manifest and the lockfile from disk. */
export function loadRepo(root) {
  const rootJson = readJson(join(root, 'package.json'));
  if (!rootJson) throw new Error(`cannot read ${join(root, 'package.json')}`);
  const manifests = [{ path: 'package.json', json: rootJson }];
  const patterns = Array.isArray(rootJson.workspaces) ? rootJson.workspaces : (rootJson.workspaces?.packages ?? []);
  for (const pattern of patterns) {
    for (const dir of expandWorkspace(root, pattern)) {
      const json = readJson(join(root, dir, 'package.json'));
      if (json) manifests.push({ path: `${dir}/package.json`, json });
    }
  }
  return { manifests, lock: readJson(join(root, 'package-lock.json')) };
}

function report(result) {
  if (result.ok) {
    console.log(`platform pin: ${result.pin} (${result.entries} entries)`);
    return 0;
  }
  for (const error of result.errors) console.error(`platform pin: ${error}`);
  return 1;
}

function selfTest() {
  const V = '0.1.0-next.5';
  const lockOf = (version) => ({
    packages: {
      '': {},
      'node_modules/@marinoscar/platform-contract': { version },
      'apps/api/node_modules/@marinoscar/platform-api': { version },
    },
  });
  const repo = (apiSpec, lockVersion) => ({
    manifests: [
      { path: 'package.json', json: { devDependencies: { [CONTRACT]: V }, overrides: { [CONTRACT]: `$${CONTRACT}` } } },
      { path: 'apps/api/package.json', json: { dependencies: { '@marinoscar/platform-api': apiSpec, [CONTRACT]: V } } },
    ],
    lock: lockOf(lockVersion),
  });
  const cases = [
    ['ok', repo(V, V), true],
    ['caret range', repo(`^${V}`, V), false],
    ['mismatch', repo(V, '0.1.0-next.4'), false],
  ];
  let failed = 0;
  for (const [name, fixture, expected] of cases) {
    const got = checkPin(fixture).ok;
    const pass = got === expected;
    if (!pass) failed += 1;
    console.log(`self-test ${pass ? 'PASS' : 'FAIL'}: ${name} (expected ${expected ? 'ok' : 'failure'})`);
  }
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return selfTest();
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = resolve(argv[i + 1]);
      i += 1;
    } else {
      console.error('usage: node scripts/check-platform-pin.mjs [--root <dir>] | --self-test');
      return 2;
    }
  }
  return report(checkPin(loadRepo(root)));
}

process.exit(main(process.argv.slice(2)));
