import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// =============================================================================
// install.sh bundles the environment template beside the CLI (issue #236)
// =============================================================================
//
// Same extraction technique as the defaults block above: the block between
// `TEMPLATE_SRC="$TMP_DIR/infra/compose/.env.example"` and its closing,
// UNINDENTED `fi` is pulled straight out of the real, current install.sh at
// test time (never a hand-copied duplicate), and run under bash with `err`/
// `warn`/`ok` stubbed to plain stdout lines and $TMP_DIR/$APP_DIR pointed at
// real temp directories. The inner `if [[ -n "$KVOX_SRC" ]]; then ... fi` is
// indented two spaces, so it is NOT what the `\nfi\n` search finds — only the
// outer, column-0 `fi` closes the extraction, which is asserted implicitly by
// every scenario below actually exercising the KVOX_SRC branch inside it.
//
// REAL GIT, not a mock: what `git remote get-url origin` and `git rev-parse
// --abbrev-ref HEAD` report for a given repository state is exactly the
// behaviour this block leans on, and a stub would only prove the stub was
// called the way the test expected.
// =============================================================================

const TEMPLATE_START_MARKER = 'TEMPLATE_SRC="$TMP_DIR/infra/compose/.env.example"';

function extractTemplateBlock(): string {
  const source = readFileSync(INSTALL_SH, 'utf8');
  const start = source.indexOf(TEMPLATE_START_MARKER);
  if (start === -1) {
    throw new Error(
      `install.sh no longer contains the expected "${TEMPLATE_START_MARKER}" line — ` +
        'the template-bundling block this test pins may have moved or been removed.',
    );
  }
  const closeMarker = '\nfi\n';
  const closeIdx = source.indexOf(closeMarker, start);
  if (closeIdx === -1) {
    throw new Error(
      'install.sh: could not find the closing (unindented) "fi" for the template-bundling block.',
    );
  }
  const end = closeIdx + closeMarker.length;
  return source.slice(start, end);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  }).trim();
}

/** A real git repository at a fresh temp directory, with one commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'install-sh-tmpdir-'));
  createdDirs.push(dir);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'first');
  return dir;
}

function writeEnvExample(repoDir: string, contents = 'DATABASE_URL=postgres://placeholder\n'): void {
  const dir = join(repoDir, 'infra', 'compose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env.example'), contents);
}

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface TemplateBlockEnv {
  tmpDir: string;
  appDir: string;
  kvoxRepo: string;
  kvoxRef: string;
  kvoxSrc?: string;
}

interface TemplateBlockRun {
  stdout: string;
  status: number | null;
}

function runTemplateBlock(vars: TemplateBlockEnv): TemplateBlockRun {
  const workDir = mkdtempSync(join(tmpdir(), 'install-sh-template-run-'));
  createdDirs.push(workDir);

  const block = extractTemplateBlock();
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'err()  { printf "ERR: %s\\n" "$1"; }',
    'warn() { printf "WARN: %s\\n" "$1"; }',
    'ok()   { printf "OK: %s\\n" "$1"; }',
    block,
  ].join('\n');
  const scriptPath = join(workDir, 'run.sh');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    TMP_DIR: vars.tmpDir,
    APP_DIR: vars.appDir,
    KVOX_REPO: vars.kvoxRepo,
    KVOX_REF: vars.kvoxRef,
    KVOX_SRC: vars.kvoxSrc ?? '',
  };

  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env,
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  return { stdout: result.stdout, status: result.status };
}

function readSourceJson(appDir: string): { repoUrl: string; ref: string } {
  return JSON.parse(readFileSync(join(appDir, 'template', 'source.json'), 'utf8')) as {
    repoUrl: string;
    ref: string;
  };
}

describe('install.sh bundles infra/compose/.env.example into $APP_DIR/template (#236)', () => {
  it('copies the template and records $KVOX_REPO/$KVOX_REF for an ordinary clone (no KVOX_SRC)', () => {
    const tmpDir = makeRepo();
    git(tmpDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
    writeEnvExample(tmpDir, 'KEY=value\n');
    const appDir = mkdtempSync(join(tmpdir(), 'install-sh-appdir-'));
    createdDirs.push(appDir);

    const { stdout, status } = runTemplateBlock({
      tmpDir,
      appDir,
      kvoxRepo: 'https://github.com/example-owner/example-repo.git',
      kvoxRef: 'v2.0.0',
    });

    expect(status).toBe(0);
    expect(readFileSync(join(appDir, 'template', '.env.example'), 'utf8')).toBe('KEY=value\n');
    expect(readSourceJson(appDir)).toEqual({
      repoUrl: 'https://github.com/example-owner/example-repo.git',
      ref: 'v2.0.0',
    });
    expect(stdout).toContain(
      'OK: Bundled the environment template from https://github.com/example-owner/example-repo.git',
    );
  });

  it('a KVOX_SRC install records the REAL origin URL, not the temp directory it was copied through', () => {
    // Simulates `KVOX_SRC=/path/to/checkout bash install.sh`: install.sh
    // copies KVOX_SRC into $TMP_DIR before this block runs, so $TMP_DIR is a
    // real git checkout whose origin is the operator's actual fork — never
    // the throwaway temp path. Recording that path instead would make the
    // bundled template useless to `bundledTemplateMatches` on every future
    // run, since the temp directory is deleted before install.sh exits.
    const tmpDir = makeRepo();
    git(tmpDir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    git(tmpDir, 'checkout', '--quiet', '-b', 'feature-x');
    writeEnvExample(tmpDir);
    const appDir = mkdtempSync(join(tmpdir(), 'install-sh-appdir-'));
    createdDirs.push(appDir);

    runTemplateBlock({
      tmpDir,
      appDir,
      // Deliberately a DIFFERENT repo than the real origin above: if this
      // value leaked into source.json instead of the real origin, this
      // assertion would catch it immediately.
      kvoxRepo: 'https://github.com/should-not-be-used/anything.git',
      kvoxRef: 'main',
      kvoxSrc: '/some/local/checkout',
    });

    expect(readSourceJson(appDir)).toEqual({
      repoUrl: 'https://github.com/acme/widgets.git',
      ref: 'feature-x',
    });
  });

  it('falls back to $KVOX_REPO when the source tree is not a git checkout at all', () => {
    // `git -C "$TMP_DIR" remote get-url origin` fails outright (no .git),
    // guarded by `|| true`, so SRC_REPO_URL stays empty and the explicit
    // fallback (`[[ -n "$SRC_REPO_URL" ]] || SRC_REPO_URL="$KVOX_REPO"`) is
    // what the recorded value actually comes from.
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-sh-plain-src-'));
    createdDirs.push(tmpDir);
    writeEnvExample(tmpDir);
    const appDir = mkdtempSync(join(tmpdir(), 'install-sh-appdir-'));
    createdDirs.push(appDir);

    runTemplateBlock({
      tmpDir,
      appDir,
      kvoxRepo: 'https://github.com/fallback-owner/fallback-repo.git',
      kvoxRef: 'main',
      kvoxSrc: '/some/local/checkout',
    });

    expect(readSourceJson(appDir)).toEqual({
      repoUrl: 'https://github.com/fallback-owner/fallback-repo.git',
      ref: '',
    });
  });

  it('records an empty ref for a KVOX_SRC checkout in detached HEAD, never the literal "HEAD"', () => {
    const tmpDir = makeRepo();
    git(tmpDir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    const sha = git(tmpDir, 'rev-parse', 'HEAD');
    git(tmpDir, 'checkout', '--quiet', '--detach', sha);
    writeEnvExample(tmpDir);
    const appDir = mkdtempSync(join(tmpdir(), 'install-sh-appdir-'));
    createdDirs.push(appDir);

    runTemplateBlock({
      tmpDir,
      appDir,
      kvoxRepo: 'https://github.com/acme/widgets.git',
      kvoxRef: 'main',
      kvoxSrc: '/some/local/checkout',
    });

    expect(readSourceJson(appDir).ref).toBe('');
  });

  it('warns rather than failing when the source has no infra/compose/.env.example, and creates no template/ dir', () => {
    const tmpDir = makeRepo();
    git(tmpDir, 'remote', 'add', 'origin', 'https://github.com/example-owner/example-repo.git');
    // Deliberately no writeEnvExample() call: the source tree has no template.
    const appDir = mkdtempSync(join(tmpdir(), 'install-sh-appdir-'));
    createdDirs.push(appDir);

    const { stdout, status } = runTemplateBlock({
      tmpDir,
      appDir,
      kvoxRepo: 'https://github.com/example-owner/example-repo.git',
      kvoxRef: 'main',
    });

    expect(status).toBe(0);
    expect(stdout).toContain(
      'WARN: No infra/compose/.env.example in the source; the wizard will read it from the remote',
    );
    expect(existsSync(join(appDir, 'template'))).toBe(false);
  });
});
