import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// =============================================================================
// Guards apps/cli/bootstrap-vps.sh's --dry-run output and its usage errors
// (issue #130, epic #168)
// =============================================================================
//
// WHY THIS LIVES IN apps/cli
// -----------------------------------------------------------------------------
// Same reasoning as `new-project-script.test.ts` and `rename-script.test.ts`
// beside this file: this workspace already runs ESM tests that spawn real
// subprocesses, and CI already runs `npm run test:run --workspace=cli`.
//
// WHAT THIS SUITE DELIBERATELY NEVER DOES
// -----------------------------------------------------------------------------
// It never runs the script WITHOUT `--dry-run` past its argument parsing. A
// live run writes under /etc/apt, /opt/infra and /usr/local/bin, and its
// second step is an interactive `gh auth login`. Every case below is either
// a `--dry-run` (the script's own `run`/`probe`/`write_line` helpers gate
// every side effect on that flag) or a usage error, which exits before any
// step starts.
//
// THE GOLDEN FIXTURE
// -----------------------------------------------------------------------------
// The dry run is specified to be DETERMINISTIC ON ANY MACHINE: it probes
// nothing on the host (not root, not docker, not gh, not node), assumes
// nothing is installed, and never reads $HOME or the hostname. That is what
// lets its output be compared byte-for-byte to a committed fixture here, and
// it is also the property that makes the fixture a readable spec of what the
// script does on a fresh box — every command it would run, in order.
//
// If a change to the script alters the output on purpose, regenerate the
// fixtures with the two commands named in `FIXTURES` below and review the diff
// like any other.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/cli/src -> apps/cli -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'apps', 'cli', 'bootstrap-vps.sh');
const FIXTURE_DIR = join(HERE, '__fixtures__');

const FIXTURES = [
  {
    name: 'the default dry run',
    args: ['--repo', 'o/r', '--dry-run'],
    file: 'bootstrap-vps.dry-run.txt',
    // Regenerate: bash apps/cli/bootstrap-vps.sh --repo o/r --dry-run > apps/cli/src/__fixtures__/bootstrap-vps.dry-run.txt
  },
  {
    name: 'a dry run with --ref, --update, --no-tui and --yes',
    args: ['--repo', 'o/r', '--ref', 'develop', '--dry-run', '--update', '--no-tui', '--yes'],
    file: 'bootstrap-vps.dry-run.update.txt',
    // Regenerate: bash apps/cli/bootstrap-vps.sh --repo o/r --ref develop --dry-run --update --no-tui --yes > apps/cli/src/__fixtures__/bootstrap-vps.dry-run.update.txt
  },
] as const;

/**
 * A deliberately alien environment. `HOME` points nowhere, the locale is C,
 * the terminal is dumb, and the cwd is the OS temp dir rather than the
 * repository — so a dry run that quietly depended on any of them would
 * diverge from the fixture, which was generated under different values.
 */
function alienEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
  };
}

function runScript(args: readonly string[], home = '/nonexistent-home-for-this-test') {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: alienEnv(home),
    cwd: tmpdir(),
    // stdin closed: nothing here may ever wait on a keypress. A dry run never
    // prompts, and a usage error exits first — this makes a regression on
    // either a fast failure rather than a hung test.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dryRun(args: readonly string[], home?: string): string {
  return execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: alienEnv(home ?? '/nonexistent-home-for-this-test'),
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('bootstrap-vps.sh parses', () => {
  it('passes bash -n', () => {
    // The same check CI runs; here so a syntax slip fails the unit suite
    // locally instead of only on the runner.
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });
});

describe('bootstrap-vps.sh --dry-run (issue #130)', () => {
  it.each(FIXTURES)('$name matches its committed fixture', ({ args, file }) => {
    const expected = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    expect(dryRun(args)).toBe(expected);
  });

  it('executes nothing: the first directory it would create is still absent', () => {
    // The closest thing to a proof that the dry run runs none of what it
    // prints. `/opt/infra/cli/r` is the checkout path for `--repo o/r`, a
    // repository that does not exist; a dry run that executed its `mkdir -p`
    // (or the `gh repo clone` after it) would leave it behind. As a non-root
    // user the `mkdir` would additionally fail and turn the exit code
    // non-zero, which the fixture cases above already assert against.
    dryRun(['--repo', 'o/r', '--dry-run']);
    expect(existsSync('/opt/infra/cli/r')).toBe(false);
  });

  it('is identical under a different HOME, and names neither the host nor HOME', () => {
    // cwd-independence is covered by the fixture cases: the fixtures were
    // generated from inside the repository and are compared from `tmpdir()`.
    const a = dryRun(['--repo', 'o/r', '--dry-run'], '/home/one');
    const b = dryRun(['--repo', 'o/r', '--dry-run'], '/some/other/home');
    expect(a).toBe(b);
    expect(a).not.toContain('/home/one');
    expect(a).not.toContain(hostname());
  });

  it('prints every step header, the install.sh hand-off, and the launch', () => {
    // The fixture pins the exact text; this pins the shape a reader relies
    // on, so a fixture regeneration that dropped a step by accident would
    // still fail here with a message naming what went missing.
    const out = dryRun(['--repo', 'o/r', '--dry-run']);
    for (const step of [
      '==> Step 1/6: Preconditions',
      '==> Step 2/6: GitHub CLI',
      '==> Step 3/6: Node.js',
      '==> Step 4/6: CLI checkout',
      '==> Step 5/6: Deploy folder',
      '==> Step 6/6: Launch',
    ]) {
      expect(out).toContain(step);
    }
    expect(out).toContain('+ gh repo clone o/r /opt/infra/cli/r\n');
    expect(out).toContain(
      '+ env KVOX_SRC=/opt/infra/cli/r KVOX_BIN_DIR=/usr/local/bin bash /opt/infra/cli/r/install.sh --no-color\n',
    );
    expect(out).toContain('+ mkdir -p /opt/infra/apps\n');
    expect(out).toContain('+ /usr/local/bin/kvox deploy doctor --skip-proxy\n');
  });

  it('--ref clones that branch and --no-tui prints the next command instead of the menu', () => {
    const out = dryRun(['--repo', 'o/r', '--ref', 'develop', '--dry-run', '--no-tui', '--yes']);
    expect(out).toContain('+ gh repo clone o/r /opt/infra/cli/r -- --branch develop\n');
    expect(out).toContain('kvox deploy install --domain <your-domain>');
    // The bare `kvox` launch line is the menu; --no-tui must not print it.
    expect(out).not.toMatch(/^ {2}\+ \/usr\/local\/bin\/kvox\n/m);
  });

  it('never probes the host: every check is reported as "would check"', () => {
    const out = dryRun(['--repo', 'o/r', '--dry-run']);
    expect(out).not.toContain('checking:');
    expect(out).not.toContain('ok:');
    expect(out.match(/would check:/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});

describe('bootstrap-vps.sh usage errors exit 2', () => {
  it('without --repo', () => {
    const result = runScript(['--dry-run']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--repo <owner>/<name> is required');
    expect(result.stderr).toContain('Usage:');
    expect(result.stdout).toBe('');
  });

  it('with an unknown flag', () => {
    const result = runScript(['--repo', 'o/r', '--dry-run', '--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument: --bogus');
    expect(result.stdout).toBe('');
  });

  it.each([['o'], ['o/r/x'], ['/r'], ['o/'], ['o/r name']])(
    'with a --repo that is not <owner>/<name>: %s',
    (slug) => {
      const result = runScript(['--repo', slug, '--dry-run']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--repo must be <owner>/<name>');
    },
  );

  it('with --repo or --ref missing its value', () => {
    expect(runScript(['--dry-run', '--repo']).status).toBe(2);
    expect(runScript(['--repo', 'o/r', '--dry-run', '--ref']).status).toBe(2);
  });

  it('--help exits 0 and prints the usage on stdout', () => {
    const result = runScript(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: bash bootstrap-vps.sh --repo <owner>/<name>');
    expect(result.stdout).toContain('--dry-run');
  });
});
