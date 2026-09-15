import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PreconditionError, UsageError } from '../errors.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  buildInstallSteps,
  composeArgv,
  composeCwd,
  defaultRootFor,
  runInstall,
  secretsFrom,
} from './install.js';
import { DEPLOY_STATE_VERSION, writeState, type DeployState } from './state.js';

function installedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    bindPort: 3535,
    deployRoot: root,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeState(state);
  return root;
}

describe('the install pipeline', () => {
  const steps = buildInstallSteps();
  const ids = steps.map((step) => step.id);

  it('runs the steps in an order the deployment actually requires', () => {
    expect(ids).toEqual([
      'preflight',
      'checkout',
      'environment',
      'validate-environment',
      'build',
      'migrate',
      'seed',
      'start',
      'health',
      'publish',
      'verify',
    ]);
  });

  it('checks prerequisites before it fetches anything', () => {
    // The whole point of a preflight: abort before the repository is cloned
    // and before .env is written.
    expect(ids.indexOf('preflight')).toBeLessThan(ids.indexOf('checkout'));
  });

  it('migrates before it starts the stack, and seeds after migrating', () => {
    expect(ids.indexOf('migrate')).toBeLessThan(ids.indexOf('start'));
    expect(ids.indexOf('migrate')).toBeLessThan(ids.indexOf('seed'));
  });

  it('publishes only after the API is known to be healthy', () => {
    // Issuing a certificate for a stack that never came up wastes rate limit.
    expect(ids.indexOf('health')).toBeLessThan(ids.indexOf('publish'));
  });

  function skipReasonFor(id: string, options: Record<string, unknown>): string | undefined {
    const step = steps.find((candidate) => candidate.id === id);
    return step?.skip?.({ options } as never);
  }

  it('honours --skip-doctor, --skip-proxy and --skip-seed', () => {
    expect(skipReasonFor('preflight', { skipDoctor: true })).toContain('--skip-doctor');
    expect(skipReasonFor('seed', { skipSeed: true })).toContain('--skip-seed');
    expect(skipReasonFor('publish', { skipProxy: true, domain: 'x' })).toContain('--skip-proxy');
  });

  it('skips publishing when there is no domain to publish under', () => {
    expect(skipReasonFor('publish', {})).toContain('no --domain');
  });

  it('does not skip anything by default', () => {
    for (const id of ids) {
      expect(skipReasonFor(id, { domain: 'app.example.test' })).toBeUndefined();
    }
  });
});

describe('the preflight step', () => {
  /** A box with docker, git and gh, and NO proxy of any kind. */
  const noProxyRunCommand = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const line = argv.join(' ');
    const canned: { exitCode: number; stdout?: string; stderr?: string } =
      line.startsWith('docker --version') ? { exitCode: 0, stdout: 'Docker version 27.3.1' }
      : line.startsWith('docker info') ? { exitCode: 0, stdout: '27.3.1' }
      : line.startsWith('docker compose version') ? { exitCode: 0, stdout: 'v2.29.0' }
      : line.startsWith('git --version') ? { exitCode: 0, stdout: 'git version 2.43.0' }
      : line.startsWith('gh --version') ? { exitCode: 0, stdout: 'gh version 2.40.1' }
      : line.startsWith('gh auth status') ? { exitCode: 0, stdout: 'Logged in to github.com account octocat' }
      : line.startsWith('df -Pk') ? { exitCode: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /' }
      : { exitCode: 1, stderr: `${argv[0]}: no such thing` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr, result);
    return result;
  }) as typeof import('./executor.js').runCommand;

  function preflightContext(options: Record<string, unknown>, lines: string[]) {
    return {
      options: {
        deployRoot: mkdtempSync(join(tmpdir(), 'appctl-preflight-')),
        bindPort: 3535,
        proxyRoot: '/nonexistent/proxy',
        ...options,
      },
      runCommand: noProxyRunCommand,
      journal: { line: (text: string) => lines.push(text) },
      hooks: undefined,
      completed: new Set<string>(),
    } as never;
  }

  const preflight = buildInstallSteps().find((step) => step.id === 'preflight');
  if (preflight === undefined) throw new Error('no preflight step');

  it('passes with --skip-proxy on a box with no proxy, reporting the skips', async () => {
    const lines: string[] = [];

    await expect(preflight.run(preflightContext({ skipProxy: true }, lines))).resolves.toBeUndefined();

    // The proxy checks ran and said why they stood down, rather than failing.
    expect(lines).toContain('skip proxy-root: --skip-proxy');
    expect(lines).toContain('skip proxy-container: --skip-proxy');
    expect(lines).toContain('skip certbot-image: --skip-proxy');
    expect(lines.some((line) => line.startsWith('fail '))).toBe(false);
  });

  it('fails on the missing proxy without the flag', async () => {
    const lines: string[] = [];

    const error = await preflight.run(preflightContext({}, lines)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('proxy-root');
  });
});

describe('runInstall preconditions', () => {
  it('refuses to install over an existing deployment, pointing at update', async () => {
    const root = installedRoot();

    const error = await runInstall({
      deployRoot: root,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('deploy update');
    expect((error as Error).message).toContain('--reinstall');
  });
});

describe('compose invocation', () => {
  it('layers base, prod and vps in that order', () => {
    // vps.compose.yml must come last: its `!override` on ports only replaces
    // what the earlier files declared if it is applied after them.
    expect(composeArgv(['up', '-d']).join(' ')).toBe(
      'docker compose -f base.compose.yml -f prod.compose.yml -f vps.compose.yml up -d',
    );
  });

  it('runs from the compose file directory', () => {
    // The relative build contexts (`../..`, `../nginx`) resolve against the
    // compose file's directory, so the working directory is not incidental.
    expect(composeCwd('/opt/infra/apps/demo')).toBe('/opt/infra/apps/demo/repo/infra/compose');
  });
});

describe('secretsFrom', () => {
  it('picks out exactly the values the journal must redact', () => {
    const env = new Map([
      ['POSTGRES_PASSWORD', 'p4ssword'],
      ['JWT_SECRET', 'jwt-secret-value'],
      ['POSTGRES_HOST', 'db.internal'],
      ['APP_URL', 'https://app.example.test'],
    ]);

    const secrets = secretsFrom(env).map((entry) => entry.key).sort();

    // Driven by the metadata registry rather than by a second guess at which
    // keys are sensitive.
    expect(secrets).toEqual(['JWT_SECRET', 'POSTGRES_PASSWORD']);
  });
});

describe('defaultRootFor', () => {
  it('derives the directory from the repository name, never a fixed one', () => {
    expect(defaultRootFor('https://example.test/o/MyApp.git', '/opt/infra/apps')).toBe(
      '/opt/infra/apps/myapp',
    );
  });
});
