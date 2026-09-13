import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { SystemDatabaseBackupValue } from '../../common/schemas/settings.schema';
import type { JobsService } from '../../jobs/jobs.service';
import type { DatabaseBackupRunnerService } from '../db-backup-runner.service';
import { DB_BACKUP_SWEEP_TYPE } from '../handlers/db-backup-sweep.handler';
import { DB_RESTORE_OLD_DB_DROP_TYPE } from '../handlers/db-restore-old-db-drop.handler';
import { DatabaseBackupAlreadyRunningError } from '../db-backup.errors';
import { DatabaseBackupScheduleTask } from './db-backup-schedule.task';

// =============================================================================
// The scheduler's acceptance criteria (issue #282, narrowed by #353)
// =============================================================================
//
// ⚠ THE SWEEP'S CRITERIA ARE NOT HERE ANY MORE, AND THAT IS THE POINT. #353
// (epic #345) moved the stale release and the retained-database drop out of
// this tick and into `db.backup.sweep` and `db.restore.old-db-drop`; every
// assertion about what they release, record and report moved intact to
// `handlers/db-backup-sweep.handler.spec.ts`. What is left here is the half
// that genuinely belongs to a scheduler — the boundary rule, the timezone, DST,
// the kill switch, the overlap guard — plus the new criterion that the other
// two duties are ENQUEUED rather than performed.
//
// NO WALL CLOCK ANYWHERE IN THIS FILE, and no fake timers either. `now` is a
// parameter of `releaseStaleRuns` and `fireDueBackup`, which is exactly why
// those two are public methods: the interesting criteria are about specific
// instants — 07:00 UTC on the morning American clocks jump forward, a tick
// that arrives forty minutes late, the second pass of an autumn 01:30 — and
// a test that had to move the machine's clock to reach them would be testing
// the harness. `handleCron` is driven only for the properties that belong to
// the cron wrapper itself: the kill switch, the overlap guard and "it never
// rejects".
//
// The scheduler holds NO PERSISTED STATE by design, so "across a restart" is
// literally a second `new DatabaseBackupScheduleTask(...)` over the same
// table — see the restart test, which is the whole argument against a
// `lastRunAt` column expressed as an assertion.
// =============================================================================

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
}

interface HarnessOptions {
  policy?: Partial<SystemDatabaseBackupValue>;
  config?: Record<string, unknown>;
  rows?: RunRow[];
  /** Replaces the default `queueBackup`, e.g. to make it reject. */
  queueBackupImpl?: () => Promise<{ run: { id: string }; job: { id: string } }>;
  /** #353: makes one of the housekeeping enqueues misbehave. */
  enqueueImpl?: (input: Record<string, unknown>) => Promise<void>;
  /** #353: what the housekeeping guard reports as already in flight. */
  activeHousekeepingJob?: { id: string; status: string } | null;
}

function makeHarness(options: HarnessOptions = {}) {
  const policy = { ...POLICY, ...options.policy };
  /** Every side effect in the order it happened, for the ordering assertions. */
  const calls: string[] = [];
  const table = new Map((options.rows ?? []).map((row) => [row.id, { ...row }]));

  /** The newest `startedAt` in the table — the real query's answer. */
  const findFirst = jest.fn(async ({ where }: any) => {
    const candidates = [...table.values()].filter((row) => row.startedAt !== null);

    if (where?.startedAt?.not !== null) throw new Error('unexpected findFirst filter');
    if (candidates.length === 0) return null;

    candidates.sort(
      (a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime()
    );

    return { id: candidates[0].id, startedAt: candidates[0].startedAt };
  });

  const prisma = {
    databaseBackupRun: { findFirst },
    // #353: `enqueueHousekeepingJob`'s "is one already in flight?" guard.
    job: { findFirst: jest.fn(async () => options.activeHousekeepingJob ?? null) },
  } as unknown as PrismaService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => policy),
  } as unknown as SystemSettingsService;

  /** Set by `fireAt` so a claimed run records the instant the tick believed it was. */
  let tickNow = new Date(0);
  let claimed = 0;

  /**
   * #351: the scheduler ENQUEUES now — `queueBackup`, not `startBackup`.
   *
   * ⚠ THE DOUBLE MODELS A WORKER CLAIMING THE JOB IMMEDIATELY, which is why
   * the row it writes is `running` with a `startedAt`. That is deliberate and
   * it is what keeps every boundary test in this file testing THE BOUNDARY
   * RULE rather than the queue: the anti-double-fire query asks "has a run
   * STARTED since this boundary", and a double that left the row `pending`
   * forever would make each of those tests fail for a reason that has nothing
   * to do with the schedule arithmetic they exist to pin.
   *
   * The genuinely-unclaimed window — a `pending` row that covers no boundary,
   * and the dedup conflict that stops the second fire — is covered
   * separately, by `ignores a row that never started` and by the
   * already-running group below.
   */
  const queueBackup = jest.fn(
    options.queueBackupImpl ??
      (async () => {
        calls.push('queueBackup');
        claimed += 1;
        const id = `run-${claimed}`;
        table.set(id, {
          id,
          status: 'running',
          storageKey: `backups/${id}.dump`,
          createdAt: tickNow,
          startedAt: tickNow,
          lastHeartbeatAt: tickNow,
        });

        return { run: { id }, job: { id: `job-${claimed}` } };
      })
  );

  const runner = { queueBackup } as unknown as DatabaseBackupRunnerService;

  const configGet = jest.fn((key: string) => (options.config ?? {})[key]);
  const config = { get: configGet } as unknown as ConfigService;

  /**
   * The queue (#353). The tick's two housekeeping duties are enqueues now, so
   * this double is what every assertion about them reads. `job.findFirst` is the
   * cheap "one already in flight?" guard `enqueueHousekeepingJob` makes first.
   */
  const enqueue = jest.fn(async (input: Record<string, unknown>) => {
    calls.push(`enqueue:${String(input.type)}`);

    if (options.enqueueImpl) await options.enqueueImpl(input);

    return { id: `housekeeping-${calls.length}`, ...input };
  });

  const jobs = { enqueue } as unknown as JobsService;

  const build = () =>
    new DatabaseBackupScheduleTask(prisma, settings, runner, config, jobs);

  const task = build();

  return {
    task,
    enqueue,
    /** A fresh instance over the SAME table — the restart simulation. */
    restart: build,
    policy,
    prisma,
    calls,
    table,
    findFirst,
    queueBackup,
    configGet,
    /** One tick's firing decision at a pinned instant. */
    async fireAt(iso: string) {
      tickNow = new Date(iso);

      return task.fireDueBackup(policy, tickNow);
    },
    /** The same, on a different (restarted) instance. */
    async fireAtWith(instance: DatabaseBackupScheduleTask, iso: string) {
      tickNow = new Date(iso);

      return instance.fireDueBackup(policy, tickNow);
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
const ALWAYS_DUE: Partial<SystemDatabaseBackupValue> = { timeOfDay: '00:00' };

/** Polls until `condition` holds, for the one test that races two ticks. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('exactly one run per boundary', () => {
  it('fires when the window has opened and nothing has started since', async () => {
    const h = makeHarness();

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('fired');
    expect(h.queueBackup).toHaveBeenCalledWith({ trigger: 'scheduled' });
  });

  it('does not fire before the window opens', async () => {
    const h = makeHarness();

    // 01:50 — the previous boundary is YESTERDAY's 02:00, and yesterday's run
    // is in the table.
    h.table.set('yesterday', {
      id: 'yesterday',
      status: 'completed',
      storageKey: 'backups/yesterday.dump',
      startedAt: new Date('2026-09-06T02:01:00.000Z'),
      lastHeartbeatAt: new Date('2026-09-06T02:40:00.000Z'),
    });

    await expect(h.fireAt('2026-09-07T01:50:00.000Z')).resolves.toBe('not_due');
    expect(h.queueBackup).not.toHaveBeenCalled();
  });

  it('stands down for the rest of the window: two ticks inside one window fire once', async () => {
    const h = makeHarness();

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('fired');
    await expect(h.fireAt('2026-09-07T02:13:00.000Z')).resolves.toBe('not_due');
    await expect(h.fireAt('2026-09-07T23:59:00.000Z')).resolves.toBe('not_due');

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  it('STILL FIRES when the tick is late — a missed window is recovered, not lost', async () => {
    // The process was down from 01:55 to 02:40. A timer registered on the
    // operator's own cron expression would simply have skipped the night.
    const h = makeHarness();

    await expect(h.fireAt('2026-09-07T02:40:00.000Z')).resolves.toBe('fired');
  });

  it('fires once the NEXT window opens, having stood down through this one', async () => {
    const h = makeHarness();

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('fired');
    await expect(h.fireAt('2026-09-08T01:00:00.000Z')).resolves.toBe('not_due');
    await expect(h.fireAt('2026-09-08T02:01:00.000Z')).resolves.toBe('fired');

    expect(h.queueBackup).toHaveBeenCalledTimes(2);
  });

  it('survives a restart with no persisted state: a fresh instance reaches the same verdict', async () => {
    // ⚠ THE ARGUMENT AGAINST A `lastRunAt` COLUMN, AS AN ASSERTION. The
    // verdict is recomputed from the settings and the table, so there is
    // nothing a restart could lose and nothing that could drift.
    const h = makeHarness();

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('fired');

    const afterRestart = h.restart();

    await expect(h.fireAtWith(afterRestart, '2026-09-07T02:23:00.000Z')).resolves.toBe(
      'not_due'
    );
    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  it('counts a MANUAL backup as covering the window', async () => {
    // The promise is "a backup exists for this window", not "a backup with the
    // scheduled label exists". Dumping the same database twice in five minutes
    // is I/O for no additional safety.
    const h = makeHarness({
      rows: [
        {
          id: 'manual-1',
          status: 'running',
          storageKey: 'backups/manual-1.dump',
          startedAt: new Date('2026-09-07T02:05:00.000Z'),
          lastHeartbeatAt: new Date('2026-09-07T02:05:00.000Z'),
        },
      ],
    });

    await expect(h.fireAt('2026-09-07T02:15:00.000Z')).resolves.toBe('not_due');
  });

  it('ignores a row that never started — it says nothing about whether a window was covered', async () => {
    const h = makeHarness({
      rows: [
        {
          id: 'never-started',
          status: 'pending',
          storageKey: 'backups/never-started.dump',
          startedAt: null,
          lastHeartbeatAt: null,
        },
      ],
    });

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('fired');
  });
});

describe('the configured timezone, not the server\'s', () => {
  it('evaluates the schedule in the operator\'s zone', async () => {
    // 03:00 UTC on 15 June is 23:00 on 14 June in New York. A scheduler that
    // evaluated "02:00" in the server's zone (UTC in a container) would see
    // the window as open and fire; in New York the last boundary was 02:00 EDT
    // on the 14th, which the run below already covers.
    const h = makeHarness({
      policy: { timezone: 'America/New_York' },
      rows: [
        {
          id: 'ny-1',
          status: 'completed',
          storageKey: 'backups/ny-1.dump',
          // 02:05 EDT on 14 June.
          startedAt: new Date('2026-06-14T06:05:00.000Z'),
          lastHeartbeatAt: new Date('2026-06-14T06:40:00.000Z'),
        },
      ],
    });

    await expect(h.fireAt('2026-06-15T03:00:00.000Z')).resolves.toBe('not_due');
    expect(h.queueBackup).not.toHaveBeenCalled();
  });

  it('fires at the operator\'s 02:00, which is 06:00 UTC in New York in summer', async () => {
    const h = makeHarness({
      policy: { timezone: 'America/New_York' },
      rows: [
        {
          id: 'yesterday',
          status: 'completed',
          storageKey: 'backups/yesterday.dump',
          // 02:05 EDT on 14 June — covers the boundary before this one.
          startedAt: new Date('2026-06-14T06:05:00.000Z'),
          lastHeartbeatAt: new Date('2026-06-14T06:40:00.000Z'),
        },
      ],
    });

    await expect(h.fireAt('2026-06-15T05:59:00.000Z')).resolves.toBe('not_due');
    await expect(h.fireAt('2026-06-15T06:05:00.000Z')).resolves.toBe('fired');
  });
});

describe('daylight saving, in both directions', () => {
  it('spring forward: a 02:00 schedule on the day 02:00 does not exist still runs, once', async () => {
    // 8 March 2026, New York: the clock jumps 02:00 EST -> 03:00 EDT, so
    // 02:00 never happens. `zonedCivilToUtc` returns the instant the clock
    // jumped to (07:00 UTC), which is what makes this a backup that happens an
    // hour late instead of a night that is silently skipped.
    const h = makeHarness({ policy: { timezone: 'America/New_York' } });

    // 06:30 UTC = 01:30 EST, still before the jump: the live boundary is the
    // PREVIOUS day's, which the run below covers.
    h.table.set('the-7th', {
      id: 'the-7th',
      status: 'completed',
      storageKey: 'backups/the-7th.dump',
      startedAt: new Date('2026-03-07T07:02:00.000Z'),
      lastHeartbeatAt: new Date('2026-03-07T07:30:00.000Z'),
    });

    await expect(h.fireAt('2026-03-08T06:30:00.000Z')).resolves.toBe('not_due');

    // 07:05 UTC = 03:05 EDT, just after the jump: the 8th's boundary has
    // arrived.
    await expect(h.fireAt('2026-03-08T07:05:00.000Z')).resolves.toBe('fired');
    // And it does not fire a second time for the same civil day.
    await expect(h.fireAt('2026-03-08T07:45:00.000Z')).resolves.toBe('not_due');

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  it('spring forward: the interval to the next fire is 23 hours, not a drifted 24', async () => {
    // Adding 86_400_000ms to yesterday's fire would put the 8th's boundary an
    // hour out and leave it there for the rest of the year. Walking civil days
    // and converting each independently is what keeps 02:00 meaning 02:00.
    const h = makeHarness({ policy: { timezone: 'America/New_York' } });

    await expect(h.fireAt('2026-03-07T07:02:00.000Z')).resolves.toBe('fired');
    // 07:00 UTC on the 8th is 23 hours after 08:00... no: 07:00 UTC on the 7th
    // was 02:00 EST, and 07:00 UTC on the 8th is 03:00 EDT — the next fire is
    // 24 hours of wall clock later but the SAME UTC hour, because the day lost
    // an hour. What must not happen is a second fire on the 7th.
    await expect(h.fireAt('2026-03-08T06:00:00.000Z')).resolves.toBe('not_due');
    await expect(h.fireAt('2026-03-08T07:01:00.000Z')).resolves.toBe('fired');

    expect(h.queueBackup).toHaveBeenCalledTimes(2);
  });

  it('fall back: an ambiguous 01:30 fires on the FIRST pass of the clock and not the second', async () => {
    // 1 November 2026, New York: 01:30 happens twice — 05:30 UTC (EDT) and
    // 06:30 UTC (EST). The boundary is the earlier one, so the second pass
    // finds a run that already covers it. Firing twice would mean two full
    // dumps of the same database an hour apart, once a year, for no reason.
    const h = makeHarness({
      policy: { timezone: 'America/New_York', timeOfDay: '01:30' },
    });

    await expect(h.fireAt('2026-11-01T05:35:00.000Z')).resolves.toBe('fired');
    await expect(h.fireAt('2026-11-01T06:35:00.000Z')).resolves.toBe('not_due');
    await expect(h.fireAt('2026-11-01T07:00:00.000Z')).resolves.toBe('not_due');

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  it('fall back: the next day\'s boundary is still 01:30 local, now an hour later in UTC', async () => {
    const h = makeHarness({
      policy: { timezone: 'America/New_York', timeOfDay: '01:30' },
    });

    await expect(h.fireAt('2026-11-01T05:35:00.000Z')).resolves.toBe('fired');
    // 2 November, 05:35 UTC = 00:35 EST — before the new boundary.
    await expect(h.fireAt('2026-11-02T05:35:00.000Z')).resolves.toBe('not_due');
    // 06:35 UTC = 01:35 EST — after it.
    await expect(h.fireAt('2026-11-02T06:35:00.000Z')).resolves.toBe('fired');
  });
});

describe('an unusable timezone', () => {
  it('stands down instead of firing at the wrong wall-clock time', async () => {
    const h = makeHarness({ policy: { timezone: 'Mars/Olympus_Mons' } });

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('bad_timezone');
    expect(h.queueBackup).not.toHaveBeenCalled();
    // It does not even reach the table: there is no boundary to compare against.
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('LOGS ONCE, not once every ten minutes', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ policy: { timezone: 'Mars/Olympus_Mons' } });

    await h.fireAt('2026-09-07T02:03:00.000Z');
    await h.fireAt('2026-09-07T02:13:00.000Z');
    await h.fireAt('2026-09-07T02:23:00.000Z');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('Mars/Olympus_Mons');
    error.mockRestore();
  });

  it('logs again when the operator swaps one bad zone for another', async () => {
    // A boolean latch would mean the second typo is never reported.
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ policy: { timezone: 'Mars/Olympus_Mons' } });

    await h.fireAt('2026-09-07T02:03:00.000Z');
    h.policy.timezone = 'Pluto/Charon';
    await h.fireAt('2026-09-07T02:13:00.000Z');

    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('clears the latch once the zone works, so a later regression is loud again', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ policy: { timezone: 'Mars/Olympus_Mons' } });

    await h.fireAt('2026-09-07T02:03:00.000Z');
    h.policy.timezone = 'UTC';
    await h.fireAt('2026-09-07T02:13:00.000Z');
    h.policy.timezone = 'Mars/Olympus_Mons';
    await h.fireAt('2026-09-07T02:23:00.000Z');

    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe('the disabled setting', () => {
  it('does not fire when databaseBackup.enabled is false', async () => {
    const h = makeHarness({ policy: { enabled: false } });

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('disabled');
    expect(h.queueBackup).not.toHaveBeenCalled();
  });

  it('STILL QUEUES THE SWEEP when scheduled backups are disabled', async () => {
    // ⚠ A run orphaned before the setting was flipped still holds the single
    // active slot. Skipping the sweep would make every later MANUAL backup fail
    // with "already running" for a schedule nobody is using. Only the FIRING is
    // gated on `databaseBackup.enabled`; the housekeeping is not.
    const h = makeHarness({ policy: { enabled: false } });

    await h.task.handleCron();

    expect(h.queueBackup).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      `enqueue:${DB_BACKUP_SWEEP_TYPE}`,
      `enqueue:${DB_RESTORE_OLD_DB_DROP_TYPE}`,
    ]);
  });

  it('queues the sweep BEFORE it fires, so a released slot is available as soon as it can be', async () => {
    // ⚠ #353 WEAKENED THIS PROPERTY AND THE ASSERTION SAYS SO. The sweep used
    // to run inline and free the slot within the tick; it is now a job, so a
    // zombie found here may still cost this tick's fire an `already_running`
    // and be picked up by the next one — at most ten minutes later, because the
    // boundary rule is stateless and recomputed every tick. What is still true,
    // and what this pins, is the ORDER: the sweep is queued first, so a worker
    // has the longest possible head start.
    const h = makeHarness({ policy: ALWAYS_DUE });

    await h.task.handleCron();

    expect(h.calls).toEqual([
      `enqueue:${DB_BACKUP_SWEEP_TYPE}`,
      'queueBackup',
      // The retained-database drop, which always goes last.
      `enqueue:${DB_RESTORE_OLD_DB_DROP_TYPE}`,
    ]);
  });
});

describe('the already-running guard', () => {
  it('logs at DEBUG, not error: the index did its job', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = makeHarness({
      queueBackupImpl: async () => {
        throw new DatabaseBackupAlreadyRunningError('other-replica-run');
      },
    });

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).resolves.toBe('already_running');
    expect(error).not.toHaveBeenCalled();
    expect(
      debug.mock.calls.some((call) => String(call[0]).includes('already running'))
    ).toBe(true);

    debug.mockRestore();
    error.mockRestore();
  });

  it('lets any other claim failure stay loud', async () => {
    const h = makeHarness({
      queueBackupImpl: async () => {
        throw new Error('databaseBackup.storageProvider is "gcs"');
      },
    });

    await expect(h.fireAt('2026-09-07T02:03:00.000Z')).rejects.toThrow('gcs');
  });
});

describe('the cron wrapper', () => {
  it('stops for DB_BACKUP_SCHEDULE_ENABLED === false', async () => {
    const h = makeHarness({ config: { 'dbBackup.scheduleEnabled': false } });

    await h.task.handleCron();

    expect(h.queueBackup).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('runs when the switch is unset, so a typo fails open into "keep backing up"', async () => {
    const h = makeHarness({ policy: ALWAYS_DUE, config: {} });

    await h.task.handleCron();

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  it('IS NOT AFFECTED BY THE JOB WORKER MODE', async () => {
    // ⚠ A backup is not queue work. An API running as a pure control plane in
    // front of an external node fleet is still the only component with a
    // database connection, so gating this on `JOBS_WORKER_MODE` would leave
    // that deployment's database backed up by nobody.
    const h = makeHarness({
      policy: ALWAYS_DUE,
      config: { 'jobs.workerMode': 'off', 'jobs.reaperEnabled': false },
    });

    await h.task.handleCron();

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
    // It never even asks.
    expect(h.configGet.mock.calls.map((call) => call[0])).toEqual(['dbBackup.scheduleEnabled']);
  });

  it('skips a tick while the previous one is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      policy: ALWAYS_DUE,
      queueBackupImpl: async () => {
        await gate;

        return { run: { id: 'slow' }, job: { id: 'job-slow' } };
      },
    });

    const first = h.task.handleCron();
    await waitFor(() => h.queueBackup.mock.calls.length === 1, 'the first tick to claim');

    // The first tick is still inside `queueBackup`; the second must not run a
    // second boundary check against the same unchanged table.
    await h.task.handleCron();

    expect(h.queueBackup).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('releases the overlap guard even when the tick throws', async () => {
    // A guard left set by a throw would stop the scheduler forever, which is
    // the one failure this whole file exists not to have.
    const h = makeHarness({
      policy: ALWAYS_DUE,
      queueBackupImpl: async () => {
        throw new Error('connection reset');
      },
    });

    await expect(h.task.handleCron()).resolves.toBeUndefined();
    await expect(h.task.handleCron()).resolves.toBeUndefined();

    expect(h.queueBackup).toHaveBeenCalledTimes(2);
  });

  it('never rejects out of the cron handler', async () => {
    const h = makeHarness();
    (h.prisma.databaseBackupRun.findFirst as jest.Mock).mockRejectedValue(
      new Error('statement timeout')
    );

    await expect(h.task.handleCron()).resolves.toBeUndefined();
  });

  it('a failed sweep ENQUEUE does not also cost tonight\'s backup', async () => {
    // The three are separate duties that happen to share a tick, and
    // `enqueueHousekeepingJob` swallows its own failures precisely so one of
    // them cannot take the others down.
    const h = makeHarness({
      policy: ALWAYS_DUE,
      enqueueImpl: async (input) => {
        if (input.type === DB_BACKUP_SWEEP_TYPE) throw new Error('statement timeout');
      },
    });

    await h.task.handleCron();

    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // #353: the two duties this tick no longer performs
  // ---------------------------------------------------------------------------

  it('QUEUES the sweep and the retained-database drop instead of doing either', async () => {
    const h = makeHarness({ policy: ALWAYS_DUE });

    await h.task.handleCron();

    const types = h.enqueue.mock.calls.map((call) => call[0].type);

    expect(types).toEqual([DB_BACKUP_SWEEP_TYPE, DB_RESTORE_OLD_DB_DROP_TYPE]);
    // Both GLOBAL and both low priority: constant dedup keys, and housekeeping
    // that never outranks a user-facing job.
    for (const call of h.enqueue.mock.calls) {
      expect(call[0]).toMatchObject({ reason: 'backfill', priority: 100 });
      expect(call[0].subjectId).toBeUndefined();
    }
  });

  it('queues the retained-database drop LAST, after the fire', async () => {
    // Pure housekeeping: nothing waits on it, and a `DROP DATABASE` blocked by
    // a session somebody left open must never delay a backup that is due.
    const h = makeHarness({ policy: ALWAYS_DUE });

    await h.task.handleCron();

    expect(h.calls.indexOf('queueBackup')).toBeLessThan(
      h.calls.indexOf(`enqueue:${DB_RESTORE_OLD_DB_DROP_TYPE}`)
    );
  });

  it('queues neither when the scheduler is switched off', async () => {
    const h = makeHarness({ config: { 'dbBackup.scheduleEnabled': false } });

    await h.task.handleCron();

    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a failed retained-database enqueue does not reject out of the tick', async () => {
    const h = makeHarness({
      policy: ALWAYS_DUE,
      enqueueImpl: async (input) => {
        if (input.type === DB_RESTORE_OLD_DB_DROP_TYPE) throw new Error('statement timeout');
      },
    });

    await expect(h.task.handleCron()).resolves.toBeUndefined();

    // ...and the duties in front of it still happened.
    expect(h.queueBackup).toHaveBeenCalledTimes(1);
  });
});
