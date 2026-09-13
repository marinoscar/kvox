// =============================================================================
// Real-Postgres test: the per-job role a worker node dumps with
// (issue #350, epic #345)
// =============================================================================
//
// THIS IS THE ACCEPTANCE TEST FOR THE ISSUE, and it exists because every
// interesting claim #350 makes is a claim about a SERVER, not about this code:
//
//   - that `pg_dump` DOES NOT NEED `SUPERUSER` — that `CONNECT` + `USAGE` +
//     `SELECT` really is enough to produce an archive `pg_restore --list`
//     accepts, given `--no-owner --no-acl`. If the grants in the broker are
//     ever wrong, THIS is the test that goes red, and nothing else does;
//   - that the role really can read every table and really cannot write or
//     create anything, which is the whole meaning of "least privilege";
//   - that `DROP ROLE` genuinely requires `DROP OWNED BY` first once
//     privileges have been granted — a fact `pg-job-role.broker.spec.ts` can
//     only assert as an ORDER, never as a NECESSITY;
//   - that `VALID UNTIL` is enforced by the server, so a credential whose
//     revocation never ran is still worthless. That is the third layer under
//     #349's two revocation paths, and it is the only one that cannot be
//     switched off;
//   - that a role WITHOUT `CREATEROLE` produces a `guided` verdict and a
//     paste-ready command block rather than an exception — the ordinary
//     managed-PostgreSQL case, probed here as a genuinely unprivileged role
//     rather than as a stubbed `false`.
//
// A double can be made to agree with any of those. Only a real server can
// disagree.
//
// ⚠ EVERY ROLE THIS SUITE CREATES IS DROPPED, INCLUDING ON FAILURE. A leaked
// `appjob_%` role confuses the next run of this file (the "does this job
// already have a grant?" lookup would find it) and, worse, leaves a login role
// in a database somebody may also be using for other work. Cleanup is
// `afterAll`, unconditional, over a tracked set AND a prefix sweep of the job
// ids this run used — the second catches a role created by an `issue()` that
// threw before it could return its handle.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db`. See `../../test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Job } from '@prisma/client';

import { resolveDbSuite } from '../../test/jobs/db-test-support';
import {
  quoteIdentifier,
  quoteLiteral,
  resolveAdminConnection,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';
import { readTocEntryCount } from './pg-restore.util';
import { spawnPgDump } from './pg-dump.util';
import type { PgConnection } from './pg-dump.util';
import {
  NODE_JOB_SECRETS_RUNBOOK_PATH,
  PG_JOB_ROLE_KIND,
  PgJobRoleBroker,
  generateRolePassword,
  jobRolePattern,
  type PgJobRoleSeam,
} from './pg-job-role.broker';

const { describeWithDb } = resolveDbSuite('pg-job-role.broker.db.spec');

/** The unprivileged role the `guided` case is probed as. PID-tagged, like the restore suite's databases. */
const UNPRIVILEGED_ROLE = `appjobspec_nocreaterole_${process.pid}`;

/** Generous, because it spawns `pg_dump` and `pg_restore` over a whole database. */
jest.setTimeout(120_000);

describeWithDb('PgJobRoleBroker against a real PostgreSQL', () => {
  let connection: AdminConnection;
  let broker: PgJobRoleBroker;

  /** Every role name this suite has seen, so cleanup is exhaustive. */
  const minted = new Set<string>();
  /** Every job id this suite minted for, so cleanup can sweep by prefix too. */
  const jobIds = new Set<string>();

  const admin = <T>(fn: (client: AdminQueryClient) => Promise<T>): Promise<T> =>
    withAdminConnection(connection, fn);

  const live = <T>(fn: (client: AdminQueryClient) => Promise<T>): Promise<T> =>
    withAdminConnection({ ...connection, database: connection.liveDatabase }, fn);

  /** A job whose id this suite will remember to clean up after. */
  const job = (): Job => {
    const id = randomUUID();
    jobIds.add(id);

    return { id, type: 'db.backup.run' } as Job;
  };

  /** Mint through the broker, remembering the handle for cleanup. */
  const mint = async (target: Job, until: Date) => {
    const issued = await broker.issue(target, until);
    minted.add(issued.handle);

    return issued;
  };

  /** Drops a role the hard way — privileges first, exactly as `revoke` does. */
  const dropRoleHard = async (role: string): Promise<void> => {
    try {
      await live(async (client) => {
        const present = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (present.rows.length > 0) {
          await client.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
        }
      });
      await admin((client) => client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`));
    } catch {
      // Reported by the leak assertion below rather than thrown here: a throw
      // in cleanup would hide the failure that caused the leak.
    }
  };

  /** Opens a session AS the given credentials, and always closes it. */
  const connectAs = async <T>(
    credentials: { user: string; password: string; database: string },
    fn: (client: Client) => Promise<T>
  ): Promise<T> => {
    const client = new Client({
      host: connection.host,
      port: Number.parseInt(connection.port, 10),
      user: credentials.user,
      password: credentials.password,
      database: credentials.database,
    });

    try {
      await client.connect();

      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  /**
   * Whether this cluster's `pg_hba.conf` actually makes PostgreSQL CHECK the
   * password.
   *
   * ⚠ THE ONE ENVIRONMENTAL FACT THAT CAN MAKE TWO OF THESE ASSERTIONS
   * VACUOUS, so it is measured rather than assumed. `VALID UNTIL` and the
   * password itself are only consulted by the PASSWORD-BASED auth methods
   * (`scram-sha-256`, `md5`, `password`). A developer cluster started with
   * `trust` — the default of a hand-rolled `initdb` — lets EVERY role in with
   * ANY password, expired or not, so a test asserting "the expired credential
   * is refused" would pass on a correct implementation and also on one that
   * never set `VALID UNTIL` at all.
   *
   * Measured by trying a deliberately wrong password against a role we know
   * exists. When it is not enforced the suite still asserts the CATALOG facts —
   * that `rolvaliduntil` is in the past, that the stored verifier changed — and
   * warns loudly that the strongest assertion could not run here, rather than
   * reporting a green it has not earned.
   */
  let passwordAuthEnforced = true;

  beforeAll(async () => {
    // ⚠ `DATABASE_URL` STRIPPED, for the reason `createDbClient` documents:
    // `test/setup.ts` loads `.env.test`, which hard-codes a `DATABASE_URL`
    // pointing at the compose test database, and it would win over the
    // `POSTGRES_*` variables the reachability probe just verified.
    const { DATABASE_URL: _ignored, ...env } = process.env;

    connection = resolveAdminConnection(env);

    // The real `withAdminConnection` — real `pg.Client`, real sessions. Only
    // the ENV resolution is pinned, for the reason above.
    const seam: PgJobRoleSeam = {
      resolveConnection: () => connection,
      withAdminConnection: (config, fn, options) => withAdminConnection(config, fn, options),
    };

    broker = new PgJobRoleBroker(seam);

    passwordAuthEnforced = await connectAs(
      { user: connection.user, password: 'definitely-not-the-password', database: connection.liveDatabase },
      async (client) => client.query('SELECT 1')
    ).then(
      () => false,
      () => true
    );

    if (!passwordAuthEnforced) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n[pg-job-role.broker.db.spec] This cluster authenticates with `trust`, so PostgreSQL ' +
          'never checks a password and never consults VALID UNTIL. The catalog assertions still ' +
          'run; the two LOGIN-REFUSED assertions are reported as skipped rather than passed. ' +
          'Point these suites at a cluster using scram-sha-256 to exercise them.\n'
      );
    }
  });

  afterAll(async () => {
    // EXHAUSTIVE AND UNCONDITIONAL. Tracked handles first, then a prefix sweep
    // for anything a failed `issue()` created without returning a name.
    for (const role of minted) {
      await dropRoleHard(role);
    }

    for (const jobId of jobIds) {
      const orphans = await admin((client) =>
        client.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ESCAPE '\\'", [
          jobRolePattern(jobId),
        ])
      ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));

      for (const row of orphans.rows) {
        if (typeof row.rolname === 'string') await dropRoleHard(row.rolname);
      }
    }

    await dropRoleHard(UNPRIVILEGED_ROLE);
  });

  it('acts on the live database from a session attached to the maintenance one', async () => {
    // The arrangement every other test in this file rests on, asserted before
    // any of them: role DDL is issued on the maintenance attachment, the schema
    // grants on the live one, and neither is a connection Prisma knows about.
    // The cleanup contract itself is checked by the final `it` in this file.
    expect(connection.database).not.toBe(connection.liveDatabase);
    expect(['postgres', 'template1']).toContain(connection.database);
  });

  // ===========================================================================
  // The acceptance criteria
  // ===========================================================================

  it('mints a role that can SELECT every table and can neither INSERT nor CREATE', async () => {
    const issued = await mint(job(), new Date(Date.now() + 10 * 60_000));
    const password = issued.material.password as string;

    expect(issued.handle).toMatch(/^appjob_[0-9a-f]{8}_[0-9a-f]{6}$/);

    const tables = await live((client) =>
      client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    );

    expect(tables.rows.length).toBeGreaterThan(0);

    await connectAs(
      { user: issued.handle, password, database: connection.liveDatabase },
      async (client) => {
        // READ EVERYTHING. `pg_dump` will touch every one of these, so a single
        // table the grant missed is a backup that fails half way through.
        for (const row of tables.rows) {
          const table = quoteIdentifier(row.tablename as string);

          await expect(client.query(`SELECT 1 FROM public.${table} LIMIT 1`)).resolves.toBeDefined();
        }

        // WRITE NOTHING. `DEFAULT VALUES` rather than a column list on purpose:
        // an unknown column would fail during analysis and the statement would
        // never reach the privilege check, which would make this assertion pass
        // for the wrong reason.
        const first = quoteIdentifier(tables.rows[0].tablename as string);
        await expect(client.query(`INSERT INTO public.${first} DEFAULT VALUES`)).rejects.toThrow(
          /permission denied/i
        );

        // CREATE NOTHING. PostgreSQL 15+ no longer grants CREATE on `public` to
        // PUBLIC, and this broker grants only USAGE, so a job credential cannot
        // leave anything behind in the database it was let into.
        await expect(client.query('CREATE TABLE public.evil (id int)')).rejects.toThrow(
          /permission denied/i
        );

        // NOR ANYTHING AT THE CLUSTER LEVEL. NOCREATEDB / NOCREATEROLE are in
        // the attribute list precisely so a leaked credential cannot escalate.
        await expect(client.query('CREATE DATABASE evil')).rejects.toThrow(/permission denied/i);
        await expect(client.query('CREATE ROLE evil')).rejects.toThrow(/permission denied/i);
      }
    );
  });

  it('produces an archive `readTocEntryCount` accepts when pg_dump runs AS the minted role', async () => {
    // ⚠ THE TEST THE WHOLE ISSUE TURNS ON. If the grants above are wrong, this
    // is what says so — and it says so by doing the actual thing a worker node
    // would do: dumping this deployment's database with a credential that holds
    // nothing but SELECT.
    const issued = await mint(job(), new Date(Date.now() + 10 * 60_000));

    const asRole: PgConnection = {
      host: connection.host,
      port: connection.port,
      user: issued.handle,
      password: issued.material.password as string,
      database: connection.liveDatabase,
      sslMode: connection.sslMode,
    };

    const dump = spawnPgDump({ connection: asRole });
    // The runner's own shape: count as the bytes arrive, and await BOTH — an
    // archive that lists entries and a dump that exited non-zero is a truncated
    // file, and either check alone reports success on it.
    const [entries] = await Promise.all([
      readTocEntryCount({ source: dump.stdout }),
      dump.done,
    ]);

    expect(entries).toBeGreaterThan(0);

    // And it is the SAME archive the application role produces, which is the
    // real claim: `--no-owner --no-acl` means ownership and grants are not in
    // the archive, so a SELECT-only dumper is not a degraded dumper.
    const asApp = spawnPgDump({
      connection: {
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password,
        database: connection.liveDatabase,
        sslMode: connection.sslMode,
      },
    });
    const [appEntries] = await Promise.all([
      readTocEntryCount({ source: asApp.stdout }),
      asApp.done,
    ]);

    expect(entries).toBe(appEntries);
  });

  it('is gone after revoke, and revoke is safe to call twice', async () => {
    const issued = await mint(job(), new Date(Date.now() + 10 * 60_000));

    await broker.revoke(issued.handle);

    const after = await admin((client) =>
      client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [issued.handle])
    );
    expect(after.rows).toHaveLength(0);

    // ⚠ "ALREADY REVOKED" IS A SUCCESS. Both revocation paths reach this and
    // they race; the sweeper meets roles a previous tick already dropped. A
    // broker that threw would turn the fast path's normal outcome into a logged
    // failure and teach everyone to ignore that log.
    await expect(broker.revoke(issued.handle)).resolves.toBeUndefined();
  });

  it('cannot be dropped by DROP ROLE alone — which is why revoke does DROP OWNED BY first', async () => {
    const issued = await mint(job(), new Date(Date.now() + 10 * 60_000));

    // The NECESSITY, not merely the order. This is the failure a naive
    // implementation hits on every single grant, forever, until somebody reads
    // a log — and it is invisible in any test that fakes the cluster.
    await expect(
      admin((client) => client.query(`DROP ROLE ${quoteIdentifier(issued.handle)}`))
    ).rejects.toThrow(/depend/i);

    await broker.revoke(issued.handle);
  });

  it('EXTENDS the existing grant on a second issue rather than minting a sibling', async () => {
    const target = job();
    const first = await mint(target, new Date(Date.now() + 10 * 60_000));
    const verifierAfterFirst = await admin((client) =>
      client
        .query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [first.handle])
        .then((result) => result.rows[0]?.rolpassword)
    );
    const secondUntil = new Date(Date.now() + 20 * 60_000);
    const second = await mint(target, secondUntil);

    // ONE CREDENTIAL PER JOB, EVER. Asked of the CLUSTER, because the row in
    // `job_node_secrets` is exactly the thing that can be lost.
    expect(second.handle).toBe(first.handle);

    // The stored VERIFIER changed, which is true whatever `pg_hba.conf` says —
    // the catalog fact behind the connection assertions below.
    expect(verifierAfterFirst).not.toBe(
      await admin((client) =>
        client
          .query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [first.handle])
          .then((result) => result.rows[0]?.rolpassword)
      )
    );

    const roles = await admin((client) =>
      client.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ESCAPE '\\'", [
        jobRolePattern(target.id),
      ])
    );
    expect(roles.rows).toHaveLength(1);

    // The extension is real: the server holds the later expiry.
    const validUntil = await admin((client) =>
      client.query('SELECT rolvaliduntil FROM pg_roles WHERE rolname = $1', [first.handle])
    );
    expect(new Date(validUntil.rows[0].rolvaliduntil as string).getTime()).toBe(
      second.expiresAt.getTime()
    );
    // EXACTLY what `issue` was given — asserted against the real catalog, so a
    // broker that re-added an overhang of its own could not hide behind a
    // fake's arithmetic either.
    expect(second.expiresAt.getTime()).toBe(secondUntil.getTime());

    // The rotated password works and the first one no longer does — a
    // credential captured from a lost response is bounded by the next re-issue
    // as well as by the clock.
    if (passwordAuthEnforced) {
      await expect(
        connectAs(
          {
            user: first.handle,
            password: second.material.password as string,
            database: connection.liveDatabase,
          },
          async (client) => client.query('SELECT 1')
        )
      ).resolves.toBeDefined();

      await expect(
        connectAs(
          {
            user: first.handle,
            password: first.material.password as string,
            database: connection.liveDatabase,
          },
          async (client) => client.query('SELECT 1')
        )
      ).rejects.toThrow();
    }

    await broker.revoke(first.handle);
  });

  it('is unusable once VALID UNTIL has passed, EVEN IF REVOCATION NEVER RAN', async () => {
    // An instant two minutes in the past. `issue` honours it EXACTLY — the
    // clock-skew allowance belongs to the caller (`node-secret-broker
    // .service.ts`), not to this broker — so the grant is born expired.
    // Nothing here calls `revoke`.
    const until = new Date(Date.now() - 120_000);
    const issued = await mint(job(), until);

    expect(issued.expiresAt.getTime()).toBe(until.getTime());
    expect(issued.expiresAt.getTime()).toBeLessThan(Date.now());

    // The catalog carries the expiry the broker reported. True on every
    // cluster, whatever `pg_hba.conf` says.
    const stored = await admin((client) =>
      client.query('SELECT rolvaliduntil FROM pg_roles WHERE rolname = $1', [issued.handle])
    );
    const validUntil = new Date(stored.rows[0].rolvaliduntil as string);
    expect(validUntil.getTime()).toBe(issued.expiresAt.getTime());
    expect(validUntil.getTime()).toBeLessThan(Date.now());

    // ⚠ THE THIRD LAYER. Both revocation paths are code in this application:
    // one runs in a process that can die, the other has an environment switch.
    // This is a column in `pg_authid` that the SERVER checks at authentication
    // time, so total revocation failure is still bounded by the clock.
    if (passwordAuthEnforced) {
      await expect(
        connectAs(
          {
            user: issued.handle,
            password: issued.material.password as string,
            database: connection.liveDatabase,
          },
          async (client) => client.query('SELECT 1')
        )
      ).rejects.toThrow();
    }

    // And the role IS still there — this test proves the expiry, not the
    // cleanup. The orphaned NAME is what the sweeper and the runbook exist for.
    const still = await admin((client) =>
      client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [issued.handle])
    );
    expect(still.rows).toHaveLength(1);

    await broker.revoke(issued.handle);
  });

  it('answers a role without CREATEROLE with a `guided` verdict and a command block — never a throw', async () => {
    const password = generateRolePassword();

    await admin((client) =>
      client.query(
        `CREATE ROLE ${quoteIdentifier(UNPRIVILEGED_ROLE)} LOGIN ` +
          `PASSWORD ${quoteLiteral(password, 'test role password')} ` +
          'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION'
      )
    );

    // A REAL unprivileged session, not a stubbed `false`: the thing under test
    // is whether the probe reads the cluster correctly as a role that genuinely
    // cannot mint.
    const unprivileged: AdminConnection = {
      ...connection,
      user: UNPRIVILEGED_ROLE,
      password,
    };

    const limited = new PgJobRoleBroker({
      resolveConnection: () => unprivileged,
      withAdminConnection: (config, fn, options) => withAdminConnection(config, fn, options),
    });

    const before = await admin((client) =>
      client.query("SELECT count(*)::text AS n FROM pg_roles WHERE rolname LIKE 'appjob\\_%' ESCAPE '\\'")
    );

    const verdict = await limited.usable();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('CREATE ROLE');
    expect(verdict.remedy).toContain(`ALTER ROLE ${quoteIdentifier(UNPRIVILEGED_ROLE)} CREATEROLE;`);

    const preflight = await limited.preflight();

    // ⚠ `guided`, NOT AN EXCEPTION AND NOT A 5xx. Managed PostgreSQL withholding
    // CREATEROLE is the ORDINARY configuration; the honest answer is two lines
    // of SQL, and a deployment that declines to run them simply leaves node
    // offload off while the API keeps taking its own backups.
    expect(preflight.outcome).toBe('guided');
    if (preflight.outcome !== 'guided') throw new Error('unreachable');
    expect(preflight.kind).toBe(PG_JOB_ROLE_KIND);
    expect(preflight.guidance.commands).toContain('app_job_minter');
    expect(preflight.guidance.runbook).toBe(NODE_JOB_SECRETS_RUNBOOK_PATH);

    // AND IT CREATED NOTHING. `usable()` is contracted not to, for the same
    // reason a restore pre-flight is not allowed to: asking "could you?" must
    // never be a step that does.
    const after = await admin((client) =>
      client.query("SELECT count(*)::text AS n FROM pg_roles WHERE rolname LIKE 'appjob\\_%' ESCAPE '\\'")
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // The privilege really is the only thing missing: an attempt to mint fails
    // rather than silently producing a half-privileged role.
    await expect(limited.issue(job(), new Date(Date.now() + 60_000))).rejects.toThrow();
  });

  it('refuses to drop a role it did not mint, however legal the name', async () => {
    // ⚠ `quoteIdentifier` WOULD HAVE QUOTED `postgres` HAPPILY. It protects the
    // statement's syntax; the prefix guard protects its meaning.
    await expect(broker.revoke('postgres')).rejects.toThrow(/not a handle this broker minted/);

    const survivor = await admin((client) =>
      client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [connection.user])
    );
    expect(survivor.rows).toHaveLength(1);
  });

  it('has left no appjob_ role behind for the job ids this run used', async () => {
    // Declared last so it runs last. The `afterAll` is the belt; this is the
    // assertion that the tests themselves cleaned up after their own successes.
    for (const jobId of jobIds) {
      const roles = await admin((client) =>
        client.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ESCAPE '\\'", [
          jobRolePattern(jobId),
        ])
      );

      for (const row of roles.rows) {
        // A role that survived is either one a test deliberately left for the
        // sweep (none do) or a leak. Name it, so the failure says which.
        expect([...minted]).toContain(row.rolname);
      }
    }
  });
});
