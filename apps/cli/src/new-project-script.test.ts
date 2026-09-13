import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// =============================================================================
// Guards scripts/new-project.mjs's safety check and its non-destructive paths
// (issue #344, epic #341)
// =============================================================================
//
// WHY THIS LIVES IN apps/cli
// -----------------------------------------------------------------------------
// Same reasoning as `rename-script.test.ts` beside this file: this workspace
// already runs ESM tests that spawn real subprocesses, and CI already runs
// `npm run test:run --workspace=cli`. There is no separate "repo tooling"
// test workspace to put this in instead.
//
// WHAT THIS SUITE DELIBERATELY NEVER DOES
// -----------------------------------------------------------------------------
// `new-project.mjs --reset-release` (without `--dry-run`) and `--license`
// (without `--dry-run`) both write real files: package.json versions,
// CHANGELOG.md, and LICENSE. This suite never runs either of those against
// THIS checkout. Every case below is either:
//
//   - a refusal (the template safety check, or input validation) — nothing
//     is ever written on that path, or
//   - `--dry-run`, which the script's own `resetRelease()`/`writeLicense()`
//     gate behind `if (!dryRun) writeFileSync(...)`, or
//   - `--audit`/`--help`, which are read-only by construction (see
//     `audit()` and `main()`: nothing in either path calls `writeFileSync`).
//
// The write path (an actual `--reset-release` or `--license` with neither
// `--dry-run` nor a refusal) is intentionally NOT exercised here. Doing that
// safely would mean copying the whole repository to a scratch directory
// first, and the fixed relative walk from this file up to `REPO_ROOT` plus
// the git-remote read inside `assertNotTemplate()` make a trustworthy copy
// more machinery than this suite's other five cases justify. See the task
// note this file was written against for the same call.
//
// THE MOST IMPORTANT CASE HERE
// -----------------------------------------------------------------------------
// `assertNotTemplate()` is what stops `--reset-release` from ever running
// unguarded against the template itself — discarding real release history
// and renumbering four packages. This repository IS the template right now
// (`identity.json`'s `repoSlug` matches the git remote's origin), so the
// very first describe block below is a live exercise of the guard the
// script exists to provide, not a synthetic fixture.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'new-project.mjs');
const MANIFEST_PATH = join(REPO_ROOT, 'packages', 'shared', 'identity.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');
const WORKSPACE_MANIFESTS = [
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/cli/package.json',
  'packages/shared/package.json',
].map((rel) => join(REPO_ROOT, rel));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run `node scripts/new-project.mjs <args>` from the repo root, never throwing on a non-zero exit. */
function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function gitPorcelainStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function readAll(paths: string[]): string[] {
  return paths.map((p) => readFileSync(p, 'utf8'));
}

// -----------------------------------------------------------------------------
// 1. The safety check — the reason this script cannot bootstrap over itself.
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs --reset-release safety check', () => {
  it('refuses to run against the template repository itself, naming both the origin and the identity value', () => {
    const identity = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { repoSlug?: string };
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();

    // If this precondition ever stops holding (the checkout's origin no
    // longer matches identity.json's repoSlug — e.g. a real fork checked out
    // this suite), the test below would pass vacuously for the wrong reason.
    // Fail loudly instead so the assumption is visible.
    expect(identity.repoSlug, 'expected identity.json repoSlug to be set').toBeTruthy();
    expect(
      origin.includes(identity.repoSlug as string),
      `expected origin (${origin}) to include repoSlug (${identity.repoSlug}) — this test's ` +
        'premise (this checkout IS the template) no longer holds',
    ).toBe(true);

    const statusBefore = gitPorcelainStatus();
    const before = readAll([...WORKSPACE_MANIFESTS, CHANGELOG_PATH]);

    const result = run(['--reset-release']);

    const statusAfter = gitPorcelainStatus();
    const after = readAll([...WORKSPACE_MANIFESTS, CHANGELOG_PATH]);

    expect(result.status, `expected non-zero exit, got 0. stdout:\n${result.stdout}`).not.toBe(0);
    expect(result.stderr).toMatch(/still points at the repository named in identity\.json/);
    expect(result.stderr).toContain(origin);
    expect(result.stderr).toContain(identity.repoSlug as string);
    // A refusal must be a true no-op.
    expect(after).toEqual(before);
    expect(statusAfter).toBe(statusBefore);
  });
});

// -----------------------------------------------------------------------------
// 2. --audit (and the implied default) — read-only, and must keep
//    recommending KEEP for the example handlers.
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs --audit', () => {
  it('exits 0, writes nothing, and reports the example handlers as KEEP', () => {
    const statusBefore = gitPorcelainStatus();

    const result = run(['--audit']);

    const statusAfter = gitPorcelainStatus();

    expect(result.status, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`).toBe(0);
    expect(statusAfter).toBe(statusBefore);

    expect(result.stdout).toMatch(/FOR A NEW PROJECT/);
    expect(result.stdout).toMatch(/Nothing above was changed\./);

    // The example-handlers item is load-bearing: example.checksum is the
    // canonical node-eligible job type and the jobs/worker-node test suites
    // depend on it as a fixture (see the long comment at the top of
    // scripts/new-project.mjs). If a future edit ever flips this
    // recommendation to "delete", this assertion must fail.
    expect(result.stdout).toMatch(/Example job handlers and storage processor/);
    expect(result.stdout).toMatch(/KEEP unless you deliberately refactor/);
    expect(result.stdout).toMatch(/example\.checksum/);
  });

  it('running with no arguments implies --audit', () => {
    const statusBefore = gitPorcelainStatus();

    const result = run([]);

    const statusAfter = gitPorcelainStatus();

    expect(result.status, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`).toBe(0);
    expect(statusAfter).toBe(statusBefore);
    expect(result.stdout).toMatch(/FOR A NEW PROJECT/);
    expect(result.stdout).toMatch(/KEEP unless you deliberately refactor/);
  });
});

// -----------------------------------------------------------------------------
// 3. --dry-run --reset-release — deliberately bypasses assertNotTemplate()
//    (verified by reading the function: it returns immediately when
//    `dryRun` is true, before the git-remote / identity comparison), so this
//    must succeed here with no --force. It must still write nothing.
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs --dry-run --reset-release', () => {
  it('exits 0 without --force, and leaves the working tree byte-identical', () => {
    const statusBefore = gitPorcelainStatus();
    const before = readAll([...WORKSPACE_MANIFESTS, CHANGELOG_PATH]);

    const result = run(['--dry-run', '--reset-release']);

    const statusAfter = gitPorcelainStatus();
    const after = readAll([...WORKSPACE_MANIFESTS, CHANGELOG_PATH]);

    expect(result.status, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Would change/);
    expect(result.stdout).toMatch(/version -> 0\.1\.0/);
    expect(result.stdout).toMatch(/CHANGELOG\.md/);
    expect(result.stdout).toMatch(/\(--dry-run: nothing was written\.\)/);

    expect(after).toEqual(before);
    expect(statusAfter).toBe(statusBefore);
  });
});

// -----------------------------------------------------------------------------
// 4. --help / -h
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs --help', () => {
  it('exits 0 and prints usage', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Prepare a fresh fork of this template as a new product\./);
    expect(result.stdout).toMatch(/--reset-release/);
    expect(result.stdout).toMatch(/--license/);
    expect(result.stdout).toMatch(/--dry-run/);
    expect(result.stdout).toMatch(/--force/);
  });

  it('-h is the same as --help', () => {
    const result = run(['-h']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Prepare a fresh fork of this template as a new product\./);
  });
});

// -----------------------------------------------------------------------------
// 5. --license validation. `main()` runs `assertNotTemplate()` whenever
//    `opts.license` is set at all — before `writeLicense()`'s own id/holder
//    checks ever run — and this checkout IS the template (see case 1 above).
//    So every case here needs `--dry-run` too, purely to get past that gate
//    and reach the validation this describe block is actually testing;
//    `writeLicense()`'s own die() calls happen before any `writeFileSync`
//    regardless of `--dry-run`, so this stays read-only either way.
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs --license validation', () => {
  it('rejects an unsupported license id and names the supported ones', () => {
    const statusBefore = gitPorcelainStatus();

    const result = run(['--dry-run', '--license', 'apache-2.0', '--holder', 'Test Holder']);

    const statusAfter = gitPorcelainStatus();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown --license "apache-2\.0"/);
    expect(result.stderr).toMatch(/Supported: mit, proprietary\./);
    expect(statusAfter).toBe(statusBefore);
  });

  it('rejects --license mit without --holder', () => {
    const statusBefore = gitPorcelainStatus();

    const result = run(['--dry-run', '--license', 'mit']);

    const statusAfter = gitPorcelainStatus();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--holder/);
    expect(statusAfter).toBe(statusBefore);
  });
});

// -----------------------------------------------------------------------------
// 6. Unknown flag
// -----------------------------------------------------------------------------

describe('scripts/new-project.mjs unknown arguments', () => {
  it('exits non-zero on an unrecognised flag', () => {
    const result = run(['--not-a-real-flag']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown argument: --not-a-real-flag/);
  });
});
