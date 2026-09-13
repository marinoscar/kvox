// =============================================================================
// The queue's insights response (issue #265, epic #254)
// =============================================================================
//
// `stats` (#264) answers "what is the queue doing right now". This answers the
// two questions it structurally cannot: "how long will this take" and "is it
// getting faster or slower". One response, four blocks, because an operator
// reading a backlog wants the backlog, its recent speed and the resulting
// estimate to have been taken at the SAME instant — three endpoints polled
// separately produce an ETA computed from a queue depth that has already
// changed, which is how a progress number ends up going backwards.
//
// -----------------------------------------------------------------------------
// `avgMs`, `p50Ms` AND `p95Ms` ARE NULLABLE, AND ZERO WOULD BE A LIE
// -----------------------------------------------------------------------------
//
// A type with no succeeded jobs inside the window has no average duration.
// The tempting shape is `avgMs: 0`, and it is wrong twice over: a UI renders
// "0 ms" as a fact ("this job type is instant"), and the ETA below MULTIPLIES
// this number by a queue depth — so a zero average turns a thousand queued
// jobs into an estimate of "done already". `null` is the only value a client
// cannot accidentally do arithmetic on, and it is what makes the ETA's
// three-step fallback (below) necessary rather than optional.
//
// `samples` is therefore the field that says whether the other three mean
// anything, and it is always a number.
//
// -----------------------------------------------------------------------------
// `basis` EXISTS BECAUSE AN ESTIMATE MUST SAY HOW MUCH OF IT IS REAL
// -----------------------------------------------------------------------------
//
// Every ETA in the response is `remaining x avgMs / concurrency`, but `avgMs`
// can come from three very different places:
//
//   - `live`    — this type's OWN succeeded jobs inside the window. The
//                 estimate is measurement.
//   - `partial` — the overall average across every type, because this type has
//                 no history of its own yet. The estimate is an analogy, and a
//                 bad one whenever job types differ in cost (they always do).
//   - `none`    — nothing has ever succeeded inside the window, so the number
//                 is a shipped constant. The estimate is a placeholder.
//
// Publishing only the milliseconds would make those three indistinguishable on
// the wire, and a UI would render all of them with the same confidence. With
// `basis` a client can say "about 4 minutes", "roughly 4 minutes, based on
// other job types" and "no idea yet" from one field — which is the difference
// between a useful estimate and a number nobody believes twice.
//
// -----------------------------------------------------------------------------
// `lifetime` HAS COUNTS AND AVERAGES AND NO PERCENTILES, DELIBERATELY
// -----------------------------------------------------------------------------
//
// Lifetime numbers are `JobStatsRollup` (the purged rows, #263) merged with
// the rows still in the table. A rollup row is four accumulators — two counts,
// a sum and a sample count — and those four are exactly the quantities that
// SURVIVE summarisation: counts add, and a mean can be reconstructed from a
// sum and a denominator.
//
// A percentile cannot. p95 is a position in a sorted distribution, and the
// distribution was deleted; nothing about `sumDurationMs` and
// `durationSamples` can recover it, and no scheme of storing "the p95 at purge
// time" and averaging it with a live p95 produces the p95 of the union — it
// produces a number that looks like one. So the rollup does not store
// percentiles and this block does not publish them. `history` publishes real
// percentiles over a bounded window, where the rows still exist to be sorted.
//
// The honest split is therefore: `history` = distribution over a window,
// `lifetime` = totals over all time. Neither pretends to be the other.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { jobStatusCountsSchema, jobTypeStatsSchema } from './job-stats.dto';

/** The window used when the caller does not ask for one. */
export const DEFAULT_INSIGHTS_WINDOW_DAYS = 7;

/**
 * The largest window this endpoint will compute over.
 *
 * A CEILING, NOT A SUGGESTION. The history block sorts every succeeded job in
 * the window to compute percentiles, so its cost is linear in the number of
 * rows the window admits — and "how many jobs finished in the last N days" is
 * not a number this code bounds. Ninety days is comfortably longer than any
 * "is it getting slower?" question needs and short enough that the query stays
 * an index range scan rather than a table sort.
 *
 * A larger value is REJECTED (400) rather than silently reduced: an operator
 * who asked for a year and got a quarter, with a response that looks exactly
 * like the one they asked for, would compare it against last month's numbers
 * and draw a conclusion about a window that was never computed. The service
 * clamps as well, so a direct call cannot escape the bound either — see
 * `job-insights.service.ts`.
 */
export const MAX_INSIGHTS_WINDOW_DAYS = 90;

/**
 * How far back `throughputPerMin` looks, in milliseconds.
 *
 * ONE HOUR, and deliberately NOT the whole window: throughput is the answer to
 * "how fast is the queue moving right now", and averaging it over a week turns
 * a queue that stopped an hour ago into one that looks healthy. It is a
 * sub-window of the smallest permitted window (one day), so it is always fully
 * contained by the rows the history query already scanned — which is why it
 * costs no extra query at all.
 */
export const THROUGHPUT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const jobInsightsQuerySchema = z.object({
  /**
   * How many days of succeeded jobs the `history` block covers.
   *
   * `z.coerce` because every query parameter arrives as a string. The bounds
   * are the schema's, so an out-of-range value is a clean 400 from the global
   * `ZodValidationPipe` before this service ever runs a query.
   */
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INSIGHTS_WINDOW_DAYS)
    .default(DEFAULT_INSIGHTS_WINDOW_DAYS),
});

export class JobInsightsQueryDto extends createZodDto(jobInsightsQuerySchema) {}

/** The parsed, defaulted shape `JobInsightsService.insights` consumes. */
export type JobInsightsQuery = z.output<typeof jobInsightsQuerySchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Durations over one set of succeeded jobs. See the header on the nulls. */
export const jobDurationStatsSchema = z.object({
  /** Succeeded, fully timestamped jobs in the window. 0 means the rest is null. */
  samples: z.number().int(),

  /** Mean duration, or `null` when `samples` is 0. */
  avgMs: z.number().nullable(),

  /** Median, via `PERCENTILE_CONT(0.5)`. `null` when `samples` is 0. */
  p50Ms: z.number().nullable(),

  /**
   * 95th percentile, via `PERCENTILE_CONT(0.95)` — INTERPOLATED, not the
   * nearest sample (`PERCENTILE_DISC`), so a small sample set still moves the
   * number continuously as jobs get slower rather than jumping between two
   * observed durations.
   */
  p95Ms: z.number().nullable(),

  /**
   * Jobs succeeded per minute over the LAST HOUR — not over the window; see
   * `THROUGHPUT_WINDOW_MS`. `history.throughputSince` publishes the instant it
   * was measured from, so a client never has to hardcode "(last hour)".
   */
  throughputPerMin: z.number(),
});

export type JobDurationStats = z.output<typeof jobDurationStatsSchema>;

export const jobTypeDurationStatsSchema = jobDurationStatsSchema.extend({
  type: z.string(),
  /** `type` through `jobTypeLabel()`; equal to `type` when unmapped. */
  label: z.string(),
});

/**
 * The three answers to "where did this estimate's average come from".
 * See the header — the field exists so a UI can phrase its own confidence.
 */
export const JOB_ETA_BASES = ['live', 'partial', 'none'] as const;

export type JobEtaBasis = (typeof JOB_ETA_BASES)[number];

export const jobEtaSchema = z.object({
  type: z.string(),
  label: z.string(),

  /** Jobs of this type not yet finished: `pending + running`. */
  pending: z.number().int(),
  running: z.number().int(),
  remaining: z.number().int(),

  /** The per-job average this estimate multiplied. Never null — see `basis`. */
  avgMs: z.number(),

  basis: z.enum(JOB_ETA_BASES),

  /** `remaining x avgMs / concurrency`, in milliseconds. */
  estimatedMs: z.number(),
});

export const jobLifetimeStatsSchema = z.object({
  type: z.string(),
  label: z.string(),

  /** Rollup (purged rows) plus the rows still in the table. Never both. */
  succeeded: z.number().int(),
  failed: z.number().int(),
  /** `succeeded + failed` — jobs that ran, whatever the outcome. */
  total: z.number().int(),

  /**
   * `(rollup.sumDurationMs + liveSum) / (rollup.durationSamples + liveSamples)`,
   * or `null` when nothing timed has ever succeeded for this type.
   */
  avgMs: z.number().nullable(),

  /** The denominator above, published so `avgMs` can be weighed. */
  durationSamples: z.number().int(),
});

export const jobInsightsSchema = z.object({
  /** The window actually used, after clamping. Echoed so a client can label it. */
  windowDays: z.number().int(),

  /** When every number below was taken. One instant for the whole response. */
  generatedAt: z.iso.datetime(),

  /**
   * `JOBS_WORKER_CONCURRENCY` as this process reads it — the divisor every
   * `eta.estimatedMs` used. Published for the same reason `stats` publishes
   * `stuckThresholdMinutes`: an estimate computed against a number the caller
   * cannot see is one a UI has to guess at, and it would guess wrong the
   * moment a deployment changed the setting.
   */
  concurrency: z.number().int(),

  live: z.object({
    total: z.number().int(),
    byStatus: jobStatusCountsSchema,
    byType: z.array(jobTypeStatsSchema),

    /** `pending` rows whose `scheduledFor` is still in the future. */
    scheduled: z.number().int(),

    /**
     * Non-terminal rows that have been deferred by a provider rate limit at
     * least once (`rateLimitHits > 0`). Terminal rows are excluded because a
     * job that finished is no longer being held up by anything.
     */
    rateLimited: z.number().int(),

    /**
     * Rows that have been claimed more than once (`attempts > 1`) — the
     * queue's flakiness signal, and the predicate `jobs_attempts_gt1_idx` was
     * built for. Includes terminal rows: "how much of this history needed a
     * second go" is the question.
     */
    retried: z.number().int(),
  }),

  history: z.object({
    /** The oldest `finishedAt` the percentiles cover. */
    windowStart: z.iso.datetime(),
    /** The instant `throughputPerMin` counts from — one hour before `generatedAt`. */
    throughputSince: z.iso.datetime(),

    /**
     * Every succeeded job in the window, as ONE distribution.
     *
     * Not derivable from `byType`: a mean could be re-weighted, but p50 and
     * p95 cannot be combined from per-group percentiles at all. It is computed
     * in the same scan as `byType` (a `GROUPING SETS` grand total), so the two
     * always describe exactly the same rows.
     */
    overall: jobDurationStatsSchema,
    byType: z.array(jobTypeDurationStatsSchema),
  }),

  /** One entry per type with work outstanding, slowest estimate first. */
  eta: z.array(jobEtaSchema),

  /** All-time totals per type: rollup + live, counts and averages only. */
  lifetime: z.array(jobLifetimeStatsSchema),
});

export class JobInsightsDto extends createZodDto(jobInsightsSchema) {}

/** The service's own return type: identical, but with `Date`s where the wire has strings. */
export type JobInsightsResult = Omit<
  z.output<typeof jobInsightsSchema>,
  'generatedAt' | 'history'
> & {
  generatedAt: Date;
  history: Omit<
    z.output<typeof jobInsightsSchema>['history'],
    'windowStart' | 'throughputSince'
  > & { windowStart: Date; throughputSince: Date };
};

export const resetHistoryResultSchema = z.object({
  /**
   * `JobStatsRollup` rows deleted.
   *
   * Rows, not jobs: one row per job type, each holding that type's whole
   * purged history. A deployment with four job types reports `4` however many
   * millions of jobs those four accumulators summarised.
   */
  reset: z.number().int(),
});

export class ResetHistoryResultDto extends createZodDto(resetHistoryResultSchema) {}
