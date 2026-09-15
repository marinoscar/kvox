import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandResult, RunCommandOptions } from './executor.js';
import { NotInstalledError } from './state.js';
import { RENEW_WITHIN_DAYS, buildUpdateSteps, certificateDueForRenewal, runUpdate } from './update.js';

describe('the update pipeline', () => {
  const steps = buildUpdateSteps();
  const ids = steps.map((step) => step.id);

  it('looks for a new revision before it changes anything', () => {
    expect(ids).toEqual([
      'preflight',
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
