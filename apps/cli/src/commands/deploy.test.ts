import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { Check, CheckContext, CompletedCheck } from '../deploy/checks/index.js';
import { readDeployInfo } from '../deploy/deploy-info.js';
import { DEPLOY_STATE_VERSION, deployStatePath, writeState, type DeployState } from '../deploy/state.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../deploy/executor.js';
import { CLI_NAME } from '../branding.js';
import type { InstallOptions } from '../deploy/install.js';
import { FAKE_COMMITS, fakeVps, populateClone } from '../deploy/testing/fake-vps.js';
import type { UpdateCheck } from '../deploy/update.js';
import { EXIT, exitCodeFor } from '../errors.js';
import {
  PUBLIC_IP_ENV_VAR,
  buildReport,
  describeAge,
  registerDeployCommand,
  renderResult,
  renderSummary,
  type DeployContext,
  type DoctorReport,
} from './deploy.js';

const ESC = String.fromCharCode(27);

function check(
  id: string,
  severity: 'required' | 'recommended',
  status: 'pass' | 'warn' | 'fail' | 'skip',
  detail = 'detail',
  remedy?: string,
): Check {
  return {
    id,
    title: id,
    severity,
    run: async () => ({ status, detail, ...(remedy === undefined ? {} : { remedy }) }),
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runDoctor(
  argv: readonly string[],
  checks: readonly Check[],
  extra: Partial<DeployContext> = {},
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    checks,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    // Outside any checkout, so no test spawns git against this repository.
    cwd: mkdtempSync(join(tmpdir(), 'appctl-doctor-cwd-')),
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'doctor', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

const HEALTHY: Check[] = [
  check('a', 'required', 'pass', 'fine'),
  check('b', 'recommended', 'pass', 'fine'),
];

/** A check that records the context it was handed, for the flag tests. */
function contextProbe(): { check: Check; seen: () => CheckContext } {
  let captured: CheckContext | undefined;
  return {
    check: {
      id: 'probe',
      title: 'probe',
      severity: 'required',
      run: async (context) => {
        captured = context;
        return { status: 'pass', detail: 'seen' };
      },
    },
    seen: () => {
      if (captured === undefined) throw new Error('the probe check never ran');
      return captured;
    },
  };
}

describe('kvox deploy doctor flags (issue #122)', () => {
  it('passes --skip-proxy, --skip-github and --proxy-container into the check context', async () => {
    const probe = contextProbe();

    const result = await runDoctor(
      ['--skip-proxy', '--skip-github', '--proxy-container', 'edge'],
      [probe.check],
    );

    expect(result.error).toBeUndefined();
    expect(probe.seen().skipProxy).toBe(true);
    expect(probe.seen().skipGithub).toBe(true);
    expect(probe.seen().proxyContainer).toBe('edge');
  });

  it('leaves the flags unset when not given', async () => {
    const probe = contextProbe();
    await runDoctor([], [probe.check]);

    expect(probe.seen().skipProxy).toBeUndefined();
    expect(probe.seen().skipGithub).toBeUndefined();
    expect(probe.seen().proxyContainer).toBeUndefined();
    expect(probe.seen().publicIp).toBeUndefined();
  });

  it('takes --public-ip from the flag, or from the environment', async () => {
    const fromFlag = contextProbe();
    await runDoctor(['--public-ip', '203.0.113.10'], [fromFlag.check]);
    expect(fromFlag.seen().publicIp).toBe('203.0.113.10');

    const previous = process.env[PUBLIC_IP_ENV_VAR];
    process.env[PUBLIC_IP_ENV_VAR] = '198.51.100.7';
    try {
      const fromEnv = contextProbe();
      await runDoctor([], [fromEnv.check]);
      expect(fromEnv.seen().publicIp).toBe('198.51.100.7');
    } finally {
      if (previous === undefined) delete process.env[PUBLIC_IP_ENV_VAR];
      else process.env[PUBLIC_IP_ENV_VAR] = previous;
    }
  });

  it('names the repository from the recorded state for gh-repo-access', async () => {
    const probe = contextProbe();
    const root = installedRoot();

    await runDoctor(['--root', root], [probe.check]);

    // From state, without spawning git: an installed deployment knows what
    // it deployed.
    expect(probe.seen().repoUrl).toBe('https://example.test/o/r');
  });

  it('leaves the repository unknown outside a checkout, and still runs', async () => {
    const probe = contextProbe();

    const result = await runDoctor([], [probe.check], {
      runCommand: (async () => {
        throw new Error('git must not be needed here');
      }) as unknown as typeof import('../deploy/executor.js').runCommand,
    });

    expect(result.error).toBeUndefined();
    expect(probe.seen().repoUrl).toBeUndefined();
  });
});

describe('kvox deploy doctor', () => {
  it('exits 0 when every required check passes', async () => {
    const result = await runDoctor([], HEALTHY);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('2 passed');
  });

  it('exits 6 when a required check fails', async () => {
    const result = await runDoctor([], [
      check('broken', 'required', 'fail', 'nope', 'do the thing'),
    ]);

    // A distinct code is the point: `doctor || provision-the-box` has to tell
    // "not ready" apart from "kvox itself broke".
    expect(exitCodeFor(result.error)).toBe(EXIT.PRECONDITION);
    expect((result.error as Error).message).toContain('broken');
  });

  it('exits 0 when only a recommended check fails', async () => {
    // Failing on advice is how people learn to pass --force.
    const result = await runDoctor([], [
      check('a', 'required', 'pass'),
      check('advice', 'recommended', 'fail', 'meh', 'consider this'),
    ]);

    expect(result.error).toBeUndefined();
  });

  it('writes nothing to stdout without --json', async () => {
    const result = await runDoctor([], HEALTHY);

    // stdout is reserved so `--json | jq` stays clean.
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  it('shows a remedy for every failing check', async () => {
    const result = await runDoctor([], [
      check('broken', 'required', 'fail', 'nope', 'run the fix command'),
    ]);

    expect(result.stderr).toContain('run the fix command');
  });

  it('emits no ANSI when the stream is not a terminal', async () => {
    const result = await runDoctor([], HEALTHY);

    expect(result.stderr).not.toContain(ESC);
  });

  it('emits no ANSI under --no-color even on a terminal', async () => {
    const result = await runDoctor(['--no-color'], HEALTHY, { isTty: true });

    expect(result.stderr).not.toContain(ESC);
  });

  it('reports a check that throws as a failure rather than crashing', async () => {
    const exploding: Check = {
      id: 'boom',
      title: 'boom',
      severity: 'recommended',
      run: async () => {
        throw new Error('probe blew up');
      },
    };

    const result = await runDoctor([], [check('a', 'required', 'pass'), exploding]);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('probe blew up');
  });
});

describe('kvox deploy doctor --json', () => {
  it('writes valid JSON on stdout and nothing on stderr', async () => {
    const result = await runDoctor(['--json'], HEALTHY);

    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(report.summary).toEqual({ passed: 2, warned: 0, failed: 0, skipped: 0 });
  });

  it('still exits 6 when a required check failed', async () => {
    const result = await runDoctor(['--json'], [
      check('broken', 'required', 'fail', 'nope', 'fix it'),
    ]);

    expect(exitCodeFor(result.error)).toBe(EXIT.PRECONDITION);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.remedy).toBe('fix it');
  });

  it('never emits ANSI, whatever the terminal looks like', async () => {
    const result = await runDoctor(['--json'], HEALTHY, { isTty: true });

    expect(result.stdout).not.toContain(ESC);
  });
});

describe('buildReport', () => {
  const results: CompletedCheck[] = [
    { id: 'a', title: 'A', severity: 'required', status: 'pass', detail: 'ok', durationMs: 1 },
    {
      id: 'b',
      title: 'B',
      severity: 'recommended',
      status: 'warn',
      detail: 'hmm',
      remedy: 'maybe',
      durationMs: 2,
    },
  ];

  it('omits remedy entirely when there is none', () => {
    const report = buildReport(results);

    expect(report.checks[0]).not.toHaveProperty('remedy');
    expect(report.checks[1]?.remedy).toBe('maybe');
  });

  it('is ok when only a recommended check warned', () => {
    expect(buildReport(results).ok).toBe(true);
  });
});

describe('rendering', () => {
  const failing: CompletedCheck = {
    id: 'x',
    title: 'Something',
    severity: 'required',
    status: 'fail',
    detail: 'not there',
    remedy:
      'A remedy long enough that it has to wrap across more than one line so it stays readable in an eighty column session over ssh',
    durationMs: 1,
  };

  it('marks status with a glyph, not only colour', () => {
    // Read over SSH, piped into files, and by people who cannot tell red from
    // green - colour alone would make the status invisible to all three.
    expect(renderResult(failing, false)).toContain('XX');
  });

  it('wraps a long remedy', () => {
    const lines = renderResult(failing, false).trim().split('\n');

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it('does not print a remedy for a passing check', () => {
    const passing: CompletedCheck = { ...failing, status: 'pass' };

    expect(renderResult(passing, false)).not.toContain('->');
  });

  it('colours only when asked', () => {
    expect(renderResult(failing, true)).toContain(ESC);
    expect(renderResult(failing, false)).not.toContain(ESC);
  });

  it('leads the summary with failures', () => {
    const line = renderSummary({ passed: 9, warned: 1, failed: 2, skipped: 0 }, false);

    expect(line.trim().startsWith('2 failed')).toBe(true);
    expect(line).toContain('1 warning(s)');
  });
});

describe('the deploy group', () => {
  it('fails rather than doing nothing when no subcommand is given', async () => {
    const program = new Command();
    program.exitOverride();
    registerDeployCommand(program, { checks: HEALTHY });

    // A CLI that exits 0 having done nothing turns a broken pipeline step
    // into a green one.
    await expect(program.parseAsync(['deploy'], { from: 'user' })).rejects.toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// `kvox deploy status`  (issue #183)
// ---------------------------------------------------------------------------

function installedRoot(root = mkdtempSync(join(tmpdir(), 'appctl-status-')), name?: string): string {
  mkdirSync(root, { recursive: true });
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    ...(name === undefined ? {} : { name }),
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
}

function appsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-apps-'));
}

function composeRunCommand(psJson: string, migrateOutput: string) {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const line = argv.join(' ');
    const stdout = line.includes(' ps ') ? psJson : migrateOutput;
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
    return result;
  }) as typeof import('../deploy/executor.js').runCommand;
}

const ALL_RUNNING = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'i' },
  { Name: 'demo-web-1', Service: 'web', State: 'running', Image: 'i' },
]);

const WEB_DOWN = JSON.stringify([
  { Name: 'demo-api-1', Service: 'api', State: 'running', Image: 'i' },
  { Name: 'demo-web-1', Service: 'web', State: 'exited', Image: 'i' },
]);

async function runStatus(
  argv: readonly string[],
  extra: Partial<DeployContext>,
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'status', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

describe('kvox deploy status', () => {
  it('exits 0 and reports every section when healthy', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('Revision');
    expect(result.stderr).toContain('Containers');
    expect(result.stderr).toContain('up to date');
    expect(result.stderr).toContain('healthy');
  });

  it('is unhealthy when the web container is down, even with the API green', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(WEB_DOWN, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect(result.stderr).toContain('NOT healthy');
  });

  it('is unhealthy with pending migrations despite a green readiness probe', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root], {
      runCommand: composeRunCommand(
        ALL_RUNNING,
        'Following migrations have not yet been applied:\n20260101000000_add_thing\n',
      ),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    // /api/health/ready only proves SELECT 1 succeeded.
    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect(result.stderr).toContain('1 pending');
    expect(result.stderr).toContain('20260101000000_add_thing');
  });

  it('distinguishes "nothing installed" from "installed and unhealthy"', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-empty-'));

    const result = await runStatus(['--root', empty], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    // A monitoring script has to be able to tell these apart.
    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('deploy install');
  });

  // The app-folder layout (#119): which app under --apps-root.

  it('needs no --name when exactly one app is installed under --apps-root', async () => {
    const root = appsRoot();
    installedRoot(join(root, 'only'), 'only');

    const result = await runStatus(['--apps-root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('healthy');
  });

  it('runs compose under the installed app\'s project name', async () => {
    const root = appsRoot();
    installedRoot(join(root, 'folder'), 'recorded');
    const seen: string[][] = [];

    await runStatus(['--apps-root', root], {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        seen.push([...argv]);
        return composeRunCommand(ALL_RUNNING, 'Database schema is up to date!')(argv, options);
      }) as typeof import('../deploy/executor.js').runCommand,
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) {
      expect(argv.slice(0, 4)).toEqual(['docker', 'compose', '-p', 'recorded']);
    }
  });

  it('exits 2 naming the apps root when nothing is installed under it', async () => {
    const root = appsRoot();

    const result = await runStatus(['--apps-root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain(root);
    expect((result.error as Error).message).toContain('deploy install');
  });

  it('refuses to guess between several installed apps, naming them', async () => {
    const root = appsRoot();
    installedRoot(join(root, 'alpha'), 'alpha');
    installedRoot(join(root, 'beta'), 'beta');

    const result = await runStatus(['--apps-root', root], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('alpha');
    expect((result.error as Error).message).toContain('beta');
    expect((result.error as Error).message).toContain('--name');
  });

  it('lets --name pick one of several', async () => {
    const root = appsRoot();
    installedRoot(join(root, 'alpha'), 'alpha');
    installedRoot(join(root, 'beta'), 'beta');
    const seen: string[][] = [];

    const result = await runStatus(['--apps-root', root, '--name', 'beta'], {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        seen.push([...argv]);
        return composeRunCommand(ALL_RUNNING, 'Database schema is up to date!')(argv, options);
      }) as typeof import('../deploy/executor.js').runCommand,
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.error).toBeUndefined();
    expect(seen[0]?.slice(2, 4)).toEqual(['-p', 'beta']);
  });

  it('says so when --name points at a folder with nothing installed', async () => {
    const root = appsRoot();
    installedRoot(join(root, 'alpha'), 'alpha');

    const result = await runStatus(['--apps-root', root, '--name', 'ghost'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain(join(root, 'ghost'));
  });

  it('writes the report as JSON on stdout and nothing on stderr', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root, '--json'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { healthy: boolean };
    expect(report.healthy).toBe(true);
  });

  it('reports a failing external check', async () => {
    const root = installedRoot();

    const result = await runStatus(['--root', root, '--domain', 'app.example.test'], {
      runCommand: composeRunCommand(ALL_RUNNING, 'Database schema is up to date!'),
      fetch: (async (url: string | URL) =>
        String(url).startsWith('https://')
          ? Promise.reject(
              Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }),
            )
          : new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.stderr).toContain('certificate has expired');
    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
  });
});

// The update line (issue #123): the same computation `update --check` runs,
// bounded, and never a reason to call a serving deployment unhealthy.

const LATEST = 'b'.repeat(40);

/** Compose answers as above; git answers as a clone three commits behind, or refuses to fetch. */
function gitAwareRunCommand(options: { fetchFails?: boolean } = {}) {
  const compose = composeRunCommand(ALL_RUNNING, 'Database schema is up to date!');
  return (async (argv: readonly string[], runOptions: RunCommandOptions): Promise<CommandResult> => {
    if (argv[0] !== 'git') return compose(argv, runOptions);
    const result = (stdout = ''): CommandResult => ({
      argv: [...argv], cwd: runOptions.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false,
    });
    if (argv[1] === 'fetch' && options.fetchFails === true) {
      throw new CommandFailedError('`git fetch` exited 128\n    fatal: could not read Username', { ...result(), exitCode: 128 });
    }
    if (argv[1] === 'rev-parse' && argv[2] === '--verify') return result(`${LATEST}\n`);
    if (argv[1] === 'rev-list') return result('3\n');
    if (argv[1] === 'log') return result(FAKE_COMMITS.map((commit) => `${commit.sha}\t${commit.subject}\n`).join(''));
    return result();
  }) as typeof import('../deploy/executor.js').runCommand;
}

describe('kvox deploy status: the Update line (issue #123)', () => {
  it('renders how far behind the deployment is, and includes remote under --json', async () => {
    const root = installedRoot();
    populateClone(join(root, 'repo'));

    const human = await runStatus(['--root', root], {
      runCommand: gitAwareRunCommand(),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });
    expect(human.error).toBeUndefined();
    expect(human.stderr).toMatch(new RegExp(`Update\\s+3 commits behind \\(latest ${'b'.repeat(12)}, checked just now\\)`));

    const machine = await runStatus(['--root', root, '--json'], {
      runCommand: gitAwareRunCommand(),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });
    expect(machine.stderr).toBe('');
    const report = JSON.parse(machine.stdout) as { healthy: boolean; remote: { sha: string; commitsBehind: number; checkedAt: string } | null };
    expect(report.healthy).toBe(true);
    expect(report.remote).toMatchObject({ sha: LATEST, commitsBehind: 3 });
    expect(report.remote?.checkedAt).toMatch(/Z$/);
  });

  it('bounds the fetch to ten seconds and never clones', async () => {
    const root = installedRoot();
    populateClone(join(root, 'repo'));
    const seen: { argv: string[]; timeoutMs: number | undefined }[] = [];
    const inner = gitAwareRunCommand();

    await runStatus(['--root', root], {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        seen.push({ argv: [...argv], timeoutMs: options.timeoutMs });
        return inner(argv, options);
      }) as typeof import('../deploy/executor.js').runCommand,
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    const fetch = seen.find((entry) => entry.argv[0] === 'git' && entry.argv[1] === 'fetch');
    expect(fetch?.timeoutMs).toBe(10_000);
    expect(seen.some((entry) => entry.argv[1] === 'clone')).toBe(false);
    // And gh is never consulted by a read-only report.
    expect(seen.some((entry) => entry.argv[0] === 'gh')).toBe(false);
  });

  it('survives a failing fetch: says so, stays healthy, and reports null under --json', async () => {
    const root = installedRoot();
    populateClone(join(root, 'repo'));

    const human = await runStatus(['--root', root], {
      runCommand: gitAwareRunCommand({ fetchFails: true }),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });
    expect(human.error).toBeUndefined();
    // git's "could not read Username" is the auth failure, so the reason is
    // the gh remedy in one line - not the raw git output.
    expect(human.stderr).toMatch(/Update\s+update check: unavailable \(git could not authenticate to the repository\. Run `gh auth login`/);
    expect(human.stderr).not.toContain('fatal:');
    expect(human.stderr).toContain('healthy');

    const machine = await runStatus(['--root', root, '--json'], {
      runCommand: gitAwareRunCommand({ fetchFails: true }),
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });
    const report = JSON.parse(machine.stdout) as { healthy: boolean; remote: unknown; updateCheckError?: string };
    expect(report.healthy).toBe(true);
    expect(report.remote).toBeNull();
    expect(report.updateCheckError).toContain('gh auth login');
  });

  it('is unavailable, without spawning git, when there is no checkout to compare', async () => {
    const root = installedRoot();
    const seen: string[][] = [];

    const result = await runStatus(['--root', root], {
      runCommand: (async (argv: readonly string[], options: RunCommandOptions) => {
        seen.push([...argv]);
        return composeRunCommand(ALL_RUNNING, 'Database schema is up to date!')(argv, options);
      }) as typeof import('../deploy/executor.js').runCommand,
      fetch: (async () => new Response('', { status: 200 })) as typeof globalThis.fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('update check: unavailable (There is no checkout at');
    expect(seen.some((argv) => argv[0] === 'git')).toBe(false);
  });
});

describe('describeAge', () => {
  const now = Date.parse('2026-09-16T12:00:00.000Z');

  it('rounds to the unit an operator reads at a glance', () => {
    expect(describeAge('2026-09-16T11:59:40.000Z', now)).toBe('just now');
    expect(describeAge('2026-09-16T11:58:00.000Z', now)).toBe('2 min ago');
    expect(describeAge('2026-09-16T09:00:00.000Z', now)).toBe('3 h ago');
    expect(describeAge('2026-09-14T12:00:00.000Z', now)).toBe('2 d ago');
  });
});


// ---------------------------------------------------------------------------
// `kvox deploy update --check`  (issue #123)
// ---------------------------------------------------------------------------

/** An installed app whose clone sits at the installed commit, for a check. */
function checkableRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-check-'));
  populateClone(join(root, 'repo'));
  writeState({
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    name: 'demo',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  });
  return root;
}

describe('kvox deploy update --check', () => {
  it('prints the check object on stdout, and nothing else, under --json', async () => {
    const vps = await fakeVps({ head: 'a'.repeat(40), remoteSha: LATEST });
    const root = checkableRoot();
    const stateBefore = readFileSync(deployStatePath(root), 'utf8');

    const result = await runDeploy(['update', '--check', '--json', '--root', root], { runCommand: vps.runCommand });
    await vps.close();

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const check = JSON.parse(result.stdout) as UpdateCheck;
    expect(check).toMatchObject({
      current: 'a'.repeat(40),
      latest: LATEST,
      commitsBehind: 2,
      commits: [...FAKE_COMMITS],
    });
    expect(check.checkedAt).toMatch(/Z$/);
    // Exit 0 with an update available, nothing built, the state untouched.
    expect(vps.seen.some((argv) => argv[1] === 'compose' && argv.includes('build'))).toBe(false);
    expect(vps.seen.some((argv) => argv[0] === 'git' && argv[1] === 'checkout')).toBe(false);
    expect(readFileSync(deployStatePath(root), 'utf8')).toBe(stateBefore);
    expect(readDeployInfo(root)?.remote).toMatchObject({ sha: LATEST, commitsBehind: 2 });
  });

  it('renders current -> latest with the subjects on stderr, and exits 0', async () => {
    const vps = await fakeVps({ head: 'a'.repeat(40), remoteSha: LATEST });
    const root = checkableRoot();

    const result = await runDeploy(['update', '--check', '--root', root], { runCommand: vps.runCommand });
    await vps.close();

    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`current ${'a'.repeat(12)} → latest ${'b'.repeat(12)}, 2 commits behind`);
    expect(result.stderr).toContain('b2b2b2b  feat(api): the second thing');
    expect(result.stderr).not.toContain('Build images');
  });

  it('says already up to date when nothing moved', async () => {
    const vps = await fakeVps({ head: 'a'.repeat(40), remoteSha: 'a'.repeat(40) });
    const root = checkableRoot();

    const result = await runDeploy(['update', '--check', '--json', '--root', root], { runCommand: vps.runCommand });
    await vps.close();

    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout) as UpdateCheck).toMatchObject({ commitsBehind: 0, commits: [] });
  });

  it('passes --skip-github through', async () => {
    const vps = await fakeVps({ head: 'a'.repeat(40), remoteSha: LATEST });
    const root = checkableRoot();
    writeState({ ...(JSON.parse(readFileSync(deployStatePath(root), 'utf8')) as DeployState), repoUrl: 'https://github.com/acme/demo.git' });

    const result = await runDeploy(['update', '--check', '--json', '--skip-github', '--root', root], { runCommand: vps.runCommand });
    await vps.close();

    expect(result.error).toBeUndefined();
    expect(vps.seen.some((argv) => argv[0] === 'gh')).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// `kvox deploy install` flags and `kvox deploy certs`  (issue #125)
// ---------------------------------------------------------------------------

async function runDeploy(
  argv: readonly string[],
  extra: Partial<DeployContext>,
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

/** Captures what the install command hands to the pipeline. */
function installProbe(): { install: typeof import('../deploy/install.js').runInstall; seen: () => InstallOptions } {
  let captured: InstallOptions | undefined;
  return {
    install: (async (options: InstallOptions) => {
      captured = options;
      return { deployRoot: '/tmp/x', name: 'x', commitSha: 'a'.repeat(40), journalPath: '/tmp/x/log', nextStep: 'log in' };
    }) as typeof import('../deploy/install.js').runInstall,
    seen: () => {
      if (captured === undefined) throw new Error('install never ran');
      return captured;
    },
  };
}

describe('kvox deploy install flags (issue #125)', () => {
  it('passes --proxy-container through', async () => {
    const probe = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test', '--proxy-container', 'edge'], { install: probe.install });
    expect(probe.seen().proxyContainer).toBe('edge');
  });

  it('passes ipv6: false for --no-ipv6, and nothing otherwise so the probe decides', async () => {
    const off = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test', '--no-ipv6'], { install: off.install });
    expect(off.seen().ipv6).toBe(false);

    const unset = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test'], { install: unset.install });
    expect(unset.seen()).not.toHaveProperty('ipv6');
  });

  it('passes --skip-github through, and leaves it unset otherwise', async () => {
    const on = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test', '--skip-github'], { install: on.install });
    expect(on.seen().skipGithub).toBe(true);

    const off = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test'], { install: off.install });
    expect(off.seen()).not.toHaveProperty('skipGithub');
  });

  it('leaves installCron undefined by default, true for --install-cron, false for --no-install-cron', async () => {
    const unset = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test'], { install: unset.install });
    // Undefined is the third state: "when a certificate was issued".
    expect(unset.seen()).not.toHaveProperty('installCron');

    const on = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test', '--install-cron'], { install: on.install });
    expect(on.seen().installCron).toBe(true);

    const off = installProbe();
    await runDeploy(['install', '--domain', 'app.example.test', '--no-install-cron'], { install: off.install });
    expect(off.seen().installCron).toBe(false);
  });
});

/** A proxy directory with one issued certificate for `domain`. */
function proxyRootWith(...domains: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-certs-proxy-'));
  for (const domain of domains) {
    mkdirSync(join(root, 'letsencrypt', 'live', domain), { recursive: true });
    writeFileSync(join(root, 'letsencrypt', 'live', domain, 'fullchain.pem'), 'cert');
    writeFileSync(join(root, 'letsencrypt', 'live', domain, 'cert.pem'), 'cert');
  }
  return root;
}

/** Records every argv; certbot answers with `certbotOutput`, openssl with `notAfter`. */
function certsRunCommand(seen: string[][], certbotOutput = 'No renewals were attempted.\n', notAfter = 'Dec 31 00:00:00 2099 GMT') {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    seen.push([...argv]);
    const stdout = argv.includes('certbot/certbot') ? certbotOutput : argv[0] === 'openssl' ? `notAfter=${notAfter}\n` : '';
    return { argv: [...argv], cwd: options.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
  }) as typeof import('../deploy/executor.js').runCommand;
}

function publishedRoot(root: string, proxyRoot: string, name = 'demo'): string {
  mkdirSync(root, { recursive: true });
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    domain: 'app.example.test',
    bindPort: 3535,
    deployRoot: root,
    name,
    appsRoot: join(root, '..'),
    proxyRoot,
    proxyContainer: 'edge-proxy',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
}

describe('kvox deploy certs renew', () => {
  it('runs certbot renew for this app\'s domain through docker, against the recorded proxy', async () => {
    const proxyRoot = proxyRootWith('app.example.test');
    const root = publishedRoot(join(appsRoot(), 'demo'), proxyRoot);
    const seen: string[][] = [];

    const result = await runDeploy(['certs', 'renew', '--root', root], { runCommand: certsRunCommand(seen) });

    expect(result.error).toBeUndefined();
    expect(seen).toEqual([
      [
        'docker', 'run', '--rm',
        '-v', `${proxyRoot}/letsencrypt:/etc/letsencrypt`,
        '-v', `${proxyRoot}/webroot:/var/www/certbot`,
        'certbot/certbot', 'renew', '--webroot', '-w', '/var/www/certbot', '--non-interactive',
        '--cert-name', 'app.example.test',
      ],
    ]);
    expect(result.stderr).toContain('Nothing was due');
  });

  it('--dry-run passes certbot\'s --dry-run, prints the argv, never reloads, and exits 0', async () => {
    const root = publishedRoot(join(appsRoot(), 'demo'), proxyRootWith('app.example.test'));
    const seen: string[][] = [];
    const simulated = 'Congratulations, all simulated renewals succeeded:\n  /etc/letsencrypt/live/app.example.test/fullchain.pem (success)\n';

    const result = await runDeploy(['certs', 'renew', '--root', root, '--dry-run'], { runCommand: certsRunCommand(seen, simulated) });

    expect(result.error).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('--dry-run');
    expect(seen[0]).toContain('certbot/certbot');
    expect(result.stderr).toContain('certbot/certbot renew');
    expect(result.stderr).toContain('--dry-run');
    expect(seen.some((argv) => argv.includes('reload'))).toBe(false);
  });

  it('--all renews every lineage, without --cert-name, and needs no installed app', async () => {
    const proxyRoot = proxyRootWith('a.example.test', 'b.example.test');
    const seen: string[][] = [];

    const result = await runDeploy(
      ['certs', 'renew', '--all', '--apps-root', appsRoot(), '--proxy-root', proxyRoot, '--proxy-container', 'edge'],
      { runCommand: certsRunCommand(seen) },
    );

    expect(result.error).toBeUndefined();
    expect(seen[0]).not.toContain('--cert-name');
    expect(seen[0]).toContain(`${proxyRoot}/letsencrypt:/etc/letsencrypt`);
  });

  it('reloads the recorded container only when certbot renewed something', async () => {
    const root = publishedRoot(join(appsRoot(), 'demo'), proxyRootWith('app.example.test'));
    const seen: string[][] = [];
    const renewed = 'Congratulations, all renewals succeeded:\n  /etc/letsencrypt/live/app.example.test/fullchain.pem (success)\n';

    const result = await runDeploy(['certs', 'renew', '--root', root, '--json'], { runCommand: certsRunCommand(seen, renewed) });

    expect(result.error).toBeUndefined();
    expect(seen[1]).toEqual(['docker', 'exec', 'edge-proxy', 'nginx', '-s', 'reload']);
    const report = JSON.parse(result.stdout) as { renewed: string[]; reloaded: boolean };
    expect(report).toMatchObject({ renewed: ['app.example.test'], reloaded: true });
    expect(result.stderr).toBe('');
  });

  it('--install-cron writes the cron file once and leaves it alone on the second run', async () => {
    const apps = appsRoot();
    const root = publishedRoot(join(apps, 'demo'), proxyRootWith('app.example.test'));
    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-certs-cron-'));
    const ctx: Partial<DeployContext> = { runCommand: certsRunCommand([]), cronDir, cliPath: '/usr/local/bin/cli' };

    const first = await runDeploy(['certs', 'renew', '--root', root, '--install-cron'], ctx);
    expect(first.error).toBeUndefined();
    expect(first.stderr).toContain(`Wrote ${join(cronDir, `${CLI_NAME}-certs-demo`)}`);
    const contents = readFileSync(join(cronDir, `${CLI_NAME}-certs-demo`), 'utf8');
    expect(contents).toContain(`/usr/local/bin/cli deploy certs renew --all --apps-root ${join(root, '..')} --name demo`);

    const second = await runDeploy(['certs', 'renew', '--root', root, '--install-cron'], ctx);
    expect(second.stderr).toContain('Kept');
    expect(readFileSync(join(cronDir, `${CLI_NAME}-certs-demo`), 'utf8')).toBe(contents);
  });

  it('refuses without --all when nothing is installed, naming the way out', async () => {
    const result = await runDeploy(['certs', 'renew', '--apps-root', appsRoot()], { runCommand: certsRunCommand([]) });

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect((result.error as Error).message).toContain('--all');
  });
});

describe('kvox deploy certs status', () => {
  it('lists every certificate with its expiry, exit 0 while all are valid', async () => {
    const proxyRoot = proxyRootWith('a.example.test', 'b.example.test');

    const result = await runDeploy(['certs', 'status', '--apps-root', appsRoot(), '--proxy-root', proxyRoot], {
      runCommand: certsRunCommand([]),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('a.example.test');
    expect(result.stderr).toContain('b.example.test');
    expect(result.stderr).toMatch(/expires in \d+ day\(s\)/);
  });

  it('exits 1 naming an expired certificate', async () => {
    const proxyRoot = proxyRootWith('old.example.test');

    const result = await runDeploy(['certs', 'status', '--apps-root', appsRoot(), '--proxy-root', proxyRoot, '--json'], {
      runCommand: certsRunCommand([], '', 'Jan  1 00:00:00 2020 GMT'),
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.FAILURE);
    expect((result.error as Error).message).toContain('old.example.test');
    const report = JSON.parse(result.stdout) as { certificates: Array<{ domain: string; daysLeft: number }> };
    expect(report.certificates[0]?.domain).toBe('old.example.test');
    expect(report.certificates[0]?.daysLeft).toBeLessThan(0);
  });

  it('exits 2 when there is nothing under the proxy', async () => {
    const result = await runDeploy(['certs', 'status', '--apps-root', appsRoot(), '--proxy-root', proxyRootWith()], {
      runCommand: certsRunCommand([]),
    });

    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
  });

  it('reads the proxy root from the installed app when none is given', async () => {
    const proxyRoot = proxyRootWith('app.example.test');
    const root = publishedRoot(join(appsRoot(), 'demo'), proxyRoot);

    const result = await runDeploy(['certs', 'status', '--root', root], { runCommand: certsRunCommand([]) });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain(proxyRoot);
  });
});
