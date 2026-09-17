import {
  chmodSync as chmodSyncFs,
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
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreconditionError } from '../errors.js';
import { DeployInfoError, deployInfoDir, readDeployInfo, writeDeployInfo } from './deploy-info.js';
import { composeEnvPath, envFilePath, writeEnvFile } from './env-file.js';
import type { CommandResult, RunCommandOptions } from './executor.js';
import { unknownServerFacts } from './server-facts.js';
import { DEPLOY_STATE_VERSION, NotInstalledError, deployStatePath, readState, writeState, type DeployState } from './state.js';
import {
  FAKE_APP_VERSION,
  FAKE_COMMITS,
  fakeVps,
  healthyFetch,
  populateClone,
  silentPrompt,
  type FakeVps,
} from './testing/fake-vps.js';
import {
  RENEW_WITHIN_DAYS,
  buildUpdateSteps,
  certificateDueForRenewal,
  renderUpdateCheck,
  runUpdate,
  type UpdateCheck,
} from './update.js';

// =============================================================================
// One mocked call, for one test (#159)
// =============================================================================
//
// A `deploy-info` the Docker daemon created as root:root, which a non-root
// `update` can neither chmod nor write into, cannot be staged for real: this
// suite runs as whatever user CI gives it (the `deploy-e2e` job runs as an
// unprivileged one, which is how this class of failure became visible at
// all), and a test needing two uids would be skipped exactly where it
// matters. So `chmodSync` is failed at the seam, and only for the one path a
// test names - everything else passes through via `importOriginal`.
// =============================================================================

let chmodShouldFailFor: string | undefined;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      const target = String(args[0]);
      if (chmodShouldFailFor !== undefined && target.endsWith(chmodShouldFailFor)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${target}'`), {
          code: 'EPERM',
        });
      }
      return actual.chmodSync(...args);
    },
  };
});

describe('the update pipeline', () => {
  const steps = buildUpdateSteps();
  const ids = steps.map((step) => step.id);

  it('looks for a new revision before it changes anything', () => {
    expect(ids).toEqual([
      'preflight',
      'auth',
      'fetch',
      'environment-drift',
      'build',
      'migrate',
      'seed',
      'restart',
      'health',
      'publish',
      'verify',
    ]);
  });

  function skipReason(id: string, context: Record<string, unknown>): string | undefined {
    return steps.find((step) => step.id === id)?.skip?.(context as never);
  }

  it('stands every later step down when the revision has not moved', () => {
    // Several minutes of build and a restart for a no-op is exactly the
    // friction that stops people updating often.
    for (const id of ['build', 'migrate', 'seed', 'restart', 'health', 'publish', 'verify']) {
      expect(skipReason(id, { unchanged: true, options: {}, state: {} })).toBe(
        'already up to date',
      );
    }
  });

  it('still runs the fetch step when unchanged, since that is what decides', () => {
    expect(skipReason('fetch', { unchanged: true, options: {}, state: {} })).toBeUndefined();
  });

  it('authenticates with gh before the fetch, only for a GitHub remote', () => {
    expect(ids.indexOf('auth')).toBeLessThan(ids.indexOf('fetch'));
    expect(skipReason('auth', { options: {}, state: { repoUrl: 'https://github.com/acme/demo.git' } })).toBeUndefined();
    // Another forge is deployed with plain git; gh is never consulted.
    expect(skipReason('auth', { options: {}, state: { repoUrl: 'https://example.test/o/demo' } })).toBe('not a GitHub remote');
    expect(skipReason('auth', { options: { skipGithub: true }, state: { repoUrl: 'https://github.com/acme/demo.git' } })).toContain('--skip-github');
  });

  it('re-seeds by default', () => {
    // The only way permissions added by a new release reach an existing
    // deployment; without it the feature ships and the permission does not.
    expect(skipReason('seed', { options: {}, state: {} })).toBeUndefined();
  });

  it('honours --skip-seed', () => {
    expect(skipReason('seed', { options: { skipSeed: true }, state: {} })).toContain(
      '--skip-seed',
    );
  });

  it('skips publishing for a deployment that was never published', () => {
    expect(skipReason('publish', { options: {}, state: {} })).toContain('not published');
  });

  it('honours --skip-proxy', () => {
    expect(
      skipReason('publish', { options: { skipProxy: true }, state: { domain: 'x' } }),
    ).toContain('--skip-proxy');
  });
});

describe('renderUpdateCheck', () => {
  const check: UpdateCheck = {
    current: 'a'.repeat(40),
    latest: 'b'.repeat(40),
    commitsBehind: 2,
    commits: [...FAKE_COMMITS],
    checkedAt: '2026-09-16T00:00:00.000Z',
  };

  it('is a headline with twelve-character shas, then one line per commit', () => {
    expect(renderUpdateCheck(check)).toEqual([
      `current ${'a'.repeat(12)} → latest ${'b'.repeat(12)}, 2 commits behind`,
      'b2b2b2b  feat(api): the second thing',
      'b1b1b1b  fix(web): the first thing',
    ]);
  });

  it('says so, in one line, when there is nothing to update', () => {
    expect(renderUpdateCheck({ ...check, latest: check.current, commitsBehind: 0, commits: [] })).toEqual([
      `already up to date at ${'a'.repeat(12)}`,
    ]);
  });

  it('counts one commit in the singular', () => {
    expect(renderUpdateCheck({ ...check, commitsBehind: 1, commits: [check.commits[0] as { sha: string; subject: string }] })[0]).toContain('1 commit behind');
  });
});

/** A runCommand that answers openssl with the given expiry and everything else with success. */
function runCommandExpiring(notAfter: string, seen: string[][] = [], certbotOutput = '') {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    seen.push([...argv]);
    const stdout = argv[0] === 'openssl' ? `notAfter=${notAfter}\n` : argv.includes('certbot/certbot') ? certbotOutput : '';
    return { argv: [...argv], cwd: options.cwd, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
  }) as typeof import('./executor.js').runCommand;
}

function proxyRootWithCertificate(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-update-proxy-'));
  mkdirSync(join(root, 'nginx', 'conf.d'), { recursive: true });
  mkdirSync(join(root, 'webroot'), { recursive: true });
  const live = join(root, 'letsencrypt', 'live', 'app.example.test');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'fullchain.pem'), 'cert');
  writeFileSync(join(live, 'cert.pem'), 'cert');
  return root;
}

const NOW = new Date('2026-03-01T00:00:00Z');

/** An expiry `days` after `base`, in openssl's own format (`Mar 30 00:00:00 2026 GMT`). */
function daysFrom(base: Date, days: number): string {
  const date = new Date(base.getTime() + days * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.toUTCString().slice(8, 11)} ${String(date.getUTCDate()).padStart(2, ' ')} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()} GMT`;
}

const daysFromNow = (days: number): string => daysFrom(NOW, days);

describe('certificateDueForRenewal', () => {
  const target = () => ({ domain: 'app.example.test', bindPort: 3535, proxyRoot: proxyRootWithCertificate() });

  it('is due at 29 days', async () => {
    expect(RENEW_WITHIN_DAYS).toBe(30);
    await expect(certificateDueForRenewal(target(), runCommandExpiring(daysFromNow(29)), NOW)).resolves.toBe(true);
  });

  it('is not due at 31 days', async () => {
    await expect(certificateDueForRenewal(target(), runCommandExpiring(daysFromNow(31)), NOW)).resolves.toBe(false);
  });

  it('is due once expired', async () => {
    await expect(certificateDueForRenewal(target(), runCommandExpiring(daysFromNow(-1)), NOW)).resolves.toBe(true);
  });

  it('is not due when the expiry cannot be read, leaving it to the cron', async () => {
    await expect(certificateDueForRenewal(target(), runCommandExpiring('garbage'), NOW)).resolves.toBe(false);
  });
});

describe('the update publish step', () => {
  function publishStep() {
    const step = buildUpdateSteps().find((candidate) => candidate.id === 'publish');
    if (step === undefined) throw new Error('no publish step');
    return step;
  }

  function contextFor(root: string, runCommand: typeof import('./executor.js').runCommand, extra: Record<string, unknown> = {}) {
    const lines: string[] = [];
    return {
      options: { deployRoot: '/tmp/x' },
      runCommand,
      journal: { line: (line: string) => void lines.push(line) },
      state: { domain: 'app.example.test', bindPort: 3535, proxyRoot: root, proxyContainer: 'proxy-nginx' },
      name: 'demo',
      env: new Map([['MAX_FILE_SIZE', String(3 * 1024 * 1024 * 1024)]]),
      completed: new Set<string>(),
      ...extra,
    } as never;
  }

  // The step reads the real clock, so these expiries are relative to it. The
  // "not due" case sits half a day past the window so the seconds that tick
  // by during the test cannot carry it across a day boundary.
  const wallClock = new Date();
  const dueSoon = () => daysFrom(wallClock, 29);
  const notDue = () => daysFrom(wallClock, 31.5);
  const farOff = () => daysFrom(wallClock, 80);

  it('passes the upload limit through, so an update does not reset client_max_body_size', async () => {
    const root = proxyRootWithCertificate();

    // A certificate nowhere near expiry: nothing but the vhost happens.
    await publishStep().run(contextFor(root, runCommandExpiring(farOff())));

    const vhost = readFileSync(join(root, 'nginx', 'conf.d', 'app.example.test.conf'), 'utf8');
    expect(vhost).toContain('client_max_body_size 3072m;');
    expect(vhost).toContain('root /var/www/certbot;');
  });

  it('talks to the container recorded in the state', async () => {
    const root = proxyRootWithCertificate();
    const seen: string[][] = [];

    await publishStep().run(contextFor(root, runCommandExpiring(farOff(), seen)));

    const exec = seen.filter((argv) => argv[1] === 'exec');
    expect(exec.length).toBeGreaterThan(0);
    for (const argv of exec) expect(argv[2]).toBe('proxy-nginx');
  });

  it('renews within 30 days of expiry, and not before', async () => {
    const renewedOutput = 'Congratulations, all renewals succeeded:\n  /etc/letsencrypt/live/app.example.test/fullchain.pem (success)\n';

    const soon: string[][] = [];
    await publishStep().run(contextFor(proxyRootWithCertificate(), runCommandExpiring(dueSoon(), soon, renewedOutput)));
    const renew = soon.find((argv) => argv.includes('renew'));
    expect(renew).toBeDefined();
    expect(renew).toContain('certbot/certbot');
    expect(renew?.slice(-2)).toEqual(['--cert-name', 'app.example.test']);
    // Certbot reported a renewal, so the proxy was reloaded for it.
    expect(soon.filter((argv) => argv.includes('reload')).length).toBeGreaterThanOrEqual(1);

    const later: string[][] = [];
    await publishStep().run(contextFor(proxyRootWithCertificate(), runCommandExpiring(notDue(), later)));
    expect(later.some((argv) => argv.includes('renew'))).toBe(false);
  });

  it('never re-issues a certificate that exists', async () => {
    const seen: string[][] = [];

    await publishStep().run(contextFor(proxyRootWithCertificate(), runCommandExpiring(farOff(), seen)));

    expect(seen.some((argv) => argv.includes('certonly'))).toBe(false);
  });
});

describe('runUpdate preconditions', () => {
  it('refuses to run when nothing is installed, naming install', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-noinstall-'));

    const error = await runUpdate({ deployRoot: empty }).catch((caught: unknown) => caught);

    // The precondition install does not have, and the reason this is its own
    // command rather than a flag: the guards are opposite.
    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
  });
});

// =============================================================================
// The pipeline end to end, against a fake VPS  (issue #120)
// =============================================================================

const INSTALLED_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const INSTALLED_AT = '2026-01-01T00:00:00.000Z';
const DEPLOYED_AT = '2026-01-02T00:00:00.000Z';

/** The .env an install would have written for FAKE_ENV_EXAMPLE. */
function installedEnv(vps: FakeVps, name: string): string {
  return [
    ...[...vps.answers().entries()].map(([key, value]) => `${key}=${value}`),
    'POSTGRES_SSL=false',
    'APP_BIND_PORT=3535',
    `COMPOSE_PROJECT_NAME=${name}`,
    '',
  ].join('\n');
}

/** An installed app: state, clone at the installed SHA, and its .env. */
function installedApp(vps: FakeVps, layout: 'current' | 'pre-120' = 'current'): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-update-'));
  populateClone(join(root, 'repo'));

  const state: DeployState = {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: INSTALLED_SHA,
    bindPort: 3535,
    deployRoot: root,
    name: 'demo',
    installedAt: INSTALLED_AT,
    lastDeployedAt: DEPLOYED_AT,
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
  writeState(state);

  if (layout === 'current') {
    writeEnvFile(root, installedEnv(vps, 'demo'));
  } else {
    // An install from before #120: a regular file inside the clone, no link.
    writeFileSync(composeEnvPath(root), installedEnv(vps, 'demo'), { mode: 0o600 });
  }
  return root;
}

/** The human-readable journal an update just wrote under the deploy root. */
function updateJournal(root: string): string {
  const dir = join(root, 'logs');
  const names = readdirSync(dir)
    .filter((name) => name.startsWith('appctl-update-') && name.endsWith('.log'))
    .sort();
  const newest = names[names.length - 1];
  if (newest === undefined) throw new Error(`no update journal under ${dir}`);
  return readFileSync(join(dir, newest), 'utf8');
}

describe('runUpdate against a fake VPS', () => {
  let vps: FakeVps;

  beforeEach(async () => {
    vps = await fakeVps({ head: INSTALLED_SHA, remoteSha: NEW_SHA });
    vi.stubGlobal('fetch', healthyFetch());
  });

  afterEach(async () => {
    chmodShouldFailFor = undefined;
    vi.unstubAllGlobals();
    await vps.close();
  });

  function update(
    root: string,
    hooks?: { onProgress?: (message: string) => void; onLog?: (line: string) => void; onStepStart?: (step: { id: string }) => void },
    extra: { check?: boolean; force?: boolean } = {},
  ) {
    return runUpdate({
      deployRoot: root,
      runCommand: vps.runCommand,
      nonInteractive: true,
      promptContext: silentPrompt(),
      skipProxy: true,
      skipSeed: true,
      cwd: root,
      ...(hooks === undefined ? {} : { hooks }),
      ...extra,
    });
  }

  const built = () => vps.seen.some((argv) => argv[1] === 'compose' && argv.includes('build'));

  // Issue #156, the update side of install.test.ts's guard: every streamed
  // command carries the run journal's redactor, so `onLog` - which
  // `commands/deploy.ts` writes straight to stderr - cannot show an operator
  // what `logs/*.log` masks.
  it('never wires onLine without a redactor', async () => {
    const root = installedApp(vps);
    const streamed: RunCommandOptions[] = [];

    const watching = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      if (options.onLine !== undefined) streamed.push(options);
      return await vps.runCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    await runUpdate({
      deployRoot: root,
      runCommand: watching,
      nonInteractive: true,
      promptContext: silentPrompt(),
      skipProxy: true,
      skipSeed: true,
      cwd: root,
      hooks: { onLog: () => undefined },
    });

    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.filter((options) => options.redact === undefined)).toEqual([]);
  });

  it('leaves lastDeployedAt alone when the pipeline fails, and records the attempt', async () => {
    const root = installedApp(vps);
    vps.failWhen((argv) => argv[1] === 'compose' && argv.includes('build'), 'build exploded');

    const error = await update(root).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('build exploded');
    const state = readState(root) as DeployState;
    // The bug this fixes: a deploy time was stamped at fetch, before anything
    // had been applied, so a failed update claimed a deploy that never was.
    expect(state.lastDeployedAt).toBe(DEPLOYED_AT);
    expect(state.installedAt).toBe(INSTALLED_AT);
    expect(state.commitSha).toBe(INSTALLED_SHA);
    expect(state.previousSha).toBe(INSTALLED_SHA);
    expect(state.lastAttemptAt).toBeDefined();
    expect(state.lastAttemptAt as string > DEPLOYED_AT).toBe(true);
    // And nothing claims otherwise to the application either: this run failed
    // at `build`, long before `health`, so #283's rule does not reach it -
    // nothing was restarted and nothing new is serving.
    expect(readDeployInfo(root)).toBeUndefined();
  });

  it('stamps lastDeployedAt only on success, never touching installedAt', async () => {
    const root = installedApp(vps);
    const before = Date.now();

    const result = await update(root);

    expect(result.changed).toBe(true);
    expect(result.previousSha).toBe(INSTALLED_SHA);
    expect(result.commitSha).toBe(NEW_SHA);

    const state = readState(root) as DeployState;
    expect(state.installedAt).toBe(INSTALLED_AT);
    // `lastDeployedAt` is optional on the state since #267 (a failed FIRST
    // install has none); a successful update always stamps one, which is
    // what this asserts.
    expect(state.lastDeployedAt).toBeDefined();
    expect(Date.parse(state.lastDeployedAt as string)).toBeGreaterThanOrEqual(before);
    expect(state.lastAttemptAt).toBe(state.lastDeployedAt);
    expect(state.commitSha).toBe(NEW_SHA);
    expect(state.previousSha).toBe(INSTALLED_SHA);
    expect(state.lastCommand).toBe('update');
    expect(state.envPath).toBe(envFilePath(root));
  });

  it('writes deploy-info after a successful update, keeping installedAt', async () => {
    const root = installedApp(vps);

    await update(root);

    const state = readState(root) as DeployState;
    const info = readDeployInfo(root);
    expect(info).toMatchObject({
      schema: 1,
      app: { name: 'demo', version: FAKE_APP_VERSION, commitSha: NEW_SHA, ref: 'main' },
      installedAt: INSTALLED_AT,
      updatedAt: state.lastDeployedAt,
      lastCommand: 'update',
      domain: null,
      bindPort: 3535,
      host: { dockerVersion: '27.3.1', composeVersion: '2.29.7', diskBytes: 78125000 * 1024 },
      // This run fetched and deployed the latest, so it is zero behind - not
      // "never checked", which would be wrong at the one moment it is current.
      remote: { sha: NEW_SHA, commitsBehind: 0 },
    });
    expect(info?.updatedAt.endsWith('Z')).toBe(true);
    expect(info?.remote?.checkedAt.endsWith('Z')).toBe(true);
  });

  it('shows what it is about to apply before it builds', async () => {
    const root = installedApp(vps);
    const events: string[] = [];

    const result = await update(root, {
      onStepStart: ({ id }) => void events.push(`step:${id}`),
      onProgress: (message) => void events.push(`progress:${message}`),
      onLog: (line) => void events.push(`log:${line}`),
    });

    const headline = events.findIndex((event) =>
      event.startsWith(`progress:current ${'a'.repeat(12)} → latest ${'b'.repeat(12)}, 2 commits behind`),
    );
    expect(headline).toBeGreaterThan(events.indexOf('step:fetch'));
    expect(headline).toBeLessThan(events.indexOf('step:build'));
    expect(events[headline + 1]).toBe('log:b2b2b2b  feat(api): the second thing');
    expect(events[headline + 2]).toBe('log:b1b1b1b  fix(web): the first thing');
    expect(result.check).toMatchObject({ current: INSTALLED_SHA, latest: NEW_SHA, commitsBehind: 2 });
  });

  // The preflight covers the database because the pipeline MIGRATES (#179).
  // `migrate` stops the api container and runs `prisma:migrate` three steps
  // later; a preflight that omitted the database would be checking everything
  // except the thing this run is about to change.
  it('preflights the database it is about to migrate against, in dependency order', async () => {
    const root = installedApp(vps);

    await update(root);

    // The preflight journals one `<status> <id>: <detail>` line per check.
    const log = updateJournal(root);
    const ids = [...log.matchAll(/^(?:pass|warn|fail|skip) (database-[a-z-]+):/gm)].map(
      (match) => match[1],
    );

    // In dependency order, because `runChecks` honours `requires` BY POSITION:
    // the vector check without the three ahead of it reports `skip` and checks
    // nothing at all.
    expect(ids).toEqual([
      'database-reachable',
      'database-credentials',
      'database-exists',
      'database-vector-extension',
    ]);
    expect(log).toContain('pass database-vector-extension: vector 0.8.0 installed');

    // And all of it before a single migration is applied.
    expect(log.indexOf('database-vector-extension')).toBeLessThan(log.indexOf('[migrate]'));
  });

  it('fails at preflight, not inside migrate, when the database is unusable', async () => {
    // The bug this closes predates #179: an update against an unreachable
    // database, a rotated password or a dropped database used to fail INSIDE
    // `migrate`, as a Prisma stack trace, with the api container already
    // stopped.
    const root = installedApp(vps);
    vps.failWhen(
      (argv) => argv[0] === 'docker' && argv[1] === 'run',
      'psql: error: FATAL:  password authentication failed for user "app"',
    );

    const error = await update(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('database-credentials');
    expect(vps.seen.some((argv) => argv.join(' ').includes('prisma:migrate'))).toBe(false);
    expect(built()).toBe(false);
  });

  it('refreshes deploy-info from the unchanged state when there is nothing to deploy', async () => {
    vps.remoteSha = INSTALLED_SHA;
    const root = installedApp(vps);

    const result = await update(root);

    expect(result.changed).toBe(false);
    expect(readState(root)).toMatchObject({
      commitSha: INSTALLED_SHA,
      lastDeployedAt: DEPLOYED_AT,
      lastCommand: 'install',
    });
    expect(readState(root)?.lastAttemptAt).toBeUndefined();
    expect(readDeployInfo(root)).toMatchObject({
      installedAt: INSTALLED_AT,
      updatedAt: DEPLOYED_AT,
      lastCommand: 'install',
      remote: { sha: INSTALLED_SHA, commitsBehind: 0 },
    });
  });

  // ---- `update --check`  (issue #123) ---------------------------------------

  it('--check answers current, latest and the commits between, and deploys nothing', async () => {
    const root = installedApp(vps);
    const statePath = deployStatePath(root);
    writeDeployInfo(root, readState(root) as DeployState, {
      hostname: 'vps-1', os: null, kernel: null, arch: null, cpuModel: null, cpus: null,
      memoryBytes: null, diskBytes: null, dockerVersion: null, composeVersion: null, nodeVersion: null,
    });
    const before = statSync(statePath).mtimeMs;

    const result = await update(root, undefined, { check: true });

    expect(result.changed).toBe(false);
    expect(result.commitSha).toBe(INSTALLED_SHA);
    expect(result.check).toEqual({
      current: INSTALLED_SHA,
      latest: NEW_SHA,
      commitsBehind: 2,
      commits: [...FAKE_COMMITS],
      checkedAt: expect.stringMatching(/Z$/) as string,
    });

    // The remote was fetched and compared, and the clone was NOT moved.
    expect(vps.seen.some((argv) => argv[0] === 'git' && argv[1] === 'fetch')).toBe(true);
    expect(vps.seen.some((argv) => argv[0] === 'git' && argv[1] === 'checkout')).toBe(false);
    expect(vps.head).toBe(INSTALLED_SHA);
    expect(built()).toBe(false);

    // The state file is untouched - the acceptance criterion is its mtime.
    expect(statSync(statePath).mtimeMs).toBe(before);
    expect(readState(root)).toMatchObject({ commitSha: INSTALLED_SHA, lastCommand: 'install' });
    expect(readState(root)?.previousSha).toBeUndefined();
    expect(readState(root)?.lastAttemptAt).toBeUndefined();

    // deploy-info's remote is refreshed, and nothing else in it is rebuilt.
    expect(readDeployInfo(root)).toMatchObject({
      app: { commitSha: INSTALLED_SHA },
      updatedAt: DEPLOYED_AT,
      lastCommand: 'install',
      host: { hostname: 'vps-1' },
      remote: { sha: NEW_SHA, commitsBehind: 2, checkedAt: result.check?.checkedAt },
    });
  });

  it('--check reports zero commits behind when the remote has not moved', async () => {
    vps.remoteSha = INSTALLED_SHA;
    const root = installedApp(vps);
    const progress: string[] = [];

    const result = await update(root, { onProgress: (message) => void progress.push(message) }, { check: true });

    expect(result.check).toMatchObject({ current: INSTALLED_SHA, latest: INSTALLED_SHA, commitsBehind: 0, commits: [] });
    expect(progress).toContain(`already up to date at ${'a'.repeat(12)}`);
    expect(built()).toBe(false);
  });

  it('--check writes a first deploy-info for a deployment that has none', async () => {
    const root = installedApp(vps);
    expect(readDeployInfo(root)).toBeUndefined();

    await update(root, undefined, { check: true });

    expect(readDeployInfo(root)).toMatchObject({
      app: { commitSha: INSTALLED_SHA },
      lastCommand: 'install',
      remote: { sha: NEW_SHA, commitsBehind: 2 },
    });
  });

  it('consults gh before the fetch for a GitHub remote, and stops with exit 6 when logged out', async () => {
    const root = installedApp(vps);
    writeState({ ...(readState(root) as DeployState), repoUrl: 'https://github.com/acme/demo.git' });

    await update(root, undefined, { check: true });
    const commands = vps.seen.map((argv) => argv.slice(0, 3).join(' '));
    const setup = commands.indexOf('gh auth setup-git');
    expect(commands.indexOf('gh auth status')).toBeGreaterThanOrEqual(0);
    expect(setup).toBeGreaterThan(commands.indexOf('gh auth status'));
    expect(commands.indexOf('git fetch --tags')).toBeGreaterThan(setup);

    vps.failWhen((argv) => argv[0] === 'gh' && argv[2] === 'status', 'You are not logged in to any GitHub hosts.');
    const error = await update(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as Error).message).toContain('gh auth login');
    // Refused before the fetch, so the state still says what it said.
    expect(readState(root)?.lastAttemptAt).toBeUndefined();
  });

  // ===========================================================================
  // deploy-info is prepared BEFORE the pipeline  (issue #159)
  // ===========================================================================

  it('repairs a 0700 deploy-info before it runs a single compose command', async () => {
    // `update` pre-created nothing: the first thing to touch deploy-info was
    // the write at the very END of a successful run, after `restart` had run
    // the `compose up` that makes the Docker daemon create a missing bind
    // source as root:root. The directory is now right before any command runs.
    const root = installedApp(vps);
    mkdirSync(deployInfoDir(root), { recursive: true, mode: 0o700 });
    chmodSyncFs(deployInfoDir(root), 0o700);
    const modes: number[] = [];

    const watching = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      modes.push(statSync(deployInfoDir(root)).mode & 0o777);
      return await vps.runCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    await runUpdate({
      deployRoot: root,
      runCommand: watching,
      nonInteractive: true,
      promptContext: silentPrompt(),
      skipProxy: true,
      skipSeed: true,
      cwd: root,
    });

    expect(modes.length).toBeGreaterThan(0);
    // Every command, not just the last: `compose up` must never find it 0700.
    expect(modes.filter((mode) => mode !== 0o755)).toEqual([]);
    expect(statSync(deployInfoDir(root)).mode & 0o777).toBe(0o755);
    expect(readDeployInfo(root)?.lastCommand).toBe('update');
  });

  it('creates deploy-info even when the deployment never had one', async () => {
    const root = installedApp(vps);
    const seenBefore: boolean[] = [];

    const watching = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
      seenBefore.push(existsSync(deployInfoDir(root)));
      return await vps.runCommand(argv, options);
    }) as typeof import('./executor.js').runCommand;

    await runUpdate({
      deployRoot: root,
      runCommand: watching,
      nonInteractive: true,
      promptContext: silentPrompt(),
      skipProxy: true,
      skipSeed: true,
      cwd: root,
    });

    // So the Docker daemon never gets the chance to invent it as root:root.
    expect(seenBefore.filter((existed) => !existed)).toEqual([]);
  });

  it('refuses a deploy-info it cannot fix before anything is deployed, naming the chown', async () => {
    const root = installedApp(vps);
    mkdirSync(deployInfoDir(root), { recursive: true });
    chmodShouldFailFor = 'deploy-info';

    const error = await update(root).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeployInfoError);
    const message = (error as Error).message;
    const { uid, gid } = userInfo();
    expect(message).toContain(`Cannot prepare ${deployInfoDir(root)}`);
    expect(message).toContain(`sudo chown -R ${uid}:${gid} ${deployInfoDir(root)}`);
    expect(message).toContain(`sudo chmod 755 ${deployInfoDir(root)}`);
    // Not the raw EACCES on `info.json.<pid>.tmp` this issue is about, and
    // not after a full build/migrate/restart: nothing ran at all.
    expect(message).not.toContain('.tmp');
    expect(vps.seen).toEqual([]);
    expect(readdirSync(deployInfoDir(root))).toEqual([]);
    expect(readState(root)?.lastAttemptAt).toBeUndefined();
  });

  it('refuses the same way under --check, which writes before any compose command', async () => {
    const root = installedApp(vps);
    mkdirSync(deployInfoDir(root), { recursive: true });
    chmodShouldFailFor = 'deploy-info';

    const error = await update(root, undefined, { check: true }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeployInfoError);
    expect((error as Error).message).toMatch(/sudo chown -R \d+:\d+ .*deploy-info/);
    expect(vps.seen).toEqual([]);
  });

  it('--check still records the remote through a 0700 directory it repairs', async () => {
    const root = installedApp(vps);
    mkdirSync(deployInfoDir(root), { recursive: true });
    chmodSyncFs(deployInfoDir(root), 0o700);

    await update(root, undefined, { check: true });

    expect(statSync(deployInfoDir(root)).mode & 0o777).toBe(0o755);
    expect(readDeployInfo(root)).toMatchObject({ remote: { sha: NEW_SHA, commitsBehind: 2 } });
    expect(built()).toBe(false);
  });

  it('migrates a pre-#120 .env to the app root and pins DEPLOY_ROOT', async () => {
    const root = installedApp(vps, 'pre-120');
    const progress: string[] = [];

    await update(root, { onProgress: (message) => void progress.push(message) });

    expect(statSync(envFilePath(root)).mode & 0o777).toBe(0o600);
    expect(lstatSync(composeEnvPath(root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(composeEnvPath(root))).toBe('../../../.env');
    expect(readFileSync(envFilePath(root), 'utf8')).toContain(`DEPLOY_ROOT=${root}`);
    expect(readFileSync(envFilePath(root), 'utf8')).toContain('COMPOSE_PROJECT_NAME=demo');
    expect(progress.some((message) => message.includes('Moved .env'))).toBe(true);
  });

  // ===========================================================================
  // Issue #283: an update past `health` has already deployed the new revision
  // ===========================================================================
  //
  // `update` writes deploy-info after its own success only. A failure after
  // `health` therefore left the LAST SUCCESSFUL deploy's document in place,
  // naming the OLD commit as what is running - while `restart` had already
  // brought the stack up on the new one and the API had already answered on
  // it. On a deployment with no document yet (a pre-#120 install, or one whose
  // first install failed) it left nothing at all, and About said the CLI had
  // never deployed it.
  //
  // `update()` passes `skipProxy`, so `verify` is the one step after `health`;
  // failing the frontend probe fails it with /api/health/ready still
  // answering, exactly as in install.test.ts.
  describe('a failed update past health still refreshes what is deployed (#283)', () => {
    function apiUpFrontendDown(): typeof globalThis.fetch {
      return (async (input: RequestInfo | URL) =>
        ({
          status: String(input).includes('/api/health/') ? 200 : 502,
        }) as Response) as typeof globalThis.fetch;
    }

    it('does not blank an existing record, and moves it to the revision now serving', async () => {
      const root = installedApp(vps);
      // The record the last successful deploy left behind.
      writeDeployInfo(root, readState(root) as DeployState, {
        ...unknownServerFacts(),
        hostname: 'vps-1',
      });
      expect(readDeployInfo(root)?.app.commitSha).toBe(INSTALLED_SHA);
      vi.stubGlobal('fetch', apiUpFrontendDown());

      const error = await update(root).catch((caught: unknown) => caught);

      expect((error as Error).message).toContain('not healthy');
      const info = readDeployInfo(root);
      expect(info).toBeDefined();
      // The new revision is what restart brought up and health answered on.
      expect(info?.app.commitSha).toBe(NEW_SHA);
      expect(info?.lastCommand).toBe('update');
      expect(info?.run).toMatchObject({ completed: false, failedStep: 'verify' });
    });

    it('keeps updatedAt on the last deploy that SUCCEEDED, stamping nothing new', async () => {
      // #120's rule, which this must not undo: `updatedAt` is the last
      // successful deploy. `run` is what says the newest commit arrived on a
      // run that did not finish.
      const root = installedApp(vps);
      vi.stubGlobal('fetch', apiUpFrontendDown());

      await update(root).catch(() => undefined);

      const info = readDeployInfo(root);
      expect(info?.updatedAt).toBe(DEPLOYED_AT);
      expect(info?.installedAt).toBe(INSTALLED_AT);
      // The STATE is untouched by this write: update records a deploy only on
      // success, and a failed run must not look like one.
      expect(readState(root)?.lastDeployedAt).toBe(DEPLOYED_AT);
      expect(readState(root)?.commitSha).toBe(INSTALLED_SHA);
    });

    it('marks the record complete again once an update succeeds', async () => {
      const root = installedApp(vps);
      vi.stubGlobal('fetch', apiUpFrontendDown());
      await update(root).catch(() => undefined);
      expect(readDeployInfo(root)?.run?.completed).toBe(false);

      // `--force`, because the first run already moved the clone to NEW_SHA:
      // a plain re-run finds nothing to fetch and redeploys nothing, which is
      // #120's behaviour and the next test's subject.
      vi.stubGlobal('fetch', healthyFetch());
      await update(root, undefined, { force: true });

      expect(readDeployInfo(root)?.run).toEqual({ completed: true });
      expect(readDeployInfo(root)?.app.commitSha).toBe(NEW_SHA);
    });

    it('does not rewrite the record BACKWARDS when the retry finds nothing to do', async () => {
      // The regression #283's own fix would otherwise introduce. After a
      // failure past `health` the clone is at NEW_SHA and serving it, but the
      // state still says INSTALLED_SHA - `update` records a commit only on
      // success. A plain re-run then takes the "already up to date" path,
      // which refreshes deploy-info from that stale state: the record would
      // move from the revision that IS running to the one that is not, and
      // lose the marker saying the run never finished.
      const root = installedApp(vps);
      vi.stubGlobal('fetch', apiUpFrontendDown());
      await update(root).catch(() => undefined);
      expect(readState(root)?.commitSha).toBe(INSTALLED_SHA);

      vi.stubGlobal('fetch', healthyFetch());
      const result = await update(root);

      expect(result.changed).toBe(false);
      const info = readDeployInfo(root);
      expect(info?.app.commitSha).toBe(NEW_SHA);
      // This run deployed nothing, so it says nothing about how any run
      // ended: the previous document's `run` rides through untouched.
      expect(info?.run).toMatchObject({ completed: false, failedStep: 'verify' });
    });
  });
});
