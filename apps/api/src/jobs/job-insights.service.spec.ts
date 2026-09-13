// =============================================================================
// Unit tests for JobInsightsService (issue #265, epic #254)
// =============================================================================
//
// The division of labour is #264's, applied one endpoint further along. What a
// mock can prove here is every DECISION the service makes over rows it was
// handed: which `where` each count carries, which of the three ETA bases wins,
// how the rollup and the live halves are merged, what the empty distribution
// looks like, and — the one that would otherwise never be checked — that every
// raw statement this file issues is a `SELECT`.
//
// What a mock CANNOT prove is what `PERCENTILE_CONT` returns, whether the
// merge stays conserved across a real purge, or that the whole computation
// runs while a worker holds `FOR UPDATE` locks. All three are Postgres's
// answers and all three are asked in `test/jobs/job-insights.db.spec.ts`.
//
// The clock is pinned through `JOB_CLOCK` in every case, so `windowStart` and
// `throughputSince` are exact timestamps rather than ranges — a range
// assertion passes just as happily for a window that is out by a factor of 24.
// =============================================================================

import { Prisma } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';

import { JobInsightsService, FALLBACK_JOB_DURATION_MS } from './job-insights.service';
import { JobClock } from './job-clock';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MAX_INSIGHTS_WINDOW_DAYS,
  THROUGHPUT_WINDOW_MS,
  jobInsightsQuerySchema,
} from './dto/job-insights.dto';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** A parsed query, so every test goes through the same defaults the pipe applies. */
function query(raw: Record<string, unknown> = {}) {
  return jobInsightsQuerySchema.parse(raw);
}

/** A `groupBy(['type','status'])` row in the shape Prisma returns. */
const typeRow = (type: string, status: string, count: number) => ({
  type,
  status,
  _count: { _all: count },
});

/** A `groupBy(['status'])` row. */
const statusRow = (status: string, count: number) => ({ status, _count: { _all: count } });

/** One windowed-history row, per type or (with `is_overall: 1`) the grand total. */
const historyRow = (
  type: string | null,
  samples: number,
  avg: number,
  p50: number,
  p95: number,
  lastHour = 0
) => ({
  is_overall: type === null ? 1 : 0,
  type,
  samples,
  avg_ms: avg,
  p50_ms: p50,
  p95_ms: p95,
  last_hour: lastHour,
});

/**
 * The harness plus the two `groupBy` fixtures.
 *
 * Separate from `makeService` only because the two `groupBy` calls share one
 * mock and are told apart by their `by` argument, which is easier to read as
 * an explicit setter than as another constructor parameter.
 */
function makeHarness(options: {
  byStatus?: unknown[];
  byType?: unknown[];
  history?: unknown[];
  lifetimeDurations?: unknown[];
  rollups?: unknown[];
  counts?: number[];
  concurrency?: number;
} = {}) {
  const rawCalls: Prisma.Sql[] = [];
  const byStatus = options.byStatus ?? [];
  const byType = options.byType ?? [];
  const history = options.history ?? [];
  const lifetimeDurations = options.lifetimeDurations ?? [];

  const groupBy = jest
    .fn()
    .mockImplementation(async (args: { by: string[] }) =>
      args.by.length === 1 ? byStatus : byType
    );

  // Three `count` calls in a fixed order: scheduled, rateLimited, retried.
  const countQueue = [...(options.counts ?? [0, 0, 0])];
  const count = jest.fn().mockImplementation(async () => countQueue.shift() ?? 0);

  const rollupFindMany = jest.fn().mockResolvedValue(options.rollups ?? []);
  const rollupDeleteMany = jest.fn().mockResolvedValue({ count: 0 });

  const queryRaw = jest.fn().mockImplementation(async (sql: Prisma.Sql) => {
    rawCalls.push(sql);

    return rawCalls.length === 1 ? history : lifetimeDurations;
  });

  const prisma = {
    job: { groupBy, count },
    jobStatsRollup: { findMany: rollupFindMany, deleteMany: rollupDeleteMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaService;

  const clock: JobClock = { now: () => NOW.getTime(), sleep: async () => undefined };

  const config = {
    get: jest.fn().mockReturnValue(options.concurrency ?? 2),
  } as unknown as ConfigService;

  return {
    service: new JobInsightsService(prisma, config, clock),
    groupBy,
    count,
    rollupFindMany,
    rollupDeleteMany,
    queryRaw,
    rawCalls,
  };
}

describe('JobInsightsService', () => {
  // ==========================================================================
  // ⚠ The property the endpoint's existence depends on
  // ==========================================================================

  describe('every statement is a read', () => {
    it('issues only SELECTs as raw SQL, and takes no lock of any kind', async () => {
      // THE FILE'S CENTRAL CLAIM, asserted on the SQL text itself. A statement
      // that wrote, or that added `FOR UPDATE` to "make the numbers
      // consistent", would block the claim query — an endpoint that stalls the
      // queue it reports on, precisely when an operator opens it.
      const { service, rawCalls } = makeHarness();

      await service.insights(query());

      expect(rawCalls).toHaveLength(2);

      for (const sql of rawCalls) {
        expect(sql.sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
        expect(sql.sql.toUpperCase()).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|FOR UPDATE|FOR SHARE|LOCK TABLE|PG_ADVISORY)\b/
        );
      }
    });

    it('never calls $executeRaw, and writes nothing during a read', async () => {
      const { service, rollupDeleteMany } = makeHarness();

      await service.insights(query());

      expect(rollupDeleteMany).not.toHaveBeenCalled();
    });

    it('binds the window as a parameter rather than interpolating it', async () => {
      // The same guarantee `job-claim.service.spec.ts` asserts for the claim:
      // a date rendered into the SQL text is an injection surface and defeats
      // statement caching.
      const { service, rawCalls } = makeHarness();

      await service.insights(query({ windowDays: 3 }));

      const [history] = rawCalls;

      expect(history.values).toEqual([
        new Date(NOW.getTime() - THROUGHPUT_WINDOW_MS),
        new Date(NOW.getTime() - 3 * DAY_MS),
      ]);
      expect(history.sql).not.toContain('2026-');
    });
  });

  // ==========================================================================
  // The window
  // ==========================================================================

  describe('windowDays', () => {
    it('defaults to 7 days', async () => {
      const { service } = makeHarness();

      const result = await service.insights(query());

      expect(result.windowDays).toBe(7);
      expect(result.history.windowStart).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    });

    it('rejects an out-of-range value at the schema, before any query runs', async () => {
      // The route's 400. `.max()` on the schema is what the global pipe turns
      // into a clean 400 rather than a clamped-and-mislabelled response.
      expect(() => query({ windowDays: MAX_INSIGHTS_WINDOW_DAYS + 1 })).toThrow();
      expect(() => query({ windowDays: 0 })).toThrow();
      expect(() => query({ windowDays: 'many' })).toThrow();
    });

    it('coerces the string a query parameter always is', async () => {
      expect(query({ windowDays: '30' }).windowDays).toBe(30);
    });

    it('clamps a direct call that bypasses the schema', async () => {
      // Unreachable over HTTP, and that is why it is tested: the bound belongs
      // to the query's cost, not to one route's validation.
      const { service, rawCalls } = makeHarness();

      const result = await service.insights({ windowDays: 4000 });

      expect(result.windowDays).toBe(MAX_INSIGHTS_WINDOW_DAYS);
      expect(rawCalls[0].values[1]).toEqual(
        new Date(NOW.getTime() - MAX_INSIGHTS_WINDOW_DAYS * DAY_MS)
      );
    });

    it('measures throughput over the last hour, not over the window', async () => {
      const { service } = makeHarness();

      const result = await service.insights(query({ windowDays: 30 }));

      expect(result.history.throughputSince).toEqual(
        new Date(NOW.getTime() - THROUGHPUT_WINDOW_MS)
      );
    });
  });

  // ==========================================================================
  // live
  // ==========================================================================

  describe('live', () => {
    it('zero-fills every status and sums the total from the same aggregate', async () => {
      const { service } = makeHarness({
        byStatus: [statusRow('pending', 3), statusRow('succeeded', 7)],
      });

      const result = await service.insights(query());

      expect(result.live.byStatus).toEqual({
        pending: 3,
        running: 0,
        succeeded: 7,
        failed: 0,
      });
      expect(result.live.total).toBe(10);
    });

    it('leaves both groupBy aggregates unfiltered so the covering index serves them', async () => {
      const { service, groupBy } = makeHarness();

      await service.insights(query());

      for (const call of groupBy.mock.calls) {
        expect(call[0].where).toBeUndefined();
      }
    });

    it('counts scheduled, rate-limited and retried jobs with the intended predicates', async () => {
      const { service, count } = makeHarness({ counts: [4, 5, 6] });

      const result = await service.insights(query());

      const wheres = count.mock.calls.map((call: [{ where: unknown }]) => call[0].where);

      expect(wheres[0]).toEqual({ status: 'pending', scheduledFor: { gt: NOW } });

      // Non-terminal only: a finished job is not being held up any more.
      expect(wheres[1]).toEqual({
        rateLimitHits: { gt: 0 },
        status: { in: ['pending', 'running'] },
      });

      // `attempts > 1` EXACTLY — `jobs_attempts_gt1_idx` is partial on that
      // predicate as written, so `gte: 2` would be the same integers and a
      // sequential scan.
      expect(wheres[2]).toEqual({ attempts: { gt: 1 } });

      expect(result.live).toMatchObject({ scheduled: 4, rateLimited: 5, retried: 6 });
    });

    it('labels byType and orders it busiest-first with an alphabetical tie-break', async () => {
      const { service } = makeHarness({
        byType: [
          typeRow('zeta.task', 'succeeded', 2),
          typeRow('alpha.task', 'succeeded', 2),
          typeRow('example.echo', 'pending', 5),
        ],
      });

      const result = await service.insights(query());

      expect(result.live.byType.map((row) => row.type)).toEqual([
        'example.echo',
        'alpha.task',
        'zeta.task',
      ]);
      expect(result.live.byType[0].label).toBe('Example echo');
      // An unmapped type renders as itself, never blank.
      expect(result.live.byType[1].label).toBe('alpha.task');
    });
  });

  // ==========================================================================
  // history
  // ==========================================================================

  describe('history', () => {
    it('separates the GROUPING SETS grand total from the per-type rows', async () => {
      const { service } = makeHarness({
        history: [
          historyRow(null, 3, 200, 200, 290, 3),
          historyRow('example.echo', 2, 150, 150, 195, 2),
          historyRow('slow.task', 1, 300, 300, 300, 1),
        ],
      });

      const result = await service.insights(query());

      expect(result.history.overall).toMatchObject({ samples: 3, avgMs: 200, p50Ms: 200 });
      expect(result.history.byType.map((row) => row.type)).toEqual([
        // Slowest median first.
        'slow.task',
        'example.echo',
      ]);
      expect(result.history.byType.every((row) => row.samples > 0)).toBe(true);
    });

    it('publishes nulls, not zeroes, when nothing succeeded in the window', async () => {
      // A zero average is a number the ETA would multiply a backlog by.
      const { service } = makeHarness({ history: [] });

      const result = await service.insights(query());

      expect(result.history.overall).toEqual({
        samples: 0,
        avgMs: null,
        p50Ms: null,
        p95Ms: null,
        throughputPerMin: 0,
      });
      expect(result.history.byType).toEqual([]);
    });

    it('turns the last-hour count into a per-minute rate', async () => {
      const { service } = makeHarness({
        history: [historyRow(null, 120, 100, 100, 100, 120)],
      });

      const result = await service.insights(query());

      expect(result.history.overall.throughputPerMin).toBe(2);
    });

    it('coerces a numeric string from the driver rather than passing it through', async () => {
      const { service } = makeHarness({
        history: [
          { is_overall: 1, type: null, samples: 2, avg_ms: '150.5', p50_ms: '150.5', p95_ms: null, last_hour: 0 },
        ],
      });

      const result = await service.insights(query());

      expect(result.history.overall.avgMs).toBe(150.5);
      expect(result.history.overall.p95Ms).toBeNull();
    });
  });

  // ==========================================================================
  // eta — the three bases
  // ==========================================================================

  describe('eta', () => {
    it("is `live` when the type has its own history", async () => {
      const { service } = makeHarness({
        byType: [typeRow('example.echo', 'pending', 8), typeRow('example.echo', 'running', 2)],
        history: [
          historyRow(null, 100, 5_000, 5_000, 5_000),
          historyRow('example.echo', 10, 1_000, 1_000, 1_000),
        ],
        concurrency: 2,
      });

      const result = await service.insights(query());

      expect(result.eta).toHaveLength(1);
      expect(result.eta[0]).toMatchObject({
        type: 'example.echo',
        pending: 8,
        running: 2,
        remaining: 10,
        avgMs: 1_000,
        basis: 'live',
        // 10 jobs x 1000ms / 2 workers.
        estimatedMs: 5_000,
      });
    });

    it('is `partial` when the type falls back to the overall average', async () => {
      const { service } = makeHarness({
        byType: [typeRow('brand.new', 'pending', 4)],
        // The overall row exists (other types have run); this type has none.
        history: [historyRow(null, 50, 2_000, 2_000, 2_000)],
        concurrency: 1,
      });

      const result = await service.insights(query());

      expect(result.eta[0]).toMatchObject({
        type: 'brand.new',
        avgMs: 2_000,
        basis: 'partial',
        estimatedMs: 8_000,
      });
    });

    it('is `none` when there is no history at all', async () => {
      const { service } = makeHarness({
        byType: [typeRow('brand.new', 'pending', 2)],
        history: [],
        concurrency: 1,
      });

      const result = await service.insights(query());

      expect(result.eta[0]).toMatchObject({
        basis: 'none',
        avgMs: FALLBACK_JOB_DURATION_MS,
        estimatedMs: 2 * FALLBACK_JOB_DURATION_MS,
      });
    });

    it('counts running jobs as remaining work', async () => {
      const { service } = makeHarness({
        byType: [typeRow('example.echo', 'running', 3)],
        history: [historyRow(null, 5, 1_000, 1_000, 1_000)],
        concurrency: 1,
      });

      const result = await service.insights(query());

      expect(result.eta[0]).toMatchObject({ pending: 0, running: 3, remaining: 3 });
    });

    it('omits types with nothing outstanding', async () => {
      const { service } = makeHarness({
        byType: [typeRow('done.task', 'succeeded', 900), typeRow('done.task', 'failed', 5)],
      });

      const result = await service.insights(query());

      expect(result.eta).toEqual([]);
    });

    it('divides by the configured worker concurrency and publishes it', async () => {
      const { service } = makeHarness({
        byType: [typeRow('example.echo', 'pending', 12)],
        history: [historyRow(null, 5, 1_000, 1_000, 1_000)],
        concurrency: 4,
      });

      const result = await service.insights(query());

      expect(result.concurrency).toBe(4);
      expect(result.eta[0].estimatedMs).toBe(3_000);
    });

    it('floors the divisor at 1 for a pool that is switched off', async () => {
      // The true ETA is infinite; `Infinity` serializes as `null` and a
      // division by zero is worse. The configured 0 is still published, so a
      // client can say the queue is not draining.
      const { service } = makeHarness({
        byType: [typeRow('example.echo', 'pending', 3)],
        history: [historyRow(null, 5, 1_000, 1_000, 1_000)],
        concurrency: 0,
      });

      const result = await service.insights(query());

      expect(result.concurrency).toBe(0);
      expect(result.eta[0].estimatedMs).toBe(3_000);
    });

    it('orders the longest wait first', async () => {
      const { service } = makeHarness({
        byType: [typeRow('quick.task', 'pending', 1), typeRow('slow.task', 'pending', 50)],
        history: [historyRow(null, 5, 1_000, 1_000, 1_000)],
        concurrency: 1,
      });

      const result = await service.insights(query());

      expect(result.eta.map((row) => row.type)).toEqual(['slow.task', 'quick.task']);
    });
  });

  // ==========================================================================
  // lifetime
  // ==========================================================================

  describe('lifetime', () => {
    it('adds the rollup to the live rows without double counting either', async () => {
      const { service } = makeHarness({
        byType: [
          typeRow('example.echo', 'succeeded', 4),
          typeRow('example.echo', 'failed', 1),
          typeRow('example.echo', 'pending', 9),
        ],
        lifetimeDurations: [{ type: 'example.echo', sum_ms: 4_000, samples: 4 }],
        rollups: [
          {
            type: 'example.echo',
            succeededCount: 96,
            failedCount: 9,
            sumDurationMs: 192_000,
            durationSamples: 96,
          },
        ],
      });

      const result = await service.insights(query());

      expect(result.lifetime).toEqual([
        {
          type: 'example.echo',
          label: 'Example echo',
          succeeded: 100,
          failed: 10,
          total: 110,
          // (192000 + 4000) / (96 + 4)
          avgMs: 1_960,
          durationSamples: 100,
        },
      ]);

      // `pending` is not lifetime work: it has not run.
      expect(result.lifetime[0].total).toBe(110);
    });

    it('includes a purged type with no live rows left', async () => {
      // Iterating only the live side silently drops a type whose entire
      // history has been purged — and the remaining number still looks like a
      // number, which is why nobody notices.
      const { service } = makeHarness({
        byType: [],
        rollups: [
          {
            type: 'retired.task',
            succeededCount: 12,
            failedCount: 3,
            sumDurationMs: 24_000,
            durationSamples: 12,
          },
        ],
      });

      const result = await service.insights(query());

      expect(result.lifetime).toEqual([
        {
          type: 'retired.task',
          label: 'retired.task',
          succeeded: 12,
          failed: 3,
          total: 15,
          avgMs: 2_000,
          durationSamples: 12,
        },
      ]);
    });

    it('includes a brand-new type with no rollup row', async () => {
      const { service } = makeHarness({
        byType: [typeRow('brand.new', 'succeeded', 2)],
        lifetimeDurations: [{ type: 'brand.new', sum_ms: 500, samples: 2 }],
        rollups: [],
      });

      const result = await service.insights(query());

      expect(result.lifetime[0]).toMatchObject({
        type: 'brand.new',
        succeeded: 2,
        failed: 0,
        avgMs: 250,
        durationSamples: 2,
      });
    });

    it('reports a null average rather than NaN for a type that has only failed', async () => {
      const { service } = makeHarness({
        byType: [typeRow('always.broken', 'failed', 7)],
        lifetimeDurations: [],
        rollups: [],
      });

      const result = await service.insights(query());

      expect(result.lifetime[0]).toMatchObject({
        succeeded: 0,
        failed: 7,
        total: 7,
        avgMs: null,
        durationSamples: 0,
      });
    });

    it('orders busiest-first with an alphabetical tie-break', async () => {
      const { service } = makeHarness({
        byType: [typeRow('zeta.task', 'succeeded', 1), typeRow('alpha.task', 'succeeded', 1)],
        rollups: [
          {
            type: 'busy.task',
            succeededCount: 50,
            failedCount: 0,
            sumDurationMs: 0,
            durationSamples: 0,
          },
        ],
      });

      const result = await service.insights(query());

      expect(result.lifetime.map((row) => row.type)).toEqual([
        'busy.task',
        'alpha.task',
        'zeta.task',
      ]);
    });
  });

  // ==========================================================================
  // reset-history
  // ==========================================================================

  describe('resetHistory', () => {
    it('deletes every rollup row and reports how many', async () => {
      const { service, rollupDeleteMany } = makeHarness();
      rollupDeleteMany.mockResolvedValue({ count: 3 });

      await expect(service.resetHistory()).resolves.toEqual({ reset: 3 });
      expect(rollupDeleteMany).toHaveBeenCalledWith({});
    });

    it('touches no job row', async () => {
      const { service, groupBy, count, queryRaw } = makeHarness();

      await service.resetHistory();

      expect(groupBy).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Configuration
  // ==========================================================================

  it('falls back to the shipped concurrency when the setting is missing', async () => {
    // A `NaN` divisor would publish an ETA of NaN milliseconds.
    const { service } = makeHarness({
      byType: [typeRow('example.echo', 'pending', 4)],
      history: [historyRow(null, 5, 1_000, 1_000, 1_000)],
      concurrency: undefined as unknown as number,
    });

    const result = await service.insights(query());

    expect(result.concurrency).toBe(2);
    expect(Number.isFinite(result.eta[0].estimatedMs)).toBe(true);
  });

  it('issues every query in parallel, not in sequence', async () => {
    // `Promise.all` is a correctness property here, not just a latency one:
    // the live backlog, the window's percentiles and the lifetime totals must
    // describe very nearly the same instant, or the ETA is computed from a
    // depth that has already moved.
    let inFlight = 0;
    let peak = 0;

    const observe = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;

      return value;
    };

    const prisma = {
      job: {
        groupBy: jest.fn().mockImplementation(() => observe([])),
        count: jest.fn().mockImplementation(() => observe(0)),
      },
      jobStatsRollup: {
        findMany: jest.fn().mockImplementation(() => observe([])),
        deleteMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockImplementation(() => observe([])),
    } as unknown as PrismaService;

    const service = new JobInsightsService(
      prisma,
      { get: () => 2 } as unknown as ConfigService,
      { now: () => NOW.getTime(), sleep: async () => undefined }
    );

    await service.insights(query());

    expect(peak).toBe(8);
  });
});
