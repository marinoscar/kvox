import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../../branding.js';
import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import { DATABASE_CHECKS, databaseSettings } from './database.js';
import { DNS_CHECKS } from './dns.js';
import { ALL_CHECKS } from './index.js';
import { TLS_CHECKS, findRenewal, parseNotAfter } from './tls.js';
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

// The pgvector preflight (issue #179, epic #165). The reason it is `required`
// and not advice is in database.ts's header: if the extension cannot be
// provided, `prisma migrate deploy` aborts, so a warning here would mean doctor
// says "you're fine" and install fails anyway.
describe('database-vector-extension', () => {
  // Answers each of the check's three statements independently, so a test only
  // has to state the facts it cares about.
  function vectorRunCommand(catalogue: {
    installed?: string;
    available?: string;
    rolsuper?: string;
  }): typeof import('../executor.js').runCommand {
    return fakeRunCommand((argv) => {
      const statement = argv[argv.length - 1] ?? '';
      if (statement.includes('pg_extension')) {
        return { exitCode: 0, stdout: catalogue.installed ?? '' };
      }
      if (statement.includes('pg_available_extensions')) {
        return { exitCode: 0, stdout: catalogue.available ?? '' };
      }
      if (statement.includes('rolsuper')) {
        return { exitCode: 0, stdout: catalogue.rolsuper ?? 'f' };
      }
      return { exitCode: 0, stdout: '' };
    });
  }

  function vectorCheck(): Check {
    return find(DATABASE_CHECKS, 'database-vector-extension');
  }

  it('is required, and runs only once the database is known to exist', () => {
    expect(vectorCheck().severity).toBe('required');
    expect(vectorCheck().requires).toContain('database-exists');
  });

  it('passes on an already-installed extension, whatever the role may do', async () => {
    // The ordinary managed-PostgreSQL case: an administrator installed it once,
    // out of band, and the application role never could and never needs to. A
    // check that only asked "can you install it?" would fail this deployment.
    const result = await vectorCheck().run(
      context({ runCommand: vectorRunCommand({ installed: '0.7.4', rolsuper: 'f' }) }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('0.7.4');
  });

  it('passes when it is available to install and the role is a superuser', async () => {
    const result = await vectorCheck().run(
      context({ runCommand: vectorRunCommand({ available: '0.8.0', rolsuper: 't' }) }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('0.8.0');
    expect(result.detail).toContain('not yet installed');
  });

  it('warns - never fails - when it is available but the role is not a superuser', async () => {
    // Superuser is not the only way a role may create an extension, so refusing
    // outright would be wrong; saying nothing would be worse.
    const result = await vectorCheck().run(
      context({ runCommand: vectorRunCommand({ available: '0.8.0', rolsuper: 'f' }) }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('appuser');
    expect(result.remedy).toContain('CREATE EXTENSION vector');
  });

  it('fails with a pasteable remedy when the server has no vector at all', async () => {
    const result = await vectorCheck().run(
      context({ runCommand: vectorRunCommand({}) }),
    );

    expect(result.status).toBe('fail');
    // A command and a package name, not a category (types.ts rule 2).
    expect(result.remedy).toContain('CREATE EXTENSION vector');
    expect(result.remedy).toContain('appdb');
    expect(result.remedy).toContain('postgresql-16-pgvector');
    // And how much is actually blocked, so nobody tears down a working
    // deployment over a feature they may not be using yet.
    expect(result.remedy).toContain('semantic search');
  });

  it('warns rather than throwing when psql itself cannot be run', async () => {
    // Rule 1: a check never throws. Not being able to ASK the question is not
    // an answer to it, so an unreadable catalogue must not become a hard fail.
    const result = await vectorCheck().run(
      context({ runCommand: fakeRunCommand(() => undefined) }),
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('could not read');
    expect(result.remedy ?? '').not.toBe('');
  });

  it('skips when there is no environment resolved yet', async () => {
    const result = await vectorCheck().run(context({ env: undefined }));
    expect(result.status).toBe('skip');
  });

  it('never puts the password in the argv of its probes', async () => {
    const seen: string[][] = [];
    await vectorCheck().run(
      context({
        runCommand: fakeRunCommand((argv) => {
          seen.push([...argv]);
          return { exitCode: 0, stdout: '' };
        }),
      }),
    );

    expect(seen.flat().join(' ')).not.toContain('p@ss/word#1');
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
    expect(result.remedy).toContain('--public-ip');
  });

  it('treats --public-ip as one of this host addresses', async () => {
    // Behind NAT the interfaces carry a private address; the operator states
    // the public one instead of the check asking a third party for it.
    const result = await find(DNS_CHECKS, 'dns-points-here').run(
      context({
        resolveHost: async () => ['198.51.100.7'],
        ownAddresses: async () => ['10.0.0.5'],
        publicIp: '198.51.100.7',
      }),
    );

    expect(result.status).toBe('pass');
  });

  it('skips both checks under --skip-dns and under --skip-proxy', async () => {
    for (const [flag, detail] of [
      [{ skipDns: true }, '--skip-dns'],
      [{ skipProxy: true }, '--skip-proxy'],
    ] as const) {
      const results = await runChecks(DNS_CHECKS, context({ resolveHost: async () => [], ...flag }));

      expect(results.map((result) => result.status)).toEqual(['skip', 'skip']);
      expect(results.map((result) => result.detail)).toEqual([detail, detail]);
    }
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

  it('warns when no renewal mechanism can be found, naming --install-cron', async () => {
    const result = await find(TLS_CHECKS, 'certificate-renewal').run(
      context({
        fs: { ...presentFs, exists: (path: string) => !path.includes('cron.d') },
        runCommand: fakeRunCommand(() => ({ exitCode: 1, stderr: 'disabled' })),
      }),
    );

    expect(result.status).toBe('warn');
    // A certificate nobody renews is a 90-day timer on an outage.
    expect(result.remedy).toContain('90 days');
    expect(result.remedy).toContain(`${CLI_NAME} deploy certs renew --install-cron`);
  });

  describe('accepts a renewal in any form it might take on the server', () => {
    const noTimer = fakeRunCommand((argv) =>
      argv.join(' ').startsWith('crontab -l') ? { exitCode: 1, stderr: 'no crontab for root' } : { exitCode: 1, stderr: 'disabled' },
    );
    const cronFs = (dir: Record<string, string>, crontab = ''): CheckFs => ({
      ...presentFs,
      readDir: (path) => (path === '/etc/cron.d' ? Object.keys(dir) : undefined),
      readFile: (path) => (path === '/etc/crontab' ? crontab : dir[path.replace('/etc/cron.d/', '')]),
    });

    it('certbot.timer', async () => {
      const result = await findRenewal(context({ fs: cronFs({}) }));
      expect(result).toContain('certbot.timer');
    });

    it('a cron.d file calling a shared renewal script, named by path', async () => {
      // The target server renews with a shared script under cron - nothing
      // called certbot.timer and no /etc/cron.d/certbot.
      const result = await findRenewal(
        context({
          runCommand: noTimer,
          fs: cronFs({ 'infra-tls': '# renewals\n17 3 * * * root /opt/infra/bin/renew-certs.sh\n' }),
        }),
      );
      expect(result).toBe('/etc/cron.d/infra-tls');
    });

    it("this CLI's own cron file, by name, whatever it contains", async () => {
      const result = await findRenewal(
        context({ runCommand: noTimer, fs: cronFs({ [`${CLI_NAME}-certs-demo`]: '' }) }),
      );
      expect(result).toBe(`/etc/cron.d/${CLI_NAME}-certs-demo`);
    });

    it('a line in /etc/crontab', async () => {
      const result = await findRenewal(
        context({ runCommand: noTimer, fs: cronFs({}, '0 4 * * * root docker run --rm certbot/certbot renew\n') }),
      );
      expect(result).toBe('/etc/crontab');
    });

    it("root's crontab", async () => {
      const result = await findRenewal(
        context({
          fs: cronFs({}),
          runCommand: fakeRunCommand((argv) =>
            argv.join(' ').startsWith('crontab -l')
              ? { exitCode: 0, stdout: '30 2 * * * /usr/local/bin/renew-all\n' }
              : { exitCode: 1, stderr: 'disabled' },
          ),
        }),
      );
      expect(result).toBe('crontab -l');
    });

    it('but not a commented-out line, or a cron.d file about something else', async () => {
      const result = await findRenewal(
        context({
          runCommand: noTimer,
          fs: cronFs({ backups: '# certbot renew used to live here\n0 1 * * * root /opt/backup.sh\n' }),
        }),
      );
      expect(result).toBeUndefined();
    });
  });

  it('skips every certificate check under --skip-proxy', async () => {
    const results = await runChecks(TLS_CHECKS, context({ skipProxy: true }));

    expect(results.map((result) => result.status)).toEqual(['skip', 'skip', 'skip']);
    expect(results.every((result) => result.detail === '--skip-proxy')).toBe(true);
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

  it('warns on an expired certificate, with the renew command', () => {
    const result = parseNotAfter('notAfter=Dec  1 12:00:00 2025 GMT', now);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('expired');
    // Through the CLI, never a host certbot - there is none on the server.
    expect(result.remedy).toContain(`${CLI_NAME} deploy certs renew`);
    expect(result.remedy).not.toMatch(/(^|\s)certbot renew/);
  });

  it('warns when the output cannot be read', () => {
    expect(parseNotAfter('nonsense', now).status).toBe('warn');
  });
});

describe('the complete registry', () => {
  it('runs host, GitHub, database, DNS and TLS in that order', () => {
    const ids = ALL_CHECKS.map((check) => check.id);

    // Host first: a server with no docker should say so before it starts
    // probing databases with a container it cannot run. GitHub next: the
    // clone is the first thing install does after preflight.
    expect(ids.indexOf('docker-installed')).toBeLessThan(ids.indexOf('gh-installed'));
    expect(ids.indexOf('gh-installed')).toBeLessThan(ids.indexOf('database-reachable'));
    expect(ids.indexOf('database-reachable')).toBeLessThan(ids.indexOf('dns-resolves'));
    expect(ids.indexOf('dns-resolves')).toBeLessThan(ids.indexOf('certificate-present'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries every v2 check and none of the retired ones', () => {
    const ids = ALL_CHECKS.map((check) => check.id);

    for (const id of [
      'gh-installed', 'gh-authenticated', 'gh-repo-access',
      'proxy-container', 'proxy-network-mode', 'proxy-config-valid',
      'certbot-image', 'proxy-ipv6', 'ufw-ports',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ids).not.toContain('certbot-installed');
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
