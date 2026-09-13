// =============================================================================
// Queue insights and ETA (issue #265, epic #254)
// =============================================================================
//
// ⚠ EVERY QUERY IN THIS FILE IS A PURE `SELECT`, AND THAT IS THE PROPERTY THAT
// MAKES THE ENDPOINT SAFE TO EXPOSE AT ALL
// -----------------------------------------------------------------------------
//
// This service reports on a table that a worker pool is actively claiming rows
// out of. The claim statement (`job-claim.service.ts`) is an `UPDATE ... WHERE
// id IN (SELECT ... FOR UPDATE SKIP LOCKED)`: it takes `ROW EXCLUSIVE` on
// `jobs` and holds row locks for as long as its transaction lives. Anything
// here that took a conflicting lock would not merely be slow — it would BLOCK
// THE QUEUE IT IS REPORTING ON, and it would do so exactly when an operator
// opens the dashboard, which is exactly when the queue is already in trouble.
// A monitoring surface that can stall the thing it monitors is worse than no
// monitoring surface.
//
// So every statement below is a plain `SELECT` (Prisma `groupBy`, `count`,
// `findMany`, and `$queryRaw` whose text begins with `SELECT`). A plain
// `SELECT` takes `ACCESS SHARE`, which conflicts with nothing except `ACCESS
// EXCLUSIVE` — i.e. with `DROP`/`ALTER TABLE`, and with nothing the queue does
// in normal operation. It does not wait behind `FOR UPDATE` row locks either:
// under Postgres's default READ COMMITTED, a reader sees the last committed
// version of a locked row and moves on. Insights and a saturated worker pool
// are therefore mutually invisible.
//
// The rules that keep it that way, for anyone extending this file:
//
//   - NO `FOR UPDATE`, `FOR SHARE`, `LOCK TABLE` or advisory lock. Ever.
//   - NO write of any kind — not a "cheap" counter bump, not a `last_viewed_at`
//     stamp, not an upsert into a cache table. `resetHistory()` at the bottom
//     is the ONE write in this service and it is a separate, explicitly
//     authorized route, not part of the read.
//   - NO `$executeRaw`. If a statement needs raw SQL it is a `$queryRaw`
//     starting with `SELECT`, and `job-insights.service.spec.ts` asserts that
//     for every raw statement this file issues.
//
// `test/jobs/job-insights.db.spec.ts` proves the property end to end: it holds
// real `FOR UPDATE` row locks open in one transaction and runs the whole
// insights computation from a second connection, which must return complete,
// correct numbers without waiting.
//
// -----------------------------------------------------------------------------
// ON DEMAND, IN PARALLEL — NO SNAPSHOT TABLE, NO CRON, NO POLLING
// -----------------------------------------------------------------------------
//
// Eight queries, all issued together through one `Promise.all`, all answered
// from indexes the schema already has. Nothing is precomputed and nothing is
// kept.
//
// REJECTED: A CRON-REFRESHED SNAPSHOT TABLE. The obvious "make it fast" move
// is a `job_insights_snapshot` row rewritten every minute, which the endpoint
// then reads. It was rejected on four counts, and the first is fatal on its
// own:
//
//   1. IT IS A WRITER ON THE HOT PATH. The refresh job would write on a timer
//      into the same database the worker pool is claiming from, forever, in
//      every deployment — including the overwhelming majority whose queue
//      nobody is watching. The read-only property above, the single reason
//      this endpoint is safe, would be traded away to make a page nobody has
//      open marginally faster.
//   2. IT ANSWERS A QUESTION NOBODY ASKED. A snapshot is stale by its refresh
//      interval, so the ETA would be computed from a queue depth up to a
//      minute old — and queue depth is the one input that changes fastest.
//      "Estimated 4 minutes" derived from a backlog that has since halved is
//      not a cached answer; it is a wrong one.
//   3. THE WINDOW IS A PARAMETER. `windowDays` makes the answer a function of
//      the request, so a snapshot would have to be per-window (a cache keyed
//      by a caller-supplied number, which is a cache with an unbounded key
//      space) or the parameter would have to go.
//   4. IT IS A MIGRATION, A TABLE, A SCHEDULED TASK AND A STALENESS RULE, for
//      an endpoint a human opens by hand a few times a week. The cost of
//      computing this live is eight indexed aggregates; the cost of caching it
//      is a permanent piece of infrastructure.
//
// `stats()`'s two-second cache is not a counter-example: it caches four
// unconditional counts IN PROCESS, with no table, no timer and no writes, for
// an endpoint a dashboard polls every few seconds. This one is opened by a
// person, so there is nothing to collapse.
//
// -----------------------------------------------------------------------------
// THE WINDOW IS BOUNDED, AND `lifetime` IS THE REASON THAT IS NOT A GAP
// -----------------------------------------------------------------------------
//
// `history` scans succeeded jobs whose `finishedAt` falls inside the window,
// capped at {@link MAX_INSIGHTS_WINDOW_DAYS}. It is bounded because computing
// a percentile means SORTING the sample set, and an unbounded percentile query
// is one whose cost grows with a table nothing in this file controls.
//
// REJECTED: UNBOUNDED LIFETIME PERCENTILES. "p95 over all time" sounds
// strictly better than "p95 over 7 days" and is in fact two bad things at
// once. It cannot be computed after a purge — the rows whose distribution it
// describes have been deleted (#263), so an "all time" percentile would
// silently mean "since the last purge", a window that moves with the retention
// setting and is never stated anywhere. And where history HAS been kept, the
// query degrades exactly as the deployment grows, on an endpoint whose whole
// justification is that it cannot hurt the queue.
//
// `lifetime` therefore publishes what genuinely survives summarisation —
// counts, and a mean reconstructed from a sum and a denominator — and says so.
// See `dto/job-insights.dto.ts` for why storing percentiles in the rollup is
// not a fix but a fabrication.
//
// -----------------------------------------------------------------------------
// THE LIFETIME MERGE, AND WHY IT CANNOT DOUBLE COUNT
// -----------------------------------------------------------------------------
//
// The invariant comes from `handlers/job-history-purge.handler.ts`, and the
// merge here is only correct because of it: the purge folds a batch into
// `JobStatsRollup` and DELETES that exact batch INSIDE ONE `$transaction`, by
// the ids it just counted. So at any instant a terminal job is in exactly one
// of two places — still a `jobs` row, or an increment inside a rollup
// accumulator — and never in both, and never in neither. Lifetime is
// therefore a plain sum of the two halves:
//
//     succeeded = rollup.succeededCount + (live succeeded rows)
//     failed    = rollup.failedCount    + (live failed rows)
//     avgMs     = (rollup.sumDurationMs + liveSum)
//                 / (rollup.durationSamples + liveSamples)
//
// The half that is easy to get wrong is the DENOMINATOR, and the rule is
// `foldDeltas`': a duration sample is a SUCCEEDED row with both timestamps and
// a non-negative duration. Failures are counted in `failedCount` and
// contribute nothing to the average (a failure's duration measures how long it
// took to break, which is dominated by timeouts); a row with a negative
// duration — an NTP step backwards between the claim and the terminal write —
// drops out of the SUM AND THE SAMPLE COUNT together, because counting a
// sample whose duration was discarded drags the mean towards zero.
// `LIFETIME_LIVE_DURATIONS_SQL` below repeats that predicate exactly. If the
// two ever disagree, the average silently changes every time a purge runs,
// which is the failure this whole arrangement exists to prevent.
//
// The live COUNTS are not queried separately: they are read out of the same
// unconditional `groupBy(['type','status'])` the `live` block already ran, so
// the two blocks of the response cannot report different live totals.
//
// -----------------------------------------------------------------------------
// THE `where` CLAUSES ARE SHAPED TO THE PARTIAL INDEXES FROM #255
// -----------------------------------------------------------------------------
//
// Two partial indexes exist in `20260906120000_add_jobs/migration.sql` for
// precisely these queries, and a partial index is only usable when the query's
// predicate IMPLIES the index's. That makes the exact spelling of these
// `where`s load-bearing rather than stylistic:
//
//   - `jobs_attempts_gt1_idx ON jobs(attempts) WHERE attempts > 1` — so the
//     `retried` count is `attempts > 1` and not `attempts >= 2`, and not
//     `attempts != 1`. All three describe the same integers; only the first
//     matches the index predicate as written.
//   - `jobs_succeeded_duration_idx ON jobs(finished_at, started_at, type)
//     WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS
//     NOT NULL` — so BOTH raw queries repeat all three of those predicates
//     even though `started_at IS NOT NULL` looks redundant next to an
//     arithmetic expression that would produce NULL anyway. Dropping either
//     NULL test turns an index-only scan into a sequential scan of the whole
//     table, and the query keeps returning the right answer while doing so,
//     which is why nobody notices.
//
//     Every column those two queries touch is IN that index — `finished_at`,
//     `started_at`, `type` — so both are answerable without visiting the heap,
//     and the window filter is a range scan on its leading column.
//
// The unconditional `groupBy` aggregates are unfiltered for the reason
// `stats()` gives: `jobs(status, type, id)` covers them, and adding any `where`
// pushes them onto the heap.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { JOB_CLOCK, JobClock, systemJobClock } from './job-clock';
import { countOf, foldTypeCounts, sumCounts, zeroCounts } from './job-counts.util';
import { jobTypeLabel } from './job-type-labels';
import { resolveWorkerConcurrency } from './job.worker';
import { JobStatusName } from './dto/job-response.dto';
import { JobStatusCounts } from './dto/job-stats.dto';
import {
  JobDurationStats,
  JobEtaBasis,
  JobInsightsQuery,
  JobInsightsResult,
  MAX_INSIGHTS_WINDOW_DAYS,
  THROUGHPUT_WINDOW_MS,
} from './dto/job-insights.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The per-job duration assumed when NOTHING has ever succeeded.
 *
 * Reached only on the `basis: 'none'` branch, which is the response's own
 * statement that this number is a placeholder and not a measurement — see
 * `dto/job-insights.dto.ts`. Thirty seconds is chosen to be obviously
 * order-of-magnitude ("a handful of minutes for a hundred jobs") rather than
 * flatteringly small: an estimate that starts near zero and then grows as real
 * samples arrive reads as the queue getting slower, which is the one wrong
 * impression a first-run dashboard must not give.
 *
 * It is deliberately NOT configurable. A knob for the value used when there is
 * no data is a knob whose correct setting is unknowable, and the honest fix
 * for a bad `none` estimate is to run some jobs.
 */
export const FALLBACK_JOB_DURATION_MS = 30_000;

/**
 * The non-terminal statuses. A job in one of these is still outstanding work,
 * which is what makes it part of a remaining-work estimate.
 */
const OUTSTANDING_STATUSES: readonly JobStatusName[] = ['pending', 'running'];

/**
 * A job's duration in milliseconds, as a `double precision` expression.
 *
 * CAST EXPLICITLY, and not for tidiness. `EXTRACT(EPOCH FROM interval)`
 * returns `numeric` on PostgreSQL 14 and later, and Prisma maps `numeric`
 * to a `Decimal` OBJECT rather than a JS number — so `avg()` and `sum()` over
 * the uncast expression would arrive here as objects that serialize to
 * `{"s":1,"e":3,...}` in the response body. The cast keeps every duration a
 * plain `number` all the way to the wire, which is the same class of concern
 * that made `JobStatsRollup.sumDurationMs` a `Float` and not a `BigInt`.
 */
const DURATION_MS = Prisma.sql`((EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::double precision)`;

/**
 * The three predicates `jobs_succeeded_duration_idx` is partial on, verbatim.
 *
 * Shared by both raw queries so the index match cannot be broken in one of
 * them and kept in the other — the failure mode being a query that still
 * returns the correct answer while sequentially scanning the table.
 */
const TIMED_SUCCESS = Prisma.sql`
  status = 'succeeded'::"JobStatus"
  AND started_at IS NOT NULL
  AND finished_at IS NOT NULL
`;

/** One row of the windowed history aggregate. `type` is NULL on the grand total. */
interface HistoryRow {
  is_overall: number;
  type: string | null;
  samples: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  last_hour: number;
}

/** One row of the live half of the lifetime duration merge. */
interface LifetimeDurationRow {
  type: string;
  sum_ms: number | null;
  samples: number;
}

@Injectable()
export class JobInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() @Inject(JOB_CLOCK) private readonly clock: JobClock = systemJobClock
  ) {}

  /**
   * The whole insights response, from eight parallel `SELECT`s.
   *
   * `Promise.all` rather than eight awaits, for a correctness reason as much
   * as a latency one: the queries are issued together, so the live counts, the
   * window's percentiles and the lifetime totals describe very nearly the same
   * instant. Serialised, the last query would run after the first by however
   * long the middle six took, and on a busy queue the ETA would be computed
   * from a backlog that had already moved — the same argument `stats()` makes
   * for summing `total` out of its first aggregate rather than counting it
   * separately.
   *
   * `windowDays` is CLAMPED here as well as bounded by the DTO. The pipe
   * already rejects an out-of-range query parameter with a 400, so this is
   * unreachable from HTTP — and that is exactly why it is here: the clamp
   * belongs to the query's cost, not to one route's validation, and a future
   * caller reaching this method from a task or a test must not be able to ask
   * for an unbounded percentile sort.
   */
  async insights(query: JobInsightsQuery): Promise<JobInsightsResult> {
    const windowDays = Math.min(
      MAX_INSIGHTS_WINDOW_DAYS,
      Math.max(1, Math.trunc(query.windowDays))
    );

    const generatedAt = new Date(this.clock.now());
    const windowStart = new Date(generatedAt.getTime() - windowDays * DAY_MS);
    const throughputSince = new Date(generatedAt.getTime() - THROUGHPUT_WINDOW_MS);

    const [
      byStatusRows,
      byTypeRows,
      scheduled,
      rateLimited,
      retried,
      historyRows,
      lifetimeDurationRows,
      rollupRows,
    ] = await Promise.all([
      // (1) and (2) are UNCONDITIONAL, so `jobs(status, type, id)` answers
      // both with an index-only scan. See `stats()` — adding any filter here
      // turns the cheapest part of this response into the most expensive.
      this.prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.job.groupBy({ by: ['type', 'status'], _count: { _all: true } }),

      // (3) `jobs(status, scheduled_for, priority, created_at)` — the same
      // index the claim query walks.
      this.prisma.job.count({
        where: { status: 'pending', scheduledFor: { gt: generatedAt } },
      }),

      // (4) Non-terminal only: a finished job is not being held up by a
      // provider any more, whatever its history of 429s.
      this.prisma.job.count({
        where: { rateLimitHits: { gt: 0 }, status: { in: [...OUTSTANDING_STATUSES] } },
      }),

      // (5) `attempts > 1` EXACTLY — `jobs_attempts_gt1_idx` is partial on
      // that predicate as written. See the file header.
      this.prisma.job.count({ where: { attempts: { gt: 1 } } }),

      // (6) and (7) are the two raw statements; both start with SELECT.
      this.windowedDurations(windowStart, throughputSince),
      this.lifetimeLiveDurations(),

      // (8) One row per type that has ever been purged. Small by construction:
      // the table is keyed by `type`.
      this.prisma.jobStatsRollup.findMany(),
    ]);

    // -----------------------------------------------------------------------
    // live
    // -----------------------------------------------------------------------

    const byStatus = zeroCounts();
    let total = 0;

    for (const row of byStatusRows) {
      const count = countOf(row);

      byStatus[row.status as JobStatusName] = count;
      total += count;
    }

    const liveByType = foldTypeCounts(byTypeRows);

    const byType = [...liveByType.entries()]
      .map(([type, counts]) => ({
        type,
        label: jobTypeLabel(type),
        total: sumCounts(counts),
        byStatus: counts,
      }))
      // Busiest first with an alphabetical tie-break, identical to `stats()`:
      // `Map` iteration follows whatever the database returned, which is not
      // stable between two requests that see identical counts.
      .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));

    // -----------------------------------------------------------------------
    // history
    // -----------------------------------------------------------------------

    const overallRow = historyRows.find((row) => row.is_overall === 1);
    const overall = toDurationStats(overallRow);

    const historyByType = new Map<string, JobDurationStats>();

    for (const row of historyRows) {
      // `is_overall` rather than `type IS NULL`: `Job.type` is NOT NULL so the
      // two are equivalent today, but `GROUPING()` says what is meant instead
      // of relying on a column constraint to carry the meaning.
      if (row.is_overall === 1 || row.type === null) continue;

      historyByType.set(row.type, toDurationStats(row));
    }

    const historyRowsOut = [...historyByType.entries()]
      .map(([type, stats]) => ({ type, label: jobTypeLabel(type), ...stats }))
      // Slowest median first: "what is taking the time" is the question this
      // block exists to answer. A null p50 cannot occur here (a row is only
      // present when it had samples), but it is coalesced anyway rather than
      // letting a comparator return NaN and leave the array in an arbitrary
      // order.
      .sort((a, b) => (b.p50Ms ?? 0) - (a.p50Ms ?? 0) || a.type.localeCompare(b.type));

    // -----------------------------------------------------------------------
    // eta
    // -----------------------------------------------------------------------

    const concurrency = resolveWorkerConcurrency(this.config);
    const eta = this.buildEta(liveByType, historyByType, overall, concurrency);

    // -----------------------------------------------------------------------
    // lifetime
    // -----------------------------------------------------------------------

    const lifetime = buildLifetime(liveByType, lifetimeDurationRows, rollupRows);

    return {
      windowDays,
      generatedAt,
      concurrency,
      live: { total, byStatus, byType, scheduled, rateLimited, retried },
      history: {
        windowStart,
        throughputSince,
        overall,
        byType: historyRowsOut,
      },
      eta,
      lifetime,
    };
  }

  /**
   * Percentiles, mean, sample count and last-hour throughput over the window,
   * per type AND overall, in ONE scan.
   *
   * `GROUP BY GROUPING SETS ((type), ())` is what makes it one scan rather
   * than two queries, and the reason is correctness before performance: the
   * grand total's p50 and p95 CANNOT be derived from the per-type rows (a
   * percentile is a position in a sorted distribution, and merging sorted
   * distributions needs the distributions), so the overall figures have to be
   * their own aggregate. Computed here, they are aggregates over exactly the
   * rows the per-type figures came from; asked for separately, they would be
   * taken a moment later over a set that may have grown, and `overall.samples`
   * would not equal the sum of `byType[].samples` — an inconsistency an
   * operator checks precisely because it looks checkable.
   *
   * `PERCENTILE_CONT`, not `PERCENTILE_DISC`: the continuous form interpolates
   * between the two bracketing samples, so a slowing job type moves p95
   * smoothly instead of jumping between two observed durations, and a
   * two-sample set has a meaningful median instead of an arbitrary one.
   *
   * Throughput rides along as a FILTERed count over the last hour rather than
   * as a ninth query: the hour is always inside the window (the minimum window
   * is a day), so those rows are already in this scan.
   *
   * Every count is cast `::int` at the database. `count(*)` is `bigint`, which
   * Prisma hands back as a JS `bigint`, which `JSON.stringify` REFUSES to
   * serialize — the response would not fail to be built, it would fail to be
   * SENT, which is the same trap the schema's `sumDurationMs` comment warns
   * about.
   */
  private windowedDurations(windowStart: Date, throughputSince: Date): Promise<HistoryRow[]> {
    return this.prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
      SELECT
        GROUPING(type)::int AS is_overall,
        type,
        count(*)::int AS samples,
        avg(${DURATION_MS}) AS avg_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ${DURATION_MS}) AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY ${DURATION_MS}) AS p95_ms,
        (count(*) FILTER (WHERE finished_at >= ${throughputSince}::timestamptz))::int AS last_hour
      FROM jobs
      WHERE ${TIMED_SUCCESS}
        AND finished_at >= ${windowStart}::timestamptz
      GROUP BY GROUPING SETS ((type), ())
    `);
  }

  /**
   * The LIVE half of the lifetime average: sum and sample count per type over
   * every succeeded, timed row still in the table.
   *
   * Unwindowed on purpose — "lifetime" — and bounded anyway by the retention
   * the purge enforces, which is the arrangement that lets this be an
   * index-only aggregate rather than an unbounded scan.
   *
   * `finished_at >= started_at` is the sample rule from `foldDeltas`, repeated
   * so that the live half and the purged half define a duration sample
   * identically. Without it a clock that stepped backwards would contribute a
   * negative duration here and nothing at all to the rollup, so a type's
   * lifetime average would CHANGE the next time a purge ran — a moving number
   * with no event to explain it.
   */
  private lifetimeLiveDurations(): Promise<LifetimeDurationRow[]> {
    return this.prisma.$queryRaw<LifetimeDurationRow[]>(Prisma.sql`
      SELECT
        type,
        sum(${DURATION_MS})::double precision AS sum_ms,
        count(*)::int AS samples
      FROM jobs
      WHERE ${TIMED_SUCCESS}
        AND finished_at >= started_at
      GROUP BY type
    `);
  }

  /**
   * One estimate per type with outstanding work.
   *
   * `remaining = pending + running`, and `running` is included deliberately: a
   * job being worked on right now is still work the operator is waiting for.
   * It makes the estimate very slightly pessimistic (the running jobs are
   * partway through, and nothing here knows how far), and pessimistic is the
   * correct direction for a number a human is waiting on.
   *
   * The average is resolved in three steps, and `basis` records which one won
   * — see `dto/job-insights.dto.ts` for why publishing the millisecond figure
   * alone would be dishonest.
   *
   * The divisor is the CONFIGURED worker concurrency, floored at 1. A
   * deployment running `JOBS_WORKER_CONCURRENCY=0` (or `JOBS_WORKER_MODE=off`)
   * is not draining this queue at all, so the true ETA is infinite; publishing
   * `Infinity` — which JSON renders as `null` — or a division by zero would
   * both be worse than the honest approximation "as long as one worker would
   * take", with the configured `concurrency` published alongside so a client
   * can see that it is zero and say so.
   *
   * Types with nothing outstanding are OMITTED rather than listed with a zero
   * estimate: this array is a to-do list, and a queue that has been running a
   * while accumulates many types with no work in them.
   */
  private buildEta(
    liveByType: Map<string, JobStatusCounts>,
    historyByType: Map<string, JobDurationStats>,
    overall: JobDurationStats,
    concurrency: number
  ): JobInsightsResult['eta'] {
    const divisor = Math.max(1, concurrency);
    const rows: JobInsightsResult['eta'] = [];

    for (const [type, counts] of liveByType) {
      const remaining = counts.pending + counts.running;

      if (remaining === 0) continue;

      const own = historyByType.get(type);

      let avgMs: number;
      let basis: JobEtaBasis;

      if (own && own.samples > 0 && own.avgMs !== null) {
        avgMs = own.avgMs;
        basis = 'live';
      } else if (overall.samples > 0 && overall.avgMs !== null) {
        avgMs = overall.avgMs;
        basis = 'partial';
      } else {
        avgMs = FALLBACK_JOB_DURATION_MS;
        basis = 'none';
      }

      rows.push({
        type,
        label: jobTypeLabel(type),
        pending: counts.pending,
        running: counts.running,
        remaining,
        avgMs,
        basis,
        estimatedMs: (remaining * avgMs) / divisor,
      });
    }

    // Longest wait first — the type an operator needs to hear about.
    return rows.sort((a, b) => b.estimatedMs - a.estimatedMs || a.type.localeCompare(b.type));
  }

  /**
   * Clears `JobStatsRollup`, and nothing else.
   *
   * THE ONE WRITE IN THIS SERVICE, behind its own `jobs:write` route. It is
   * here rather than in `JobAdminService` because the rollup is only ever
   * READ by this file, and a "reset the numbers on this page" control that
   * lived somewhere else would be a second opinion about which numbers the
   * page shows.
   *
   * LIVE ROWS ARE UNTOUCHED, which is the whole safety argument: this deletes
   * accumulators that summarise jobs that no longer exist, so the worst
   * outcome is that lifetime totals restart from the rows still in the table.
   * No job is deleted, no job's state changes, and every live-derived number
   * in the response — `live`, `history`, `eta`, and the live half of
   * `lifetime` — is identical before and after.
   *
   * It exists because a rollup is the one number in this API that a bad
   * deployment can corrupt permanently and no other tool can correct: a fork
   * that double counted during a botched migration, or a staging database
   * seeded with fictional history, has an all-time average that is simply
   * wrong forever, since the rows that would prove it wrong were deleted.
   * Starting the accumulators again is the only available repair.
   */
  async resetHistory(): Promise<{ reset: number }> {
    const { count } = await this.prisma.jobStatsRollup.deleteMany({});

    return { reset: count };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One aggregate row as the wire shape, or the empty distribution.
 *
 * `undefined` in means "the `GROUP BY` produced no such row", which happens
 * whenever nothing succeeded in the window — and the empty case must publish
 * `samples: 0` with three nulls rather than three zeroes. See the DTO header:
 * a zero average is a number the ETA would multiply by.
 */
function toDurationStats(row: HistoryRow | undefined): JobDurationStats {
  if (!row || row.samples === 0) {
    return { samples: 0, avgMs: null, p50Ms: null, p95Ms: null, throughputPerMin: 0 };
  }

  return {
    samples: row.samples,
    avgMs: numberOrNull(row.avg_ms),
    p50Ms: numberOrNull(row.p50_ms),
    p95Ms: numberOrNull(row.p95_ms),
    throughputPerMin: row.last_hour / (THROUGHPUT_WINDOW_MS / 60_000),
  };
}

/**
 * Merges the rollup (purged rows) with the live rows into all-time totals.
 *
 * Over the UNION of the two key sets, because neither contains the other: a
 * type purged long ago and never run since has a rollup row and no live rows,
 * and a type introduced yesterday has live rows and no rollup row. Iterating
 * either side alone silently drops half the deployment's history — and drops
 * it in the direction nobody checks, because the number that remains still
 * looks like a number.
 *
 * The live counts come from the caller's `groupBy` fold rather than from a
 * query of their own; see the file header on why that is what keeps `live` and
 * `lifetime` from disagreeing.
 */
function buildLifetime(
  liveByType: Map<string, JobStatusCounts>,
  durationRows: LifetimeDurationRow[],
  rollupRows: Array<{
    type: string;
    succeededCount: number;
    failedCount: number;
    sumDurationMs: number;
    durationSamples: number;
  }>
): JobInsightsResult['lifetime'] {
  const liveDurations = new Map(durationRows.map((row) => [row.type, row]));
  const rollups = new Map(rollupRows.map((row) => [row.type, row]));

  const types = new Set<string>([...liveByType.keys(), ...rollups.keys()]);

  return [...types]
    .map((type) => {
      const live = liveByType.get(type) ?? zeroCounts();
      const rollup = rollups.get(type);
      const durations = liveDurations.get(type);

      const succeeded = (rollup?.succeededCount ?? 0) + live.succeeded;
      const failed = (rollup?.failedCount ?? 0) + live.failed;

      const sumMs = (rollup?.sumDurationMs ?? 0) + (numberOrNull(durations?.sum_ms) ?? 0);
      const durationSamples = (rollup?.durationSamples ?? 0) + (durations?.samples ?? 0);

      return {
        type,
        label: jobTypeLabel(type),
        succeeded,
        failed,
        total: succeeded + failed,
        // Guarded rather than assumed: a type with only failures has counts
        // but no samples, and `0 / 0` is `NaN` — which `JSON.stringify` emits
        // as `null` anyway, but only after any arithmetic a caller did on the
        // way has silently become NaN too.
        avgMs: durationSamples > 0 ? sumMs / durationSamples : null,
        durationSamples,
      };
    })
    // Busiest first, alphabetical tie-break — the same ordering rule as every
    // other per-type array in this module.
    .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
}

/**
 * A finite number, or `null`.
 *
 * Aggregates return SQL NULL for an empty group, and the driver can hand back
 * a string for some numeric shapes depending on the adapter in use. Coercing
 * once here means no caller has to decide what `avg_ms` being `"1234.5"`
 * means, and `NaN` never reaches the response.
 */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}
