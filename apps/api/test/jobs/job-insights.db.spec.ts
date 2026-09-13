// =============================================================================
// Real-Postgres test: insights are read-only, exact, and conserved across a
// purge (issue #265, epic #254)
// =============================================================================
//
// FOUR CLAIMS LIVE HERE, and not one of them is testable against a mock.
//
//   1. ⚠ LOCK SAFETY — the property that makes this endpoint safe to expose at
//      all. "Every query is a pure `SELECT`, so reporting on the queue can
//      never block the queue" is a statement about LOCK MODES, and a mocked
//      client has none. Here a second connection holds real `FOR UPDATE` row
//      locks on claimed rows inside an open transaction while the whole
//      insights computation runs from another — which must return complete,
//      correct numbers without waiting. `src/jobs/job-insights.service.spec.ts`
//      asserts the other half (that no statement CONTAINS a lock or a write),
//      because a database cannot prove the absence of SQL that was never sent.
//
//   2. PERCENTILES. `PERCENTILE_CONT` is Postgres's arithmetic, and the whole
//      reason the history block is raw SQL. A mock returns whatever number the
//      test put in it, which proves nothing about the interpolation — so the
//      fixture below is hand-computed and the expected p50/p95 are written out
//      with their derivation.
//
//   3. THE LIFETIME MERGE ACROSS A PURGE. "Rollup plus live, with no double
//      counting" is only true because the purge folds and deletes one batch
//      inside one transaction. The interesting failure — a row counted in both
//      halves, or in neither — appears only when rows genuinely move from the
//      table into the accumulator, so the real handler is run against real
//      rows and the totals are compared before and after.
//
//   4. `reset-history` LEAVES LIVE NUMBERS INTACT. Also a two-table claim: the
//      rollup goes, the `jobs` rows stay, and every live-derived figure in the
//      response is byte-identical afterwards.
//
// WHAT IS DELIBERATELY *NOT* HERE: the `basis: 'none'` case. `none` means
// "nothing at all has succeeded anywhere in the window", which is a statement
// about the WHOLE `jobs` table — and this suite shares a database with every
// other `*.db.spec.ts` file and, locally, with a developer's own data, so it
// owns its prefix and nothing else. Asserting an empty table would be a test
// that passes on an empty machine and fails on a working one, which is worse
// than no test. All three bases are asserted in
// `src/jobs/job-insights.service.spec.ts`, where the fixture IS the whole
// table; `partial` and `live` are asserted here as well because both survive
// unrelated rows.
//
// THIS IS A `*.db.spec.ts` FILE — see `db-test-support.ts` and
// `job-claim.db.spec.ts`'s header for the run/skip mechanics.
// =============================================================================

import type { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import { JobHistoryPurgeHandler } from '../../src/jobs/handlers/job-history-purge.handler';
import { JobInsightsService } from '../../src/jobs/job-insights.service';
import type { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import type { Job } from '@prisma/client';
import { createDbClient, resolveDbSuite } from './db-test-support';

const { describeWithDb } = resolveDbSuite('job-insights.db.spec');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Retention the purge runs with in this suite. */
const RETENTION_DAYS = 30;

/** The worker concurrency every ETA here is divided by. */
const CONCURRENCY = 2;

const PURGE_JOB = { id: 'insights-db-spec', type: 'job.history.purge' } as Job;

function insightsFor(client: PrismaClient): JobInsightsService {
  const config = { get: () => CONCURRENCY } as unknown as ConfigService;

  return new JobInsightsService(client as unknown as PrismaService, config);
}

/** The real purge handler, with only the settings read stubbed. */
function purgeFor(client: PrismaClient): JobHistoryPurgeHandler {
  const systemSettings = {
    getJobsPolicy: async () => ({
      history: { retentionDays: RETENTION_DAYS, purgeEnabled: true },
      stuckThresholdMinutes: 30,
    }),
  } as unknown as SystemSettingsService;

  const registry = { register: () => undefined } as unknown as JobHandlerRegistry;

  return new JobHistoryPurgeHandler(client as unknown as PrismaService, systemSettings, registry);
}

describeWithDb('JobInsightsService (real Postgres)', () => {
  let client: PrismaClient;
  let insights: JobInsightsService;

  // Per-process scoping, as in every other queue suite. BOTH tables are
  // covered by the one prefix: `job_stats_rollup` is keyed by `type`.
  const TYPE_PREFIX = `test.insights.${process.pid}.`;
  let typeCounter = 0;
  const nextType = (): string => `${TYPE_PREFIX}${(typeCounter += 1)}`;

  beforeAll(async () => {
    client = createDbClient();
    await client.$connect();
    insights = insightsFor(client);
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

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  const ago = (ms: number): Date => new Date(Date.now() - ms);

  async function seed(data: Omit<Prisma.JobCreateInput, 'reason'>): Promise<string> {
    const row = await client.job.create({
      data: { reason: 'backfill', ...data } as Prisma.JobCreateInput,
    });

    return row.id;
  }

  /** A succeeded row that finished `finishedAgoMs` ago, having taken `durationMs`. */
  const succeeded = (type: string, finishedAgoMs: number, durationMs: number) => {
    const finishedAt = ago(finishedAgoMs);

    return seed({
      type,
      status: 'succeeded',
      attempts: 1,
      createdAt: new Date(finishedAt.getTime() - durationMs - 1000),
      startedAt: new Date(finishedAt.getTime() - durationMs),
      finishedAt,
    });
  };

  const failedRow = (type: string, finishedAgoMs: number) => {
    const finishedAt = ago(finishedAgoMs);

    return seed({
      type,
      status: 'failed',
      attempts: 3,
      createdAt: new Date(finishedAt.getTime() - 5000),
      startedAt: new Date(finishedAt.getTime() - 5000),
      finishedAt,
      lastError: 'nope',
    });
  };

  const pending = (type: string, count: number) =>
    Promise.all(
      Array.from({ length: count }, () => seed({ type, status: 'pending', createdAt: new Date() }))
    );

  /** The history row for one type, or `undefined`. */
  const historyOf = async (type: string, windowDays = 7) => {
    const result = await insights.insights({ windowDays });

    return result.history.byType.find((row) => row.type === type);
  };

  // ===========================================================================
  // 1. Lock safety — the reason this endpoint can exist
  // ===========================================================================

  it('runs to completion while another connection holds claimed rows locked', async () => {
    const type = nextType();

    await succeeded(type, 2 * 60 * MINUTE_MS, 1000);
    await pending(type, 4);

    // A SECOND, INDEPENDENT CLIENT — its own pool, its own connection — so the
    // lock below is genuinely held by another session rather than by the same
    // one that then reads.
    const claimer = createDbClient();
    await claimer.$connect();

    let insightsRanInsideTheLock = false;

    try {
      await claimer.$transaction(
        async (tx) => {
          // The claim's own shape: lock the pending rows FOR UPDATE and move
          // them to `running`, then HOLD the transaction open. This is exactly
          // the state a saturated worker pool is in.
          await tx.$queryRaw(Prisma.sql`
            UPDATE jobs SET status = 'running'::"JobStatus", started_at = now()
            WHERE id IN (
              SELECT id FROM jobs
              WHERE status = 'pending'::"JobStatus" AND type = ${type}
              FOR UPDATE SKIP LOCKED
            )
          `);

          const startedAt = Date.now();
          const result = await insights.insights({ windowDays: 7 });
          const elapsed = Date.now() - startedAt;

          insightsRanInsideTheLock = true;

          // IT MUST NOT HAVE WAITED. A statement taking a conflicting lock
          // would block until this transaction ended, which (since this
          // transaction is what is awaiting it) means until the transaction
          // timeout — so a failure here is a hang, and the elapsed-time
          // assertion is what turns that into a readable one.
          expect(elapsed).toBeLessThan(5_000);

          // And it must have returned the truth, not a partial read: the
          // uncommitted claim is invisible under READ COMMITTED, so the four
          // rows are still `pending` as far as this reader is concerned.
          const live = result.live.byType.find((row) => row.type === type);
          expect(live?.byStatus).toMatchObject({ pending: 4, succeeded: 1 });

          const eta = result.eta.find((row) => row.type === type);
          expect(eta?.remaining).toBe(4);
        },
        { timeout: 30_000, maxWait: 10_000 }
      );
    } finally {
      await claimer.$disconnect();
    }

    expect(insightsRanInsideTheLock).toBe(true);
  }, 60_000);

  // ===========================================================================
  // 2. Percentiles, hand-computed
  // ===========================================================================

  it('computes p50 and p95 as PERCENTILE_CONT interpolations of the fixture', async () => {
    const type = nextType();

    // Five durations: 1000, 2000, 3000, 4000, 5000 ms.
    //
    //   p50: position 0.5 x (5 - 1) = 2.0  -> exactly sorted[2]      = 3000
    //   p95: position 0.95 x (5 - 1) = 3.8 -> sorted[3] + 0.8 x (sorted[4] - sorted[3])
    //                                       = 4000 + 0.8 x 1000     = 4800
    //
    // The p95 is the case that distinguishes `PERCENTILE_CONT` from
    // `PERCENTILE_DISC`, which would answer 5000 — a real observed duration,
    // and the wrong answer for a number meant to move smoothly as a job type
    // slows down.
    const durations = [1000, 2000, 3000, 4000, 5000];

    for (const [index, duration] of durations.entries()) {
      await succeeded(type, (index + 2) * 60 * MINUTE_MS, duration);
    }

    const stats = await historyOf(type);

    expect(stats).toBeDefined();
    expect(stats?.samples).toBe(5);
    expect(stats?.avgMs).toBeCloseTo(3000, 6);
    expect(stats?.p50Ms).toBeCloseTo(3000, 6);
    expect(stats?.p95Ms).toBeCloseTo(4800, 6);

    // Every duration is a plain JS number all the way to the wire — the
    // `::double precision` cast, without which `EXTRACT(EPOCH ...)` arrives as
    // a `Decimal` object that serializes as `{"s":1,...}`.
    expect(typeof stats?.p95Ms).toBe('number');
  });

  it('counts only jobs inside the window', async () => {
    const type = nextType();

    await succeeded(type, 1 * DAY_MS, 1000);
    await succeeded(type, 2 * DAY_MS, 1000);
    // Outside a 7-day window, inside a 30-day one.
    await succeeded(type, 10 * DAY_MS, 9000);

    await expect(historyOf(type, 7).then((row) => row?.samples)).resolves.toBe(2);
    await expect(historyOf(type, 7).then((row) => row?.avgMs)).resolves.toBeCloseTo(1000, 6);

    await expect(historyOf(type, 30).then((row) => row?.samples)).resolves.toBe(3);
  });

  it('excludes failed jobs and untimed rows from the duration distribution', async () => {
    const type = nextType();

    await succeeded(type, 60 * MINUTE_MS, 2000);
    await failedRow(type, 60 * MINUTE_MS);
    // Terminal but never stamped — a restored backup, an external control
    // plane. `jobs_succeeded_duration_idx` is partial on both NOT NULLs, and
    // this row must fall out of the aggregate rather than contribute a null.
    await seed({
      type,
      status: 'succeeded',
      attempts: 1,
      createdAt: ago(60 * MINUTE_MS),
      startedAt: null,
      finishedAt: null,
    });

    const stats = await historyOf(type);

    expect(stats?.samples).toBe(1);
    expect(stats?.avgMs).toBeCloseTo(2000, 6);
  });

  it('measures throughput over the last hour only', async () => {
    const type = nextType();

    // Three inside the hour, two well outside it but inside the window.
    await succeeded(type, 5 * MINUTE_MS, 1000);
    await succeeded(type, 10 * MINUTE_MS, 1000);
    await succeeded(type, 30 * MINUTE_MS, 1000);
    await succeeded(type, 3 * 60 * MINUTE_MS, 1000);
    await succeeded(type, 2 * DAY_MS, 1000);

    const stats = await historyOf(type);

    expect(stats?.samples).toBe(5);
    // 3 jobs in 60 minutes.
    expect(stats?.throughputPerMin).toBeCloseTo(3 / 60, 10);
  });

  // ===========================================================================
  // The partial-index predicates, against real rows
  // ===========================================================================

  it('counts retried and rate-limited jobs with the predicates the partial indexes are built on', async () => {
    const type = nextType();

    const before = (await insights.insights({ windowDays: 7 })).live;

    // `attempts > 1` — two of these three qualify.
    await seed({ type, status: 'failed', attempts: 3, finishedAt: new Date() });
    await seed({ type, status: 'succeeded', attempts: 2, startedAt: new Date(), finishedAt: new Date() });
    await seed({ type, status: 'succeeded', attempts: 1, startedAt: new Date(), finishedAt: new Date() });

    // `rateLimitHits > 0` AND non-terminal — the terminal one must not count.
    await seed({ type, status: 'pending', rateLimitHits: 2, rateLimitedAt: new Date() });
    await seed({ type, status: 'failed', attempts: 1, rateLimitHits: 5, finishedAt: new Date() });

    const after = (await insights.insights({ windowDays: 7 })).live;

    // Deltas, because this suite owns its prefix and not the table.
    expect(after.retried - before.retried).toBe(2);
    expect(after.rateLimited - before.rateLimited).toBe(1);
  });

  // ===========================================================================
  // 3. ETA bases that survive unrelated rows
  // ===========================================================================

  it("uses a type's own history when it has one (`live`)", async () => {
    const type = nextType();

    // Ten succeeded jobs at 2 seconds each, and eight still outstanding.
    for (let index = 0; index < 10; index += 1) {
      await succeeded(type, (index + 1) * MINUTE_MS, 2000);
    }

    await pending(type, 6);
    await seed({ type, status: 'running', attempts: 1, startedAt: new Date() });
    await seed({ type, status: 'running', attempts: 1, startedAt: new Date() });

    const result = await insights.insights({ windowDays: 7 });
    const eta = result.eta.find((row) => row.type === type);

    expect(eta).toMatchObject({ pending: 6, running: 2, remaining: 8, basis: 'live' });
    expect(eta?.avgMs).toBeCloseTo(2000, 6);
    // 8 remaining x 2000ms / 2 workers.
    expect(eta?.estimatedMs).toBeCloseTo(8000, 6);
    expect(result.concurrency).toBe(CONCURRENCY);
  });

  it('falls back to the overall average for a type with no history (`partial`)', async () => {
    const withHistory = nextType();
    const brandNew = nextType();

    await succeeded(withHistory, 30 * MINUTE_MS, 4000);
    await succeeded(withHistory, 40 * MINUTE_MS, 4000);
    await pending(brandNew, 3);

    const result = await insights.insights({ windowDays: 7 });
    const eta = result.eta.find((row) => row.type === brandNew);

    expect(eta?.basis).toBe('partial');
    // The overall average is over the whole table, so its VALUE is not this
    // suite's to predict — but that it equals the published overall figure,
    // and is not this type's own (it has none), is.
    expect(eta?.avgMs).toBeCloseTo(result.history.overall.avgMs ?? -1, 6);
    expect(result.history.byType.find((row) => row.type === brandNew)).toBeUndefined();
  });

  // ===========================================================================
  // 4. Lifetime: conserved across a real purge
  // ===========================================================================

  it('reports lifetime totals that are identical before and after a purge', async () => {
    const type = nextType();

    // Old enough to be purged: five successes at 1s..5s and two failures.
    const oldDurations = [1000, 2000, 3000, 4000, 5000];
    for (const duration of oldDurations) {
      await succeeded(type, (RETENTION_DAYS + 5) * DAY_MS, duration);
    }
    await failedRow(type, (RETENTION_DAYS + 5) * DAY_MS);
    await failedRow(type, (RETENTION_DAYS + 6) * DAY_MS);

    // Recent enough to survive it.
    await succeeded(type, 1 * DAY_MS, 6000);
    await failedRow(type, 1 * DAY_MS);

    const lifetimeOf = async () => {
      const result = await insights.insights({ windowDays: 7 });

      return result.lifetime.find((row) => row.type === type);
    };

    const before = await lifetimeOf();

    expect(before).toMatchObject({
      succeeded: 6,
      failed: 3,
      total: 9,
      durationSamples: 6,
    });
    // (1000 + 2000 + 3000 + 4000 + 5000 + 6000) / 6
    expect(before?.avgMs).toBeCloseTo(3500, 6);

    // Now move the old half into the rollup, for real.
    await purgeFor(client).process(PURGE_JOB);

    const rollup = await client.jobStatsRollup.findUnique({ where: { type } });
    expect(rollup).toMatchObject({ succeededCount: 5, failedCount: 2, durationSamples: 5 });
    await expect(client.job.count({ where: { type } })).resolves.toBe(2);

    const after = await lifetimeOf();

    // CONSERVATION. Not "close enough" — identical. The purged rows are in the
    // accumulator, the survivors are in the table, and no row is in both.
    expect(after).toEqual(before);
  }, 60_000);

  it('does not double count when the purge runs again', async () => {
    const type = nextType();

    await succeeded(type, (RETENTION_DAYS + 2) * DAY_MS, 2000);
    await succeeded(type, (RETENTION_DAYS + 3) * DAY_MS, 4000);
    await failedRow(type, (RETENTION_DAYS + 4) * DAY_MS);

    const purge = purgeFor(client);

    await purge.process(PURGE_JOB);
    const afterFirst = (await insights.insights({ windowDays: 7 })).lifetime.find(
      (row) => row.type === type
    );

    // The second run finds nothing left to fold; a non-atomic purge would find
    // the same rows again and count them twice.
    await purge.process(PURGE_JOB);
    const afterSecond = (await insights.insights({ windowDays: 7 })).lifetime.find(
      (row) => row.type === type
    );

    expect(afterFirst).toMatchObject({ succeeded: 2, failed: 1, total: 3, durationSamples: 2 });
    expect(afterFirst?.avgMs).toBeCloseTo(3000, 6);
    expect(afterSecond).toEqual(afterFirst);
  }, 60_000);

  it('publishes a purged type that has no live rows left at all', async () => {
    const type = nextType();

    await succeeded(type, (RETENTION_DAYS + 5) * DAY_MS, 2000);
    await failedRow(type, (RETENTION_DAYS + 5) * DAY_MS);

    await purgeFor(client).process(PURGE_JOB);

    await expect(client.job.count({ where: { type } })).resolves.toBe(0);

    const lifetime = (await insights.insights({ windowDays: 7 })).lifetime.find(
      (row) => row.type === type
    );

    // Iterating only the live side would drop this type entirely, and the
    // number that remained would still look like a number.
    expect(lifetime).toMatchObject({
      succeeded: 1,
      failed: 1,
      total: 2,
      durationSamples: 1,
    });
    expect(lifetime?.avgMs).toBeCloseTo(2000, 6);
  }, 60_000);

  // ===========================================================================
  // 5. reset-history
  // ===========================================================================

  it('clears the rollup and leaves live rows and live-derived numbers intact', async () => {
    const type = nextType();

    await succeeded(type, (RETENTION_DAYS + 5) * DAY_MS, 8000);
    await succeeded(type, 1 * DAY_MS, 2000);
    await pending(type, 3);

    await purgeFor(client).process(PURGE_JOB);
    await expect(client.jobStatsRollup.findUnique({ where: { type } })).resolves.not.toBeNull();

    const before = await insights.insights({ windowDays: 7 });
    const liveBefore = before.live.byType.find((row) => row.type === type);
    const historyBefore = before.history.byType.find((row) => row.type === type);
    const etaBefore = before.eta.find((row) => row.type === type);
    const lifetimeBefore = before.lifetime.find((row) => row.type === type);

    expect(lifetimeBefore).toMatchObject({ succeeded: 2, durationSamples: 2 });
    expect(lifetimeBefore?.avgMs).toBeCloseTo(5000, 6);

    // `resetHistory` is not scoped by type — it cannot be, the control means
    // "start the accumulators again" — so this suite puts back every rollup
    // row it does not own. Deleting a developer's real lifetime totals to make
    // a point about a test fixture would be exactly the kind of damage the
    // rest of this file is careful to avoid.
    const foreignRollups = (await client.jobStatsRollup.findMany()).filter(
      (row) => !row.type.startsWith(TYPE_PREFIX)
    );

    try {
      const { reset } = await insights.resetHistory();

      expect(reset).toBe(foreignRollups.length + 1);
      await expect(client.jobStatsRollup.count()).resolves.toBe(0);
    } finally {
      for (const row of foreignRollups) {
        await client.jobStatsRollup.create({ data: row });
      }
    }

    const after = await insights.insights({ windowDays: 7 });

    // Every live-derived block is untouched...
    expect(after.live.byType.find((row) => row.type === type)).toEqual(liveBefore);
    expect(after.history.byType.find((row) => row.type === type)).toEqual(historyBefore);
    expect(after.eta.find((row) => row.type === type)).toEqual(etaBefore);

    // ...and lifetime now reports only what is still in the table: the purged
    // 8-second job is gone from the accumulator, so the average is the
    // survivor's alone.
    const lifetimeAfter = after.lifetime.find((row) => row.type === type);
    expect(lifetimeAfter).toMatchObject({ succeeded: 1, failed: 0, durationSamples: 1 });
    expect(lifetimeAfter?.avgMs).toBeCloseTo(2000, 6);

    // And no job row was harmed.
    await expect(client.job.count({ where: { type } })).resolves.toBe(4);
  }, 60_000);
});
