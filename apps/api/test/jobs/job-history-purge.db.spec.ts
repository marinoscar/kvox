// =============================================================================
// Real-Postgres test: the history purge is atomic and its arithmetic conserves
// (issue #263, epic #254)
// =============================================================================
//
// TWO CLAIMS LIVE HERE, and neither is testable against a mock.
//
//   1. ATOMICITY. "A crash can never delete a row without counting it, or
//      count one without deleting it" is a statement about a `$transaction`
//      ROLLING BACK. A mocked `$transaction` rolls nothing back — it is a
//      function that calls its callback — so a unit test of it asserts only
//      that the code was arranged the way the test arranged it. Here the
//      batch is failed DELIBERATELY, from inside the transaction, and the
//      database is then asked what survived.
//
//   2. CONSERVATION. "Lifetime totals from the rollup plus the live rows equal
//      the pre-purge totals" is arithmetic over two real tables — one being
//      deleted from, one being incremented — and the interesting failure
//      (double counting on a re-run) only appears when rows genuinely
//      disappear.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import { Job, Prisma, PrismaClient } from '@prisma/client';

import { JobHistoryPurgeHandler } from '../../src/jobs/handlers/job-history-purge.handler';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-history-purge.db.spec');

/** Retention every test in this suite runs with. */
const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
// Reads the clock on every call. A seeder that derives more than one field of
// the SAME row from `daysAgo(...)` — e.g. `startedAt` and `finishedAt`, whose
// difference is asserted to equal an exact `durationMs` — MUST call this once
// and reuse the result. Calling it twice for one row lets the millisecond
// tick between the two reads, which silently inflates that row's derived
// duration by 1ms and made `sumDurationMs` assertions flake under load (see
// issue #263 follow-up: "conserves lifetime totals across a purge").
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

/** The job row the handler is "running as"; only its id is ever read. */
const PURGE_JOB = { id: 'purge-db-spec', type: 'job.history.purge' } as Job;

/**
 * The real handler over a real client, with the settings read stubbed: the
 * `system_settings` row belongs to the application, and a test that wrote to
 * it would be changing a shared deployment's policy to make a point about
 * arithmetic.
 */
function handlerFor(client: PrismaClient, purgeEnabled = true): JobHistoryPurgeHandler {
  const systemSettings = {
    getJobsPolicy: async () => ({
      history: { retentionDays: RETENTION_DAYS, purgeEnabled },
      stuckThresholdMinutes: 30,
    }),
  } as unknown as SystemSettingsService;

  const registry = { register: () => undefined } as unknown as JobHandlerRegistry;

  return new JobHistoryPurgeHandler(client as unknown as PrismaService, systemSettings, registry);
}

/**
 * The same client, with `job.deleteMany` INSIDE a transaction rigged to throw.
 *
 * This is the simulated crash: the rollup upserts have already been applied
 * within the transaction when the delete blows up, so if the two were not
 * atomic the counts would survive without the rows — the "counted undeleted"
 * corruption, which inflates lifetime totals silently and permanently.
 *
 * Proxied rather than mocked so everything else is the real client: the
 * handler still runs its real query, its real fold and its real upserts, and
 * the transaction it opens is a real Postgres transaction that really rolls
 * back.
 */
function clientFailingTheDelete(
  client: PrismaClient,
  /**
   * Called with the transaction client at the instant the delete is about to
   * fail — i.e. AFTER the rollup upserts have been applied inside the
   * transaction, and BEFORE the rollback. It is what keeps the assertions
   * below from passing vacuously: without it, "no rollup row afterwards"
   * would also be true of an implementation that never wrote one.
   */
  observeBeforeFailing?: (tx: PrismaClient) => Promise<void>
): PrismaService {
  const original = client.$transaction.bind(client) as (
    fn: (tx: unknown) => Promise<unknown>
  ) => Promise<unknown>;

  const failingTransaction = (fn: (tx: unknown) => Promise<unknown>) =>
    original(async (tx: unknown) =>
      fn(
        new Proxy(tx as object, {
          get(target, prop) {
            if (prop !== 'job') {
              return Reflect.get(target, prop);
            }

            const delegate = Reflect.get(target, prop) as Record<string, unknown>;

            return new Proxy(delegate, {
              get(delegateTarget, delegateProp) {
                if (delegateProp === 'deleteMany') {
                  return async () => {
                    await observeBeforeFailing?.(tx as PrismaClient);

                    throw new Error('simulated crash mid-batch');
                  };
                }

                return Reflect.get(delegateTarget, delegateProp);
              },
            });
          },
        })
      )
    );

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return failingTransaction;
      }

      const value = Reflect.get(target, prop, receiver);

      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as unknown as PrismaService;
}

describeWithDb('JobHistoryPurgeHandler (real Postgres)', () => {
  let client: PrismaClient;
  let handler: JobHistoryPurgeHandler;

  // Per-process scoping, as in every other queue suite: this database is
  // shared with the other `*.db.spec.ts` files and, locally, with a
  // developer's own data. Note that BOTH tables are scoped and cleaned —
  // `job_stats_rollup` is keyed by `type`, so the same prefix covers it.
  const TYPE_PREFIX = `test.purge.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    handler = handlerFor(client);
  });

  async function cleanup(): Promise<void> {
    await client.job.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
    await client.jobStatsRollup.deleteMany({ where: { type: { startsWith: TYPE_PREFIX } } });
  }

  afterEach(cleanup);

  afterAll(async () => {
    if (client) {
      await cleanup();
      await client.$disconnect();
    }
  });

  /** Inserts one terminal (or not) row and returns its id. */
  async function seed(data: Omit<Prisma.JobCreateInput, 'reason'>): Promise<string> {
    const row = await client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobCreateInput,
    });

    return row.id;
  }

  /** A succeeded row that finished `days` ago, having taken `durationMs`. */
  const succeeded = (type: string, days: number, durationMs: number) => {
    // One clock read for the whole row: `startedAt` and `finishedAt` are
    // subtracted from each other to recover `durationMs` exactly, so both
    // (and `createdAt`, compared against them for ordering) must come from
    // the same instant — see the comment at `daysAgo` above.
    const at = daysAgo(days);

    return seed({
      type,
      status: 'succeeded',
      attempts: 1,
      createdAt: at,
      startedAt: new Date(at.getTime() - durationMs),
      finishedAt: at,
    });
  };

  /** A failed row that finished `days` ago. */
  const failed = (type: string, days: number) => {
    const at = daysAgo(days); // single read — see the comment at `daysAgo`.

    return seed({
      type,
      status: 'failed',
      attempts: 3,
      createdAt: at,
      startedAt: at,
      finishedAt: at,
      lastError: 'nope',
    });
  };

  const rollupFor = (type: string) => client.jobStatsRollup.findUnique({ where: { type } });

  const rowsOfType = (type: string) => client.job.findMany({ where: { type } });

  // ===========================================================================
  // What may be deleted
  // ===========================================================================

  it('deletes only terminal rows past the cutoff', async () => {
    const type = nextType();

    const oldSucceeded = await succeeded(type, RETENTION_DAYS + 5, 1000);
    const oldFailed = await failed(type, RETENTION_DAYS + 5);
    const recentSucceeded = await succeeded(type, 1, 1000);

    await handler.process(PURGE_JOB);

    const surviving = (await rowsOfType(type)).map((row) => row.id);

    expect(surviving).toEqual([recentSucceeded]);
    expect(surviving).not.toContain(oldSucceeded);
    expect(surviving).not.toContain(oldFailed);
  });

  it('never deletes a pending or running row, however old', async () => {
    // THE RULE. A pending job is work that has not been done; age says
    // something about the queue, not about whether the work is still wanted.
    // A running row is worse — deleting it orphans an executor that is about
    // to write a terminal update for a row that no longer exists.
    const type = nextType();

    const pending = await seed({
      type,
      status: 'pending',
      createdAt: daysAgo(RETENTION_DAYS * 10),
    });
    const runningAt = daysAgo(RETENTION_DAYS * 10); // single read for both fields below.
    const running = await seed({
      type,
      status: 'running',
      attempts: 1,
      createdAt: runningAt,
      startedAt: runningAt,
    });

    await handler.process(PURGE_JOB);

    const surviving = (await rowsOfType(type)).map((row) => row.id).sort();

    expect(surviving).toEqual([pending, running].sort());
  });

  it('purges a terminal row that never got a finishedAt, aged by createdAt', async () => {
    // Otherwise `NULL < cutoff` is NULL and the row is unpurgeable forever.
    const type = nextType();

    await seed({
      type,
      status: 'failed',
      attempts: 1,
      createdAt: daysAgo(RETENTION_DAYS + 5),
      startedAt: null,
      finishedAt: null,
    });

    await handler.process(PURGE_JOB);

    await expect(rowsOfType(type)).resolves.toHaveLength(0);
  });

  it('does nothing at all when the purge is disabled', async () => {
    const type = nextType();
    await succeeded(type, RETENTION_DAYS + 5, 1000);

    await handlerFor(client, false).process(PURGE_JOB);

    await expect(rowsOfType(type)).resolves.toHaveLength(1);
    await expect(rollupFor(type)).resolves.toBeNull();
  });

  // ===========================================================================
  // Atomicity: the simulated crash
  // ===========================================================================

  it('leaves counts and rows consistent when a batch fails mid-transaction', async () => {
    const type = nextType();
    const ids = [
      await succeeded(type, RETENTION_DAYS + 5, 1000),
      await succeeded(type, RETENTION_DAYS + 6, 2000),
      await failed(type, RETENTION_DAYS + 7),
    ];

    // Captured from INSIDE the doomed transaction, so the assertions below are
    // about a rollback rather than about an upsert that never ran.
    let insideTransaction: { succeededCount: number; failedCount: number } | null = null;

    const crashing = handlerFor(
      clientFailingTheDelete(client, async (tx) => {
        insideTransaction = await tx.jobStatsRollup.findUnique({ where: { type } });
      }) as unknown as PrismaClient
    );

    await expect(crashing.process(PURGE_JOB)).rejects.toThrow('simulated crash mid-batch');

    // The counts WERE applied before the failure — the transaction had real
    // work in it to roll back.
    expect(insideTransaction).toMatchObject({ succeededCount: 2, failedCount: 1 });

    // NOTHING COUNTED UNDELETED: the upserts ran inside the transaction and
    // went back with it, so no rollup row exists for this type at all.
    await expect(rollupFor(type)).resolves.toBeNull();

    // NOTHING DELETED UNCOUNTED: every row is still there, so the next run
    // finds them again and counts them exactly once.
    const surviving = (await rowsOfType(type)).map((row) => row.id).sort();
    expect(surviving).toEqual([...ids].sort());
  });

  it('rolls back only the failed batch — a later successful run still counts every row once', async () => {
    const type = nextType();
    await succeeded(type, RETENTION_DAYS + 5, 1000);
    await succeeded(type, RETENTION_DAYS + 6, 3000);
    await failed(type, RETENTION_DAYS + 7);

    const crashing = handlerFor(clientFailingTheDelete(client) as unknown as PrismaClient);
    await expect(crashing.process(PURGE_JOB)).rejects.toThrow();

    // The retry the queue would schedule.
    await handler.process(PURGE_JOB);

    await expect(rowsOfType(type)).resolves.toHaveLength(0);
    await expect(rollupFor(type)).resolves.toMatchObject({
      succeededCount: 2,
      failedCount: 1,
      sumDurationMs: 4000,
      durationSamples: 2,
    });
  });

  it('preserves a rollup that already existed when a batch fails', async () => {
    const type = nextType();
    await client.jobStatsRollup.create({
      data: { type, succeededCount: 7, failedCount: 2, sumDurationMs: 700, durationSamples: 7 },
    });
    await succeeded(type, RETENTION_DAYS + 5, 1000);

    const crashing = handlerFor(clientFailingTheDelete(client) as unknown as PrismaClient);
    await expect(crashing.process(PURGE_JOB)).rejects.toThrow();

    // The increment went back with the transaction: not partially applied,
    // not applied twice.
    await expect(rollupFor(type)).resolves.toMatchObject({
      succeededCount: 7,
      failedCount: 2,
      sumDurationMs: 700,
      durationSamples: 7,
    });
    await expect(rowsOfType(type)).resolves.toHaveLength(1);
  });

  // ===========================================================================
  // Conservation: rollup + live rows == the pre-purge totals
  // ===========================================================================

  it('conserves lifetime totals across a purge', async () => {
    const type = nextType();

    // Five old rows (about to be purged) and three recent ones (staying).
    await succeeded(type, RETENTION_DAYS + 1, 1000);
    await succeeded(type, RETENTION_DAYS + 2, 2000);
    await succeeded(type, RETENTION_DAYS + 3, 3000);
    await failed(type, RETENTION_DAYS + 4);
    await failed(type, RETENTION_DAYS + 5);
    await succeeded(type, 1, 4000);
    await succeeded(type, 2, 5000);
    await failed(type, 3);

    const before = await lifetimeTotals(type);

    expect(before).toEqual({
      succeeded: 5,
      failed: 3,
      sumDurationMs: 15_000,
      durationSamples: 5,
    });

    await handler.process(PURGE_JOB);

    // Rows genuinely went away...
    await expect(rowsOfType(type)).resolves.toHaveLength(3);
    // ...and the totals did not move.
    await expect(lifetimeTotals(type)).resolves.toEqual(before);
  });

  it('does not double count when the purge runs again', async () => {
    // The failure mode a "count first, delete after" implementation has: the
    // second run finds the same rows still past the cutoff and folds them in
    // again, inflating lifetime totals a little more every night.
    const type = nextType();
    await succeeded(type, RETENTION_DAYS + 1, 1000);
    await failed(type, RETENTION_DAYS + 2);
    await succeeded(type, 1, 9000);

    const before = await lifetimeTotals(type);

    await handler.process(PURGE_JOB);
    await handler.process(PURGE_JOB);
    await handler.process(PURGE_JOB);

    await expect(lifetimeTotals(type)).resolves.toEqual(before);
  });

  it('keeps each type in its own rollup row', async () => {
    const typeA = nextType();
    const typeB = nextType();

    await succeeded(typeA, RETENTION_DAYS + 1, 1000);
    await succeeded(typeA, RETENTION_DAYS + 2, 1000);
    await failed(typeB, RETENTION_DAYS + 1);

    await handler.process(PURGE_JOB);

    await expect(rollupFor(typeA)).resolves.toMatchObject({
      succeededCount: 2,
      failedCount: 0,
      durationSamples: 2,
    });
    await expect(rollupFor(typeB)).resolves.toMatchObject({
      succeededCount: 0,
      failedCount: 1,
      durationSamples: 0,
    });
  });

  /**
   * Lifetime totals for a type: the rollup (what has been purged) PLUS the
   * rows still in the table. This is the quantity the purge is designed never
   * to change, and computing it the same way a future insights endpoint would
   * is the point of the assertion.
   *
   * Durations are sampled from SUCCEEDED rows only, matching
   * `jobs_succeeded_duration_idx` and `foldDeltas`.
   */
  async function lifetimeTotals(type: string): Promise<{
    succeeded: number;
    failed: number;
    sumDurationMs: number;
    durationSamples: number;
  }> {
    const rollup = await rollupFor(type);
    const live = await rowsOfType(type);

    const totals = {
      succeeded: rollup?.succeededCount ?? 0,
      failed: rollup?.failedCount ?? 0,
      sumDurationMs: rollup?.sumDurationMs ?? 0,
      durationSamples: rollup?.durationSamples ?? 0,
    };

    for (const row of live) {
      if (row.status === 'succeeded') {
        totals.succeeded += 1;

        if (row.startedAt && row.finishedAt) {
          totals.sumDurationMs += row.finishedAt.getTime() - row.startedAt.getTime();
          totals.durationSamples += 1;
        }
      } else if (row.status === 'failed') {
        totals.failed += 1;
      }
    }

    return totals;
  }
});
