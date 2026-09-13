// =============================================================================
// Real-Postgres test: the cluster operations a restore's swap is built out of
// (issue #285, epic #254)
// =============================================================================
//
// `database-restore.service.spec.ts` drives the whole restore against a fake
// cluster, which is the only way to test a sequence that takes hours and ends in
// `process.exit`. What it CANNOT test is whether PostgreSQL behaves the way that
// fake assumes — and every assumption in this subsystem is load-bearing:
//
//   - that `CREATE DATABASE` / `ALTER DATABASE ... RENAME` / `DROP DATABASE`
//     work from a session attached to the MAINTENANCE database and only from
//     there;
//   - that a rename into a name that is already taken FAILS RATHER THAN
//     OVERWRITING, which is the precondition for the inner recovery being
//     meaningful at all;
//   - that renaming the original back after such a failure genuinely restores
//     the deployment;
//   - that `withAdminConnection` leaves NO SESSION BEHIND, because a leaked
//     session is what makes a later rename fail — at the worst possible moment,
//     after the archive has been replayed and the application has been stopped;
//   - that a foreign key resolved THROUGH A SUBSELECT yields NULL instead of
//     aborting the statement, which is what keeps one missing user from
//     destroying the whole catalog carry-over.
//
// ⚠ IT MUST NEVER TOUCH THE DATABASE THE SUITE ITSELF IS CONNECTED TO. Every
// database this file creates carries {@link PREFIX}, every one is dropped in a
// `finally`/`afterAll` even when a test fails, and the live database's name is
// asserted to be untouched at the end. A test that can drop `appdb` is a test
// nobody can afford to run.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db`. See `../../test/jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { resolveDbSuite } from '../../test/jobs/db-test-support';
import {
  createDatabase,
  databaseExists,
  dropDatabase,
  quoteIdentifier,
  renameDatabase,
  resolveAdminConnection,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';

const { describeWithDb } = resolveDbSuite('database-restore.db.spec');

/**
 * The prefix every database this suite creates carries.
 *
 * ⚠ DELIBERATELY NOT `<live>_restore_` OR `<live>_old_`. Those are the names the
 * real restore builds; a suite that used them could not tell its own leftovers
 * from a real restore's, and a cleanup that dropped "anything that looks like a
 * scratch database" on a shared CI cluster would eventually drop somebody's. The
 * PID keeps two concurrent runs of this file apart.
 */
const PREFIX = `restore_spec_${process.pid}_`;

describeWithDb('Restore cluster operations (real Postgres)', () => {
  let connection: AdminConnection;

  /** Every database this suite has created, so cleanup is exhaustive. */
  const created = new Set<string>();

  /** A unique, prefixed, `quoteIdentifier`-legal database name. */
  const name = (label: string): string => {
    const value = `${PREFIX}${label}`;

    // Proves the name is one this subsystem would accept before we create it —
    // a name the allowlist rejects would fail the cleanup, not just the test.
    quoteIdentifier(value);
    created.add(value);

    return value;
  };

  const admin = <T>(fn: (client: AdminQueryClient) => Promise<T>): Promise<T> =>
    withAdminConnection(connection, fn);

  beforeAll(() => {
    // ⚠ `DATABASE_URL` STRIPPED, for the reason `createDbClient` documents:
    // `test/setup.ts` loads `.env.test`, which hard-codes a `DATABASE_URL`
    // pointing at the compose test database, and it would win over the
    // `POSTGRES_*` variables the reachability probe just verified.
    const { DATABASE_URL: _ignored, ...env } = process.env;

    connection = resolveAdminConnection(env);
  });

  afterAll(async () => {
    // EXHAUSTIVE AND UNCONDITIONAL. Every name, whether or not the test that
    // created it got as far as dropping it.
    await withAdminConnection(connection, async (client) => {
      for (const database of created) {
        try {
          await dropDatabase(client, database);
        } catch {
          // Reported by the leak assertion below rather than thrown here: a
          // throw in `afterAll` would hide the failure that caused the leak.
        }
      }
    }).catch(() => undefined);
  });

  it('attaches to the maintenance database, never to the application\'s', () => {
    // The one arrangement that cannot work is an admin session inside the
    // database the swap has to rename.
    expect(connection.database).not.toBe(connection.liveDatabase);
    expect(['postgres', 'template1']).toContain(connection.database);
  });

  it('creates a scratch database, renames it into place and back, and drops it', async () => {
    // The restore's whole shape, minus the archive: a database is created,
    // renamed to a second name, renamed back, and removed. Nothing here is a
    // mock of PostgreSQL's behaviour — the cluster either does this or it does
    // not.
    const scratch = name('scratch');
    const promoted = name('promoted');

    try {
      await admin(async (client) => {
        expect(await databaseExists(client, scratch)).toBe(false);

        await createDatabase(client, scratch);
        expect(await databaseExists(client, scratch)).toBe(true);

        await renameDatabase(client, scratch, promoted);
        expect(await databaseExists(client, scratch)).toBe(false);
        expect(await databaseExists(client, promoted)).toBe(true);

        // ...and back, which is the rollback in one statement.
        await renameDatabase(client, promoted, scratch);
        expect(await databaseExists(client, scratch)).toBe(true);
        expect(await databaseExists(client, promoted)).toBe(false);
      });
    } finally {
      await admin(async (client) => {
        await dropDatabase(client, scratch);
        await dropDatabase(client, promoted);
      });
    }

    await admin(async (client) => {
      expect(await databaseExists(client, scratch)).toBe(false);
    });
  });

  it('REFUSES a rename onto a name that is already taken', async () => {
    // ⚠ THE PRECONDITION FOR THE WHOLE DESIGN. If a rename could silently
    // replace an existing database, the swap's second statement could destroy
    // the original after the first had renamed it — and the inner recovery would
    // have nothing left to recover.
    const first = name('taken_a');
    const second = name('taken_b');

    try {
      await admin(async (client) => {
        await createDatabase(client, first);
        await createDatabase(client, second);

        await expect(renameDatabase(client, second, first)).rejects.toThrow(/already exists/i);

        // Both still there, both still themselves.
        expect(await databaseExists(client, first)).toBe(true);
        expect(await databaseExists(client, second)).toBe(true);
      });
    } finally {
      await admin(async (client) => {
        await dropDatabase(client, first);
        await dropDatabase(client, second);
      });
    }
  });

  it('recovers the original when the second rename of a swap fails', async () => {
    // THE ONE GENUINELY DANGEROUS MOMENT, rehearsed against a real cluster: park
    // the original, fail to promote the replacement, put the original back.
    const live = name('swap_live');
    const parked = name('swap_old');
    const missing = name('swap_never_created');

    try {
      await admin(async (client) => {
        await createDatabase(client, live);

        // Statement 1 of the swap.
        await renameDatabase(client, live, parked);

        // ⚠ HERE THERE IS NO DATABASE UNDER THE LIVE NAME.
        expect(await databaseExists(client, live)).toBe(false);

        // Statement 2 fails — the replacement is not there.
        await expect(renameDatabase(client, missing, live)).rejects.toThrow();

        // THE RECOVERY.
        await renameDatabase(client, parked, live);

        expect(await databaseExists(client, live)).toBe(true);
        expect(await databaseExists(client, parked)).toBe(false);
      });
    } finally {
      await admin(async (client) => {
        await dropDatabase(client, live);
        await dropDatabase(client, parked);
      });
    }
  });

  it('leaves NO session behind, on the success path and on the throw path', async () => {
    // A leaked session is what makes a later `ALTER DATABASE ... RENAME` fail,
    // and it fails after the archive has been replayed and the application has
    // been stopped. This is the assertion that the `finally` in
    // `withAdminConnection` actually reaches the server.
    const pids: number[] = [];

    const readPid = async (client: AdminQueryClient): Promise<number> => {
      const result = await client.query('SELECT pg_backend_pid()::text AS pid');

      return Number.parseInt(String(result.rows[0].pid), 10);
    };

    pids.push(await admin(readPid));

    await expect(
      admin(async (client) => {
        pids.push(await readPid(client));

        throw new Error('the callback threw');
      })
    ).rejects.toThrow('the callback threw');

    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);

    // Both backends are gone. Polled, because the server reaps a disconnected
    // backend asynchronously and a bare assertion would be flaky rather than
    // wrong.
    await admin(async (client) => {
      for (const pid of pids) {
        let alive = true;

        for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
          const result = await client.query(
            'SELECT 1 FROM pg_stat_activity WHERE pid = $1::int',
            [pid]
          );
          alive = result.rows.length > 0;

          if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(alive).toBe(false);
      }
    });
  });

  it('resolves a foreign key through a subselect to NULL instead of aborting', async () => {
    // ⚠ THE CARRY-OVER'S LOAD-BEARING TRICK, proved against a real cluster.
    // `database_backup_runs.created_by_id` references `users(id)`, and the
    // promoted database's `users` table is the ARCHIVE's — so an administrator
    // created after the backup was taken does not exist in it. A plain value
    // raises a foreign-key violation and aborts the WHOLE carry-over; the
    // subselect yields NULL.
    //
    // The tables here are a MINIMAL ANALOGUE of the real pair, not the real
    // schema: building the real one would mean running every migration into a
    // throwaway database. What is being proved is the technique, which is the
    // part that could be wrong.
    const database = name('fk_subselect');
    const presentUser = randomUUID();
    const missingUser = randomUUID();
    const rowA = randomUUID();
    const rowB = randomUUID();

    try {
      await admin(async (client) => {
        await createDatabase(client, database);
      });

      await withAdminConnection({ ...connection, database }, async (client) => {
        await client.query('CREATE TABLE users (id uuid PRIMARY KEY)');
        await client.query(
          'CREATE TABLE runs (' +
            'id uuid PRIMARY KEY, ' +
            'created_by_id uuid REFERENCES users(id), ' +
            'pre_restore_backup_id uuid REFERENCES runs(id))'
        );
        await client.query('INSERT INTO users (id) VALUES ($1::uuid)', [presentUser]);

        // A plain value for a user that is not there: the failure the subselect
        // exists to avoid.
        await expect(
          client.query('INSERT INTO runs (id, created_by_id) VALUES ($1::uuid, $2::uuid)', [
            rowA,
            missingUser,
          ])
        ).rejects.toThrow(/foreign key/i);

        // The same insert, through the subselect: it succeeds, with NULL.
        await client.query(
          'INSERT INTO runs (id, created_by_id) ' +
            'VALUES ($1::uuid, (SELECT id FROM users WHERE id = $2::uuid))',
          [rowA, missingUser]
        );

        // ...and a user that IS there is still attributed.
        await client.query(
          'INSERT INTO runs (id, created_by_id) ' +
            'VALUES ($1::uuid, (SELECT id FROM users WHERE id = $2::uuid))',
          [rowB, presentUser]
        );

        const rows = await client.query(
          'SELECT id::text AS id, created_by_id::text AS created_by_id FROM runs ORDER BY id'
        );

        const byId = new Map(rows.rows.map((row) => [row.id, row.created_by_id]));
        expect(byId.get(rowA)).toBeNull();
        expect(byId.get(rowB)).toBe(presentUser);
      });
    } finally {
      await admin(async (client) => {
        await dropDatabase(client, database);
      });
    }
  });

  it('needs the SECOND pass for the self-FK, and the second pass works', async () => {
    // `pre_restore_backup_id` points at another row in the same table. Set
    // during the insert it can reference a row that is not there yet; applied
    // afterwards, every referent is present.
    const database = name('fk_self');
    const restore = randomUUID();
    const safetyDump = randomUUID();

    try {
      await admin(async (client) => {
        await createDatabase(client, database);
      });

      await withAdminConnection({ ...connection, database }, async (client) => {
        await client.query(
          'CREATE TABLE runs (id uuid PRIMARY KEY, pre_restore_backup_id uuid REFERENCES runs(id))'
        );

        // Pass one, in an order where the referent comes SECOND — which is
        // exactly why the link cannot be part of it.
        await expect(
          client.query('INSERT INTO runs (id, pre_restore_backup_id) VALUES ($1::uuid, $2::uuid)', [
            restore,
            safetyDump,
          ])
        ).rejects.toThrow(/foreign key/i);

        await client.query('INSERT INTO runs (id) VALUES ($1::uuid)', [restore]);
        await client.query('INSERT INTO runs (id) VALUES ($1::uuid)', [safetyDump]);

        // Pass two.
        await client.query(
          'UPDATE runs SET pre_restore_backup_id = ' +
            '(SELECT id FROM runs WHERE id = $2::uuid) WHERE id = $1::uuid',
          [restore, safetyDump]
        );

        const rows = await client.query(
          'SELECT pre_restore_backup_id::text AS link FROM runs WHERE id = $1::uuid',
          [restore]
        );
        expect(rows.rows[0].link).toBe(safetyDump);

        // And a link to a referent that genuinely is not there yields NULL
        // rather than aborting — the same property as the user FK.
        await client.query(
          'UPDATE runs SET pre_restore_backup_id = ' +
            '(SELECT id FROM runs WHERE id = $2::uuid) WHERE id = $1::uuid',
          [restore, randomUUID()]
        );

        const after = await client.query(
          'SELECT pre_restore_backup_id::text AS link FROM runs WHERE id = $1::uuid',
          [restore]
        );
        expect(after.rows[0].link).toBeNull();
      });
    } finally {
      await admin(async (client) => {
        await dropDatabase(client, database);
      });
    }
  });

  it('left the application\'s own database completely alone', async () => {
    // The assertion this whole file is written around. It runs last, and it
    // checks both halves: the live database is still there, and nothing this
    // suite created outside its prefix is.
    await admin(async (client) => {
      expect(await databaseExists(client, connection.liveDatabase)).toBe(true);

      const leaked = await client.query(
        'SELECT datname FROM pg_database WHERE datname LIKE $1',
        [`${PREFIX}%`]
      );

      // Anything still here is a database a `finally` failed to drop. It is
      // reported rather than ignored, because the leftover is a full database.
      expect(leaked.rows.map((row) => row.datname)).toEqual([]);
    });
  });
});
