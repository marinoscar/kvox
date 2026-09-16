import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// =============================================================================
// Pins the root-level `install.sh`'s KVOX_HOME / KVOX_BIN_DIR defaults
// (commit f88a2ea, "Where the install lands, and why root gets a different
// answer (#226)").
//
// WHY THIS LIVES IN apps/cli
// -----------------------------------------------------------------------------
// Same reasoning as `bootstrap-vps.test.ts` beside this file: this workspace
// already runs ESM tests that shell out to real bash scripts, and CI already
// runs `npm run test:run --workspace=cli`. `install.sh` lives at the repo
// root rather than under apps/cli, but there is no separate test workspace
// for root-level shell scripts.
//
// WHAT THIS SUITE DELIBERATELY NEVER DOES
// -----------------------------------------------------------------------------
// It never runs install.sh's install/update path. install.sh has no
// `--dry-run` (unlike bootstrap-vps.sh) — every invocation past argument
// parsing clones the repo, runs `npm install`/`npm run build`, and writes
// files under $KVOX_HOME/$KVOX_BIN_DIR. None of that is safe or fast to run
// from a unit test, and none of it is what this suite is pinning.
//
// Instead, this suite extracts JUST the root-aware defaults block (the
// `if [[ "$(id -u)" -eq 0 ]]; then ... fi` shown in the CLAUDE.md task and
// commented "Where the install lands, and why root gets a different answer
// (#226)" in install.sh) straight out of the real, current install.sh source
// at test time, and sources that extracted fragment inside a throwaway bash
// process. This is NOT a hand-copied duplicate of the logic: the extraction
// re-reads install.sh on every run, so if that block is ever edited, renamed,
// or removed, the extraction itself fails loudly (`toContain`/`indexOf`
// assertions below) rather than silently testing stale, copied-and-pasted
// text.
//
// `id -u` is stubbed by putting a fake `id` executable earlier on PATH (a
// script that just echoes $FAKE_UID), exactly as the task described — this
// is what lets "running as root" be exercised without actually being root.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');

const START_MARKER = 'if [[ "$(id -u)" -eq 0 ]]; then';

/**
 * Pulls the root-aware `KVOX_HOME`/`KVOX_BIN_DIR` defaults block straight out
 * of the real install.sh, from its `if [[ "$(id -u)" -eq 0 ]]; then` line
 * through the matching `fi`. Throws (failing the test with a clear message)
 * if the block cannot be found, rather than falling back to any hard-coded
 * copy.
 */
function extractDefaultsBlock(): string {
  const source = readFileSync(INSTALL_SH, 'utf8');
  const start = source.indexOf(START_MARKER);
  if (start === -1) {
    throw new Error(
      `install.sh no longer contains the expected "${START_MARKER}" line — ` +
        'the root-aware defaults block this test pins may have moved or been removed.',
    );
  }
  const closeMarker = '\nfi\n';
  const closeIdx = source.indexOf(closeMarker, start);
  if (closeIdx === -1) {
    throw new Error('install.sh: could not find the closing "fi" for the defaults block.');
  }
  const end = closeIdx + closeMarker.length;
  return source.slice(start, end);
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'install-sh-defaults-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Runs just the extracted defaults block under bash, with `id -u` stubbed to
 * report `uid`, `$HOME` set to `home`, and any of `KVOX_HOME`/`KVOX_BIN_DIR`
 * present in `overrides` exported beforehand (mirroring a caller — e.g.
 * bootstrap-vps.sh — that sets them before invoking install.sh). Returns the
 * resulting `KVOX_HOME`/`KVOX_BIN_DIR` values.
 */
function runDefaultsBlock(
  uid: number,
  home: string,
  overrides: { KVOX_HOME?: string; KVOX_BIN_DIR?: string } = {},
): { home: string; binDir: string } {
  const fakeBinDir = join(workDir, 'fake-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeIdPath = join(fakeBinDir, 'id');
  writeFileSync(fakeIdPath, '#!/bin/sh\necho "$FAKE_UID"\n');
  chmodSync(fakeIdPath, 0o755);

  const block = extractDefaultsBlock();
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    block,
    'printf \'KVOX_HOME=%s\\n\' "$KVOX_HOME"',
    'printf \'KVOX_BIN_DIR=%s\\n\' "$KVOX_BIN_DIR"',
  ].join('\n');
  const scriptPath = join(workDir, 'run.sh');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBinDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    HOME: home,
    FAKE_UID: String(uid),
  };
  if (overrides.KVOX_HOME !== undefined) env['KVOX_HOME'] = overrides.KVOX_HOME;
  if (overrides.KVOX_BIN_DIR !== undefined) env['KVOX_BIN_DIR'] = overrides.KVOX_BIN_DIR;

  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env,
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `defaults block exited ${String(result.status)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const home_ = /KVOX_HOME=(.*)/.exec(result.stdout)?.[1];
  const binDir = /KVOX_BIN_DIR=(.*)/.exec(result.stdout)?.[1];
  if (home_ === undefined || binDir === undefined) {
    throw new Error(`could not parse defaults block output:\n${result.stdout}`);
  }
  return { home: home_, binDir };
}

describe('install.sh root-aware KVOX_HOME / KVOX_BIN_DIR defaults (#226, commit f88a2ea)', () => {
  it('root (uid 0), no overrides -> the system locations', () => {
    const { home, binDir } = runDefaultsBlock(0, '/root');
    expect(home).toBe('/usr/local/lib/kvox');
    expect(binDir).toBe('/usr/local/bin');
  });

  it('non-root, no overrides -> $HOME/.kvox and $HOME/.local/bin', () => {
    const { home, binDir } = runDefaultsBlock(1000, '/home/oscar');
    expect(home).toBe('/home/oscar/.kvox');
    expect(binDir).toBe('/home/oscar/.local/bin');
  });

  it('root WITH an explicit KVOX_BIN_DIR -> the explicit value wins (the bootstrap-vps.sh case)', () => {
    // bootstrap-vps.sh always runs install.sh as `env KVOX_SRC=... KVOX_BIN_DIR=/usr/local/bin
    // bash install.sh` (see bootstrap-vps.test.ts's fixtures). A regression
    // here would silently change how every VPS bootstrap installs, even
    // though for root the explicit value happens to match the new root
    // default — the point is that the explicit value, not the branch taken,
    // determines the outcome. KVOX_HOME is left to its root default.
    const { home, binDir } = runDefaultsBlock(0, '/root', { KVOX_BIN_DIR: '/usr/local/bin' });
    expect(binDir).toBe('/usr/local/bin');
    expect(home).toBe('/usr/local/lib/kvox');
  });

  it('root WITH an explicit KVOX_BIN_DIR that differs from the root default -> the explicit value still wins', () => {
    const { home, binDir } = runDefaultsBlock(0, '/root', { KVOX_BIN_DIR: '/opt/custom/bin' });
    expect(binDir).toBe('/opt/custom/bin');
    expect(home).toBe('/usr/local/lib/kvox');
  });

  it('non-root WITH an explicit KVOX_BIN_DIR -> the explicit value wins', () => {
    const { home, binDir } = runDefaultsBlock(1000, '/home/oscar', {
      KVOX_BIN_DIR: '/opt/custom/bin',
    });
    expect(binDir).toBe('/opt/custom/bin');
    expect(home).toBe('/home/oscar/.kvox');
  });

  it('an explicit KVOX_HOME also wins, on both branches', () => {
    const rootResult = runDefaultsBlock(0, '/root', { KVOX_HOME: '/custom/root/home' });
    expect(rootResult.home).toBe('/custom/root/home');

    const userResult = runDefaultsBlock(1000, '/home/oscar', { KVOX_HOME: '/custom/user/home' });
    expect(userResult.home).toBe('/custom/user/home');
  });
});
