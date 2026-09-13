import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import { DATABASE_CHECKS, databaseSettings } from './database.js';
import { DNS_CHECKS } from './dns.js';
import { ALL_CHECKS } from './index.js';
import { TLS_CHECKS, parseNotAfter } from './tls.js';
import { runChecks, type Check, type CheckContext, type CheckFs } from './types.js';

type Canned = { exitCode: number; stdout?: string; stderr?: string };
type Responder = (argv: readonly string[], options: RunCommandOptions) => Canned | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv, options) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as typeof import('../executor.js').runCommand;
}

const presentFs: CheckFs = { exists: () => true, isDirectory: () => true, isWritable: () => true };
const absentFs: CheckFs = { exists: () => false, isDirectory: () => false, isWritable: () => false };

const ENV = new Map([
  ['POSTGRES_HOST', 'db.internal'],
  ['POSTGRES_PORT', '5432'],
  ['POSTGRES_USER', 'appuser'],
  ['POSTGRES_PASSWORD', 'p@ss/word#1'],
  ['POSTGRES_DB', 'appdb'],
]);

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: '1' })),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    domain: 'app.example.test',
    env: ENV,
    fs: presentFs,
    ...overrides,
  };
}

function find(checks: readonly Check[], id: string): Check {
  const check = checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

describe('databaseSettings', () => {
  it('reads the POSTGRES_* values the deployment will use', () => {
    expect(databaseSettings(ENV)).toEqual({
      host: 'db.internal',
      port: '5432',
      user: 'appuser',
      password: 'p@ss/word#1',
      database: 'appdb',
      ssl: false,
    });
  });

  it('is undefined when no environment has been resolved yet', () => {
    expect(databaseSettings(undefined)).toBeUndefined();
  });
});

describe('database checks', () => {
  it('skips rather than fails when there is no environment yet', async () => {
    // Before an install there is no .env; reporting that as a broken database
    // would send someone looking at the wrong thing.
    const result = await find(DATABASE_CHECKS, 'database-reachable').run(
      context({ env: undefined }),
    );

    expect(result.status).toBe('skip');
  });

  it('never puts the password or a connection URL in its argv', async () => {
    const seen: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];

    await find(DATABASE_CHECKS, 'database-credentials').run(
      context({
        runCommand: fakeRunCommand((argv, options) => {
          seen.push([...argv]);
          envs.push(options.env);
          return { exitCode: 0, stdout: '1' };
        }),
      }),
    );

    const flat = seen.flat().join(' ');
    // The password reaches psql through PGPASSWORD, so there is no URL to leak
    // into a journal line, a detail or a remedy.
    expect(flat).not.toContain('p@ss/word#1');
    expect(flat).not.toContain('postgresql://');
    expect(envs[0]?.PGPASSWORD).toBe('p@ss/word#1');
  });

  it('reports a rejected password distinctly from a missing database', async () => {
    const badPassword = await find(DATABASE_CHECKS, 'database-credentials').run(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 2,
          stderr: 'psql: error: FATAL:  password authentication failed for user "appuser"',
        })),
      }),
    );

    expect(badPassword.status).toBe('fail');
    expect(badPassword.detail).toContain('password authentication failed');
    expect(badPassword.remedy).toContain('POSTGRES_PASSWORD');

    const missingDb = await find(DATABASE_CHECKS, 'database-exists').run(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 2,
          stderr: 'psql: error: FATAL:  database "appdb" does not exist',
        })),
      }),
    );

    expect(missingDb.status).toBe('fail');
    expect(missingDb.remedy).toContain('createdb');
    // Migrations create tables, never the database itself.
    expect(missingDb.remedy).toContain('Migrations create tables');
  });

  it('reports a pg_hba rejection as its own case', async () => {
    const result = await find(DATABASE_CHECKS, 'database-credentials').run(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 2,
          stderr: 'psql: error: FATAL:  no pg_hba.conf entry for host "10.0.0.5"',
        })),
      }),
    );

    expect(result.detail).toContain('pg_hba.conf');
    expect(result.remedy).toContain('pg_hba.conf');
  });

  it('warns when the user cannot create tables', async () => {
    const result = await find(DATABASE_CHECKS, 'database-privileges').run(
      context({ runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'f' })) }),
    );

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('GRANT CREATE');
  });

  it('skips the TLS check unless POSTGRES_SSL is true', async () => {
    const result = await find(DATABASE_CHECKS, 'database-ssl').run(context());
    expect(result.status).toBe('skip');
  });

  it('warns when TLS was asked for but the session is plaintext', async () => {
    const result = await find(DATABASE_CHECKS, 'database-ssl').run(
      context({
        env: new Map([...ENV, ['POSTGRES_SSL', 'true']]),
        runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'f' })),
      }),
    );

    expect(result.status).toBe('warn');
    // The setting was giving false assurance, which is worse than being off.
    expect(result.detail).toContain('not encrypted');
  });

  it('passes PGSSLMODE when TLS is requested', async () => {
    const seen: string[][] = [];
    await find(DATABASE_CHECKS, 'database-ssl').run(
      context({
        env: new Map([...ENV, ['POSTGRES_SSL', 'true']]),
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return { exitCode: 0, stdout: 't' };
        }),
      }),
    );

    expect(seen.flat()).toContain('PGSSLMODE=require');
  });
});

describe('dns checks', () => {
  it('skips when no domain was given', async () => {
    const result = await find(DNS_CHECKS, 'dns-resolves').run(context({ domain: undefined }));
    expect(result.status).toBe('skip');
  });

  it('fails when the name does not resolve', async () => {
    const result = await find(DNS_CHECKS, 'dns-resolves').run(
      context({ resolveHost: async () => [] }),
    );

    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('DNS record');
  });

  it('passes when the record points at one of this host addresses', async () => {
    const result = await find(DNS_CHECKS, 'dns-points-here').run(
      context({
        resolveHost: async () => ['203.0.113.10'],
        ownAddresses: async () => ['203.0.113.10', 'fe80::1'],
      }),
    );

    expect(result.status).toBe('pass');
  });

  it('names both addresses when they disagree', async () => {
    // Behind a CDN this is expected, and the operator needs to recognise it.
    const result = await find(DNS_CHECKS, 'dns-points-here').run(
      context({
        resolveHost: async () => ['198.51.100.7'],
        ownAddresses: async () => ['203.0.113.10'],
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('198.51.100.7');
    expect(result.detail).toContain('203.0.113.10');
    expect(result.remedy).toContain('CDN');
  });

  it('warns rather than fails when this host address cannot be determined', async () => {
    // A limit of the check, not evidence that DNS is wrong - and an external
    // echo service is deliberately not consulted.
    const result = await find(DNS_CHECKS, 'dns-points-here').run(
      context({
        resolveHost: async () => ['198.51.100.7'],
        ownAddresses: async () => [],
      }),
    );

    expect(result.status).toBe('warn');
  });
});

describe('tls checks', () => {
  it('treats no certificate as a pass on a first install', async () => {
    const result = await find(TLS_CHECKS, 'certificate-present').run(
      context({ fs: absentFs }),
    );

    // Issuing one is exactly what install does next.
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('none yet');
  });

  it('reports an existing certificate', async () => {
    const result = await find(TLS_CHECKS, 'certificate-present').run(context());
    expect(result.detail).toContain('already issued');
  });

  it('warns when no renewal mechanism can be found', async () => {
    const result = await find(TLS_CHECKS, 'certificate-renewal').run(
      context({
        fs: { ...presentFs, exists: (path: string) => !path.includes('cron.d') },
        runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr: 'disabled' })),
      }),
    );

    expect(result.status).toBe('warn');
    // A certificate nobody renews is a 90-day timer on an outage.
    expect(result.remedy).toContain('90 days');
  });

  it('skips the expiry check when openssl is unavailable', async () => {
    const result = await find(TLS_CHECKS, 'certificate-validity').run(
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(result.status).toBe('skip');
  });
});

describe('parseNotAfter', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('passes on a certificate with plenty of life left', () => {
    const result = parseNotAfter('notAfter=Jun  1 12:00:00 2026 GMT', now);
    expect(result.status).toBe('pass');
  });

  it('warns within thirty days', () => {
    const result = parseNotAfter('notAfter=Jan 20 12:00:00 2026 GMT', now);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('19 day');
  });

  it('warns on an expired certificate', () => {
    const result = parseNotAfter('notAfter=Dec  1 12:00:00 2025 GMT', now);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('expired');
  });

  it('warns when the output cannot be read', () => {
    expect(parseNotAfter('nonsense', now).status).toBe('warn');
  });
});

describe('the complete registry', () => {
  it('runs host, database, DNS and TLS in that order', () => {
    const ids = ALL_CHECKS.map((check) => check.id);

    // Host first: a server with no docker should say so before it starts
    // probing databases with a container it cannot run.
    expect(ids.indexOf('docker-installed')).toBeLessThan(ids.indexOf('database-reachable'));
    expect(ids.indexOf('database-reachable')).toBeLessThan(ids.indexOf('dns-resolves'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every non-passing check a remedy, across the whole registry', async () => {
    const results = await runChecks(
      ALL_CHECKS,
      context({
        runCommand: fakeRunCommand(() => undefined),
        fs: absentFs,
        totalMemoryBytes: () => 512 * 1024 * 1024,
        portFree: async () => false,
        portListening: async () => false,
        resolveHost: async () => [],
        ownAddresses: async () => [],
      }),
    );

    const missing = results
      .filter((result) => result.status === 'fail' || result.status === 'warn')
      .filter((result) => (result.remedy ?? '') === '');

    expect(missing).toEqual([]);
  });
});
