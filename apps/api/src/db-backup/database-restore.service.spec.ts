// =============================================================================
// The scratch-database restore and the atomic swap (issue #285, epic #254)
// =============================================================================
//
// This suite exists because the sequence it covers is the most dangerous thing
// in the repository and cannot be rehearsed anywhere else: a real restore takes
// hours, destroys a production database, and ends by killing its own process.
// Everything below drives that sequence through the injected seam, so the whole
// design — including `process.exit` — is exercised with no PostgreSQL, no
// `pg_restore` binary, and no risk to the Jest worker.
//
// The claims worth holding, in the order they matter:
//
//   1. A FAILURE AT ANY POINT BEFORE THE RENAME LEAVES THE LIVE DATABASE
//      COMPLETELY UNTOUCHED and drops the scratch database. Asserted per phase,
//      and asserted against the SQL the fake cluster actually received rather
//      than only against spies — the assertion a refactor cannot route around.
//   2. A FAILED SECOND RENAME PUTS THE ORIGINAL BACK. It is the one genuinely
//      dangerous moment in the design and it has two tests: one where the
//      recovery works, one where it does not.
//   3. THE CATALOG SURVIVES THE SWAP — this restore's own record, every backup
//      newer than the archive, user FKs through a subselect, the self-FK in a
//      second pass.
//   4. THE MAINTENANCE WINDOW IS OPENED IN MEMORY WITH `allowAdmins: false`.
//      The persisted flag lives inside the database being renamed.
//   5. THE ARCHIVE IS RE-VERIFIED AGAINST THE BYTES AS THEY ARE NOW, and a
//      corrupt one fails before anything is created.
// =============================================================================

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { DatabaseBackupRun, Job } from '@prisma/client';

import type { ConfigService } from '@nestjs/config';

import type { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import { JOB_TEMP_PREFIX } from '../jobs/job-temp';
import type { NotificationsService } from '../notifications/notifications.service';
import type { JobsService } from '../jobs/jobs.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import type { AdminConnection, AdminQueryClient } from './admin-connection.util';
import {
  DatabaseRestoreService,
  RESTORE_AUDIT_COMPLETE,
  RESTORE_AUDIT_FAILED,
  RESTORE_AUDIT_ROLLBACK,
  RESTORE_AUDIT_START,
  RESTORE_AUDIT_SWAP,
  RESTORE_JOBS,
  defaultDatabaseRestoreSeam,
  type DatabaseRestoreSeam,
} from './database-restore.service';
import type { DatabaseBackupRunnerService } from './db-backup-runner.service';
import { DatabaseRestoreSwapError } from './db-backup.errors';
import type {
  DatabaseRestorePreflightService,
  RestorePreflightResult,
} from './restore-preflight.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-07T12:00:00.000Z');
const LIVE = 'appdb';
const SCRATCH = 'appdb_restore_20260907T120000Z';
const OLD = 'appdb_old_20260907T120000Z';

const CONNECTION: AdminConnection = {
  host: '127.0.0.1',
  port: '5432',
  user: 'appuser',
  password: 'super-secret-password',
  database: 'postgres',
  sslMode: null,
  liveDatabase: LIVE,
};

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: '',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

/** The sha256 the fake storage's bytes actually hash to. Computed, never guessed. */
const ARCHIVE_BYTES = Buffer.from('a custom-format archive, for testing purposes');
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

const ACTOR = '11111111-0000-4000-8000-000000000001';

function backupRow(overrides: Partial<DatabaseBackupRun> = {}): DatabaseBackupRun {
  return {
    id: '0d1f1c9e-0000-4000-8000-000000000285',
    status: 'completed',
    trigger: 'manual',
    startedAt: new Date('2026-09-06T02:00:00.000Z'),
    finishedAt: new Date('2026-09-06T02:10:00.000Z'),
    lastHeartbeatAt: new Date('2026-09-06T02:10:00.000Z'),
    bytesWritten: 4096n,
    sizeBytes: 4096n,
    storageProvider: 's3',
    storageKey: 'database-backups/app/2026/09/app-20260906T020000Z-run.dump',
    bucket: 'backups',
    format: 'custom',
    checksumSha256: ARCHIVE_SHA256,
    dbVersion: '16.4',
    appVersion: '1.0.0',
    migrationName: '20260907120000_add_database_backup_runs',
    verifiedAt: new Date('2026-09-06T02:10:05.000Z'),
    lastError: null,
    createdById: ACTOR,
    restoreStatus: null,
    restoreError: null,
    restoredAt: null,
    restoredById: null,
    restoreScratchDb: null,
    restoreOldDb: null,
    swappedAt: null,
    preRestoreBackupId: null,
    createdAt: new Date('2026-09-06T02:00:00.000Z'),
    updatedAt: new Date('2026-09-06T02:10:00.000Z'),
    ...overrides,
  } as DatabaseBackupRun;
}

interface PreflightOverrides {
  scratchDatabase?: string;
  oldDatabase?: string;
  effectiveRollback?: 'retain_database' | 'pre_restore_dump';
}

function okPreflight(overrides: PreflightOverrides = {}): RestorePreflightResult {
  const effective = overrides.effectiveRollback ?? 'retain_database';

  return {
    outcome: 'ok',
    runId: backupRow().id,
    targetDatabase: LIVE,
    scratchDatabase: overrides.scratchDatabase ?? SCRATCH,
    oldDatabase: overrides.oldDatabase ?? OLD,
    gates: [],
    rollback: {
      configured: effective === 'retain_database' ? 'retain_database' : 'drop_database',
      effective,
      downgraded: false,
      reason: null,
    },
    archiveMigration: backupRow().migrationName,
    liveMigration: backupRow().migrationName,
    databaseSizeBytes: '1024',
    freeDiskBytes: '999999',
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /**
   * #353: what `startRestore`'s durable guard finds already queued. `null`
   * (the default) means nothing is.
   */
  queuedRestoreJob?: { id: string; subjectId: string | null } | null;

  /** Databases the fake cluster starts with. The live one is always there. */
  databases?: string[];
  policy?: Partial<SystemDatabaseBackupValue>;
  preflight?: RestorePreflightResult;
  /** Rows `exportCatalog` reads out of the pre-swap database. */
  catalogRows?: DatabaseBackupRun[];
  /** Bytes the storage provider hands back. Change them to corrupt the archive. */
  archiveBytes?: Buffer;
  /** Table-of-contents entries the downloaded file reports. */
  tocEntries?: number;
  /** Tables the restored database reports. Zero fails verification. */
  restoredTables?: number;
  /** Migration-ledger rows the restored database reports. */
  restoredMigrations?: number;
  /** Throws instead of downloading. */
  downloadError?: Error;
  /** Throws instead of replaying. */
  restoreError?: Error;
  /** Holds the replay open, so a test can observe a restore that is in flight. */
  restoreGate?: Promise<void>;
  /** Any statement matching this regex throws, wherever it is issued. */
  failStatement?: { pattern: RegExp; error: Error; onCall?: number };
  /** How the `pre_restore` safety backup settles. */
  preRestoreStatus?: string;
  /** Rows the retained-database sweep finds. Distinguished from the catalog read. */
  sweepRows?: Array<{ id: string; restoreOldDb: string | null; swappedAt: Date }>;
  startBackupError?: Error;
  /** #288: what `ConfigService.get('appUrl')` returns. */
  appUrl?: string;
  /** #288: the actor's row as the RESTORED database holds it. `null` = not there. */
  actorRow?: { email: string } | null;
  /** #288: a notifier that misbehaves, for the containment assertions. */
  notifyImpl?: () => Promise<void>;
}

function makeHarness(options: HarnessOptions = {}) {
  /** `<attached database>: <statement>`, in order. The no-mutation assertions read this. */
  const sql: string[] = [];
  /** The cluster's database names. */
  const cluster = new Set<string>([LIVE, 'postgres', ...(options.databases ?? [])]);
  /** Rows the carry-over inserted, in the order it inserted them. */
  const carried: unknown[][] = [];
  const selfLinks: unknown[][] = [];
  const carriedAudit: unknown[][] = [];
  /** #353: the restore's own settled `jobs` row, carried with the catalog. */
  const carriedJobs: unknown[][] = [];

  let statementFailures = 0;

  const makeClient = (attachedTo: string): AdminQueryClient => ({
    connect: jest.fn(async () => undefined),
    end: jest.fn(async () => undefined),
    query: jest.fn(async (text: string, values?: unknown[]) => {
      sql.push(`${attachedTo}: ${text}`);

      const failure = options.failStatement;
      if (failure && failure.pattern.test(text)) {
        statementFailures += 1;
        if (failure.onCall === undefined || failure.onCall === statementFailures) {
          throw failure.error;
        }
      }

      if (text.startsWith('SELECT 1 FROM pg_database')) {
        return { rows: cluster.has(String(values?.[0])) ? [{ '?column?': 1 }] : [] };
      }

      const create = /^CREATE DATABASE "([^"]+)"/.exec(text);
      if (create) {
        cluster.add(create[1]);
        return { rows: [] };
      }

      const drop = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(text);
      if (drop) {
        cluster.delete(drop[1]);
        return { rows: [] };
      }

      const rename = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(text);
      if (rename) {
        if (!cluster.has(rename[1])) {
          throw new Error(`database "${rename[1]}" does not exist`);
        }
        cluster.delete(rename[1]);
        cluster.add(rename[2]);
        return { rows: [] };
      }

      if (text.startsWith('SELECT pg_terminate_backend')) return { rows: [] };

      if (text.includes('FROM pg_class c')) {
        return { rows: [{ count: String(options.restoredTables ?? 42) }] };
      }

      if (text.includes("to_regclass('_prisma_migrations')")) {
        return { rows: [{ count: String(options.restoredMigrations ?? 7) }] };
      }

      if (text.startsWith('INSERT INTO jobs')) {
        // #353: the restore's own settled job row, carried across the rename.
        carriedJobs.push(values ?? []);
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO database_backup_runs')) {
        carried.push(values ?? []);
        return { rows: [] };
      }

      if (text.startsWith('UPDATE database_backup_runs')) {
        selfLinks.push(values ?? []);
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO audit_events')) {
        carriedAudit.push(values ?? []);
        return { rows: [] };
      }

      return { rows: [] };
    }),
  });

  // --- Prisma -------------------------------------------------------------
  const stateWrites: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    stateWrites.push(data);
    return {};
  });

  // ONE mock, two callers. The sweep is the only `findMany` that filters on
  // `restoreOldDb`, which is what makes them safe to tell apart here.
  const findMany = jest.fn(async (args?: { where?: { restoreOldDb?: unknown } }) =>
    args?.where?.restoreOldDb !== undefined
      ? options.sweepRows ?? []
      : options.catalogRows ?? [backupRow()]
  );

  /**
   * Runs a test has handed to `startRestore`, keyed by id (#353).
   *
   * `executeRestoreJob` RE-READS the row by id rather than trusting the payload
   * — the payload carries identifiers, not copies — so a harness that always
   * answered with a default row would silently discard whatever a test set up
   * (a mismatched checksum, a missing migration name). `runRestore` registers
   * the row it started with here.
   */
  const startedRuns = new Map<string, DatabaseBackupRun>();

  // Three callers now, told apart by `select` and by the map above:
  // `awaitBackupSettled` asks only for a status, `executeRestoreJob` re-reads a
  // row this test started, and the rollback delegation reads the pre-restore
  // dump's row (which no test starts, so it falls through to the default).
  const findUnique = jest.fn(
    async ({ where, select }: { where: { id: string }; select?: unknown }) =>
      select === undefined
        ? startedRuns.get(where.id) ?? backupRow({ id: where.id, trigger: 'pre_restore' })
        : { status: options.preRestoreStatus ?? 'completed' }
  );

  /**
   * #353: `startRestore`'s durable "is a restore already queued?" guard.
   *
   * Defaults to `null` (nothing queued). `options.queuedRestoreJob` is how the
   * concurrency test models a restore queued by a PREVIOUS process — the case
   * the process-local flag structurally cannot see.
   */
  const jobFindFirst = jest.fn(async () => options.queuedRestoreJob ?? null);

  const auditCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    auditRows.push(data);
    return {};
  });

  const disconnect = jest.fn(async () => undefined);

  // #288: `resolveActorEmail` reads the actor out of the RESTORED database,
  // after the swap. `options.actorRow` lets a test model the case that matters —
  // an operator whose account was created after the archive was taken and
  // therefore does not exist in it.
  const userFindUnique = jest.fn(async () =>
    options.actorRow === undefined ? { email: 'ops@example.com' } : options.actorRow
  );

  const prisma = {
    databaseBackupRun: { update, findMany, findUnique },
    job: { findFirst: jobFindFirst },
    auditEvent: { create: auditCreate },
    user: { findUnique: userFindUnique },
    $disconnect: disconnect,
  } as unknown as PrismaService;

  // --- Collaborators -------------------------------------------------------
  const policy = { ...POLICY, ...options.policy };

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => policy),
  } as unknown as SystemSettingsService;

  const download = jest.fn(async () => {
    if (options.downloadError) throw options.downloadError;
    return Readable.from([options.archiveBytes ?? ARCHIVE_BYTES]);
  });

  const storage = { download } as unknown as StorageProvider;

  const check = jest.fn(async () => options.preflight ?? okPreflight());
  const preflight = { check } as unknown as DatabaseRestorePreflightService;

  const startBackup = jest.fn(async () => {
    if (options.startBackupError) throw options.startBackupError;
    return { id: 'pre-restore-run' } as DatabaseBackupRun;
  });

  const runner = { startBackup } as unknown as DatabaseBackupRunnerService;

  const setInMemoryOverride = jest.fn();
  const maintenance = { setInMemoryOverride } as unknown as MaintenanceModeService;

  // --- Seam ----------------------------------------------------------------
  const removed: string[] = [];
  const exitProcess = jest.fn();
  const runPgRestore = jest.fn(async () => {
    if (options.restoreGate) await options.restoreGate;
    if (options.restoreError) throw options.restoreError;
  });
  const writeArchiveToFile = jest.fn(async (source: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
    const bytes = Buffer.concat(chunks);

    return {
      bytes: BigInt(bytes.length),
      // Hashed from what actually arrived — the whole point of the check.
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });

  const seam: DatabaseRestoreSeam = {
    resolveConnection: () => CONNECTION,
    withAdminConnection: (config, fn) => fn(makeClient(config.database)),
    tempFilePath: () => `/tmp/${JOB_TEMP_PREFIX}restore-test.dump`,
    writeArchiveToFile,
    readTocEntryCount: jest.fn(async () => options.tocEntries ?? 250),
    runPgRestore,
    removeFile: jest.fn(async (path: string) => {
      removed.push(path);
    }),
    sleep: jest.fn(async () => undefined),
    now: () => NOW,
    exitProcess,
  };

  // #288's notifier. `notifyPermissionHoldersNow` is AWAITED by `swap()`, and
  // `order` records when it ran — the ordering assertions are the whole point:
  // it must land after the renames and before `exitProcess`.
  // Records the SQL the cluster had seen at the moment it was called, which is
  // how the ordering assertions pin it AFTER the renames without needing a
  // second event log.
  const notifyAtSql: string[][] = [];
  const notifyPermissionHoldersNow: jest.Mock = jest.fn(async (..._args: unknown[]) => {
    notifyAtSql.push([...sql]);

    if (options.notifyImpl) await options.notifyImpl();
  });
  const notifications = {
    notifyPermissionHoldersNow,
    notifyPermissionHolders: jest.fn(async () => undefined),
  } as unknown as NotificationsService;

  const config = {
    get: jest.fn((key: string) => (key === 'appUrl' ? options.appUrl : undefined)),
  } as unknown as ConfigService;

  /**
   * #353: the queue. `startRestore` ENQUEUES now — it no longer runs anything —
   * so this double is both the assertion surface for what it queued and the
   * source of the `Job` row `runRestore` then executes.
   */
  const queuedJobs: Job[] = [];
  const enqueue = jest.fn(async (input: Record<string, unknown>) => {
    const job = {
      id: `job-restore-${queuedJobs.length + 1}`,
      type: input.type as string,
      subjectType: (input.subjectType as string) ?? null,
      subjectId: (input.subjectId as string) ?? null,
      dedupKey: `${String(input.type)}::${String(input.subjectId ?? '')}`,
      status: 'running',
      reason: input.reason as string,
      priority: (input.priority as number) ?? 0,
      payload: input.payload ?? null,
      // Charged AT CLAIM TIME, so a job reaching a handler already shows 1.
      attempts: 1,
      lastError: null,
      createdAt: new Date('2026-09-07T11:59:00.000Z'),
      startedAt: new Date('2026-09-07T12:00:00.000Z'),
      finishedAt: null,
      executor: 'server',
      claimedByNodeId: null,
      leaseExpiresAt: new Date('2026-09-07T18:00:00.000Z'),
    } as unknown as Job;

    queuedJobs.push(job);

    return job;
  });

  const jobs = { enqueue } as unknown as JobsService;

  const service = new DatabaseRestoreService(
    prisma,
    settings,
    storage,
    preflight,
    runner,
    maintenance,
    notifications,
    config,
    jobs,
    seam
  );

  return {
    service,
    enqueue,
    queuedJobs,
    jobFindFirst,
    startedRuns,
    carriedJobs,
    notifyPermissionHoldersNow,
    notifyAtSql,
    seam,
    sql,
    cluster,
    carried,
    selfLinks,
    carriedAudit,
    stateWrites,
    auditRows,
    removed,
    exitProcess,
    setInMemoryOverride,
    runPgRestore,
    writeArchiveToFile,
    download,
    startBackup,
    check,
    disconnect,
    update,
    /** Every statement, without the attachment prefix. */
    statements: () => sql.map((line) => line.slice(line.indexOf(': ') + 2)),
    /** The restore's terminal state write, if there was one. */
    finalStatus: () => {
      const withStatus = stateWrites.filter((write) => 'restoreStatus' in write);
      return withStatus.length === 0
        ? undefined
        : (withStatus[withStatus.length - 1].restoreStatus as string);
    },
    /** Every audit action written through Prisma (i.e. pre-swap), in order. */
    auditActions: () => auditRows.map((row) => row.action as string),
    /** The `where` the last `findMany` was given. */
    findManyArgs: () => findMany.mock.calls[findMany.mock.calls.length - 1]?.[0],
  };
}

type Harness = ReturnType<typeof makeHarness>;

/**
 * Drives a restore to completion (or failure) and returns the start verdict.
 *
 * ⚠ TWO STEPS SINCE #353, AND THE SPLIT IS THE CONVERSION. `startRestore` runs
 * the gates and ENQUEUES; a worker then calls `executeRestoreJob`. This helper
 * does both back to back so every criterion below reads exactly as it did when
 * the work was detached — the only difference being that the failure path now
 * rejects (the queue's `lastError` is written from that throw), which is why it
 * is caught here rather than in fifty individual cases.
 */
async function runRestore(h: Harness, run = backupRow()) {
  h.startedRuns.set(run.id, run);

  const result = await h.service.startRestore(run, { actorUserId: ACTOR });

  const job = h.queuedJobs[h.queuedJobs.length - 1];

  if (job !== undefined) {
    await h.service.executeRestoreJob(job).catch(() => undefined);
  }

  return result;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error(`timed out waiting for: ${label}`);
}

/** Every `ALTER DATABASE ... RENAME` the cluster saw. */
function renames(h: Harness): string[] {
  return h.statements().filter((text) => /^ALTER DATABASE/.test(text));
}

beforeAll(() => {
  // These paths log warnings and errors on purpose; the suite asserts behaviour,
  // not console noise.
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
describe('the happy path', () => {
  it('restores into a scratch database, verifies, swaps, and exits', async () => {
    const h = makeHarness();

    const result = await runRestore(h);

    expect(result.outcome).toBe('started');

    // The whole sequence, in order, from the statements the cluster received.
    expect(h.statements().filter((s) => /^(CREATE|ALTER|DROP) DATABASE/.test(s))).toEqual([
      `CREATE DATABASE "${SCRATCH}"`,
      `ALTER DATABASE "${LIVE}" RENAME TO "${OLD}"`,
      `ALTER DATABASE "${SCRATCH}" RENAME TO "${LIVE}"`,
    ]);

    // The replay used the scratch database and the parallel path.
    expect(h.runPgRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ database: SCRATCH }),
        jobs: RESTORE_JOBS,
      })
    );

    // `retain_database`: the displaced database is still there.
    expect(h.cluster.has(OLD)).toBe(true);
    expect(h.cluster.has(LIVE)).toBe(true);
    expect(h.cluster.has(SCRATCH)).toBe(false);

    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });

  it('writes restoring -> verifying -> swapping, in that order', async () => {
    const h = makeHarness();
    await runRestore(h);

    const statuses = h.stateWrites
      .map((write) => write.restoreStatus)
      .filter((status): status is string => typeof status === 'string');

    expect(statuses).toEqual(['restoring', 'verifying', 'swapping']);
  });

  it('records the two database names before either exists', async () => {
    // A restore that dies without reaching its own `catch` still has to say
    // which names it was going to use.
    const h = makeHarness();
    await runRestore(h);

    expect(h.stateWrites[0]).toMatchObject({
      restoreStatus: 'restoring',
      restoreScratchDb: SCRATCH,
      restoreOldDb: OLD,
      restoredById: ACTOR,
      restoredAt: NOW,
    });
  });

  it('writes start and swap audit rows before the swap, and the completion row after it', async () => {
    const h = makeHarness();
    await runRestore(h);

    // Pre-swap, through Prisma, into the database about to be displaced.
    expect(h.auditActions()).toEqual([RESTORE_AUDIT_START, RESTORE_AUDIT_SWAP]);

    // Post-swap, through the raw client, into the promoted database.
    expect(h.carriedAudit).toHaveLength(1);
    expect(h.carriedAudit[0][2]).toBe(RESTORE_AUDIT_COMPLETE);
    expect(h.carriedAudit[0][4]).toBe(backupRow().id);

    const meta = JSON.parse(String(h.carriedAudit[0][5])) as Record<string, unknown>;
    expect(meta).toMatchObject({ scratchDatabase: SCRATCH, oldDatabase: OLD });
  });

  it('supplies the audit row\'s own id, because the column has no default (#337)', async () => {
    // `audit_events.id` lost its server-side default in
    // `20260831014110_drop_stale_uuid_defaults`. An INSERT that leaves the
    // column out is a NOT NULL violation on every real restore — and
    // `reinsertCatalog` never throws, so the only trace was a CRITICAL log
    // line and a promoted database with no record of its own restore.
    const h = makeHarness();
    await runRestore(h);

    const insert = h.statements().find((s) => s.startsWith('INSERT INTO audit_events'));
    expect(insert).toContain('INSERT INTO audit_events (id,');
    expect(insert).toContain('VALUES ($1::uuid,');
    // The actor still goes through a subselect, as it did before: the promoted
    // `users` is the archive's, so an administrator created after the backup
    // was taken is not in it and a plain value would be an FK violation.
    expect(insert).toContain('(SELECT id FROM users WHERE id = $2::uuid)');

    // FRESH, not preserved: unlike a carried run, this row has no original —
    // nothing ever wrote `db_restore:complete` into the displaced database.
    expect(String(h.carriedAudit[0][0])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('takes no pre-restore backup in retain_database mode', async () => {
    // The displaced database IS the way back; a full dump as well would add
    // hours to duplicate a guarantee the restore already has.
    const h = makeHarness();
    await runRestore(h);

    expect(h.startBackup).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe('the archive is re-verified against the bytes as they are now', () => {
  it('rejects a checksum mismatch BEFORE anything is created', async () => {
    const h = makeHarness({ archiveBytes: Buffer.from('these are not those bytes') });

    await runRestore(h);

    expect(h.finalStatus()).toBe('failed');
    // NOTHING was created, dropped or renamed. Asserted against the SQL.
    expect(h.statements().filter((s) => /DATABASE/.test(s))).toEqual([]);
    expect(h.cluster.has(SCRATCH)).toBe(false);
    expect(h.cluster.has(LIVE)).toBe(true);
    expect(h.runPgRestore).not.toHaveBeenCalled();
  });

  it('names both checksums so an operator can tell storage rot from the wrong object', async () => {
    const h = makeHarness({ archiveBytes: Buffer.from('these are not those bytes') });
    await runRestore(h);

    const error = String(
      h.stateWrites.filter((write) => 'restoreError' in write && write.restoreError).pop()
        ?.restoreError
    );

    expect(error).toContain(ARCHIVE_SHA256);
    expect(error).toContain('did not survive re-verification');
  });

  it('rejects an archive whose table of contents is empty', async () => {
    const h = makeHarness({ tocEntries: 0 });
    await runRestore(h);

    expect(h.finalStatus()).toBe('failed');
    expect(h.statements().filter((s) => /DATABASE/.test(s))).toEqual([]);
  });

  it('proceeds with a warning when the backup recorded no checksum at all', async () => {
    // A best-effort provenance field must not become load-bearing after the
    // fact; the table-of-contents check still runs.
    const h = makeHarness();
    await runRestore(h, backupRow({ checksumSha256: null }));

    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });
});

// ===========================================================================
describe('a failure before the rename leaves the live database untouched', () => {
  /** Every phase that can fail before the first `ALTER DATABASE`. */
  const phases: Array<[string, HarnessOptions, boolean]> = [
    ['the download', { downloadError: new Error('connection reset by peer') }, false],
    ['archive verification', { tocEntries: 0 }, false],
    [
      'the pre-restore safety backup',
      {
        preflight: okPreflight({ effectiveRollback: 'pre_restore_dump' }),
        preRestoreStatus: 'failed',
      },
      false,
    ],
    [
      'CREATE DATABASE',
      { failStatement: { pattern: /^CREATE DATABASE/, error: new Error('permission denied') } },
      false,
    ],
    ['pg_restore', { restoreError: new Error('pg_restore exited with code 1') }, true],
    ['verification of the restored database', { restoredTables: 0 }, true],
    ['the migration-ledger check', { restoredMigrations: 0 }, true],
  ];

  it.each(phases)(
    'a failure in %s leaves the live database alone and drops the scratch database',
    async (_label, harnessOptions, scratchWasCreated) => {
      const h = makeHarness(harnessOptions);

      await runRestore(h);

      expect(h.finalStatus()).toBe('failed');

      // ⚠ THE ASSERTION THAT MATTERS: not one rename, on any of these paths.
      expect(renames(h)).toEqual([]);
      expect(h.cluster.has(LIVE)).toBe(true);
      expect(h.cluster.has(OLD)).toBe(false);

      // And the scratch database is gone — either never created, or dropped.
      expect(h.cluster.has(SCRATCH)).toBe(false);

      if (scratchWasCreated) {
        expect(h.statements()).toContain(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
      }

      // The maintenance window was never opened: traffic never stopped.
      expect(h.setInMemoryOverride).not.toHaveBeenCalled();
      expect(h.exitProcess).not.toHaveBeenCalled();
    }
  );

  it('records the failure on the row and in the audit trail', async () => {
    const h = makeHarness({ restoreError: new Error('pg_restore exited with code 1') });
    await runRestore(h);

    expect(h.stateWrites.pop()).toMatchObject({
      restoreStatus: 'failed',
      restoreError: 'pg_restore exited with code 1',
    });
    expect(h.auditActions()).toContain(RESTORE_AUDIT_FAILED);
  });

  it('refuses to reuse a scratch database that already exists', async () => {
    // It holds another restore's half-replayed contents, and `pg_restore` would
    // happily add to them.
    const h = makeHarness({ databases: [SCRATCH] });

    await runRestore(h);

    expect(h.finalStatus()).toBe('failed');
    expect(h.runPgRestore).not.toHaveBeenCalled();
    // ⚠ AND IT IS NOT DROPPED. It belongs to whatever created it.
    expect(h.cluster.has(SCRATCH)).toBe(true);
    expect(h.statements()).not.toContain(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  });

  it('never masks the original failure when the scratch drop also fails', async () => {
    const h = makeHarness({
      restoreError: new Error('pg_restore exited with code 1'),
      failStatement: { pattern: /^DROP DATABASE/, error: new Error('being accessed by others') },
    });

    await runRestore(h);

    expect(h.stateWrites.pop()).toMatchObject({
      restoreError: 'pg_restore exited with code 1',
    });
  });
});

// ===========================================================================
describe('the pre-restore safety backup', () => {
  const dumpModePreflight = okPreflight({ effectiveRollback: 'pre_restore_dump' });

  it('is taken, awaited to completion, and linked before the swap', async () => {
    const h = makeHarness({ preflight: dumpModePreflight });

    await runRestore(h);

    expect(h.startBackup).toHaveBeenCalledWith({
      trigger: 'pre_restore',
      createdById: ACTOR,
    });

    // ⚠ AWAITED. `startBackup` returns while `pg_dump` is still streaming, and
    // swapping under an in-flight dump produces a truncated way back.
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { preRestoreBackupId: 'pre-restore-run' } })
    );
    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });

  it('abandons the restore when the safety backup does not complete', async () => {
    const h = makeHarness({ preflight: dumpModePreflight, preRestoreStatus: 'failed' });

    await runRestore(h);

    expect(h.finalStatus()).toBe('failed');
    expect(renames(h)).toEqual([]);
  });

  it('drops the displaced database immediately in pre_restore_dump mode', async () => {
    // The archive is the way back here, not the displaced database, so keeping
    // a full second copy on disk would buy nothing.
    const h = makeHarness({ preflight: dumpModePreflight });

    await runRestore(h);

    expect(h.statements()).toContain(`DROP DATABASE IF EXISTS "${OLD}"`);
    expect(h.cluster.has(OLD)).toBe(false);
    expect(h.cluster.has(LIVE)).toBe(true);
  });
});

// ===========================================================================
describe('the swap', () => {
  it('opens the maintenance window in memory with allowAdmins: false', async () => {
    // The persisted flag lives INSIDE the database being renamed, and an admin
    // request during the window would reach a database that does not exist.
    const h = makeHarness();
    await runRestore(h);

    expect(h.setInMemoryOverride).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, allowAdmins: false })
    );
  });

  it('does not close the window on success — the exit is the release', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.setInMemoryOverride).toHaveBeenCalledTimes(1);
    expect(h.setInMemoryOverride).not.toHaveBeenCalledWith(null);
    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });

  it('disconnects Prisma and terminates every other session before renaming', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.disconnect).toHaveBeenCalled();

    const order = h.statements();
    const terminate = order.findIndex((s) => s.startsWith('SELECT pg_terminate_backend'));
    const firstRename = order.findIndex((s) => s.startsWith('ALTER DATABASE'));

    expect(terminate).toBeGreaterThanOrEqual(0);
    expect(terminate).toBeLessThan(firstRename);
  });

  it('carries no product name into the maintenance message', async () => {
    const h = makeHarness();
    await runRestore(h);

    const override = h.setInMemoryOverride.mock.calls[0][0] as { message: string };
    expect(override.message).toMatch(/database restore/i);
    expect(override.message).not.toMatch(/appdb/i);
  });
});

// ===========================================================================
// `db_backup.restore_completed` (#288, epic #254)
// ===========================================================================
//
// THE ORDERING IS THE FEATURE HERE. A detached dispatch raised before
// `exitProcess` would be dropped outright, and the event is `mandatory: true` —
// so the failure would be a notification that looks wired, passes every
// registry and template test, and delivers nothing in production on the one
// path that matters. These tests pin the two halves of the fix: it is AWAITED,
// and it happens between the renames and the exit.

describe('the completed restore raises db_backup.restore_completed', () => {
  it('raises it exactly once, on the AWAITED entry point', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.notifyPermissionHoldersNow).toHaveBeenCalledTimes(1);
    expect(h.notifyPermissionHoldersNow.mock.calls[0][0]).toBe(
      'db_backup.restore_completed'
    );
    // `db_backup:read` — the exact string `db-backup.controller.ts` enforces.
    expect(h.notifyPermissionHoldersNow.mock.calls[0][1]).toBe('db_backup:read');
  });

  it('⚠ raises it AFTER the renames and BEFORE the exit', async () => {
    // The whole point. `notifyAtSql` records the statements the cluster had
    // seen at the moment the notifier was called, so "after the renames" is
    // asserted against the SQL rather than against a second event log.
    const h = makeHarness();
    await runRestore(h);

    const atNotify = h.notifyAtSql[0] ?? [];
    const renamesSeen = atNotify.filter((text) => /ALTER DATABASE/.test(text));

    // BOTH renames had already happened: the live database was parked and the
    // scratch database was promoted. So the delivery rows this writes land in
    // the RESTORED database, which is the one an operator will open.
    expect(renamesSeen).toHaveLength(2);

    // And the process had not exited yet.
    expect(h.exitProcess).toHaveBeenCalledTimes(1);
    expect(
      h.notifyPermissionHoldersNow.mock.invocationCallOrder[0]
    ).toBeLessThan(h.exitProcess.mock.invocationCallOrder[0]);
  });

  it('⚠ is AWAITED: a slow dispatch delays the exit rather than being dropped by it', async () => {
    let released: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const h = makeHarness({ notifyImpl: () => gate });
    const run = backupRow();
    h.startedRuns.set(run.id, run);

    await h.service.startRestore(run, { actorUserId: ACTOR });

    // ⚠ THE JOB IS EXECUTED WITHOUT AWAITING IT HERE, which is the only way to
    // hold the restore mid-notification: since #353 the work happens inside
    // `executeRestoreJob`, and a worker is what awaits it.
    const executing = h.service.executeRestoreJob(h.queuedJobs[0]);

    await waitFor(
      () => h.notifyPermissionHoldersNow.mock.calls.length > 0,
      'the restore to reach the notification'
    );

    // Held inside the notifier: the exit has NOT happened. A detached dispatch
    // would already have been abandoned here.
    expect(h.exitProcess).not.toHaveBeenCalled();

    released();
    await executing;

    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });

  it('adds the actor to the audience rather than sending them a second message', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.notifyPermissionHoldersNow.mock.calls[0][3]).toEqual({
      alsoNotifyUserIds: [ACTOR],
    });
  });

  it('passes no extra recipients when there was no actor', async () => {
    const h = makeHarness();
    const run = backupRow();
    h.startedRuns.set(run.id, run);

    await h.service.startRestore(run, {});
    await h.service.executeRestoreJob(h.queuedJobs[0]);

    expect(h.notifyPermissionHoldersNow.mock.calls[0][3]).toEqual({
      alsoNotifyUserIds: [],
    });
  });

  it("reports the SOURCE BACKUP'S startedAt as the cut-off, not its finishedAt", async () => {
    // `pg_dump` snapshots when it STARTS, so the state the database now holds
    // is the state at the start of that run. `finishedAt` would overstate it by
    // however long the dump took.
    const h = makeHarness();
    const run = backupRow();
    await runRestore(h, run);

    const payload = h.notifyPermissionHoldersNow.mock.calls[0][2];

    expect(payload).toMatchObject({
      runId: run.id,
      backupTakenAt: run.startedAt,
      triggeredBy: 'ops@example.com',
    });
    expect(payload.completedAt).toBeInstanceOf(Date);
  });

  it('reports the actor as unknown when their account does not exist in the restored database', async () => {
    // Not an error: an operator whose account was created after the archive was
    // taken genuinely is not in it, and that is a true and rather important
    // fact about the state the deployment is now in.
    const h = makeHarness({ actorRow: null });
    await runRestore(h);

    expect(h.notifyPermissionHoldersNow.mock.calls[0][2].triggeredBy).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CONTAINMENT — the #288 acceptance criterion
  // ---------------------------------------------------------------------------

  it('a THROWING notifier does not fail the restore, and the process still exits 0', async () => {
    const h = makeHarness({
      notifyImpl: async () => {
        throw new Error('the notifier exploded');
      },
    });

    await runRestore(h);

    // The swap happened, the process exited, and the run was NOT recorded as
    // failed — which is the outcome an uncontained throw would produce, because
    // it would land in `executeRestore`'s catch and try to drop a scratch
    // database that has already been promoted to live.
    expect(renames(h)).toHaveLength(2);
    expect(h.exitProcess).toHaveBeenCalledWith(0);
    expect(h.finalStatus()).not.toBe('failed');
  });

  it('raises NOTHING when the restore failed before the swap', async () => {
    const h = makeHarness({ restoreError: new Error('pg_restore exited with code 1') });

    await runRestore(h);

    expect(h.finalStatus()).toBe('failed');
    expect(h.notifyPermissionHoldersNow).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe('THE FAILED SECOND RENAME — the one genuinely dangerous moment', () => {
  it('renames the original back into place', async () => {
    const h = makeHarness({
      failStatement: {
        pattern: /RENAME TO/,
        error: new Error('source database is being accessed by other users'),
        // The SECOND rename — the one that promotes the scratch database.
        onCall: 2,
      },
    });

    await runRestore(h);

    // Three renames: park, the failed promote, and the recovery.
    expect(renames(h)).toEqual([
      `ALTER DATABASE "${LIVE}" RENAME TO "${OLD}"`,
      `ALTER DATABASE "${SCRATCH}" RENAME TO "${LIVE}"`,
      `ALTER DATABASE "${OLD}" RENAME TO "${LIVE}"`,
    ]);

    // ⚠ THE DEPLOYMENT IS BACK ON THE DATABASE IT STARTED ON.
    expect(h.cluster.has(LIVE)).toBe(true);
    expect(h.cluster.has(OLD)).toBe(false);
    // ⚠ THE RESTORED DATABASE IS KEPT under its scratch name. It cost hours to
    // build and it is intact; dropping it because a rename failed would throw
    // that away, and section 5.2 of the runbook tells an operator how to finish
    // the swap by hand from exactly this state.
    expect(h.cluster.has(SCRATCH)).toBe(true);
    expect(h.statements()).not.toContain(`DROP DATABASE IF EXISTS "${SCRATCH}"`);

    expect(h.finalStatus()).toBe('failed');
    expect(h.exitProcess).not.toHaveBeenCalled();
  });

  it('closes the maintenance window once the original is back', async () => {
    // There is a working database to serve from, and a window nothing will ever
    // close is an outage of its own.
    const h = makeHarness({
      failStatement: { pattern: /RENAME TO/, error: new Error('nope'), onCall: 2 },
    });

    await runRestore(h);

    expect(h.setInMemoryOverride).toHaveBeenLastCalledWith(null);
  });

  it('reports originalRestored and keeps the window OPEN when the recovery also fails', async () => {
    // Both renames after the park fail: there is no database under the live
    // name, and an orderly 503 beats five hundred stack traces.
    const h = makeHarness({
      failStatement: { pattern: /RENAME TO "appdb"$/, error: new Error('nope') },
    });

    await runRestore(h);

    expect(h.cluster.has(LIVE)).toBe(false);
    expect(h.cluster.has(OLD)).toBe(true);
    expect(h.cluster.has(SCRATCH)).toBe(true);

    // The window is still open: the only `setInMemoryOverride` call was the one
    // that opened it.
    expect(h.setInMemoryOverride).toHaveBeenCalledTimes(1);
    expect(h.setInMemoryOverride).not.toHaveBeenCalledWith(null);
    expect(h.exitProcess).not.toHaveBeenCalled();
  });

  it('carries the recovery verdict on the typed error', () => {
    const restored = new DatabaseRestoreSwapError(LIVE, true, new Error('boom'));
    const lost = new DatabaseRestoreSwapError(LIVE, false, new Error('boom'));

    expect(restored.originalRestored).toBe(true);
    expect(restored.message).toContain('renamed back into place');
    expect(lost.originalRestored).toBe(false);
    expect(lost.message).toContain('5.2');
    // `instanceof` survives downlevelling — the reason for the explicit
    // `setPrototypeOf` in `db-backup.errors.ts`.
    expect(lost).toBeInstanceOf(DatabaseRestoreSwapError);
  });

  it('does not attempt the catalog carry-over when the swap failed', async () => {
    const h = makeHarness({
      failStatement: { pattern: /RENAME TO/, error: new Error('nope'), onCall: 2 },
    });

    await runRestore(h);

    expect(h.carried).toEqual([]);
  });
});

// ===========================================================================
describe('catalog carry-over', () => {
  const newerBackup = backupRow({
    id: '0d1f1c9e-0000-4000-8000-00000000aaaa',
    createdAt: new Date('2026-09-07T02:00:00.000Z'),
    createdById: 'deleted-user-0000-4000-8000-000000000000',
  });

  it('preserves this run\'s record and every backup newer than the archive', async () => {
    const h = makeHarness({ catalogRows: [backupRow(), newerBackup] });

    await runRestore(h);

    expect(h.carried).toHaveLength(2);
    expect(h.carried.map((values) => values[0])).toEqual([backupRow().id, newerBackup.id]);
  });

  it('writes THIS run\'s post-swap audit values, not the pre-swap ones', async () => {
    // Writing "restore completed" into the database nobody will ever open again
    // is exactly the mistake this avoids.
    const h = makeHarness({ catalogRows: [backupRow(), newerBackup] });

    await runRestore(h);

    const mine = h.carried[0];
    expect(mine[19]).toBe('completed'); // restore_status
    expect(mine[23]).toBe(SCRATCH); // restore_scratch_db
    expect(mine[24]).toBe(OLD); // restore_old_db
    expect(mine[25]).toBe(NOW.toISOString()); // swapped_at

    // ...and the other row is carried through unchanged.
    expect(h.carried[1][19]).toBeNull();
  });

  it('resolves both user FKs through a subselect, so a missing user is NULL not an abort', async () => {
    // The promoted database's `users` table is the ARCHIVE's: an administrator
    // created after the backup does not exist in it, and a plain value would
    // raise a foreign-key violation that aborts the WHOLE carry-over.
    const h = makeHarness();
    await runRestore(h);

    const insert = h.statements().find((s) => s.startsWith('INSERT INTO database_backup_runs'));

    expect(insert).toContain('(SELECT id FROM users WHERE id = $19::uuid)');
    expect(insert).toContain('(SELECT id FROM users WHERE id = $23::uuid)');
    // And it REPLACES the stale row rather than leaving it.
    expect(insert).toContain('ON CONFLICT (id) DO UPDATE SET');
  });

  it('applies the self-FK in a SECOND pass, after every referent is inserted', async () => {
    const h = makeHarness({
      preflight: okPreflight({ effectiveRollback: 'pre_restore_dump' }),
    });

    await runRestore(h);

    // The insert never carries `pre_restore_backup_id`...
    const insert = h.statements().find((s) => s.startsWith('INSERT INTO database_backup_runs'));
    expect(insert).not.toContain('pre_restore_backup_id');

    // ...and the second pass sets it, itself through a subselect.
    expect(h.selfLinks).toEqual([[backupRow().id, 'pre-restore-run']]);
    const link = h.statements().find((s) => s.startsWith('UPDATE database_backup_runs'));
    expect(link).toContain('(SELECT id FROM database_backup_runs WHERE id = $2::uuid)');

    // Ordering: every insert precedes every link.
    const order = h.statements();
    const lastInsert = order.reduce(
      (last, text, index) => (text.startsWith('INSERT INTO database_backup_runs') ? index : last),
      -1
    );
    expect(order.findIndex((s) => s.startsWith('UPDATE database_backup_runs'))).toBeGreaterThan(
      lastInsert
    );
  });

  it('goes into the PROMOTED database, on a session of its own', async () => {
    const h = makeHarness();
    await runRestore(h);

    const insert = h.sql.find((line) => line.includes('INSERT INTO database_backup_runs'));
    expect(insert?.startsWith(`${LIVE}: `)).toBe(true);
  });

  it('never undoes a successful swap when it fails', async () => {
    // Losing the backup catalog is bad. Undoing a restore the deployment is
    // already serving from, to avoid losing it, would be worse.
    const h = makeHarness({
      failStatement: {
        pattern: /^INSERT INTO database_backup_runs/,
        error: new Error('relation "database_backup_runs" does not exist'),
      },
    });

    await runRestore(h);

    expect(h.cluster.has(LIVE)).toBe(true);
    expect(h.cluster.has(SCRATCH)).toBe(false);
    expect(h.exitProcess).toHaveBeenCalledWith(0);
  });
});

// ===========================================================================
// ===========================================================================
// ⚠ THE JOB ROW MUST NOT LIE (#353, epic #345)
// ===========================================================================
//
// THE HAZARD, IN FULL. `process()` never returns on the success path, because
// the swap ends in `exitProcess(0)` so a supervisor can rebuild the connection
// pool against the promoted database. The worker's `completeSucceeded`
// therefore never runs. Left alone that produces:
//
//   1. a `jobs` row stuck `running` with a live lease;
//   2. a restarted API whose reaper finds the expired lease;
//   3. `maxAttempts: 1`, so the reaper FAILS the row rather than requeueing it.
//
// Step 3 is the right protection — a requeued restore would replay a restore
// that already succeeded — but it records a successful restore as `failed`.
//
// The fix is that the terminal write rides with the CATALOG CARRY: it is
// decided before the renames, written after both of them, into the PROMOTED
// database, immediately before the exit. These cases pin every part of that
// sentence, because each part is separately losable by a future refactor.
// ===========================================================================

describe('the restore settles its own job row', () => {
  /** The settled job row the carry inserted, as bound parameters. */
  const carriedJob = (h: Harness): unknown[] => {
    expect(h.carriedJobs).toHaveLength(1);

    return h.carriedJobs[0];
  };

  it('writes the job SUCCEEDED — not running, and not failed', async () => {
    const h = makeHarness();

    await runRestore(h);

    // The status is a LITERAL in `CARRY_JOB_SQL`, not a parameter, precisely so
    // no caller can carry a job row in any other state.
    const insert = h
      .statements()
      .find((text) => text.startsWith('INSERT INTO jobs'));

    expect(insert).toBeDefined();
    expect(insert).toContain(`'succeeded'::"JobStatus"`);
    expect(insert).not.toContain('running');
    expect(carriedJob(h)[0]).toBe(h.queuedJobs[0].id);
  });

  it('releases the lease and the claim, exactly as completeSucceeded would', async () => {
    // A terminal row must not appear to be held by anybody: a lease left in the
    // future is what the reaper reads, and a claim left set points at a node.
    const h = makeHarness();

    await runRestore(h);

    const insert = h.statements().find((text) => text.startsWith('INSERT INTO jobs')) ?? '';

    expect(insert).toMatch(/lease_expires_at = NULL/);
    expect(insert).toMatch(/claimed_by_node_id = NULL/);
    // `claimed_by_node_id` is not even a parameter — see `CARRY_JOB_SQL`: the
    // promoted database's `worker_nodes` is the ARCHIVE's, so binding a node id
    // could raise a foreign-key violation and abort the whole carry.
    expect(carriedJob(h)).toHaveLength(14);
  });

  it('stamps finished_at with the SWAP instant, so the run and the job agree', async () => {
    const h = makeHarness();

    await runRestore(h);

    const finishedAt = carriedJob(h)[12] as string;
    const swappedAt = (h.carried[0] ?? [])[25] as string;

    expect(finishedAt).toBe(swappedAt);
  });

  it('carries it into the PROMOTED database, after BOTH renames', async () => {
    // Written before the swap it would land in the database about to be renamed
    // away; written after only one rename there would be no database to write
    // to at all.
    const h = makeHarness();

    await runRestore(h);

    const statements = h.statements();
    const jobInsert = statements.findIndex((text) => text.startsWith('INSERT INTO jobs'));
    const renamesBefore = statements
      .slice(0, jobInsert)
      .filter((text) => /^ALTER DATABASE/.test(text));

    expect(renamesBefore).toHaveLength(2);
  });

  it('writes it BEFORE the exit', async () => {
    const h = makeHarness();

    await runRestore(h);

    // The exit is the last thing that happens, and the row is durable by then.
    expect(h.exitProcess).toHaveBeenCalledWith(0);
    expect(h.carriedJobs).toHaveLength(1);
  });

  it('writes it FIRST in the carry, ahead of the records only a human reads', async () => {
    // Everything else in the carry is read by a person later; this row is ACTED
    // ON by a machine on the next process start. If the session dies part way
    // through, this is the value most worth having landed.
    const h = makeHarness();

    await runRestore(h);

    const statements = h.statements();

    expect(statements.findIndex((text) => text.startsWith('INSERT INTO jobs'))).toBeLessThan(
      statements.findIndex((text) => text.startsWith('INSERT INTO database_backup_runs'))
    );
  });

  it('carries NOTHING when the second rename failed — the restore did not happen', async () => {
    // ⚠ THE CASE THAT MAKES "IF AND ONLY IF" TRUE. The original is renamed back
    // and the deployment is serving from it; a `succeeded` job row here would
    // claim a restore that was undone.
    const h = makeHarness({
      failStatement: {
        pattern: /RENAME TO/,
        error: new Error('source database is being accessed by other users'),
        // The SECOND rename — the one that promotes the scratch database.
        onCall: 2,
      },
    });

    await runRestore(h);

    expect(h.carriedJobs).toEqual([]);
    expect(h.exitProcess).not.toHaveBeenCalled();
    expect(h.finalStatus()).toBe('failed');
  });

  it('carries nothing when the restore failed before the swap', async () => {
    const h = makeHarness({ restoreError: new Error('pg_restore exited 1') });

    await runRestore(h);

    expect(h.carriedJobs).toEqual([]);
    expect(h.finalStatus()).toBe('failed');
  });

  it('FAILS the job when the restore failed, rather than returning normally', async () => {
    // The other half of "the row must not lie": `executeRestore` used to swallow
    // anticipated failures because nothing was listening. A handler that
    // returned normally after a failed restore would be settled `succeeded`.
    const h = makeHarness({ restoreError: new Error('pg_restore exited 1') });
    const run = backupRow();
    h.startedRuns.set(run.id, run);

    await h.service.startRestore(run, { actorUserId: ACTOR });

    await expect(h.service.executeRestoreJob(h.queuedJobs[0])).rejects.toThrow(
      'pg_restore exited 1'
    );
    // ...and the run row still carries the operator's account of what happened.
    expect(h.finalStatus()).toBe('failed');
  });

  it('refuses a job whose payload cannot be read, without touching anything', async () => {
    const h = makeHarness();

    await expect(
      h.service.executeRestoreJob({ id: 'job-x', payload: { runId: 'r' } } as never)
    ).rejects.toThrow(/payload/);

    expect(h.statements()).toEqual([]);
    expect(h.stateWrites).toEqual([]);
  });
});

describe('the temp file', () => {
  it('carries the janitor-swept prefix', () => {
    // A file whose prefix merely RESEMBLES the janitor's is a file the janitor
    // never sweeps — which is the whole reason this imports the prefix rather
    // than copying it.
    const path = defaultDatabaseRestoreSeam.tempFilePath();

    expect(path.startsWith(join(tmpdir(), JOB_TEMP_PREFIX))).toBe(true);
    expect(path.endsWith('.dump')).toBe(true);
  });

  it('is removed on success, BEFORE the swap the process does not return from', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.removed).toEqual([`/tmp/${JOB_TEMP_PREFIX}restore-test.dump`]);

    const order = h.statements();
    // Removed before the first rename, because there is no "after" here.
    expect(h.removed).toHaveLength(1);
    expect(order.filter((s) => s.startsWith('ALTER DATABASE'))).toHaveLength(2);
  });

  it('is removed on failure too', async () => {
    const h = makeHarness({ restoreError: new Error('pg_restore exited with code 1') });
    await runRestore(h);

    expect(h.removed).toEqual([`/tmp/${JOB_TEMP_PREFIX}restore-test.dump`]);
  });

  it('is removed even when the archive never verified', async () => {
    const h = makeHarness({ tocEntries: 0 });
    await runRestore(h);

    expect(h.removed).toEqual([`/tmp/${JOB_TEMP_PREFIX}restore-test.dump`]);
  });
});

// ===========================================================================
describe('starting a restore', () => {
  it('releases the concurrency slot when the pre-flight refuses', async () => {
    // The slot is claimed BEFORE the pre-flight (several network round trips,
    // and two clicks must not both get through it), so every path that does not
    // hand it to the detached body has to give it back.
    const h = makeHarness({
      preflight: {
        ...okPreflight(),
        outcome: 'blocked',
        block: {
          gateId: 'schema_compatibility',
          message: 'the archive predates the running code',
          overridable: true,
          overrideParameter: 'overrideSchemaCheck',
        },
      } as RestorePreflightResult,
    });

    expect((await h.service.startRestore(backupRow())).outcome).toBe('refused');
    expect((await h.service.startRestore(backupRow())).outcome).toBe('refused');
  });

  it('refuses without touching anything when the pre-flight is not ok', async () => {
    const h = makeHarness({
      preflight: {
        ...okPreflight(),
        outcome: 'blocked',
        block: {
          gateId: 'schema_compatibility',
          message: 'the archive predates the running code',
          overridable: true,
          overrideParameter: 'overrideSchemaCheck',
        },
      } as RestorePreflightResult,
    });

    const result = await h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    expect(result.outcome).toBe('refused');
    // ⚠ AND NOTHING WAS WRITTEN. A refused restore is not an attempted one.
    expect(h.stateWrites).toEqual([]);
    expect(h.statements()).toEqual([]);
  });

  it('runs the pre-flight itself rather than trusting its caller', async () => {
    const h = makeHarness();
    await runRestore(h);

    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it('uses the pre-flight\'s own derived names, so the row and the DDL agree', async () => {
    const h = makeHarness({
      preflight: okPreflight({
        scratchDatabase: 'appdb_restore_29991231T235959Z',
        oldDatabase: 'appdb_old_29991231T235959Z',
      }),
    });

    await runRestore(h);

    expect(h.statements()).toContain('CREATE DATABASE "appdb_restore_29991231T235959Z"');
    expect(h.stateWrites[0]).toMatchObject({
      restoreScratchDb: 'appdb_restore_29991231T235959Z',
      restoreOldDb: 'appdb_old_29991231T235959Z',
    });
  });

  // ---------------------------------------------------------------------------
  // THE THREE GUARDS (#353, epic #345)
  // ---------------------------------------------------------------------------
  //
  // Making the restore a queue job did NOT collapse concurrency control onto the
  // active-dedup index, and these two cases are why: that index folds the
  // SUBJECT into the key, so it refuses a second restore of the SAME archive and
  // permits a second restore of a DIFFERENT one — which is the catastrophe.
  // What each guard closes is argued in `startRestore`; what is pinned here is
  // that both of the ones this service owns actually refuse.

  it('refuses a double-click while the pre-flight is still running', async () => {
    // The process-local flag's whole job, and the one window nothing else can
    // cover: it is set before the pre-flight's several round trips and read
    // synchronously, so two overlapping requests cannot both reach the enqueue.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = makeHarness();
    h.check.mockImplementation(async () => {
      await gate;

      return okPreflight();
    });

    const first = h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    await waitFor(() => h.check.mock.calls.length === 1, 'the pre-flight to start');

    const second = await h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    expect(second.outcome).toBe('already_running');
    expect((second as { runId: string }).runId).toBe(backupRow().id);
    // The second request never even ran the gates.
    expect(h.check).toHaveBeenCalledTimes(1);

    release();
    await first;

    // ...and exactly one restore was queued.
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses a restore ANOTHER process queued, which the flag cannot see', async () => {
    // ⚠ THE GUARD THE PROCESS-LOCAL FLAG STRUCTURALLY CANNOT BE. A restore
    // queued before this process started — or by a second replica — is
    // invisible to an in-memory field, and it is type-wide rather than
    // subject-wide, so it is also the only guard that refuses a second restore
    // of a DIFFERENT archive.
    const h = makeHarness({
      queuedRestoreJob: { id: 'job-restore-0', subjectId: 'some-other-run' },
    });

    const result = await h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    expect(result.outcome).toBe('already_running');
    expect((result as { runId: string }).runId).toBe('some-other-run');
    // Nothing was gated, nothing was queued, nothing was written.
    expect(h.check).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.stateWrites).toEqual([]);
  });

  it('releases the process-local flag once the job is queued, not when it finishes', async () => {
    // ⚠ #353 CHANGED THIS, AND GETTING IT WRONG IS A DURABLE OUTAGE. The flag
    // used to be handed to the detached body; now this method's work ends at the
    // enqueue, so holding it any longer would mean a restore that failed at 3am
    // left this replica refusing every later restore until somebody restarted it.
    const h = makeHarness();

    await h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    // Nothing has executed the job, so the only thing that could refuse a second
    // attempt is the durable guard — which this harness reports as empty.
    const second = await h.service.startRestore(backupRow(), { actorUserId: ACTOR });

    expect(second.outcome).toBe('started');
  });

  it('puts process.exit behind the seam so a test can assert it', async () => {
    // The property this whole seam exists for: the most dangerous sequence in
    // the repository is exercised without killing the Jest worker.
    const h = makeHarness();
    await runRestore(h);

    expect(h.exitProcess).toHaveBeenCalledWith(0);
    expect(typeof defaultDatabaseRestoreSeam.exitProcess).toBe('function');
  });
});

// ===========================================================================
describe('rollback', () => {
  const swapped = backupRow({
    restoreStatus: 'completed',
    restoreScratchDb: SCRATCH,
    restoreOldDb: OLD,
    swappedAt: new Date('2026-09-07T11:00:00.000Z'),
    restoredAt: new Date('2026-09-07T10:00:00.000Z'),
    restoredById: ACTOR,
  });

  it('renames the retained database back into place — seconds', async () => {
    const h = makeHarness({ databases: [OLD] });

    const result = await h.service.rollback(swapped, ACTOR);

    expect(result).toMatchObject({ outcome: 'renamed', promoted: OLD });

    expect(renames(h)).toEqual([
      // The bad restore is parked under a fresh scratch name...
      `ALTER DATABASE "${LIVE}" RENAME TO "${SCRATCH}"`,
      // ...and the original is promoted.
      `ALTER DATABASE "${OLD}" RENAME TO "${LIVE}"`,
    ]);

    expect(h.cluster.has(LIVE)).toBe(true);
    expect(h.cluster.has(SCRATCH)).toBe(true);
  });

  it('carries the catalog over, so the rollback does not delete newer backup records', async () => {
    // Including the `pre_restore` dump's, which under some configurations is
    // the only remaining way back from the thing being undone.
    const h = makeHarness({ databases: [OLD], catalogRows: [swapped, backupRow({ id: 'newer' })] });

    await h.service.rollback(swapped, ACTOR);

    expect(h.carried.map((values) => values[0])).toEqual([swapped.id, 'newer']);
    expect(h.carried[0][19]).toBe('rolled_back');
    // [0] is the row's own generated id (#337); the action is [2].
    expect(h.carriedAudit[0][2]).toBe(RESTORE_AUDIT_ROLLBACK);
  });

  it('never drops the database it parked', async () => {
    // It is the restore being undone, and an operator who rolled back at 3am
    // may still want to look at it.
    const h = makeHarness({ databases: [OLD] });

    await h.service.rollback(swapped, ACTOR);

    expect(h.statements().filter((s) => s.startsWith('DROP DATABASE'))).toEqual([]);
  });

  it('exits with a delay, so its HTTP response can be flushed first', async () => {
    const h = makeHarness({ databases: [OLD] });

    await h.service.rollback(swapped, ACTOR);

    expect(h.exitProcess).toHaveBeenCalledWith(0, expect.any(Number));
    expect((h.exitProcess.mock.calls[0][1] as number) > 0).toBe(true);
  });

  it('delegates to a full restore of the pre-restore dump when the database is gone', async () => {
    // Hours, not seconds — and the caller is told which it got.
    const h = makeHarness({
      catalogRows: [],
      restoreError: new Error('stop before the swap so the assertion is about the delegation'),
    });

    const result = await h.service.rollback(
      { ...swapped, preRestoreBackupId: 'pre-restore-run' } as DatabaseBackupRun,
      ACTOR
    );

    expect(result).toMatchObject({ outcome: 'restore_started', preRestoreRunId: 'pre-restore-run' });

    // ⚠ WITH THE SCHEMA CHECK OVERRIDDEN. That dump came from the schema the
    // code was running moments before the restore, so a compatibility block
    // would be spurious — and would fire exactly when the way back is needed.
    expect(h.check).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pre-restore-run' }),
      expect.objectContaining({ overrideSchemaMismatch: true })
    );

    // ⚠ THE DELEGATION IS AN ENQUEUE SINCE #353, NOT A DETACHED REPLAY. What
    // `restore_started` now promises is that a `db.restore.run` job exists —
    // and running it here proves the queued plan is executable rather than
    // merely queued.
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toMatchObject({
      type: 'db.restore.run',
      subjectId: 'pre-restore-run',
    });

    await h.service.executeRestoreJob(h.queuedJobs[0]).catch(() => undefined);

    expect(h.finalStatus()).toBe('failed');
  });

  it('reports unavailable — honestly — when neither route exists', async () => {
    const h = makeHarness();

    const result = await h.service.rollback(swapped, ACTOR);

    expect(result.outcome).toBe('unavailable');
    expect((result as { reason: string }).reason).toContain('oldDatabaseRetentionHours');
    // Nothing was renamed to report it.
    expect(renames(h)).toEqual([]);
  });

  it('reports unavailable for a backup that was never restored', async () => {
    const h = makeHarness();

    const result = await h.service.rollback(backupRow(), ACTOR);

    expect(result).toMatchObject({ outcome: 'unavailable' });
    expect((result as { reason: string }).reason).toContain('no recorded restore');
  });
});

// ===========================================================================
describe('the retained-database sweep', () => {
  const expired = {
    id: 'run-expired',
    restoreOldDb: OLD,
    swappedAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  it('drops a displaced database past its retention window', async () => {
    const h = makeHarness({ databases: [OLD], sweepRows: [expired] });

    const dropped = await h.service.dropExpiredOldDatabases(POLICY, NOW);

    expect(dropped).toBe(1);
    expect(h.statements()).toContain(`DROP DATABASE IF EXISTS "${OLD}"`);
    expect(h.cluster.has(OLD)).toBe(false);
  });

  it('never sweeps an in-flight restore, because its swappedAt is still NULL', async () => {
    // `NULL < cutoff` is never true in SQL, so the filter carries this property
    // on its own — asserted here as the `where` the service actually sends.
    const h = makeHarness({ sweepRows: [] });

    await h.service.dropExpiredOldDatabases(POLICY, NOW);

    expect(h.findManyArgs()).toMatchObject({
      where: {
        restoreOldDb: { not: null },
        swappedAt: { lt: new Date(NOW.getTime() - 48 * 3_600_000) },
      },
    });
  });

  it('refuses to drop the live or the maintenance database, whatever the row says', async () => {
    // `quoteIdentifier` makes the statement safe to SEND. This makes it safe to
    // MEAN: a hand-edited row must not be able to have a cron drop the database
    // the application is serving from.
    const h = makeHarness({
      sweepRows: [
        { id: 'a', restoreOldDb: LIVE, swappedAt: expired.swappedAt },
        { id: 'b', restoreOldDb: 'postgres', swappedAt: expired.swappedAt },
      ],
    });

    const dropped = await h.service.dropExpiredOldDatabases(POLICY, NOW);

    expect(dropped).toBe(0);
    expect(h.statements().filter((text) => text.startsWith('DROP DATABASE'))).toEqual([]);
    expect(h.cluster.has(LIVE)).toBe(true);
  });

  it('keeps going when one database refuses to be dropped', async () => {
    const h = makeHarness({
      databases: [OLD, 'appdb_old_20260902T000000Z'],
      sweepRows: [
        expired,
        { id: 'run-2', restoreOldDb: 'appdb_old_20260902T000000Z', swappedAt: expired.swappedAt },
      ],
      failStatement: {
        pattern: /^DROP DATABASE IF EXISTS "appdb_old_20260907T120000Z"/,
        error: new Error('is being accessed by other users'),
      },
    });

    const dropped = await h.service.dropExpiredOldDatabases(POLICY, NOW);

    expect(dropped).toBe(1);
    expect(h.cluster.has(OLD)).toBe(true);
    expect(h.cluster.has('appdb_old_20260902T000000Z')).toBe(false);
  });

  it('skips a database that has already gone, without failing', async () => {
    // Re-running the sweep, or a restore that dropped its own displaced
    // database in `pre_restore_dump` mode.
    const h = makeHarness({ sweepRows: [expired] });

    expect(await h.service.dropExpiredOldDatabases(POLICY, NOW)).toBe(0);
    expect(h.statements().filter((text) => text.startsWith('DROP DATABASE'))).toEqual([]);
  });

  it('opens no connection at all when nothing is due', async () => {
    const h = makeHarness({ sweepRows: [] });

    expect(await h.service.dropExpiredOldDatabases(POLICY, NOW)).toBe(0);
    expect(h.statements()).toEqual([]);
  });
});
