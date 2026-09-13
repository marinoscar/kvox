import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from '@prisma/client';

import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../../common/schemas/settings.schema';
import type { NotificationsService } from '../../notifications/notifications.service';
import type {
  BackupPruneResult,
  DatabaseBackupRetentionService,
} from '../db-backup-retention.service';
import { DatabaseBackupSweepHandler } from './db-backup-sweep.handler';

// =============================================================================
// The backup sweep's acceptance criteria (issue #282 and #288, moved by #353)
// =============================================================================
//
// ⚠ THESE ARE THE SCHEDULER'S TESTS, ADAPTED — not new ones. Until #353 (epic
// #345) the stale release and the retention prune ran INLINE, the first in
// `DatabaseBackupScheduleTask`'s ten-minute tick and the second at the end of
// every successful backup. Both are now `db.backup.sweep`, so every criterion
// about what the sweep releases, what it leaves alone, what it records and what
// it reports moved here with the code. `tasks/db-backup-schedule.task.spec.ts`
// keeps the scheduling half (the boundary rule, the timezone, DST, the cron
// wrapper) and gained the assertion that it now only ENQUEUES.
//
// NO WALL CLOCK ANYWHERE IN THIS FILE, and no fake timers either. `now` is a
// parameter of `releaseStaleRuns`, which is exactly why it is a public method:
// the interesting criteria are about specific instants, and a test that had to
// move the machine's clock to reach them would be testing the harness.
// =============================================================================

/** The row the worker hands `process`. Only `id` is read, for the log lines. */
const JOB = { id: 'job-sweep' } as Job;

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: 's3',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

interface RunRow {
  id: string;
  status: string;
  storageKey: string;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  /**
   * #351: the age a `pending` row is swept by. A queued run has neither a
   * start nor a heartbeat — that is what `pending` MEANS — so `createdAt` is
   * the only column that can say how long it has held the active slot.
   */
  createdAt?: Date | null;
  finishedAt?: Date;
  lastError?: string;
  /** #288: projected by the sweep's read and rendered by the notification. */
  trigger?: string;
  /**
   * #352: the queue job that is executing this run, if one is.
   *
   * The sweep asks the JOB whether an executor still holds it, because a
   * backup taken on a worker node cannot write a heartbeat to this database
   * at all. A row with no `jobId` (every `pre_restore` dump, and everything
   * older than #351) is swept on its heartbeat exactly as it always was.
   */
  jobId?: string | null;
}

interface HarnessOptions {
  policy?: Partial<SystemDatabaseBackupValue>;
  /**
   * #352: job ids the queue reports as `running` with a lease that has NOT
   * expired. The sweep must leave their runs alone whatever the heartbeat
   * says — that is how a node-executed dump survives a stale window it has no
   * way to write to.
   */
  liveJobs?: string[];
  config?: Record<string, unknown>;
  rows?: RunRow[];
  deleteImpl?: (key: string) => Promise<void>;
  /** Rows this table pretends were mutated by somebody else between read and write. */
  settleDuringSweep?: string[];
  /** Replaces retention's prune, e.g. to make it reject. */
  pruneImpl?: () => Promise<BackupPruneResult>;
  /** #288: a notifier that misbehaves, for the containment assertions. */
  notifyImpl?: () => Promise<void>;
}

function makeHarness(options: HarnessOptions = {}) {
  const policy = { ...POLICY, ...options.policy };
  /** Every side effect in the order it happened, for the ordering assertions. */
  const calls: string[] = [];
  const table = new Map((options.rows ?? []).map((row) => [row.id, { ...row }]));
  const settleDuring = new Set(options.settleDuringSweep ?? []);

  /**
   * The sweep's predicate, evaluated arm by arm.
   *
   * ⚠ `status` MOVED INSIDE THE ARMS in #351 — the sweep no longer asks for
   * one status with three age tests, it asks for two statuses each with its
   * own age column (`lastHeartbeatAt`/`startedAt` for `running`, `createdAt`
   * for `pending`). This double follows that shape literally rather than
   * approximating it, so a predicate that stopped matching pending rows would
   * fail here rather than pass by accident.
   */
  const findMany = jest.fn(async (args: any) => {
    const { where } = args;

    return [...table.values()]
      .filter((row) =>
        where.OR.some((arm: any) => {
          if (row.status !== arm.status) return false;

          // The queued-but-never-claimed arm: aged by `createdAt`, because a
          // pending row has neither a heartbeat nor a start.
          if (arm.createdAt !== undefined) {
            return row.createdAt != null && row.createdAt < arm.createdAt.lt;
          }

          if (arm.lastHeartbeatAt === null) {
            return row.lastHeartbeatAt === null && row.startedAt !== null
              ? row.startedAt < arm.startedAt.lt
              : false;
          }

          return row.lastHeartbeatAt !== null && row.lastHeartbeatAt < arm.lastHeartbeatAt.lt;
        })
      )
      .map((row) => ({ ...row }));
  });

  const updateMany = jest.fn(
    async ({ where, data }: { where: any; data: Record<string, unknown> }) => {
      calls.push(`row:${where.id}`);

      const row = table.get(where.id);

      // The race the conditional `where` exists for: this row finished
      // between the sweep's read and its write.
      if (settleDuring.has(where.id) && row !== undefined) row.status = 'completed';

      if (row === undefined || row.status !== where.status) return { count: 0 };

      Object.assign(row, data);

      return { count: 1 };
    }
  );

  /**
   * The queue's side of the sweep (#352): which of these jobs is still held.
   *
   * Deliberately asserts the PREDICATE rather than just returning the set —
   * "held" means `status: 'running'` AND a lease in the future, and a sweep
   * that dropped either half would either leak (never sweeping an abandoned
   * node run) or lose data (sweeping a live one).
   */
  const liveJobs = new Set(options.liveJobs ?? []);
  const jobFindMany = jest.fn(async ({ where }: any) => {
    if (where.status !== 'running') throw new Error('expected the held-lease predicate');
    if (where.leaseExpiresAt?.gt === undefined) throw new Error('expected a lease check');

    return (where.id.in as string[])
      .filter((id) => liveJobs.has(id))
      .map((id) => ({ id }));
  });

  const prisma = {
    databaseBackupRun: { findMany, updateMany },
    job: { findMany: jobFindMany },
  } as unknown as PrismaService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => policy),
  } as unknown as SystemSettingsService;

  const deleteObject = jest.fn(async (key: string) => {
    calls.push(`object:${key}`);
    if (options.deleteImpl) await options.deleteImpl(key);
  });

  const storage = { delete: deleteObject } as unknown as StorageProvider;

  const configGet = jest.fn((key: string) => (options.config ?? {})[key]);
  const config = { get: configGet } as unknown as ConfigService;

  // #288's notifier. A jest mock, so the containment assertions can make it
  // throw and still require the sweep to finish.
  const notifyPermissionHolders: jest.Mock = jest.fn(async (..._args: unknown[]) => {
    if (options.notifyImpl) await options.notifyImpl();
  });
  const notifications = {
    notifyPermissionHolders,
  } as unknown as NotificationsService;

  /**
   * Retention's half of the sweep (#353). Its own rules are covered in
   * `db-backup-retention.service.spec.ts`; what is asserted through this double
   * is only that the handler calls it, with the tick's clock, AFTER the stale
   * release.
   */
  const prune = jest.fn(
    options.pruneImpl ??
      (async (_now?: Date): Promise<BackupPruneResult> => {
        calls.push('prune');

        return { prunedByCount: 0, prunedByAge: 0, keptAfterFailedDelete: 0 };
      })
  );

  const retention = { prune } as unknown as DatabaseBackupRetentionService;

  const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

  const handler = new DatabaseBackupSweepHandler(
    registry,
    prisma,
    settings,
    retention,
    storage,
    config,
    notifications
  );

  return {
    handler,
    notifyPermissionHolders,
    policy,
    prisma,
    calls,
    table,
    findMany,
    updateMany,
    jobFindMany,
    prune,
    deleteObject,
    configGet,
    async sweepAt(iso: string) {
      return handler.releaseStaleRuns(policy, new Date(iso));
    },
  };
}

/**
 * The policy the `handleCron` tests use.
 *
 * `handleCron` reads `new Date()` — that is the whole point of it, and the
 * only part of this feature that may. A midnight schedule makes the boundary
 * "today at 00:00 in UTC", which is at or before every instant of every day,
 * so "an empty table means a backup is due" is true whatever hour CI happens
 * to run at. Pinning the wall clock instead would test the harness.
 */
function runningRow(id: string, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id,
    status: 'running',
    storageKey: `backups/${id}.dump`,
    createdAt: new Date('2026-09-07T02:00:00.000Z'),
    startedAt: new Date('2026-09-07T02:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-09-07T02:00:20.000Z'),
    trigger: 'scheduled',
    ...overrides,
  };
}

/**
 * #351: a run that was QUEUED and never claimed.
 *
 * `startedAt` and `lastHeartbeatAt` are NULL because that is what `pending`
 * means — nothing has started, so nothing has beaten. `createdAt` is the only
 * column that can say how long this row has been holding the single active
 * slot, which is exactly why the sweep's third arm reads it.
 */
function pendingRow(id: string, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id,
    status: 'pending',
    storageKey: `backups/${id}.dump`,
    createdAt: new Date('2026-09-07T02:00:00.000Z'),
    startedAt: null,
    lastHeartbeatAt: null,
    trigger: 'scheduled',
    ...overrides,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('the stale sweep', () => {
  it('releases a run whose heartbeat stopped, and frees the slot', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:20.000Z') })],
    });

    // runStaleMinutes is 120, so 05:00 is well past.
    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);

    const row = h.table.get('zombie');
    expect(row?.status).toBe('stale');
    expect(row?.finishedAt).toEqual(new Date('2026-09-07T05:00:00.000Z'));
    expect(row?.lastError).toContain('120');
  });

  // ---------------------------------------------------------------------------
  // #351: the arm the original predicate's own ⚠ demanded once `pending` rows
  // became real
  // ---------------------------------------------------------------------------

  it('releases a QUEUED run no worker ever claimed, aging it by createdAt', async () => {
    // The failure this arm exists for: a `pending` row holds the single active
    // slot under the tightened index, and it has no heartbeat that could ever
    // age it out. Without this, one deleted job — or one deployment with
    // JOBS_WORKER_MODE=off — blocks every backup that deployment would ever
    // take again.
    const h = makeHarness({ rows: [pendingRow('never-claimed')] });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);
    expect(h.table.get('never-claimed')?.status).toBe('stale');
  });

  it('leaves a queued run inside the window alone — an ordinary queue delay is not staleness', async () => {
    const h = makeHarness({
      rows: [pendingRow('just-queued', { createdAt: new Date('2026-09-07T04:59:00.000Z') })],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);
    expect(h.table.get('just-queued')?.status).toBe('pending');
  });

  it('tells a queued run apart from an abandoned dump in the reason it records', async () => {
    // ⚠ TWO MESSAGES, NOT ONE. An operator fixes these in different places: a
    // `running` row was executing somewhere that went away; a `pending` row
    // was never picked up, which is a statement about the QUEUE and not about
    // any dump. Flattening both into "stopped heartbeating" would send
    // somebody hunting through `pg_dump` logs for a process that never existed.
    const h = makeHarness({
      rows: [pendingRow('never-claimed'), runningRow('zombie')],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(2);

    expect(h.table.get('never-claimed')?.lastError).toContain('no worker claimed its job');
    expect(h.table.get('never-claimed')?.lastError).toContain('No dump was ever started');
    expect(h.table.get('zombie')?.lastError).toContain('stopped heartbeating');
  });

  it('guards the pending transition on `pending`, not on the old literal `running`', async () => {
    // The regression this pins is the one that looks exactly like working: a
    // hard-coded `status: 'running'` in the compare-and-swap would make every
    // pending candidate `count === 0`, and the sweep would report freeing
    // nothing while quietly leaving the slot blocked.
    const h = makeHarness({ rows: [pendingRow('never-claimed')] });

    await h.sweepAt('2026-09-07T05:00:00.000Z');

    expect(h.updateMany.mock.calls[0][0].where).toEqual({
      id: 'never-claimed',
      status: 'pending',
    });
  });

  it('leaves a queued run alone if it moved on between the sweep\'s read and its write', async () => {
    // Same race the `running` guard covers, from the other side. A `pending`
    // row can move on in exactly the way that matters here — a worker claims
    // it and the dump runs to completion — and the conditional update must
    // then match nothing, so the sweep cannot stamp `stale` over a backup that
    // succeeded while it was deciding.
    const h = makeHarness({
      rows: [pendingRow('claimed-mid-sweep')],
      settleDuringSweep: ['claimed-mid-sweep'],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);
  });

  it('leaves a run whose heartbeat is still inside the window alone', async () => {
    const h = makeHarness({
      rows: [runningRow('healthy', { lastHeartbeatAt: new Date('2026-09-07T04:59:00.000Z') })],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);
    expect(h.table.get('healthy')?.status).toBe('running');
  });

  it('ages a zombie with a NULL heartbeat by startedAt', async () => {
    // A process that died between the claim and its first progress write.
    // `NULL < cutoff` is NULL in SQL, never true, so without the second arm
    // this row holds the active slot forever.
    const h = makeHarness({
      rows: [
        runningRow('never-beat', {
          lastHeartbeatAt: null,
          startedAt: new Date('2026-09-07T02:00:00.000Z'),
        }),
      ],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);
    expect(h.table.get('never-beat')?.status).toBe('stale');
  });

  it('guards the transition on status: running, so a run that finished in the race is NOT stomped', async () => {
    // The read and the write are not atomic. The interesting case is a dump
    // whose heartbeat was starved by a lock wait and that then completed
    // normally: `count === 0`, and overwriting it would discard a verified
    // backup's record AND delete the archive it points at.
    const h = makeHarness({
      rows: [runningRow('racer', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      settleDuringSweep: ['racer'],
    });

    await expect(h.sweepAt('2026-09-07T06:00:00.000Z')).resolves.toBe(0);

    expect(h.table.get('racer')?.status).toBe('completed');
    // And — the part that matters most — its object was never deleted.
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.updateMany.mock.calls[0][0].where).toEqual({ id: 'racer', status: 'running' });
  });

  it('transitions the ROW FIRST and cleans the object SECOND', async () => {
    // The row is the guard. Deleting the object first and then dying would
    // leave a `running` row holding the slot and pointing at nothing.
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
    });

    await h.sweepAt('2026-09-07T06:00:00.000Z');

    expect(h.calls).toEqual(['row:zombie', 'object:backups/zombie.dump']);
  });

  it('still counts the release when the object delete fails', async () => {
    // A visible stale row naming an orphaned object beats an invisible
    // billable one — and the slot, which is the part that had to happen, is
    // free either way.
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      deleteImpl: async () => {
        throw new Error('AccessDenied');
      },
    });

    await expect(h.sweepAt('2026-09-07T06:00:00.000Z')).resolves.toBe(1);
    expect(h.table.get('zombie')?.status).toBe('stale');
  });

  it('never re-queues a stale run: the next scheduled backup is the retry', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
    });

    await h.sweepAt('2026-09-07T06:00:00.000Z');

    // The row is transitioned exactly once and nothing puts it back: `stale` is
    // terminal, and the retry for a backup is the next scheduled one.
    expect(h.table.get('zombie')?.status).toBe('stale');
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.table.get('zombie')?.status).not.toBe('pending');
  });

  it('uses runStaleMinutes as the window', async () => {
    const h = makeHarness({
      policy: { runStaleMinutes: 30 },
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
    });

    await expect(h.sweepAt('2026-09-07T02:20:00.000Z')).resolves.toBe(0);
    await expect(h.sweepAt('2026-09-07T02:40:00.000Z')).resolves.toBe(1);
  });

  // ===========================================================================
  // A run whose JOB is still leased is not stale (#352, epic #345)
  // ===========================================================================
  //
  // THE FAILURE THESE PREVENT IS DATA LOSS, not untidiness. A backup taken on
  // a worker node cannot write `lastHeartbeatAt` — a node has no database
  // access at all — so after `runStaleMinutes` the sweep would mark a
  // perfectly healthy run `stale`, DELETE THE ARCHIVE THE NODE IS STILL
  // UPLOADING, and then refuse the result when it arrived. The liveness signal
  // for a remote executor is the one it is already maintaining: the job's
  // lease.

  it('leaves a `running` run alone while its job is still held under a live lease', async () => {
    const h = makeHarness({
      rows: [
        runningRow('on-a-node', {
          jobId: 'job-1',
          // Written once, when the node asked for its upload target, and never
          // again — which is exactly what a node-executed run looks like.
          lastHeartbeatAt: new Date('2026-09-07T02:00:20.000Z'),
        }),
      ],
      liveJobs: ['job-1'],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);

    expect(h.table.get('on-a-node')?.status).toBe('running');
    // AND THE ARCHIVE IS STILL THERE. This is the assertion that matters: the
    // sweep deletes the object of every run it transitions.
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('leaves a `pending` run alone while its job is still held — the node has claimed but not yet uploaded', async () => {
    const h = makeHarness({
      rows: [pendingRow('queued-on-a-node', { jobId: 'job-2' })],
      liveJobs: ['job-2'],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);
    expect(h.table.get('queued-on-a-node')?.status).toBe('pending');
  });

  it('sweeps it the moment the lease is gone — a node that died is still a run to give up on', async () => {
    const h = makeHarness({
      rows: [runningRow('abandoned', { jobId: 'job-3' })],
      // `liveJobs` is empty: the queue reports the job as no longer held,
      // which is what an expired lease or a settled job looks like.
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);
    expect(h.table.get('abandoned')?.status).toBe('stale');
  });

  it('asks the queue nothing when no candidate has a job — every pre-#351 run and every pre-restore dump', async () => {
    const h = makeHarness({
      rows: [runningRow('no-job', { lastHeartbeatAt: new Date('2026-09-07T02:00:20.000Z') })],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);

    // Not "returns an empty set" — makes NO QUERY. A sweep that asked the jobs
    // table once per tick on a deployment that has never run a queued backup
    // would be a query nobody could explain.
    expect(h.jobFindMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// `db_backup.backup_failed` from the STALE side (#288, epic #254)
// =============================================================================

describe('the stale sweep raises db_backup.backup_failed', () => {
  it('raises it once per run it actually transitioned', async () => {
    const h = makeHarness({
      rows: [
        runningRow('zombie-a', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') }),
        runningRow('zombie-b', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') }),
      ],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(2);

    expect(h.notifyPermissionHolders).toHaveBeenCalledTimes(2);
    expect(h.notifyPermissionHolders.mock.calls[0][0]).toBe('db_backup.backup_failed');
    // `db_backup:read` — the exact string `db-backup.controller.ts` enforces,
    // and the same one the runner's own failure path uses.
    expect(h.notifyPermissionHolders.mock.calls[0][1]).toBe('db_backup:read');
  });

  it("carries outcome 'stale', not 'failed' — nothing observed this run break", async () => {
    // An operator chases the two in completely different places: a dump's
    // stderr versus a host that disappeared. Flattening both into "backup
    // failed" sends them to the wrong one.
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
    });

    await h.sweepAt('2026-09-07T05:00:00.000Z');

    const payload = h.notifyPermissionHolders.mock.calls[0][2];

    expect(payload).toMatchObject({
      runId: 'zombie',
      outcome: 'stale',
      trigger: 'scheduled',
      failedAt: new Date('2026-09-07T05:00:00.000Z'),
    });
  });

  it('quotes the SAME explanation the row was given, rather than a second wording of it', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
    });

    await h.sweepAt('2026-09-07T05:00:00.000Z');

    expect(h.notifyPermissionHolders.mock.calls[0][2].error).toBe(
      h.table.get('zombie')?.lastError,
    );
  });

  it('raises NOTHING for a run that settled between the read and the write', async () => {
    // `count === 0`: somebody else transitioned it, and one settled run must
    // raise exactly one notification however many replicas are sweeping.
    const h = makeHarness({
      rows: [runningRow('racer', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      settleDuringSweep: ['racer'],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);

    expect(h.notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('raises NOTHING when every run is still heartbeating', async () => {
    const h = makeHarness({
      rows: [runningRow('healthy', { lastHeartbeatAt: new Date('2026-09-07T04:59:00.000Z') })],
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(0);

    expect(h.notifyPermissionHolders).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // CONTAINMENT — the #288 acceptance criterion
  // ---------------------------------------------------------------------------

  it('a THROWING notifier does not fail the sweep, and the slot is still freed', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      notifyImpl: () => {
        throw new Error('the notifier exploded');
      },
    });

    await expect(h.sweepAt('2026-09-07T05:00:00.000Z')).resolves.toBe(1);

    expect(h.table.get('zombie')?.status).toBe('stale');
  });

  it('a THROWING notifier does not stop the object cleanup that follows it', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      notifyImpl: () => {
        throw new Error('the notifier exploded');
      },
    });

    await h.sweepAt('2026-09-07T05:00:00.000Z');

    expect(h.deleteObject).toHaveBeenCalledWith('backups/zombie.dump');
  });

  it('a notifier that REJECTS does not fail the job', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z') })],
      notifyImpl: async () => {
        throw new Error('dispatch blew up');
      },
    });

    await expect(h.handler.process(JOB)).resolves.toBeUndefined();
    expect(h.table.get('zombie')?.status).toBe('stale');
  });
});


// =============================================================================
// The two duties, and the order they happen in (#353, epic #345)
// =============================================================================
//
// `process` is the only thing in this file that is genuinely NEW rather than
// moved: before #353 the release and the prune had no common caller — one was a
// cron duty, the other ran at the end of a backup — and nothing anywhere
// asserted their relationship. Now they are one job, and these are its rules.
// =============================================================================

describe('DatabaseBackupSweepHandler.process', () => {
  it('releases stale runs FIRST and prunes SECOND', async () => {
    // The order is load-bearing: the release is what frees the single active
    // slot, and the prune is pure storage housekeeping that nothing waits on.
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2020-01-01T00:00:00.000Z') })],
    });

    await h.handler.process(JOB);

    expect(h.calls.indexOf('row:zombie')).toBeLessThan(h.calls.indexOf('prune'));
    expect(h.prune).toHaveBeenCalledTimes(1);
  });

  it('judges the release and the prune against ONE instant', async () => {
    // Same `now` for both duties, so a run cannot be inside the stale window
    // for one and outside it for the other.
    const h = makeHarness();

    await h.handler.process(JOB);

    expect(h.prune.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it('still prunes when the release failed, and then FAILS the job', async () => {
    // One job, not one transaction: a failure in either duty must not cost the
    // other, and the job must still be recorded as incomplete.
    const h = makeHarness();
    h.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(h.handler.process(JOB)).rejects.toThrow('the stale sweep failed');
    expect(h.prune).toHaveBeenCalledTimes(1);
  });

  it('still releases when the prune failed, and then FAILS the job', async () => {
    const h = makeHarness({
      rows: [runningRow('zombie', { lastHeartbeatAt: new Date('2020-01-01T00:00:00.000Z') })],
      pruneImpl: async () => {
        throw new Error('bucket unreachable');
      },
    });

    await expect(h.handler.process(JOB)).rejects.toThrow('the retention prune failed');
    // ⚠ THE SLOT IS STILL FREE. The release committed before the prune ran, and
    // a thrown job does not undo it — which is why the message names which duty
    // failed rather than saying "sweep failed".
    expect(h.table.get('zombie')?.status).toBe('stale');
  });

  it('resolves when both duties succeeded', async () => {
    const h = makeHarness();

    await expect(h.handler.process(JOB)).resolves.toBeUndefined();
  });
});
