import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// =============================================================================
// Guards scripts/rename.mjs against decaying into a no-op (issue #343, epic #341)
// =============================================================================
//
// WHY THIS LIVES IN apps/cli
// -----------------------------------------------------------------------------
// Same reasoning as `template-identity.test.ts` beside this file: this
// workspace already runs ESM tests that spawn real subprocesses
// (`apps/cli/src/deploy/repo.test.ts` spawns real `git`), and CI already runs
// `npm run test:run --workspace=cli`. There is no separate "repo tooling"
// test workspace to put this in instead.
//
// WHAT THIS DOES AND DOES NOT PROVE
// -----------------------------------------------------------------------------
// `rename.mjs` rewrites files in place under normal operation, and this suite
// deliberately never lets it do that against the real working tree — every
// invocation below passes `--dry-run`. The point of the suite is narrower and,
// for a codemod, more important than "it edits files": every anchor the
// script's `buildPlan()` declares must still find exactly the hit count it
// expects RIGHT NOW, against the repository as it exists today. `buildPlan()`
// fails loudly (`problems`, non-zero exit) the moment an anchor's surrounding
// file changes shape — a refactor of README.md, a reworded install.sh line —
// and it is exactly that failure mode this suite exists to catch. A codemod
// that silently skips a file and reports success would leave the old name in
// a published OpenAPI document; see the long comment at the top of
// `scripts/rename.mjs` itself.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const RENAME_SCRIPT = join(REPO_ROOT, 'scripts', 'rename.mjs');
const MANIFEST_PATH = join(REPO_ROOT, 'packages', 'shared', 'identity.json');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run `node scripts/rename.mjs <args>` from the repo root, never throwing on a non-zero exit. */
function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [RENAME_SCRIPT, ...args], {
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

// -----------------------------------------------------------------------------
// `--dry-run` skips the dirty-tree check entirely (verified by reading
// `main()`: the `git status --porcelain` check is gated on
// `!opts.dryRun && !opts.force`), so every test below is safe to run against
// whatever state this checkout happens to be in — dirty or clean — without
// `--force`.
// -----------------------------------------------------------------------------

describe('scripts/rename.mjs --dry-run writes nothing', () => {
  it('exits 0 and leaves the working tree byte-identical', () => {
    const before = readFileSync(MANIFEST_PATH, 'utf8');
    const statusBefore = gitPorcelainStatus();

    const result = run([
      '--dry-run',
      '--name',
      'Rename Guard Sample',
      '--repo',
      'sample-owner/sample-repo',
      '--theme',
      '#123456',
    ]);

    const statusAfter = gitPorcelainStatus();
    const after = readFileSync(MANIFEST_PATH, 'utf8');

    expect(result.status, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`).toBe(0);
    expect(after).toBe(before);
    expect(statusAfter).toBe(statusBefore);
  });
});

describe('scripts/rename.mjs --dry-run reports a hit for every declared anchor', () => {
  it('produces no "did not match as declared" failures', () => {
    // The real point of this test: if an unrelated refactor changes the shape
    // of a file `buildPlan()` targets (a reworded README line, a moved env
    // default), the script's own hit-count check goes red here — instead of
    // the codemod silently skipping that file and reporting a clean run.
    const result = run([
      '--dry-run',
      '--name',
      'Rename Guard Sample',
      '--repo',
      'sample-owner/sample-repo',
      '--theme',
      '#123456',
    ]);

    expect(
      result.status,
      `rename.mjs exited ${result.status}; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toMatch(/did not match as declared/);
    expect(result.stdout).toMatch(/Planned edits/);
    // Every anchor line in the "planned" listing is prefixed `~` for a real
    // hit or `=` for "already applied"; neither prefix appears if the plan is
    // empty, so require at least one real edit to guard against a plan that
    // silently shrank to nothing.
    expect(result.stdout).toMatch(/^\s*~ /m);
  });
});

describe('scripts/rename.mjs --help', () => {
  it('exits 0 and prints usage', () => {
    const result = run(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rebrand this template/);
    expect(result.stdout).toMatch(/--dry-run/);
    expect(result.stdout).toMatch(/--theme/);
    expect(result.stdout).toMatch(/--repo/);
  });

  it('-h is the same as --help', () => {
    const result = run(['-h']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Rebrand this template/);
  });
});

describe('scripts/rename.mjs input validation', () => {
  it('rejects a 3-digit --theme with a message naming the 6-digit requirement', () => {
    const result = run(['--dry-run', '--theme', '#fff']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/6-digit hex/);
  });

  it('rejects a --repo that is not owner/name', () => {
    const result = run(['--dry-run', '--repo', 'notaslug']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/owner\/name/);
  });
});
