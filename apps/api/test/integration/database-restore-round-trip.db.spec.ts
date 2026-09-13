// =============================================================================
// Real-Postgres test: the restore orchestration, end to end — a genuine
// swap, catalog carry-over, rollback, and failure injection on every
// pre-swap phase (issue #290, epic #254, Phase 8)
// =============================================================================
//
// EVIDENCE FOR EPIC #254'S SUCCESS CRITERIA 8 AND 9: a restore actually
// replaces the live database with a verified archive and can be undone, and
// a restore that fails before the swap leaves the live database untouched
// and cleans up after itself.
//
// WHAT ALREADY EXISTS, AND WHY THIS FILE IS NOT A DUPLICATE OF IT.
// `db-backup/database-restore.db.spec.ts` proves the CLUSTER PRIMITIVES this
// service is built from — `CREATE DATABASE`/`RENAME`/`DROP` really work from
// the maintenance database, a rename onto a taken name really fails rather
// than overwriting, the inner recovery really restores the original, no
// session leaks, and the subselect FK trick really yields NULL instead of
// aborting — each rehearsed directly against `admin-connection.util.ts`,
// never through `DatabaseRestoreService` itself.
// `database-restore.service.spec.ts` proves the SERVICE's own sequencing —
// six phases in order, the swap's inner recovery, the notification's
// position between the rename and the exit — against a `DatabaseRestoreSeam`
// double that never touches a real cluster.
// NEITHER runs `DatabaseRestoreService.startRestore`/`.rollback` against a
// real PostgreSQL cluster, with a real archive that real `pg_restore`
// replays into a real scratch database. That is what is missing, and it is
// the seam where the two already-tested halves (the primitives, the
// sequencing) could still disagree without either suite noticing — a
// `renameDatabase` call built with the wrong argument order, say, would pass
// both existing suites and fail only here.
//
// ⚠ NEVER THE SHARED TEST DATABASE. Every database this file acts on as a
// "live" deployment is created fresh in `beforeAll`, migrated for real with
// `prisma migrate deploy`, and dropped in `afterAll` — see
// `../helpers/scratch-database.helper.ts`. `assertNeverTheSharedDatabase`
// below is not decorative: it runs before anything else and throws loudly if
// a derived "live" name were ever miscomputed to collide with the real
// `POSTGRES_DB`, so a bug here fails the suite instead of renaming the
// database every other suite in `test:db` depends on.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db` (CI's `smoke` job — no new service container). See
// `../jobs/db-test-support.ts`.
//
// MEASURED WALL CLOCK: ~14s for this file alone (two `prisma migrate deploy`
// runs at ~2.2s each, two real `pg_dump`s, a real `pg_restore` replay for
// the round trip and another for the phase-5 fixture, and one further
// genuine restore attempt per failure-injection test). See
// `docs/TESTING.md` for the whole real-Postgres suite's budget.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import { DatabaseBackupRun, PrismaClient } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import {
  createDatabase,
  databaseExists,
  dropDatabase,
  buildScratchDatabaseName,
  resolveAdminConnection,
  withAdminConnection,
  type AdminConnection,
} from '../../src/db-backup/admin-connection.util';
import { DatabaseBackupRunnerService } from '../../src/db-backup/db-backup-runner.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { DB_RESTORE_RUN_TYPE } from '../../src/db-backup/database-restore.service';
import { ACTIVE_STORAGE_PROVIDER_ID, BACKUP_ARCHIVE_FORMAT } from '../../src/db-backup/db-backup-storage';
import {
  DatabaseRestoreService,
  defaultDatabaseRestoreSeam,
  type DatabaseRestoreSeam,
} from '../../src/db-backup/database-restore.service';
import { spawnPgDump } from '../../src/db-backup/pg-dump.util';
import { readTocEntryCount } from '../../src/db-backup/pg-restore.util';
import {
  DatabaseRestorePreflightService,
  defaultRestorePreflightSeam,
} from '../../src/db-backup/restore-preflight.service';
import { MaintenanceModeService } from '../../src/common/maintenance/maintenance-mode.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { cleanupTmpDir, TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import {
  engineForConnection,
  envFor,
  migrateDeploy,
  pgConnectionFor,
  prismaClientFor,
  sleep,
} from '../helpers/scratch-database.helper';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('database-restore-round-trip.db.spec');

const PREFIX = `restore_e2e_${process.pid}_`;

/**
 * Throws if `name` is (or could resolve to) the shared test database this
 * whole `test:db` run is otherwise connected to. Called before every
 * `CREATE DATABASE`/rename target this file computes.
 */
function assertNeverTheSharedDatabase(name: string): void {
  const shared = process.env.POSTGRES_DB;

  if (name === shared || !name.startsWith(PREFIX)) {
    throw new Error(
      `Refusing to act on database "${name}": it is the shared test database (or does not ` +
        `carry this suite's "${PREFIX}" prefix). This is a hard stop, not a skipped test — a ` +
        'restore suite that could touch the shared database is unsafe to run at all.'
    );
  }
}

interface Environment {
  dbName: string;
  prisma: PrismaClient;
  adminConnection: AdminConnection;
  tmpDir: string;
  storage: TmpDirStorageProvider;
  runner: DatabaseBackupRunnerService;
  preflight: DatabaseRestorePreflightService;
  /** `'notified'` then `'exit:<code>'`, in call order — the ordering under test. */
  events: string[];
  makeRestoreService(seamOverrides?: Partial<DatabaseRestoreSeam>): DatabaseRestoreService;
}

const settingsStub = {
  getDatabaseBackupPolicy: async () => DEFAULT_SYSTEM_SETTINGS.databaseBackup,
} as unknown as SystemSettingsService;

const configStub = { get: () => undefined } as unknown as ConfigService;

async function buildEnvironment(dbName: string): Promise<Environment> {
  assertNeverTheSharedDatabase(dbName);

  const prisma = prismaClientFor(dbName);
  await prisma.$connect();

  const adminConnection = resolveAdminConnection(envFor(dbName));
  const tmpDir = join(tmpdir(), `restore-e2e-${process.pid}-${randomUUID()}`);
  const storage = new TmpDirStorageProvider(tmpDir);

  const events: string[] = [];
  const notifications = {
    notifyPermissionHolders: async () => undefined,
    // `notifyPermissionHoldersNow` is what `announceRestoreCompleted` awaits
    // — the ordering under test is THIS resolving before `exitProcess` fires.
    notifyPermissionHoldersNow: async () => {
      events.push('notified');
      return { queued: 0, skipped: 0 };
    },
  } as unknown as NotificationsService;

  // ⚠ THE QUEUE SEAM THROWS IF IT IS EVER REACHED, DELIBERATELY. This suite
  // exercises the `pre_restore` safety dump, which goes through `startBackup`
  // and has NO job by design (#351): a restore must not wait on a worker slot,
  // on `JOBS_WORKER_MODE`, or on this process still polling the queue seconds
  // from now. A stub that quietly succeeded would let a refactor route the
  // pre-restore dump through `queueBackup` with nothing here noticing.
  const jobsStub = {
    enqueueWithin: async () => {
      throw new Error('the pre_restore dump must not enqueue a job');
    },
  } as unknown as JobsService;

  const runner = new DatabaseBackupRunnerService(
    prisma as unknown as PrismaService,
    settingsStub,
    storage,
    notifications,
    configStub,
    jobsStub,
    engineForConnection(pgConnectionFor(dbName))
  );

  const preflightSeam = { ...defaultRestorePreflightSeam, resolveConnection: () => adminConnection };
  const preflight = new DatabaseRestorePreflightService(
    prisma as unknown as PrismaService,
    settingsStub,
    preflightSeam
  );

  const maintenance = new MaintenanceModeService(settingsStub, prisma as unknown as PrismaService);

  function makeRestoreService(seamOverrides: Partial<DatabaseRestoreSeam> = {}): DatabaseRestoreService {
    const seam: DatabaseRestoreSeam = {
      ...defaultDatabaseRestoreSeam,
      resolveConnection: () => adminConnection,
      // The injected seam this whole file exists to use: records the exit
      // rather than ending the Jest worker. See the file header on
      // `DatabaseRestoreSeam.exitProcess`.
      exitProcess: (code: number) => {
        events.push(`exit:${code}`);
      },
      ...seamOverrides,
    };

    return new DatabaseRestoreService(
      prisma as unknown as PrismaService,
      settingsStub,
      storage,
      preflight,
      runner,
      maintenance,
      notifications,
      configStub,
      // ⚠ THE REAL QUEUE (#353, epic #345), NOT THE RUNNER'S THROWING STUB.
      // `startRestore` ENQUEUES now — it runs nothing — so a stub here would
      // make every case in this file assert against a restore that never
      // happened. `runQueuedRestore` below is the worker.
      new JobsService(prisma as unknown as PrismaService),
      seam
    );
  }

  return { dbName, prisma, adminConnection, tmpDir, storage, runner, preflight, events, makeRestoreService };
}

/**
 * THE WORKER, BY HAND (#353, epic #345).
 *
 * `startRestore` queues a `db.restore.run` job and returns; in production a
 * `JobWorker` claims it and calls `process()`, which calls
 * `executeRestoreJob`. This file is not testing the worker's poll loop — it is
 * testing what the restore does to a real cluster — so it does the two things
 * a claim does (charge the attempt, take a lease) and then executes.
 *
 * ⚠ IT SETTLES A FAILED JOB, AND IT MUST. `startRestore`'s durable guard
 * refuses while ANY `db.restore.run` is `pending` or `running`, so a failed
 * restore left `running` here would make every later case in this file come
 * back `already_running` — which is the same thing that would happen in a
 * deployment whose worker died, and is exactly why that guard is type-wide.
 * The SUCCESS path is deliberately not settled here: the restore settles its
 * own row as part of the catalog carry, which is the property the round-trip
 * case asserts against real Postgres.
 */
async function runQueuedRestore(
  env: Environment,
  service: DatabaseRestoreService,
  runId: string
): Promise<void> {
  const job = await env.prisma.job.findFirst({
    where: { type: DB_RESTORE_RUN_TYPE, subjectId: runId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  if (job === null) throw new Error(`no ${DB_RESTORE_RUN_TYPE} job was queued for ${runId}`);

  const claimed = await env.prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'running',
      startedAt: new Date(),
      // Charged AT CLAIM TIME, exactly as `JobClaimService` charges it.
      attempts: { increment: 1 },
      executor: 'server',
      leaseExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    },
  });

  try {
    await service.executeRestoreJob(claimed);
  } catch {
    await env.prisma.job.update({
      where: { id: claimed.id },
      data: { status: 'failed', finishedAt: new Date(), leaseExpiresAt: null },
    });
  }
}

/** Polls a `database_backup_runs` row (via `prisma`) until it is no longer active. */
async function awaitBackupSettled(
  prisma: PrismaClient,
  runId: string,
  timeoutMs = 30_000
): Promise<DatabaseBackupRun> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const row = await prisma.databaseBackupRun.findUniqueOrThrow({ where: { id: runId } });

    if (row.status !== 'pending' && row.status !== 'running') {
      if (row.status !== 'completed') {
        throw new Error(`Backup run ${runId} settled as "${row.status}": ${row.lastError}`);
      }
      return row;
    }

    if (Date.now() >= deadline) throw new Error(`Backup run ${runId} did not settle in ${timeoutMs}ms.`);
    await sleep(100);
  }
}

/** Takes a real, completed backup of `env.dbName` and returns its row. */
async function takeKnownBackup(env: Environment): Promise<DatabaseBackupRun> {
  const claimed = await env.runner.startBackup({ trigger: 'manual', createdById: null });
  return awaitBackupSettled(env.prisma, claimed.id);
}

/** A fresh backup-run row pointing at the SAME archive `source` does, minus the id/timestamps. */
async function cloneRun(
  prisma: PrismaClient,
  source: DatabaseBackupRun,
  overrides: Partial<DatabaseBackupRun> = {}
): Promise<DatabaseBackupRun> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = source;

  return prisma.databaseBackupRun.create({
    data: { ...rest, id: randomUUID(), ...overrides },
  });
}

/**
 * Polls `database_backup_runs.restore_status` for `runId` on `dbName`
 * through a FRESH raw connection every attempt — never Prisma, and never a
 * connection held across the poll. A swap terminates every session on the
 * live database and briefly renames it away entirely, so a held connection
 * (Prisma's pool included) is exactly what would make this poll flaky; a
 * fresh `pg.Client` per attempt tolerates both transparently and simply
 * retries on the (expected) connection error while the rename is in flight.
 */
async function pollRestoreOutcome(
  adminConnection: AdminConnection,
  dbName: string,
  runId: string,
  timeoutMs = 30_000
): Promise<{ restore_status: string; restore_error: string | null }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const result = await withAdminConnection({ ...adminConnection, database: dbName }, (client) =>
        client.query(
          'SELECT restore_status, restore_error FROM database_backup_runs WHERE id = $1::uuid',
          [runId]
        )
      );

      const row = result.rows[0] as { restore_status: string; restore_error: string | null } | undefined;

      if (row && (row.restore_status === 'completed' || row.restore_status === 'failed')) {
        return row;
      }
    } catch {
      // Expected mid-rename (the database briefly does not exist under this
      // name, or its sessions were just terminated) — retried below.
    }

    if (Date.now() >= deadline) {
      throw new Error(`Restore of run ${runId} against "${dbName}" did not settle in ${timeoutMs}ms.`);
    }

    await sleep(150);
  }
}

/** A cheap content fingerprint: the migration count plus the sorted public table list. */
async function fingerprint(adminConnection: AdminConnection, dbName: string): Promise<string> {
  return withAdminConnection({ ...adminConnection, database: dbName }, async (client) => {
    const migrations = await client.query('SELECT count(*)::text AS count FROM _prisma_migrations');
    const tables = await client.query(
      "SELECT string_agg(tablename, ',' ORDER BY tablename) AS names FROM pg_tables WHERE schemaname = 'public'"
    );

    return `migrations=${migrations.rows[0].count};tables=${tables.rows[0].names}`;
  });
}

describeWithDb('Database restore orchestration against real Postgres', () => {
  let rootAdmin: AdminConnection;
  /** Every database this whole file creates, so `afterAll` cleanup is exhaustive. */
  const trackedDatabases = new Set<string>();

  const trackAndCreate = async (dbName: string): Promise<void> => {
    assertNeverTheSharedDatabase(dbName);
    trackedDatabases.add(dbName);
    await withAdminConnection(rootAdmin, (client) => createDatabase(client, dbName));
  };

  const track = (dbName: string): void => {
    assertNeverTheSharedDatabase(dbName);
    trackedDatabases.add(dbName);
  };

  beforeAll(() => {
    const { DATABASE_URL: _ignored, ...env } = process.env;
    rootAdmin = resolveAdminConnection(env);
  });

  afterAll(async () => {
    await withAdminConnection(rootAdmin, async (client) => {
      for (const dbName of trackedDatabases) {
        if (await databaseExists(client, dbName)) {
          await dropDatabase(client, dbName).catch(() => undefined);
        }
      }
    }).catch(() => undefined);
  }, 30_000);

  // ===========================================================================
  // Round trip: a known archive, restored, promoted with catalog carry-over,
  // then rolled back to the original.
  // ===========================================================================

  describe('round trip', () => {
    const dbName = `${PREFIX}live_rt`;
    let env: Environment;
    let knownRun: DatabaseBackupRun;

    beforeAll(async () => {
      await trackAndCreate(dbName);
      migrateDeploy(dbName);
      env = await buildEnvironment(dbName);
      knownRun = await takeKnownBackup(env);
    }, 60_000);

    afterAll(async () => {
      await env?.prisma?.$disconnect().catch(() => undefined);
      if (env?.tmpDir) await cleanupTmpDir(env.tmpDir);
    }, 30_000);

    it('restores the archive, promotes it live with the catalog carried over, then rolls back', async () => {
      const restoreService = env.makeRestoreService();

      const started = await restoreService.startRestore(knownRun, { actorUserId: null });
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;

      await runQueuedRestore(env, restoreService, knownRun.id);

      track(started.scratchDatabase);
      track(started.oldDatabase);

      const outcome = await pollRestoreOutcome(env.adminConnection, dbName, knownRun.id);
      expect(outcome.restore_status).toBe('completed');
      expect(outcome.restore_error).toBeNull();

      // `notifyPermissionHoldersNow` is awaited BETWEEN the rename and the
      // exit seam (issue #288) — poll briefly for both to have landed, since
      // the SQL write above and these two in-process events are not the same
      // synchronisation point.
      const deadline = Date.now() + 5_000;
      while (env.events.length < 2 && Date.now() < deadline) await sleep(50);

      expect(env.events).toEqual(['notified', 'exit:0']);

      // --- Catalog carry-over: this run's OWN row survived into the ---------
      // --- promoted database, and the completion audit row landed there too.
      const carried = await withAdminConnection({ ...env.adminConnection, database: dbName }, (client) =>
        client.query(
          'SELECT restore_status, restore_scratch_db, restore_old_db FROM database_backup_runs ' +
            'WHERE id = $1::uuid',
          [knownRun.id]
        )
      );
      expect(carried.rows[0]).toMatchObject({
        restore_status: 'completed',
        restore_scratch_db: started.scratchDatabase,
        restore_old_db: started.oldDatabase,
      });

      // --- ⚠ THE RESTORE'S OWN JOB ROW, SETTLED, IN THE PROMOTED DATABASE ---
      //
      // THE HAZARD #353 HAD TO SOLVE, PROVEN AGAINST REAL POSTGRES. `process()`
      // never returns on this path — the process exits inside the swap — so the
      // worker's terminal write never runs. Left alone, the row would sit
      // `running` with a live lease until the restarted API's reaper found it
      // and, under `maxAttempts: 1`, marked a SUCCESSFUL restore `failed`.
      //
      // The terminal write therefore rides with the catalog carry
      // (`CARRY_JOB_SQL`): decided before the renames, written after both of
      // them, into the database that survives, before the exit. Reading it back
      // out of the PROMOTED database is the only way to prove all four.
      const carriedJob = await withAdminConnection(
        { ...env.adminConnection, database: dbName },
        (client) =>
          client.query(
            'SELECT status::text, attempts, lease_expires_at, claimed_by_node_id, ' +
              'finished_at, executor FROM jobs WHERE type = $1 AND subject_id = $2',
            [DB_RESTORE_RUN_TYPE, knownRun.id]
          )
      );

      expect(carriedJob.rows).toHaveLength(1);
      expect(carriedJob.rows[0]).toMatchObject({
        status: 'succeeded',
        // Cleared, exactly as `JobTerminalService.completeSucceeded` clears
        // them: a terminal row must not appear to be held by anybody, and the
        // lease is what the reaper reads.
        lease_expires_at: null,
        claimed_by_node_id: null,
        executor: 'server',
      });
      expect(carriedJob.rows[0].finished_at).not.toBeNull();

      // `db_restore:start` and `db_restore:swap` are written by
      // `writeAudit()` — real `this.prisma.auditEvent.create()` calls — BEFORE
      // the rename, into whatever database is live AT THAT MOMENT. That is
      // the pre-swap live database, which the rename parks under
      // `started.oldDatabase`; see `RESTORE_AUDIT_SWAP`'s own `meta.note`
      // ("This row is in the database being displaced"). So these two are
      // read from the PARKED database, not the promoted one.
      const parkedAudit = await withAdminConnection(
        { ...env.adminConnection, database: started.oldDatabase },
        (client) =>
          client.query('SELECT action FROM audit_events WHERE target_id = $1::text ORDER BY id', [
            knownRun.id,
          ])
      );
      expect(parkedAudit.rows.map((row) => row.action as string)).toEqual(
        expect.arrayContaining(['db_restore:start', 'db_restore:swap'])
      );

      // `db_restore:complete` is the one audit row written INTO the promoted
      // database (`reinsertCatalog`, via `CARRY_AUDIT_SQL`), after the
      // renames. It is the evidence the restore happened, in the only
      // database anybody will open again — so its absence would be invisible:
      // `reinsertCatalog` NEVER THROWS by design, and a failed carry-over is
      // only a `CRITICAL` log line while the restore still reports success.
      // That is exactly what #337 was — the INSERT omitted `id`, relying on a
      // database-level DEFAULT that `20260831014110_drop_stale_uuid_defaults`
      // dropped from `audit_events.id`, and this row was silently lost on
      // every real restore.
      const promotedAudit = await withAdminConnection({ ...env.adminConnection, database: dbName }, (client) =>
        client.query(
          'SELECT id, action, target_id FROM audit_events WHERE target_id = $1::text ORDER BY id',
          [knownRun.id]
        )
      );
      expect(promotedAudit.rows.map((row) => row.action as string)).toEqual(['db_restore:complete']);
      expect(promotedAudit.rows[0].id).toEqual(expect.any(String));

      // The promoted database really is the replayed archive, not an empty
      // shell that merely carried the catalog over: it boots (a real,
      // non-empty migration ledger).
      const promotedFingerprint = await fingerprint(env.adminConnection, dbName);
      expect(promotedFingerprint).toContain('migrations=');
      expect(promotedFingerprint).not.toContain('migrations=0');

      // --- Roll back --------------------------------------------------------
      // A FRESH reader: `restoreService`'s own `prisma` was disconnected by
      // the swap and reconnects lazily, but a dedicated reader removes any
      // doubt about which connection is answering.
      const reader = prismaClientFor(dbName);
      try {
        const runRow = await reader.databaseBackupRun.findUniqueOrThrow({ where: { id: knownRun.id } });
        expect(runRow.restoreOldDb).toBe(started.oldDatabase);

        const rollbackResult = await restoreService.rollback(runRow, null);
        expect(rollbackResult).toMatchObject({ outcome: 'renamed', promoted: started.oldDatabase });
        if (rollbackResult.outcome === 'renamed') track(rollbackResult.parked);
      } finally {
        await reader.$disconnect();
      }

      // The original is live again: `restore_status` for THIS run reads
      // `rolled_back` once more, from the database that is live right now.
      const afterRollback = await withAdminConnection(
        { ...env.adminConnection, database: dbName },
        (client) =>
          client.query('SELECT restore_status FROM database_backup_runs WHERE id = $1::uuid', [knownRun.id])
      );
      expect(afterRollback.rows[0].restore_status).toBe('rolled_back');
    }, 60_000);
  });

  // ===========================================================================
  // Failure injection: each pre-swap phase, in isolation.
  //
  // Under this suite's `retain_database` policy (the shipped default — see
  // `DEFAULT_SYSTEM_SETTINGS.databaseBackup`), the restore's pre-swap phases
  // are (1) archive download+verify, (3) scratch database creation, (4) the
  // `pg_restore` replay, and (5) verification of what was replayed — phase
  // (2), the `pre_restore` safety backup, applies only under
  // `pre_restore_dump` and is out of scope here. Each phase gets one real
  // failure, injected the most honest way available for that phase (a wrong
  // checksum, a real name collision, a seam override, and a genuinely
  // schema-less archive respectively) rather than a blanket mock — see each
  // `it` for why.
  // ===========================================================================

  describe('failure injection on each pre-swap phase', () => {
    const dbName = `${PREFIX}live_fail`;
    const foreignDbName = `${PREFIX}foreign`;
    let env: Environment;
    let goodRun: DatabaseBackupRun;
    let baselineFingerprint: string;

    beforeAll(async () => {
      await trackAndCreate(dbName);
      migrateDeploy(dbName);
      env = await buildEnvironment(dbName);
      goodRun = await takeKnownBackup(env);
      baselineFingerprint = await fingerprint(env.adminConnection, dbName);
    }, 60_000);

    afterEach(async () => {
      // THE PROPERTY THE WHOLE RESTORE DESIGN EXISTS FOR (epic success
      // criterion 9): whatever the phase, whatever failed, the live database
      // is untouched. Checked after EVERY test in this block, not just once.
      await expect(fingerprint(env.adminConnection, dbName)).resolves.toBe(baselineFingerprint);
    });

    afterAll(async () => {
      await env?.prisma?.$disconnect().catch(() => undefined);
      if (env?.tmpDir) await cleanupTmpDir(env.tmpDir);
    }, 30_000);

    it('phase 1 — a checksum mismatch fails before anything is created', async () => {
      // THE MOST HONEST INJECTION FOR THIS PHASE: a real, otherwise-valid run
      // row whose `checksumSha256` does not match the (real, untouched)
      // archive bytes — exactly what `downloadAndVerifyArchive` exists to
      // catch, with no seam override standing in for it.
      const badRun = await cloneRun(env.prisma, goodRun, {
        checksumSha256: '0'.repeat(64),
      });

      const restoreService = env.makeRestoreService();
      // +0s: `buildScratchDatabaseName` has SECOND granularity, and this describe
      // block's four tests run back-to-back — an offset per test keeps their derived
      // scratch-database names from colliding with each other.
      const now = new Date(Date.now());
      const started = await restoreService.startRestore(badRun, { actorUserId: null, now });
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;

      await runQueuedRestore(env, restoreService, badRun.id);

      const outcome = await pollRestoreOutcome(env.adminConnection, dbName, badRun.id);
      expect(outcome.restore_status).toBe('failed');
      expect(outcome.restore_error).toMatch(/sha256/i);

      // No exit — a failed pre-swap restore returns control, it does not end
      // the process.
      expect(env.events).toEqual([]);

      // Nothing was ever created for phase 1 to have to drop.
      const scratchName = buildScratchDatabaseName(dbName, now);
      await expect(
        withAdminConnection(rootAdmin, (client) => databaseExists(client, scratchName))
      ).resolves.toBe(false);
    });

    it('phase 3 — a scratch-name collision fails, and leaves the colliding database alone', async () => {
      const run = await cloneRun(env.prisma, goodRun, {});
      // +6s: `buildScratchDatabaseName` has SECOND granularity, and this describe
      // block's four tests run back-to-back — an offset per test keeps their derived
      // scratch-database names from colliding with each other.
      const now = new Date(Date.now() + 6_000);
      const scratchName = buildScratchDatabaseName(dbName, now);

      // The collision: something already sits under the name this restore
      // would have used. `createScratchDatabase`'s own comment is explicit
      // that it must be "left alone", not reused and not dropped — this test
      // is that promise, checked against a real collision.
      await trackAndCreate(scratchName);

      const restoreService = env.makeRestoreService();
      const started = await restoreService.startRestore(run, { actorUserId: null, now });
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;

      await runQueuedRestore(env, restoreService, run.id);

      const outcome = await pollRestoreOutcome(env.adminConnection, dbName, run.id);
      expect(outcome.restore_status).toBe('failed');
      expect(outcome.restore_error).toMatch(/already exists/i);
      expect(env.events).toEqual([]);

      // The pre-existing database is untouched, not "dropped" — there was
      // never anything of THIS restore's to drop.
      await expect(
        withAdminConnection(rootAdmin, (client) => databaseExists(client, scratchName))
      ).resolves.toBe(true);
    });

    it('phase 4 — a pg_restore failure drops the scratch database it had just created', async () => {
      const run = await cloneRun(env.prisma, goodRun, {});
      // +12s: `buildScratchDatabaseName` has SECOND granularity, and this describe
      // block's four tests run back-to-back — an offset per test keeps their derived
      // scratch-database names from colliding with each other.
      const now = new Date(Date.now() + 12_000);
      const scratchName = buildScratchDatabaseName(dbName, now);

      const restoreService = env.makeRestoreService({
        // The one genuine seam override in this file: a real `pg_restore`
        // failure (a corrupt archive, a permissions error mid-replay) is
        // awkward to manufacture with a REAL archive without also risking a
        // flaky reproduction, and the property under test — "phase 4 failing
        // drops the scratch database phase 3 really created" — does not
        // depend on which error `pg_restore` returns, only on the fact that
        // it did. Everything up to and after this call is still real:
        // `createScratchDatabase` genuinely runs (the scratch database
        // really exists when this throws), and the catch/cleanup path that
        // follows is the service's own, unmodified.
        runPgRestore: async () => {
          throw new Error('simulated pg_restore failure for phase 4');
        },
      });

      const started = await restoreService.startRestore(run, { actorUserId: null, now });
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;

      await runQueuedRestore(env, restoreService, run.id);

      const outcome = await pollRestoreOutcome(env.adminConnection, dbName, run.id);
      expect(outcome.restore_status).toBe('failed');
      expect(outcome.restore_error).toContain('simulated pg_restore failure');
      expect(env.events).toEqual([]);

      // THE ASSERTION THIS TEST EXISTS FOR: the scratch database phase 3
      // really created is really gone.
      await expect(
        withAdminConnection(rootAdmin, (client) => databaseExists(client, scratchName))
      ).resolves.toBe(false);
    });

    it('phase 5 — a schema-less archive fails verification and drops its scratch database', async () => {
      // A genuinely foreign archive: a database with an ordinary table but no
      // `_prisma_migrations` ledger at all — "what a restore of somebody
      // else's archive looks like", in the verify method's own words. Real
      // `pg_dump`, real bytes, real `pg_restore --list` count (> 0, so phase
      // 1 passes); it is phase 5 specifically that must catch it.
      await trackAndCreate(foreignDbName);
      await withAdminConnection({ ...rootAdmin, database: foreignDbName }, async (client) => {
        await client.query('CREATE TABLE some_table (id int)');
        await client.query('INSERT INTO some_table (id) VALUES (1)');
      });

      const foreignConnection = pgConnectionFor(foreignDbName);
      const dump = spawnPgDump({ connection: foreignConnection, compressionLevel: 6 });

      const chunks: Buffer[] = [];
      for await (const chunk of dump.stdout as AsyncIterable<Buffer>) chunks.push(chunk);
      await dump.done;
      const archive = Buffer.concat(chunks);

      const storageKey = `test-foreign/${randomUUID()}.dump`;
      await env.storage.upload(storageKey, Readable.from(archive), {
        mimeType: 'application/octet-stream',
      });

      // Sanity self-check on the archive just built, independent of the
      // service under test: it really is a non-empty, readable archive (so
      // phase 1's own check will pass and phase 5's is what has to catch
      // this fixture).
      const recheck = await readTocEntryCount({ source: await env.storage.download(storageKey) });
      expect(recheck).toBeGreaterThan(0);

      const checksumSha256 = createHash('sha256').update(archive).digest('hex');

      const foreignRun = await env.prisma.databaseBackupRun.create({
        data: {
          id: randomUUID(),
          status: 'completed',
          trigger: 'manual',
          startedAt: new Date(),
          finishedAt: new Date(),
          lastHeartbeatAt: new Date(),
          bytesWritten: BigInt(archive.length),
          sizeBytes: BigInt(archive.length),
          storageProvider: ACTIVE_STORAGE_PROVIDER_ID,
          storageKey,
          bucket: env.storage.getBucket(),
          format: BACKUP_ARCHIVE_FORMAT,
          checksumSha256,
          // No migration name recorded: the schema gate treats this as
          // "unknown" (a warning, never a block) — see
          // `compareMigrationNames`. This archive is foreign in a way the
          // schema gate cannot see; only phase 5's own check can.
          migrationName: null,
          createdById: null,
        },
      });

      // +18s: `buildScratchDatabaseName` has SECOND granularity, and this describe
      // block's four tests run back-to-back — an offset per test keeps their derived
      // scratch-database names from colliding with each other.
      const now = new Date(Date.now() + 18_000);
      const scratchName = buildScratchDatabaseName(dbName, now);

      const restoreService = env.makeRestoreService();
      const started = await restoreService.startRestore(foreignRun, { actorUserId: null, now });
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;

      await runQueuedRestore(env, restoreService, foreignRun.id);

      const outcome = await pollRestoreOutcome(env.adminConnection, dbName, foreignRun.id);
      expect(outcome.restore_status).toBe('failed');
      expect(outcome.restore_error).toMatch(/_prisma_migrations/);
      expect(env.events).toEqual([]);

      await expect(
        withAdminConnection(rootAdmin, (client) => databaseExists(client, scratchName))
      ).resolves.toBe(false);
    }, 30_000);
  });
});
