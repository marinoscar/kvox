import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_NAME } from '../branding.js';
import { PreconditionError, UsageError } from '../errors.js';
import { CLI_VERSION } from '../package-info.js';
import { deployInfoDir, deployInfoPath, readDeployInfo } from './deploy-info.js';
import { composeEnvPath, envFilePath } from './env-file.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from './executor.js';
import {
  buildInstallSteps,
  composeArgv,
  composeCwd,
  defaultRootFor,
  runInstall,
  secretsFrom,
  type InstallOptions,
} from './install.js';
import { DEPLOY_STATE_VERSION, readState, writeState, type DeployState } from './state.js';
import {
  FAKE_APP_VERSION,
  fakeVps,
  healthyFetch,
  populateClone,
  silentPrompt,
  type FakeVps,
} from './testing/fake-vps.js';

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
      'auth',
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

  it('authenticates with gh after the preflight and before the clone', () => {
    // A logged-out gh has to stop the run with the login command in hand,
    // not as git's own "Authentication failed" halfway into the clone.
    expect(ids.indexOf('preflight')).toBeLessThan(ids.indexOf('auth'));
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('checkout'));
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

  it('honours --skip-doctor, --skip-proxy, --skip-seed and --skip-github', () => {
    expect(skipReasonFor('preflight', { skipDoctor: true })).toContain('--skip-doctor');
    expect(skipReasonFor('seed', { skipSeed: true })).toContain('--skip-seed');
    expect(skipReasonFor('publish', { skipProxy: true, domain: 'x' })).toContain('--skip-proxy');
    expect(skipReasonFor('auth', { skipGithub: true, repo: 'https://github.com/acme/widgets' })).toContain('--skip-github');
  });

  it('stands the auth step down for a remote that is not on GitHub', () => {
    // Another forge, or CI's file:// remote, is deployed with plain git and
    // gh is never consulted - a fact about the fork, not a failure.
    expect(skipReasonFor('auth', { repo: 'https://example.test/o/r.git' })).toBe('not a GitHub remote');
    expect(skipReasonFor('auth', { repo: 'file:///srv/git/r.git' })).toBe('not a GitHub remote');
    expect(skipReasonFor('auth', { repo: 'git@github.com:acme/widgets.git' })).toBeUndefined();
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

  // --- --skip-github reaches the checks, not only the `auth` step (#133) ----
  //
  // Every CI runner has `gh` installed and nobody logged into it, so
  // `gh-authenticated` - a REQUIRED check - fails there. The flag that is
  // supposed to make this pipeline runnable against a `file://` remote has to
  // cover the preflight too, or it covers only half of what it claims: the
  // `auth` step stands down, the preflight refuses, and the install never
  // starts. These two tests pin both halves.
  describe('--skip-github', () => {
    /** The same box, with `gh` present and nobody logged into it. */
    const loggedOutRunCommand = (async (
      argv: readonly string[],
      options: RunCommandOptions,
    ): Promise<CommandResult> => {
      if (argv.join(' ').startsWith('gh auth status')) {
        const result: CommandResult = {
          argv: [...argv],
          cwd: options.cwd,
          exitCode: 1,
          stdout: '',
          stderr: 'You are not logged into any GitHub hosts.',
          durationMs: 1,
          timedOut: false,
        };
        throw new CommandFailedError(result.stderr, result);
      }
      return await noProxyRunCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    function loggedOutContext(options: Record<string, unknown>, lines: string[]) {
      const context = preflightContext(options, lines) as {
        runCommand: typeof import('./executor.js').runCommand;
      };
      context.runCommand = loggedOutRunCommand;
      return context as never;
    }

    it('reports the gh checks as skipped rather than failing them', async () => {
      const lines: string[] = [];

      await expect(
        preflight.run(loggedOutContext({ skipProxy: true, skipGithub: true }, lines)),
      ).resolves.toBeUndefined();

      expect(lines).toContain('skip gh-installed: --skip-github');
      expect(lines).toContain('skip gh-authenticated: --skip-github');
      expect(lines).toContain('skip gh-repo-access: --skip-github');
      expect(lines.some((line) => line.startsWith('fail '))).toBe(false);
    });

    it('fails on a logged-out gh without the flag', async () => {
      const lines: string[] = [];

      const error = await preflight
        .run(loggedOutContext({ skipProxy: true }, lines))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionError);
      expect((error as Error).message).toContain('gh-authenticated');
    });
  });
});

describe('the auth step', () => {
  function authStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'auth');
    if (step === undefined) throw new Error('no auth step');
    return step;
  }

  function contextFor(repo: string, respond: (argv: readonly string[]) => { exitCode: number; stderr?: string }) {
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
      options: { deployRoot: mkdtempSync(join(tmpdir(), 'appctl-auth-')), name: 'x', appsRoot: '/tmp', repo, ref: 'main' },
      runCommand,
      journal: { line: (line: string) => void lines.push(line) },
      completed: new Set<string>(),
    };
    return { context: context as never, seen, lines };
  }

  it('checks the login and hands git the token, in that order', async () => {
    const { context, seen, lines } = contextFor('git@github.com:acme/widgets.git', () => ({ exitCode: 0 }));

    await authStep().run(context);

    expect(seen).toEqual([
      ['gh', 'auth', 'status'],
      ['gh', 'auth', 'setup-git', '--hostname', 'github.com'],
    ]);
    expect(lines.some((line) => line.includes('acme/widgets'))).toBe(true);
  });

  it('stops on a precondition, with the login command, when gh is logged out', async () => {
    const { context, seen } = contextFor('https://github.com/acme/widgets', (argv) =>
      argv[2] === 'status' ? { exitCode: 1, stderr: 'You are not logged in to any GitHub hosts.' } : { exitCode: 0 },
    );

    const error = await authStep().run(context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('gh auth login');
    // Nothing else ran: no setup-git, and certainly no clone.
    expect(seen).toEqual([['gh', 'auth', 'status']]);
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

describe('the start step (#257)', () => {
  function startStep() {
    const step = buildInstallSteps().find((candidate) => candidate.id === 'start');
    if (step === undefined) throw new Error('no start step');
    return step;
  }

  /**
   * A command table answering the docker port query, plus the compose call the
   * step makes afterwards. `inspect` is what decides the outcome; `up -d` is
   * recorded so a test can prove the stack was NOT started.
   */
  function startContext(options: {
    inspect: string;
    dockerFails?: boolean;
    portFree?: boolean;
    name?: string;
  }) {
    const seen: string[][] = [];
    const lines: string[] = [];
    const runCommand = (async (
      argv: readonly string[],
      runOptions: RunCommandOptions,
    ): Promise<CommandResult> => {
      seen.push([...argv]);
      const line = argv.join(' ');
      const result: CommandResult = {
        argv: [...argv],
        cwd: runOptions.cwd,
        exitCode: 0,
        stdout: line.startsWith('docker ps')
          ? 'aaaaaaaaaaaa\n'
          : line.startsWith('docker inspect')
            ? options.inspect
            : '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      };
      if (options.dockerFails === true && line.startsWith('docker ps')) {
        throw new CommandFailedError('Cannot connect to the Docker daemon', {
          ...result,
          exitCode: 1,
        });
      }
      return result;
    }) as typeof import('./executor.js').runCommand;

    return {
      context: {
        options: {
          deployRoot: '/tmp/x',
          name: options.name ?? 'demo',
          appsRoot: '/tmp',
          bindPort: 3535,
          proxyRoot: '/tmp/proxy',
          portFree: async () => options.portFree ?? true,
        },
        runCommand,
        journal: {
          line: (line: string) => void lines.push(line),
          command: () => undefined,
          redact: (value: string) => value,
        },
        completed: new Set<string>(),
      } as never,
      seen,
      lines,
    };
  }

  function started(seen: readonly (readonly string[])[]): boolean {
    return seen.some((argv) => argv.includes('up') && argv.includes('-d'));
  }

  it('starts the stack when the port is still free', async () => {
    const { context, seen } = startContext({ inspect: '/unrelated||9000\n' });

    await startStep().run(context);

    expect(started(seen)).toBe(true);
  });

  it('refuses when a foreign container took the port during the build, naming it', async () => {
    // The four-minute window this whole check exists for: free when chosen,
    // taken by the time it is used.
    const { context, seen } = startContext({ inspect: '/pgadmin|tools|3535\n' });

    const error = await startStep()
      .run(context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('3535');
    expect((error as Error).message).toContain('pgadmin');
    // The remedy, not a silently different port: DNS may already point here.
    expect((error as Error).message).toContain('--answer APP_BIND_PORT=');
    expect(started(seen)).toBe(false);
  });

  it('refuses for a STOPPED foreign container too, which `up -d` would have taken', async () => {
    // `up -d` would succeed against a stopped container's port and break that
    // application the next time somebody started it. This is the whole issue.
    const { context, seen } = startContext({
      inspect: '/pgadmin|tools|3535\n',
      portFree: true,
    });

    await expect(startStep().run(context)).rejects.toBeInstanceOf(UsageError);
    expect(started(seen)).toBe(false);
  });

  it("PROCEEDS when this deployment's own container holds the port: the --resume case", async () => {
    // A `--resume` after a failed health step finds this deployment's own nginx
    // still bound to the port, which `up -d` is about to recreate. Refusing
    // here would make the resume path impossible, which is the regression
    // this check is most likely to cause.
    const { context, seen, lines } = startContext({
      inspect: '/demo-nginx-1|demo|3535\n',
      // Our own container IS listening, so the bind probe says "not free" -
      // and must not be consulted once we know the holder is ours.
      portFree: false,
      name: 'demo',
    });

    await startStep().run(context);

    expect(started(seen)).toBe(true);
    expect(lines.join('\n')).toContain('demo-nginx-1');
  });

  it('refuses when something that is not a container is listening', async () => {
    const { context, seen } = startContext({ inspect: '/unrelated||9000\n', portFree: false });

    const error = await startStep()
      .run(context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('3535');
    expect(started(seen)).toBe(false);
  });

  it('starts anyway when docker cannot be asked', async () => {
    // The next line runs docker; this check must not be what makes docker a
    // hard requirement of a step that already needs it.
    const { context, seen } = startContext({ inspect: '', dockerFails: true });

    await startStep().run(context);

    expect(started(seen)).toBe(true);
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

// =============================================================================
// Issue #249: `--resume` must refuse rather than silently start a fresh
// install when it finds no state at the resolved deploy root.
//
// The deploy root is resolved BEFORE any state is read (see the comment above
// the guard in install.ts), so without --repo/--name/--root it is only a
// GUESS at the repository the operator meant - and a --resume that "resumed"
// against that guess was the actual bug: it silently started a brand-new
// install and the only visible symptom was an EACCES on an unfamiliar
// directory.
// =============================================================================
describe('runInstall --resume without state (#249)', () => {
  /** A runCommand stub for the ambient-git-checkout ("guessed") case. */
  function stubOriginRunCommand(originUrl: string, branch: string) {
    return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      const stdout =
        argv[1] === 'remote' ? originUrl : argv[1] === 'rev-parse' && argv[2] === '--abbrev-ref' ? branch : '';
      return { argv: [...argv], cwd: options.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
    }) as typeof import('./executor.js').runCommand;
  }

  it('throws UsageError and creates nothing when no state exists at the resolved root', async () => {
    // A path under a fresh temp dir that has never been created - the load-
    // bearing assertion below is that it STAYS that way. The old behaviour's
    // first act on this exact input was `mkdirSync`.
    const parent = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    const root = join(parent, 'fresh');

    const error = await runInstall({
      deployRoot: root,
      resume: true,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('Nothing to resume');
    // Names the deploy root that was searched.
    expect((error as Error).message).toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it('does not fire on an ordinary first install: no --resume, no state', async () => {
    // Same shape as the case above (a deploy root that does not exist yet),
    // but without --resume. This is the "not too broad" check: a guard that
    // fired here would refuse every brand-new install.
    const parent = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    const root = join(parent, 'fresh');

    const error = await runInstall({
      deployRoot: root,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    // Whatever stopped the (stubbed, command-less) pipeline next, it was not
    // the resume guard - proven by the one thing only past-the-guard code
    // does: `mkdirSync(options.deployRoot)`.
    expect(existsSync(root)).toBe(true);
    expect(error).not.toBeInstanceOf(UsageError);
  });

  it('says the layout was GUESSED when it came from the ambient git checkout', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'appctl-install-guess-'));
    const appsRoot = join(tmp, 'infra', 'apps');
    const app = join(tmp, 'elsewhere', 'app');
    mkdirSync(app, { recursive: true });
    mkdirSync(join(app, '.git'), { recursive: true });

    const error = await runInstall({
      appsRoot,
      cwd: app,
      runCommand: stubOriginRunCommand('https://example.test/o/guessedapp.git', 'main'),
      resume: true,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('GUESSED from the git checkout');
  });

  it('does not claim a guess when --name named the deployment', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-apps-'));

    const error = await runInstall({
      appsRoot,
      name: 'custom',
      resume: true,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).not.toMatch(/guess/i);
    expect((error as Error).message).toContain('taken from --name/--root');
  });

  it('does not claim a guess when --root named the deployment', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    const root = join(parent, 'fresh');

    const error = await runInstall({
      deployRoot: root,
      resume: true,
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).not.toMatch(/guess/i);
    expect((error as Error).message).toContain('taken from --name/--root');
  });

  it('says the layout was derived from --repo when that flag named the repository', async () => {
    const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-apps-'));

    const error = await runInstall({
      appsRoot,
      repo: 'https://example.test/o/flagged.git',
      ref: 'main',
      resume: true,
      // Never called: an explicit --repo (with --ref, so no default-ref
      // lookup either) resolves the target with no command at all.
      runCommand: neverRun,
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
      domain: 'app.example.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('derived from --repo');
  });

  // Together, the four assertions above exercise three of
  // `describeLayoutSource`'s four distinct, non-empty wordings - 'derived
  // from --repo', 'GUESSED from the git checkout...' and 'taken from
  // --name/--root' - and prove they really are distinguishable (no two share
  // a substring the others lack, e.g. only the guess uses "guess" at all).
  // The fourth wording, 'taken from an existing deployment state', is
  // produced only when `resolveRepoTarget` is called with a `state` option -
  // which `runInstall` never does (`resolveInstallLayout` and `resolveTarget`
  // in install.ts pass only `cwd`/`appsRoot`/`runCommand`/`repoFlag`/
  // `refFlag`). That branch is unreachable through the public `runInstall`
  // entry point and `describeLayoutSource` itself is not exported, so it is
  // not covered here - covering it would require a source change, and this
  // pass is test-files-only.
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

// =============================================================================
// The pipeline end to end, against a fake VPS  (issue #120)
// =============================================================================

describe('runInstall against a fake VPS', () => {
  let vps: FakeVps;

  beforeEach(async () => {
    vps = await fakeVps({ remoteSha: 'c'.repeat(40) });
    vi.stubGlobal('fetch', healthyFetch());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await vps.close();
  });

  function install(root: string, extra: Partial<InstallOptions> = {}) {
    return runInstall({
      deployRoot: root,
      name: 'demo',
      bindPort: 3535,
      proxyRoot: join(root, 'proxy'),
      domain: 'app.example.test',
      repo: 'https://example.test/o/demo.git',
      ref: 'main',
      runCommand: vps.runCommand,
      cwd: root,
      nonInteractive: true,
      answers: vps.answers(),
      promptContext: silentPrompt(),
      skipDoctor: true,
      skipProxy: true,
      skipSeed: true,
      ...extra,
    });
  }

  // ===========================================================================
  // Issue #156: the live stream is redacted, not only the journal
  // ===========================================================================
  //
  // The structural half of the fix. `executor.ts` masks a line as it is
  // assembled, which only helps if the redactor REACHES `runCommand` - so the
  // guard is stated the way the invariant is: no call may wire `onLine`
  // without also passing `redact`. A future step that forwards `onLog` and
  // forgets the redactor fails here rather than leaking on somebody's screen.
  it('never wires onLine without a redactor, and the redactor is this run\'s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    const streamed: RunCommandOptions[] = [];

    const watching = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      if (options.onLine !== undefined) streamed.push(options);
      return await vps.runCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    // Hooks, or `onLine` is never wired at all and the assertion is vacuous.
    await install(root, { runCommand: watching, hooks: { onLog: () => undefined } });

    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.filter((options) => options.redact === undefined)).toEqual([]);

    // And it is the JOURNAL's redactor, seeded with the secrets this install
    // generated - not an identity function that satisfies the check above.
    const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(readFileSync(envFilePath(root), 'utf8'))?.[1];
    expect(password).toBeTruthy();
    for (const options of streamed) {
      expect(options.redact?.(`psql://u:${password as string}@db`)).not.toContain(password);
    }
  });

  it('writes .env at the app root, 0600, and links it into the clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));

    const result = await install(root);

    expect(result.commitSha).toBe('c'.repeat(40));
    const env = envFilePath(root);
    expect(env).toBe(join(root, '.env'));
    expect(statSync(env).mode & 0o777).toBe(0o600);

    const link = composeEnvPath(root);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../../.env');
    // Compose reads through the link and sees the same file.
    expect(readFileSync(link, 'utf8')).toBe(readFileSync(env, 'utf8'));

    const contents = readFileSync(env, 'utf8');
    expect(contents).toContain('COMPOSE_PROJECT_NAME=demo');
    expect(contents).toContain(`DEPLOY_ROOT=${root}`);
    expect(contents).toContain(`POSTGRES_PORT=${vps.dbPort}`);
    expect(readState(root)?.envPath).toBe(env);
  });

  it('migrates a pre-#120 .env found inside the clone on --reinstall', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    // An earlier install: a clone at some SHA, its .env a regular file inside
    // it, and a state file - which is what makes this a reinstall.
    populateClone(join(root, 'repo'));
    vps.head = 'a'.repeat(40);
    writeFileSync(composeEnvPath(root), 'POSTGRES_PASSWORD=from-before\n', { mode: 0o600 });
    installedRoot(root);
    const progress: string[] = [];

    await install(root, { reinstall: true, hooks: { onProgress: (message) => void progress.push(message) } });

    expect(lstatSync(composeEnvPath(root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(composeEnvPath(root))).toBe('../../../.env');
    expect(statSync(envFilePath(root)).mode & 0o777).toBe(0o600);
    // The wizard ran over the migrated file: an answer wins over what was on
    // disk, and the result landed at the root.
    expect(readFileSync(envFilePath(root), 'utf8')).toContain('POSTGRES_PASSWORD=not-the-default-password');
    expect(progress.some((message) => message.includes('Moved .env'))).toBe(true);
  });

  it('verifies the database inside the wizard and follows the port it chose (issue #127)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));

    const result = await install(root, {
      // No APP_BIND_PORT answer and a port the wizard is free to overrule.
      answers: new Map([...vps.answers()].filter(([key]) => key !== 'APP_BIND_PORT')),
      bindPort: 3535,
    });

    // The database step ran its checks against the typed values, before the
    // separate validate-environment step, and journaled them.
    const journal = readFileSync(result.journalPath, 'utf8');
    expect(journal).toContain('pass database-reachable');
    expect(journal).toContain('pass database-credentials');
    // Whatever port the wizard settled on is the one the state records and
    // the one written to .env: the pipeline follows the wizard, not the flag.
    const env = readFileSync(envFilePath(root), 'utf8');
    const written = /^APP_BIND_PORT=(\d+)$/m.exec(env)?.[1];
    expect(written).toBeDefined();
    expect(readState(root)?.bindPort).toBe(Number(written));
  });

  it('refuses an unattended install whose database check fails, naming the check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    vps.failWhen(
      (argv) => argv[0] === 'docker' && argv[1] === 'run' && argv.includes('psql'),
      'psql: error: connection to server failed: FATAL: password authentication failed for user "app" (28P01)',
    );

    const error = await install(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('database-credentials');
    expect((error as Error).message).toContain('password authentication failed');
    // Nothing was built; the failure came from the environment step itself.
    expect(vps.seen.some((argv) => argv[1] === 'compose' && argv.includes('build'))).toBe(false);
  });

  it('writes deploy-info/info.json with schema 1 and installedAt equal to updatedAt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));

    await install(root);

    const path = deployInfoPath(root);
    expect(path).toBe(join(root, 'deploy-info', 'info.json'));
    expect(statSync(path).mode & 0o777).toBe(0o644);

    const state = readState(root) as DeployState;
    const info = readDeployInfo(root);
    expect(info).toMatchObject({
      schema: 1,
      app: {
        name: 'demo',
        version: FAKE_APP_VERSION,
        commitSha: 'c'.repeat(40),
        ref: 'main',
        repoUrl: 'https://example.test/o/demo',
      },
      installedAt: state.installedAt,
      updatedAt: state.lastDeployedAt,
      lastCommand: 'install',
      deployedBy: { cli: CLI_NAME, version: CLI_VERSION },
      domain: 'app.example.test',
      bindPort: 3535,
      host: {
        dockerVersion: '27.3.1',
        composeVersion: '2.29.7',
        diskBytes: 78125000 * 1024,
        nodeVersion: process.version.replace(/^v/, ''),
      },
      remote: null,
    });
    // A first install: one moment, recorded twice.
    expect(info?.installedAt).toBe(info?.updatedAt);
    expect(info?.installedAt).toMatch(/Z$/);
    expect(info?.updatedAt).toMatch(/Z$/);
    // And nothing secret made it in.
    expect(readFileSync(path, 'utf8')).not.toContain('not-the-default-password');
  });

  it('creates deploy-info before the stack starts, not after (#133)', async () => {
    // The Docker daemon creates a missing bind-mount source as root:root, and
    // `vps.compose.yml` mounts `<root>/deploy-info` into the api container. If
    // the `start` step gets there first, the epilogue's writeDeployInfo fails
    // with EACCES on its temp file for any operator who is not root - every
    // step green, the install dead on its last line. Existence alone is not
    // the assertion: the ORDER is.
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    const dir = deployInfoDir(root);
    let existedAtStart: boolean | undefined;
    const watching = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      if (argv[0] === 'docker' && argv[1] === 'compose' && argv.includes('up') && argv.includes('-d')) {
        existedAtStart ??= existsSync(dir);
      }
      return await vps.runCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    await install(root, { runCommand: watching });

    // The `start` step really did run - otherwise the flag proves nothing.
    expect(existedAtStart).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('consults gh before cloning a GitHub remote, and never for another forge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));

    await install(root, { repo: 'git@github.com:acme/demo.git' });

    const commands = vps.seen.map((argv) => argv.slice(0, 3).join(' '));
    const status = commands.indexOf('gh auth status');
    const setup = commands.indexOf('gh auth setup-git');
    const clone = commands.indexOf('git clone --no-checkout');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(setup).toBeGreaterThan(status);
    expect(clone).toBeGreaterThan(setup);
    // And the clone went over https, whatever scheme the operator typed.
    expect(vps.seen[clone]?.[3]).toBe('https://github.com/acme/demo.git');
    expect(readState(root)?.repoUrl).toBe('https://github.com/acme/demo.git');

    const other = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    vps.seen.length = 0;
    await install(other);
    expect(vps.seen.some((argv) => argv[0] === 'gh')).toBe(false);
  });

  it('exits 6 with nothing cloned when gh is logged out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    vps.failWhen((argv) => argv[0] === 'gh' && argv[2] === 'status', 'You are not logged in to any GitHub hosts.');

    const error = await install(root, { repo: 'https://github.com/acme/demo' }).catch((caught: unknown) => caught);

    // The acceptance criterion: the auth step, exit code 6, the remedy, and
    // no clone - not a generic failure after git prompted for a password.
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('Authenticate with GitHub failed');
    expect((error as Error).message).toContain('gh auth login');
    expect(vps.seen.some((argv) => argv[0] === 'git' && argv[1] === 'clone')).toBe(false);
    expect(existsSync(join(root, 'repo'))).toBe(false);
    expect(readState(root)).toBeUndefined();
  });

  it('writes deploy-info only after the state, so a failed install leaves neither', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    vps.failWhen((argv) => argv[1] === 'compose' && argv.includes('build'), 'build exploded');

    const error = await install(root).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('build exploded');
    expect(readState(root)).toBeUndefined();
    expect(readDeployInfo(root)).toBeUndefined();
  });

  // ===========================================================================
  // Issue #249: --resume must still work when it finds real state to resume
  // ===========================================================================
  //
  // The new guard only fires when `--resume` finds NO state. This is the other
  // half of that condition: a `--resume` that DOES find a valid state must
  // keep working exactly as before - the fix must not become a second way to
  // block an ordinary resume.
  it('still resumes when --resume is given and a valid state exists at the deploy root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-install-'));
    installedRoot(root);

    const result = await install(root, { resume: true });

    expect(result.commitSha).toBe('c'.repeat(40));
    expect(readState(root)?.lastCommand).toBe('install');
  });
});
