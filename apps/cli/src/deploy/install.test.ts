import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
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

function installedRoot(root = mkdtempSync(join(tmpdir(), 'appctl-install-'))): string {
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

/** Never reached by the tests below; the precondition fires first. */
const neverRun = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
  throw new Error(`unexpected command: ${argv.join(' ')} in ${options.cwd}`);
}) as typeof import('./executor.js').runCommand;

describe('the install pipeline', () => {
  const steps = buildInstallSteps();
  const ids = steps.map((step) => step.id);

  it('runs the steps in an order the deployment actually requires', () => {
    expect(ids).toEqual([
      'preflight',
      'network',
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

  it('ensures the devnet network after preflight and before building', () => {
    // base.compose.yml declares it external; `up -d` fails without it.
    expect(ids.indexOf('preflight')).toBeLessThan(ids.indexOf('network'));
    expect(ids.indexOf('network')).toBeLessThan(ids.indexOf('build'));
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

describe('the network step', () => {
  function networkStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'network');
    if (step === undefined) throw new Error('no network step');
    return step;
  }

  function contextFor(respond: (argv: readonly string[]) => { exitCode: number; stderr?: string }) {
    const seen: string[][] = [];
    const lines: string[] = [];
    const runCommand = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      seen.push([...argv]);
      const canned = respond(argv);
      const result: CommandResult = {
        argv: [...argv],
        cwd: options.cwd,
        exitCode: canned.exitCode,
        stdout: '',
        stderr: canned.stderr ?? '',
        durationMs: 1,
        timedOut: false,
      };
      if (result.exitCode !== 0) throw new CommandFailedError(result.stderr, result);
      return result;
    }) as typeof import('./executor.js').runCommand;

    const context = {
      options: { deployRoot: '/tmp/x', name: 'x', appsRoot: '/tmp' },
      runCommand,
      journal: {
        redact: (text: string) => text,
        command: () => undefined,
        line: (line: string) => void lines.push(line),
      },
      completed: new Set<string>(),
    };
    return { context: context as never, seen, lines };
  }

  it('is a no-op when the network already exists', async () => {
    const { context, seen } = contextFor(() => ({ exitCode: 0 }));

    await networkStep().run(context);

    expect(seen).toEqual([['docker', 'network', 'inspect', 'devnet']]);
  });

  it('creates the network when inspect says it is missing', async () => {
    const { context, seen } = contextFor((argv) =>
      argv[2] === 'inspect' ? { exitCode: 1, stderr: 'No such network: devnet' } : { exitCode: 0 },
    );

    await networkStep().run(context);

    expect(seen).toEqual([
      ['docker', 'network', 'inspect', 'devnet'],
      ['docker', 'network', 'create', 'devnet'],
    ]);
  });

  it('is excluded from the preflight, which would otherwise refuse the install that creates it', async () => {
    const preflight = buildInstallSteps().find((candidate) => candidate.id === 'preflight');
    const seen: string[][] = [];
    const runCommand = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      seen.push([...argv]);
      return { argv: [...argv], cwd: options.cwd, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
    }) as typeof import('./executor.js').runCommand;

    await preflight?.run({
      options: { deployRoot: '/tmp/x', name: 'x', appsRoot: '/tmp', bindPort: 3535, proxyRoot: '/tmp/proxy' },
      runCommand,
      journal: { line: () => undefined },
      completed: new Set<string>(),
    } as never).catch(() => undefined);

    expect(seen.some((argv) => argv.join(' ').startsWith('docker network inspect'))).toBe(false);
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

describe('runInstall layout resolution', () => {
  // Each case installs a state file where the resolved root SHOULD be and
  // relies on the existing-deployment refusal to name it, which proves the
  // resolution without running a single pipeline step.
  it('deploys to <apps-root>/<repository name> by default', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-apps-'));
    installedRoot(join(appsRoot, 'myapp'));

    const error = await runInstall({
      appsRoot,
      repo: 'https://example.test/o/MyApp.git',
      ref: 'main',
      cwd: appsRoot,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain(join(appsRoot, 'myapp'));
  });

  it('lets --name choose the folder under the apps root', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-apps-'));
    installedRoot(join(appsRoot, 'custom'));

    const error = await runInstall({
      appsRoot,
      name: 'custom',
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(join(appsRoot, 'custom'));
  });

  it('lets --root override the whole path, ignoring the apps root', async () => {
    const root = installedRoot();

    const error = await runInstall({
      appsRoot: '/nowhere',
      deployRoot: root,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(root);
    expect((error as Error).message).not.toContain('/nowhere');
  });
});

describe('compose invocation', () => {
  it('pins the project name and layers base, prod and vps in that order', () => {
    // `-p <name>` keeps two apps on one box from sharing the project `compose`
    // and replacing each other's containers (#119). vps.compose.yml must come
    // last: its `!override` on ports only replaces what the earlier files
    // declared if it is applied after them.
    expect(composeArgv('demo', ['up', '-d']).join(' ')).toBe(
      'docker compose -p demo -f base.compose.yml -f prod.compose.yml -f vps.compose.yml up -d',
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
