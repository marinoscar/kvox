// =============================================================================
// The queue's summary (issue #264, epic #254)
// =============================================================================
//
// What a dashboard polls: how much work exists, in what state, of what type,
// and how much of it is in trouble. One request, because the alternative — a
// count endpoint per tile — is five round trips whose answers are taken at
// five different instants, so the tiles do not add up and an operator learns
// to distrust the page.
//
// -----------------------------------------------------------------------------
// EVERY STATUS KEY IS ALWAYS PRESENT, INCLUDING THE ZEROES
// -----------------------------------------------------------------------------
//
// `byStatus` and each entry's `byStatus` are zero-filled from `JOB_STATUSES`
// before the `groupBy` rows are folded in. A `GROUP BY` returns no row for a
// status nothing is in, so the natural shape of this response is one where
// `failed` is simply absent on a healthy queue — and a client rendering
// `stats.byStatus.failed` then shows `undefined` exactly when everything is
// fine. Zero-filling makes "no failures" and "the key is missing" the same
// thing on the wire, which is what a tile can render without a fallback.
//
// -----------------------------------------------------------------------------
// `stuckThresholdMinutes` IS PUBLISHED BECAUSE `stuckRunning` IS MEANINGLESS
// WITHOUT IT
// -----------------------------------------------------------------------------
//
// `stuckRunning` is a count against a threshold the caller cannot see: it
// lives in the `jobs.stuckThresholdMinutes` system setting, it is read through
// `JobStuckService.getStuckThresholdMinutes()`, and it can be changed while
// the dashboard is open. A UI that showed "4 stuck" and had to hardcode "(over
// 30 minutes)" would go on saying 30 after an operator moved the setting to 5,
// which turns a status line into a false one. Sending the number that was
// ACTUALLY used for this response removes that possibility.
//
// It is also what the `reset-stuck` control needs to prefill its "older than"
// input with the value an empty body would use.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Counts per status, zero-filled — every key is always present. */
export const jobStatusCountsSchema = z.object({
  pending: z.number().int(),
  running: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
});

export type JobStatusCounts = z.output<typeof jobStatusCountsSchema>;

/**
 * One row of the by-type breakdown.
 *
 * Ordered by `total` descending then `type` ascending in the service, so the
 * busiest type is first and the order is stable between two polls that see the
 * same counts — a table whose rows reshuffle every two seconds is unreadable.
 */
export const jobTypeStatsSchema = z.object({
  type: z.string(),
  /** `type` through `jobTypeLabel()`; equal to `type` when unmapped. */
  label: z.string(),
  total: z.number().int(),
  byStatus: jobStatusCountsSchema,
});

export const jobStatsSchema = z.object({
  /** Every `jobs` row, whatever its status or age. */
  total: z.number().int(),

  byStatus: jobStatusCountsSchema,
  byType: z.array(jobTypeStatsSchema),

  /**
   * `pending` rows whose `scheduledFor` is still in the future — retry
   * backoff and rate-limit deferrals. A subset of `byStatus.pending`, never a
   * fifth status; see `job-list-query.dto.ts` for why that distinction is
   * kept on the wire.
   */
  scheduled: z.number().int(),

  /**
   * `running` rows the lease reaper would reclaim right now, counted with the
   * reaper's own `stuckRunningWhere()` so the dashboard and the sweeper can
   * never disagree about which rows those are.
   */
  stuckRunning: z.number().int(),

  /** The threshold `stuckRunning` was computed against, in minutes. */
  stuckThresholdMinutes: z.number().int().positive(),

  /** When these counts were taken. Every field above shares this instant. */
  generatedAt: z.iso.datetime(),
});

export class JobStatsDto extends createZodDto(jobStatsSchema) {}

/** The service's own return type: identical, but with `generatedAt` as a `Date`. */
export type JobStatsResult = Omit<z.output<typeof jobStatsSchema>, 'generatedAt'> & {
  generatedAt: Date;
};
