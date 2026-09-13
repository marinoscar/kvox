import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { Check, CompletedCheck } from '../deploy/checks/index.js';
import { DEPLOY_STATE_VERSION, deployStatePath, type DeployState } from '../deploy/state.js';
import type { CommandResult, RunCommandOptions } from '../deploy/executor.js';
import { EXIT, exitCodeFor } from '../errors.js';
import {
  buildReport,
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

describe('appctl deploy doctor', () => {
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
    // "not ready" apart from "appctl itself broke".
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

describe('appctl deploy doctor --json', () => {
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
// `appctl deploy status`  (issue #183)
// ---------------------------------------------------------------------------

function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-status-'));
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
  };
  writeFileSync(deployStatePath(root), JSON.stringify(state));
  return root;
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

describe('appctl deploy status', () => {
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
