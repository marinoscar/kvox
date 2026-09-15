import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../branding.js';
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
    // Recommended, but run here anyway: its answer decides whether the vhost
    // binds [::] (#125).
    expect(lines).toContain('skip proxy-ipv6: --skip-proxy');
    expect(lines.some((line) => line.startsWith('fail '))).toBe(false);
  });

  it('fails on the missing proxy without the flag', async () => {
    const lines: string[] = [];

    const error = await preflight.run(preflightContext({}, lines)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('proxy-root');
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

describe('the publish step', () => {
  function publishStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'publish');
    if (step === undefined) throw new Error('no publish step');
    return step;
  }

  function proxyRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'appctl-publish-proxy-'));
    mkdirSync(join(root, 'nginx', 'conf.d'), { recursive: true });
    mkdirSync(join(root, 'webroot'), { recursive: true });
    return root;
  }

  function writeCertificate(root: string): void {
    const live = join(root, 'letsencrypt', 'live', 'app.example.test');
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'fullchain.pem'), 'cert');
  }

  /** Serves the self-probe's nonce out of the proxy's own webroot. */
  function routedFetch(root: string): typeof globalThis.fetch {
    return (async (input: string | URL | Request) => {
      const file = join(root, 'webroot', new URL(String(input)).pathname);
      return existsSync(file) ? new Response(readFileSync(file, 'utf8')) : new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
  }

  function contextFor(
    root: string,
    options: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ) {
    const seen: string[][] = [];
    const lines: string[] = [];
    const runCommand = (async (argv: readonly string[], runOptions: RunCommandOptions): Promise<CommandResult> => {
      seen.push([...argv]);
      return { argv: [...argv], cwd: runOptions.cwd, exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
    }) as typeof import('./executor.js').runCommand;

    const cronDir = mkdtempSync(join(tmpdir(), 'appctl-publish-cron-'));
    return {
      context: {
        options: {
          deployRoot: '/tmp/x',
          name: 'demo',
          appsRoot: '/tmp',
          bindPort: 3535,
          proxyRoot: root,
          domain: 'app.example.test',
          email: 'admin@example.test',
          fetch: routedFetch(root),
          cliPath: '/usr/local/bin/cli',
          cronDir,
          ...options,
        },
        runCommand,
        journal: { line: (line: string) => void lines.push(line) },
        completed: new Set<string>(),
        ...context,
      } as never,
      seen,
      lines,
      cronDir,
    };
  }

  it('issues through docker certbot, then validates and reloads through docker exec on the detected container', async () => {
    const root = proxyRoot();
    const { context, seen } = contextFor(root, {}, { proxyContainer: 'edge-proxy' });

    await publishStep().run(context);

    expect(seen.map((argv) => argv.slice(0, 3).join(' '))).toEqual([
      'docker run --rm',
      'docker exec edge-proxy',
      'docker exec edge-proxy',
    ]);
    expect(seen[0]).toContain('certbot/certbot');
    expect(seen[1]?.slice(3)).toEqual(['nginx', '-t']);
    expect(seen[2]?.slice(3)).toEqual(['nginx', '-s', 'reload']);
  });

  it('prefers --proxy-container over the detected one, and falls back to the conventional name', async () => {
    const flagged = contextFor(proxyRoot(), { proxyContainer: 'named' }, { proxyContainer: 'detected' });
    await publishStep().run(flagged.context);
    expect(flagged.seen[1]?.[2]).toBe('named');

    const bare = contextFor(proxyRoot(), {});
    await publishStep().run(bare.context);
    expect(bare.seen[1]?.[2]).toBe('proxy-nginx');
  });

  it('writes the vhost with container paths, the upload limit from the environment, and no [::] when IPv6 is off', async () => {
    const root = proxyRoot();
    const { context } = contextFor(
      root,
      {},
      { env: new Map([['MAX_FILE_SIZE', String(2 * 1024 * 1024 * 1024)]]), ipv6: false, proxyContainer: 'p' },
    );

    await publishStep().run(context);

    const vhost = readFileSync(join(root, 'nginx', 'conf.d', 'app.example.test.conf'), 'utf8');
    expect(vhost).toContain('root /var/www/certbot;');
    expect(vhost).toContain('ssl_certificate     /etc/letsencrypt/live/app.example.test/fullchain.pem;');
    expect(vhost).not.toContain(root);
    expect(vhost).toContain('client_max_body_size 2048m;');
    expect(vhost).not.toContain('[::]');
  });

  it('lets --no-ipv6 override a probe that found IPv6', async () => {
    const root = proxyRoot();
    const { context } = contextFor(root, { ipv6: false }, { ipv6: true, proxyContainer: 'p' });

    await publishStep().run(context);

    expect(readFileSync(join(root, 'nginx', 'conf.d', 'app.example.test.conf'), 'utf8')).not.toContain('[::]');
  });

  it('fails at the self-probe, before certbot, when the domain does not route here', async () => {
    const root = proxyRoot();
    const { context, seen } = contextFor(root, {
      fetch: (async () => new Response('somebody else', { status: 200 })) as typeof globalThis.fetch,
    });

    const error = await publishStep().run(context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('app.example.test');
    expect(seen).toEqual([]);
    expect(existsSync(join(root, 'nginx', 'conf.d', 'app.example.test.conf'))).toBe(false);
  });

  it('installs the renewal cron when it issued a certificate', async () => {
    const root = proxyRoot();
    const { context, cronDir } = contextFor(root, {});

    await publishStep().run(context);

    expect(readdirSync(cronDir)).toEqual([`${CLI_NAME}-certs-demo`]);
    const cron = readFileSync(join(cronDir, `${CLI_NAME}-certs-demo`), 'utf8');
    expect(cron).toContain('/usr/local/bin/cli deploy certs renew --all --apps-root /tmp --name demo');
  });

  it('leaves the cron alone when the certificate already existed, unless --install-cron', async () => {
    const existing = proxyRoot();
    writeCertificate(existing);
    const kept = contextFor(existing, {});
    await publishStep().run(kept.context);
    // No certbot run either: the certificate was already there.
    expect(kept.seen.some((argv) => argv.includes('certbot/certbot'))).toBe(false);
    expect(readdirSync(kept.cronDir)).toEqual([]);

    const forced = proxyRoot();
    writeCertificate(forced);
    const written = contextFor(forced, { installCron: true });
    await publishStep().run(written.context);
    expect(readdirSync(written.cronDir)).toEqual([`${CLI_NAME}-certs-demo`]);
  });

  it('honours --no-install-cron even when it issued a certificate', async () => {
    const { context, cronDir } = contextFor(proxyRoot(), { installCron: false });

    await publishStep().run(context);

    expect(readdirSync(cronDir)).toEqual([]);
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
