// =============================================================================
// PgJobRoleBroker unit coverage (issue #350, epic #345)
// =============================================================================
//
// WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY CANNOT PROVE.
//
// Everything here runs against a FAKE cluster, so it can assert the things that
// are decisions — the statement text, the attribute list, the two connections,
// the ordering of a failed mint's undo, the cache, the guarded handle — quickly
// and on a machine with no PostgreSQL. What it cannot possibly assert is
// whether PostgreSQL AGREES: whether those grants are enough for `pg_dump`,
// whether `DROP ROLE` really needs `DROP OWNED BY` first, whether `VALID UNTIL`
// really locks the role out. Those are facts about a server, and asserting them
// against a double would only prove this file's own assumptions back to itself.
//
// `pg-job-role.broker.db.spec.ts` owns all of them against a real PostgreSQL 16,
// and it is the acceptance test for the issue. Read the two together; neither
// is sufficient alone.
// =============================================================================

import { Job } from '@prisma/client';

import { InvalidSqlLiteralError } from './admin-connection.util';
import type { AdminConnection, AdminQueryClient } from './admin-connection.util';
import {
  JOB_ROLE_PREFIX,
  NODE_JOB_SECRETS_RUNBOOK_PATH,
  PG_JOB_ROLE_KIND,
  PgJobRoleBroker,
  ROLE_CONNECTION_LIMIT,
  ROLE_PASSWORD_CHARS,
  USABLE_CACHE_MS,
  assertBrokerHandle,
  buildCreateRoleGrantCommands,
  buildJobRoleName,
  generateRolePassword,
  jobRolePattern,
  jobRoleSlug,
  type PgJobRoleSeam,
} from './pg-job-role.broker';

const CONNECTION: AdminConnection = {
  host: 'db.internal',
  port: '5432',
  user: 'appuser',
  password: 'app-password',
  database: 'postgres',
  liveDatabase: 'appdb',
  sslMode: null,
};

const JOB = { id: '1234abcd-5678-4ef0-9012-3456789abcde', type: 'db.backup.run' } as Job;
const LEASE_END = new Date('2026-09-07T18:00:00.000Z');

/** One statement, with the database the session issuing it was attached to. */
interface RecordedQuery {
  database: string;
  text: string;
  values?: unknown[];
}

interface HarnessOptions {
  /** Rows a `SELECT` answers with, keyed by a fragment of the statement. */
  rows?: (text: string, values?: unknown[]) => Array<Record<string, unknown>>;
  /** Statements that should fail, matched by fragment. */
  failOn?: (text: string) => Error | null;
  /** Makes `withAdminConnection` itself reject — an unreachable cluster. */
  connectError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const queries: RecordedQuery[] = [];

  const seam: PgJobRoleSeam = {
    resolveConnection: () => ({ ...CONNECTION }),
    withAdminConnection: async (config, fn) => {
      if (options.connectError) throw options.connectError;

      const client: AdminQueryClient = {
        connect: async () => undefined,
        end: async () => undefined,
        query: async (text: string, values?: unknown[]) => {
          queries.push({ database: config.database, text, values });

          const failure = options.failOn?.(text);
          if (failure) throw failure;

          return { rows: options.rows?.(text, values) ?? [], rowCount: null };
        },
      };

      return fn(client);
    },
  };

  return { seam, queries, broker: new PgJobRoleBroker(seam) };
}

/** Rows for a cluster where the connected role holds CREATEROLE. */
const CAN_CREATE_ROLE = (text: string) =>
  text.includes('rolcreaterole') ? [{ can_create: true }] : [];

/** Rows for a cluster where it does not — the ordinary managed-PostgreSQL case. */
const CANNOT_CREATE_ROLE = (text: string) =>
  text.includes('rolcreaterole') ? [{ can_create: false }] : [];

const ddl = (queries: RecordedQuery[]): RecordedQuery[] =>
  queries.filter((query) => !/^\s*SELECT/i.test(query.text));

describe('the role name', () => {
  it('is appjob_<job fragment>_<random>, and the fragment identifies the job', () => {
    const name = buildJobRoleName(JOB.id);

    expect(name).toMatch(/^appjob_1234abcd_[0-9a-f]{6}$/);
    expect(name.startsWith(JOB_ROLE_PREFIX)).toBe(true);
    // Comfortably inside NAMEDATALEN-1, which is what stops the server
    // silently truncating two names into one.
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
  });

  it('never repeats, so a re-issue after a lost row cannot collide with a live role', () => {
    const names = new Set(Array.from({ length: 200 }, () => buildJobRoleName(JOB.id)));

    // ⚠ THE REASON THE SUFFIX EXISTS. A name that is a pure function of the job
    // id makes `CREATE ROLE` fail on re-issue, and the obvious fix — dropping
    // first — would invalidate a credential another executor is using now.
    expect(names.size).toBe(200);
  });

  it('survives a job id with nothing identifier-safe in it', () => {
    expect(jobRoleSlug('---')).toBe('job');
    expect(jobRoleSlug('')).toBe('job');
    expect(() => buildJobRoleName('---')).not.toThrow();
  });

  it('escapes the underscores in its LIKE pattern', () => {
    // `_` is LIKE's single-character wildcard. Unescaped, `appjob_1234abcd_%`
    // also matches `appjobX1234abcdY...` — which matches nothing today, which
    // is exactly why the bug would survive review.
    expect(jobRolePattern(JOB.id)).toBe('appjob\\_1234abcd\\_%');
  });
});

describe('the generated password', () => {
  it('is drawn from exactly the alphabet quoteLiteral accepts', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(generateRolePassword()).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('is 43 characters — ~256 bits, derived from randomBytes(32) and not chosen for looks', () => {
    expect(generateRolePassword()).toHaveLength(ROLE_PASSWORD_CHARS);
    expect(generateRolePassword(12)).toHaveLength(12);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRolePassword()));

    expect(seen.size).toBe(200);
  });

  it('uses the whole alphabet, so rejection sampling has not silently truncated it', () => {
    const seen = new Set(generateRolePassword(20_000).split(''));

    // 62 characters, every one reachable. A `% 62` over raw bytes would still
    // pass this — what it would fail is being uniform, which is why the
    // implementation rejects rather than folds.
    expect(seen.size).toBe(62);
  });
});

describe('assertBrokerHandle', () => {
  it('accepts a handle this broker minted', () => {
    expect(() => assertBrokerHandle(buildJobRoleName(JOB.id))).not.toThrow();
  });

  it.each(['postgres', 'appuser', '', 'app_job_minter', 'APPJOB_x'])(
    'refuses "%s" — quoteIdentifier would have quoted it happily',
    (handle) => {
      // ⚠ THE GUARD THAT STOPS `DROP ROLE postgres`. quoteIdentifier protects
      // the statement's SYNTAX; this protects its MEANING.
      expect(() => assertBrokerHandle(handle)).toThrow(/not a handle this broker minted/);
    }
  );
});

describe('the guided command block', () => {
  it('names the deployment\'s real role and offers both grants', () => {
    const commands = buildCreateRoleGrantCommands('appuser');

    // A block with a placeholder in it is not a deliverable, it is homework.
    expect(commands).toContain('ALTER ROLE "appuser" CREATEROLE;');
    expect(commands).toContain('CREATE ROLE app_job_minter NOINHERIT CREATEROLE;');
    expect(commands).toContain('GRANT app_job_minter TO "appuser";');
    expect(commands).not.toContain('<');
  });

  it('refuses to build a block around an illegal role name', () => {
    // The role comes from the deployment's own configuration, so this is a
    // guard against a malformed `POSTGRES_USER` reaching a paste-ready block
    // that an administrator would run as a superuser.
    expect(() => buildCreateRoleGrantCommands('app"user; DROP ROLE x')).toThrow();
  });
});

describe('usable()', () => {
  it('says yes when the connected role may CREATE ROLE, having created nothing', async () => {
    const { broker, queries } = harness({ rows: CAN_CREATE_ROLE });

    await expect(broker.usable()).resolves.toEqual({ ok: true });

    // ⚠ `JobSecretBroker.usable()` MUST NOT CREATE, DROP OR RENAME ANYTHING.
    // Asking "could you mint one?" is not asking for one.
    expect(ddl(queries)).toHaveLength(0);
    expect(queries).toHaveLength(1);
  });

  it('says no with a paste-ready remedy when it may not', async () => {
    const { broker } = harness({ rows: CANNOT_CREATE_ROLE });

    const verdict = await broker.usable();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');

    expect(verdict.reason).toContain('CREATE ROLE');
    // The reason is what a node carries in its 503; the remedy is what a person
    // pastes. Splitting them is the whole point of the pair.
    expect(verdict.remedy).toContain('ALTER ROLE "appuser" CREATEROLE;');
  });

  it('turns an unreachable cluster into a verdict, never a stack trace on a node\'s request', async () => {
    const { broker } = harness({ connectError: new Error('ECONNREFUSED') });

    const verdict = await broker.usable();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('ECONNREFUSED');
    expect(verdict.remedy).toContain(NODE_JOB_SECRETS_RUNBOOK_PATH);
  });

  it('caches the probe, so a polling fleet does not ask once per node per tick', async () => {
    const { broker, queries } = harness({ rows: CAN_CREATE_ROLE });

    await broker.usable();
    await broker.usable();
    await broker.usable();

    expect(queries).toHaveLength(1);
  });

  it('caches a FAILING probe too — the case a whole fleet re-asks hardest', async () => {
    const { broker, queries } = harness({ connectError: new Error('ECONNREFUSED') });

    await broker.usable();
    await broker.usable();

    // Re-running a failing connection attempt per node per tick is how a
    // database problem becomes a database outage.
    expect(queries).toHaveLength(0);
    expect(broker).toBeDefined();
  });

  it('re-probes once the cache has aged out', async () => {
    const { broker, queries } = harness({ rows: CAN_CREATE_ROLE });

    await broker.usable();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + USABLE_CACHE_MS + 1);

    try {
      await broker.usable();
      expect(queries).toHaveLength(2);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('preflight()', () => {
  it('reports `ok` with the role and the database it would grant on', async () => {
    const { broker } = harness({ rows: CAN_CREATE_ROLE });

    const result = await broker.preflight();

    expect(result.outcome).toBe('ok');
    expect(result.kind).toBe(PG_JOB_ROLE_KIND);
    expect(result.databaseRole).toBe('appuser');
    expect(result.targetDatabase).toBe('appdb');
  });

  it('reports `guided` — never a throw — with the SQL that fixes it', async () => {
    const { broker } = harness({ rows: CANNOT_CREATE_ROLE });

    const result = await broker.preflight();

    // ⚠ THE ORDINARY MANAGED-POSTGRESQL ANSWER, and it is a verdict rather than
    // an error for the same reason the restore pre-flight's CREATEDB gate is.
    expect(result.outcome).toBe('guided');
    if (result.outcome !== 'guided') throw new Error('unreachable');
    expect(result.guidance.commands).toContain('ALTER ROLE "appuser" CREATEROLE;');
    expect(result.guidance.commands).toContain('app_job_minter');
    expect(result.guidance.runbook).toBe(NODE_JOB_SECRETS_RUNBOOK_PATH);
  });

  it('says so plainly when there was nothing to probe, rather than offering a GRANT that would not help', async () => {
    const { broker } = harness({ connectError: new Error('ECONNREFUSED') });

    const result = await broker.preflight();

    expect(result.outcome).toBe('guided');
    if (result.outcome !== 'guided') throw new Error('unreachable');
    expect(result.guidance.commands).toContain('could not be reached');
    expect(result.guidance.commands).not.toContain('ALTER ROLE');
  });

  it('takes a FRESH probe, because the operator has usually just run the GRANT', async () => {
    let canCreate = false;
    const { broker, queries } = harness({
      rows: (text) => (text.includes('rolcreaterole') ? [{ can_create: canCreate }] : []),
    });

    await expect(broker.preflight()).resolves.toMatchObject({ outcome: 'guided' });

    canCreate = true;

    // A minute-old "still no" is how a correct fix reads as a broken one.
    await expect(broker.preflight()).resolves.toMatchObject({ outcome: 'ok' });
    expect(queries).toHaveLength(2);
  });

  it('creates nothing', async () => {
    const { broker, queries } = harness({ rows: CANNOT_CREATE_ROLE });

    await broker.preflight();

    expect(ddl(queries)).toHaveLength(0);
  });
});

describe('issue()', () => {
  it('creates a LOGIN role with every attribute spelled out, and no privilege beyond reading', async () => {
    const { broker, queries } = harness();

    const issued = await broker.issue(JOB, LEASE_END);

    const create = queries.find((query) => query.text.startsWith('CREATE ROLE'));
    expect(create).toBeDefined();

    // ⚠ THE ATTRIBUTE LIST IS THE LEAST-PRIVILEGE PROMISE. Spelled out rather
    // than relying on defaults, so a cluster-level `ALTER ROLE ... SET` or a
    // future PostgreSQL default cannot quietly widen a job credential.
    expect(create?.text).toContain('NOSUPERUSER');
    expect(create?.text).toContain('NOCREATEDB');
    expect(create?.text).toContain('NOCREATEROLE');
    expect(create?.text).toContain('NOINHERIT');
    expect(create?.text).toContain('NOREPLICATION');
    expect(create?.text).toContain(`CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT}`);
    expect(create?.text).toContain(`"${issued.handle}"`);
    // Issued on the MAINTENANCE database: roles are cluster-wide, and this is
    // the attachment the restore path already insists on.
    expect(create?.database).toBe('postgres');
  });

  it('sets VALID UNTIL to EXACTLY the instant it was given, and reports that as expiresAt', async () => {
    const { broker, queries } = harness();

    const issued = await broker.issue(JOB, LEASE_END);

    // ⚠ THE ASSERTION THAT KEEPS THE CONTRACT TRUE. `JobSecretBroker.issue`
    // says a broker may grant LESS and must not grant more, so this broker adds
    // nothing — no rounding, no padding, no overhang of its own. The clock-skew
    // allowance a database credential needs is the CALLER's
    // (`SECRET_CLOCK_SKEW_ALLOWANCE_MS`), taken once for every broker rather
    // than reinvented per backend. A future change that quietly re-added a
    // grace here fails right at this line.
    expect(issued.expiresAt.toISOString()).toBe(LEASE_END.toISOString());
    expect(issued.expiresAt.getTime()).toBe(LEASE_END.getTime());

    // ⚠ THE THIRD LAYER, ENFORCED BY POSTGRESQL AND NOT BY THIS APPLICATION.
    // Both revocation paths are code that can be switched off or never reached;
    // this is a column the server checks at authentication time.
    expect(
      queries.find((query) => query.text.startsWith('CREATE ROLE'))?.text
    ).toContain(`VALID UNTIL '${LEASE_END.toISOString()}'`);
  });

  it('does not alias the Date it was handed, so a caller mutating it cannot move a live grant', async () => {
    const { broker } = harness();
    const until = new Date(LEASE_END.getTime());

    const issued = await broker.issue(JOB, until);
    until.setFullYear(until.getFullYear() + 10);

    expect(issued.expiresAt.getTime()).toBe(LEASE_END.getTime());
  });

  it('extends to exactly the new instant on a re-issue, still adding nothing', async () => {
    const existing = 'appjob_1234abcd_aabbcc';
    const { broker, queries } = harness({
      rows: (text) => (text.includes('pg_roles') ? [{ rolname: existing }] : []),
    });

    const later = new Date(LEASE_END.getTime() + 30 * 60_000);
    const issued = await broker.issue(JOB, later);

    expect(issued.expiresAt.toISOString()).toBe(later.toISOString());
    expect(queries.find((query) => query.text.startsWith('ALTER ROLE'))?.text).toContain(
      `VALID UNTIL '${later.toISOString()}'`
    );
  });

  it('grants CONNECT on the cluster session and the read privileges on the LIVE database', async () => {
    const { broker, queries } = harness();

    const issued = await broker.issue(JOB, LEASE_END);
    const grants = queries.filter((query) => query.text.startsWith('GRANT'));

    expect(grants.map((query) => `${query.database}:${query.text}`)).toEqual([
      `postgres:GRANT CONNECT ON DATABASE "appdb" TO "${issued.handle}"`,
      `appdb:GRANT USAGE ON SCHEMA public TO "${issued.handle}"`,
      `appdb:GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${issued.handle}"`,
      `appdb:GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO "${issued.handle}"`,
    ]);
  });

  it('hands back discrete connection fields and never a DSN', async () => {
    const { broker } = harness();

    const issued = await broker.issue(JOB, LEASE_END);

    expect(issued.material).toEqual({
      driver: 'postgresql',
      host: 'db.internal',
      port: '5432',
      database: 'appdb',
      user: issued.handle,
      password: expect.stringMatching(/^[A-Za-z0-9]{43}$/),
      sslMode: null,
    });

    // ⚠ A `postgresql://user:pass@host/db` string is one accidental log line
    // away from a leaked password, and building one means percent-encoding the
    // password into a URL — the exact round trip #172 exists to stop.
    expect(JSON.stringify(issued.material)).not.toContain('postgresql://');
  });

  it('puts nothing secret in the handle — it is the only half that is persisted', async () => {
    const { broker } = harness();

    const issued = await broker.issue(JOB, LEASE_END);

    expect(issued.handle).toMatch(/^appjob_[0-9a-f]{8}_[0-9a-f]{6}$/);
    expect(issued.handle).not.toContain(issued.material.password as string);
  });

  it('EXTENDS an existing grant rather than minting a sibling, keeping the same handle', async () => {
    const existing = 'appjob_1234abcd_aabbcc';
    const { broker, queries } = harness({
      rows: (text) => (text.includes('pg_roles') ? [{ rolname: existing }] : []),
    });

    const issued = await broker.issue(JOB, LEASE_END);

    // ⚠ ONE CREDENTIAL PER JOB, EVER. A broker that minted per call would leak
    // one role per node restart into the database it is protecting, and the
    // revocation paths — which know exactly one handle — would clean up
    // exactly one of them.
    expect(issued.handle).toBe(existing);
    expect(queries.some((query) => query.text.startsWith('CREATE ROLE'))).toBe(false);

    const alter = queries.find((query) => query.text.startsWith('ALTER ROLE'));
    expect(alter?.text).toContain(`"${existing}"`);
    // Re-asserts the full attribute list rather than trusting whatever the role
    // currently carries.
    expect(alter?.text).toContain('NOSUPERUSER');
  });

  it('asks the CLUSTER which roles exist, not the bookkeeping', async () => {
    const { broker, queries } = harness();

    await broker.issue(JOB, LEASE_END);

    const lookup = queries.find((query) => query.text.includes('pg_roles'));

    // The row in `job_node_secrets` is exactly the thing that can be lost —
    // which is why layer 3 exists — so a broker whose idempotence depended on
    // it would fail in precisely the case it is needed.
    expect(lookup?.values).toEqual([jobRolePattern(JOB.id)]);
  });

  it('rotates the password on a re-issue, because nothing still knows the old one', async () => {
    const existing = 'appjob_1234abcd_aabbcc';
    const { broker } = harness({
      rows: (text) => (text.includes('pg_roles') ? [{ rolname: existing }] : []),
    });

    const first = await broker.issue(JOB, LEASE_END);
    const second = await broker.issue(JOB, LEASE_END);

    expect(first.handle).toBe(second.handle);
    expect(first.material.password).not.toBe(second.material.password);
  });

  it('DROPS a role it created but could not grant — an unrecorded grant is unfindable', async () => {
    const { broker, queries } = harness({
      // `rolname = $1` is the existence check the undo makes; `rolname LIKE $1`
      // is the "does this job already have a grant?" lookup, which must stay
      // empty so this is the CREATE path.
      rows: (text) => (text.includes('rolname = $1') ? [{ '?column?': 1 }] : []),
      failOn: (text) =>
        text.startsWith('GRANT SELECT ON ALL TABLES') ? new Error('permission denied') : null,
    });

    await expect(broker.issue(JOB, LEASE_END)).rejects.toThrow('permission denied');

    // ⚠ THE CHEAP FAILURE UNDOES THE EXPENSIVE SUCCESS. The caller never learns
    // the handle, so a surviving role is a live login neither revocation path
    // could ever find.
    expect(queries.some((query) => query.text.startsWith('DROP ROLE IF EXISTS'))).toBe(true);
  });

  it('does NOT drop a role it merely re-issued, because that credential is in use', async () => {
    const existing = 'appjob_1234abcd_aabbcc';
    const { broker, queries } = harness({
      rows: (text) => (text.includes('pg_roles') ? [{ rolname: existing }] : []),
      failOn: (text) =>
        text.startsWith('GRANT SELECT ON ALL TABLES') ? new Error('permission denied') : null,
    });

    await expect(broker.issue(JOB, LEASE_END)).rejects.toThrow('permission denied');

    // It already has a `job_node_secrets` row, so it is still recorded and
    // still revocable — and an executor may be using it right now.
    expect(queries.some((query) => query.text.startsWith('DROP ROLE'))).toBe(false);
  });

  it('refuses to build a statement around a password outside the generated alphabet', () => {
    // Belt and braces on the seam between the generator and the quoter: the
    // generator cannot produce this, and if it ever did the statement would not
    // be built at all.
    expect(() => {
      const { quoteLiteral } = jest.requireActual<typeof import('./admin-connection.util')>(
        './admin-connection.util'
      );

      return quoteLiteral("hunter2'; DROP ROLE appuser; --", 'role password');
    }).toThrow(InvalidSqlLiteralError);
  });
});

describe('revoke()', () => {
  const HANDLE = 'appjob_1234abcd_aabbcc';
  const rolePresent = (text: string) => (text.includes('pg_roles') ? [{ '?column?': 1 }] : []);

  it('clears the privileges first and only then drops the role', async () => {
    const { broker, queries } = harness({ rows: rolePresent });

    await broker.revoke(HANDLE);

    const statements = ddl(queries).map((query) => `${query.database}:${query.text}`);

    // ⚠ THE ORDER IS FORCED BY POSTGRESQL. A role holding granted privileges
    // cannot be dropped ("cannot be dropped because some objects depend on
    // it"), and getting this backwards produces a revocation that throws every
    // time, forever, for every grant.
    expect(statements).toEqual([
      `appdb:DROP OWNED BY "${HANDLE}"`,
      `postgres:DROP ROLE IF EXISTS "${HANDLE}"`,
    ]);
  });

  it('disconnects the role\'s sessions first — DROP ROLE does not', async () => {
    const { broker, queries } = harness({ rows: rolePresent });

    await broker.revoke(HANDLE);

    const terminate = queries.find((query) => query.text.includes('pg_terminate_backend'));

    // Without this, "revoked" means "cannot reconnect" while a node keeps
    // streaming on the connection it already had.
    expect(terminate?.values).toEqual([HANDLE]);
    expect(queries.indexOf(terminate!)).toBeLessThan(
      queries.findIndex((query) => query.text.startsWith('DROP OWNED BY'))
    );
  });

  it('drops anyway when it may not signal backends', async () => {
    const { broker, queries } = harness({
      rows: rolePresent,
      failOn: (text) =>
        text.includes('pg_terminate_backend') ? new Error('permission denied') : null,
    });

    // `pg_signal_backend` is not granted everywhere, and failing to disconnect
    // a session that is about to lose its role anyway must not stop the drop.
    await expect(broker.revoke(HANDLE)).resolves.toBeUndefined();
    expect(queries.some((query) => query.text.startsWith('DROP ROLE IF EXISTS'))).toBe(true);
  });

  it('is a no-op success when the role is already gone', async () => {
    const { broker, queries } = harness({ rows: () => [] });

    // ⚠ "ALREADY REVOKED" IS A SUCCESS. Both revocation paths reach here, they
    // race, and the sweeper routinely meets roles a previous tick dropped. A
    // broker that threw would turn the fast path's normal outcome into a logged
    // failure and teach everyone to ignore the log.
    await expect(broker.revoke(HANDLE)).resolves.toBeUndefined();
    expect(ddl(queries)).toHaveLength(0);
  });

  it('treats a race that ended with the role gone as success', async () => {
    let seen = 0;
    const { broker } = harness({
      // Present on the first look, absent on the re-check after the failure.
      rows: (text) => {
        if (!text.includes('pg_roles')) return [];
        seen += 1;

        return seen === 1 ? [{ '?column?': 1 }] : [];
      },
      failOn: (text) => (text.startsWith('DROP OWNED BY') ? new Error('role does not exist') : null),
    });

    await expect(broker.revoke(HANDLE)).resolves.toBeUndefined();
  });

  it('rethrows a real failure, so the row stays unrevoked for the next sweep', async () => {
    const { broker } = harness({
      rows: rolePresent,
      failOn: (text) => (text.startsWith('DROP ROLE') ? new Error('deadlock detected') : null),
    });

    await expect(broker.revoke(HANDLE)).rejects.toThrow('deadlock detected');
  });

  it('refuses a handle outside its own namespace, issuing no DDL at all', async () => {
    const { broker, queries } = harness({ rows: rolePresent });

    await expect(broker.revoke('postgres')).rejects.toThrow(/not a handle this broker minted/);
    expect(queries).toHaveLength(0);
  });
});
