// =============================================================================
// The bodies and results of the four job actions (issue #264, epic #254)
// =============================================================================
//
// Two request bodies, both entirely optional, and three result shapes. They
// share a file because each is a handful of numbers and because splitting them
// would put the request and the result of the same operation in different
// places, which is exactly where they drift.
//
// -----------------------------------------------------------------------------
// `olderThanMinutes` HAS NO DEFAULT, AND THAT ABSENCE IS THE FEATURE
// -----------------------------------------------------------------------------
//
// `resetStuckSchema` gives `olderThanMinutes` no `.default(...)`, so an empty
// body parses to `{}` and `JobStuckService.resetStuck(undefined)` falls
// through to `getStuckThresholdMinutes()` — the `jobs.stuckThresholdMinutes`
// system setting, the same number the lease reaper's cron sweep uses.
//
// A default here — even `.default(30)`, even spelled as
// `DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes` — would be a SECOND
// place the threshold is decided, and it would win: the parsed value is always
// defined, so the service's settings lookup would become dead code reachable
// only from the cron. An operator who moved the setting to 5 minutes would
// then find the dashboard button still sweeping at 30 and no way to tell why.
// The value is deliberately allowed to be `undefined` all the way down to the
// one function that knows where the number lives.
//
// The parameter still exists because there is a real use for it: sweeping
// tighter than the configured threshold during an incident, without changing a
// setting that the cron will then keep using afterwards. `0` is permitted and
// means "every running job that matches any recovery signal, at any age" —
// the lease signal in `stuckRunningWhere()` is independent of the threshold,
// so `0` is not a synonym for "everything running".
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const retryFailedSchema = z.object({
  /**
   * Restrict the sweep to one job type. Omitted, every failed job is retried.
   *
   * A plain equality match on the machine key, not a prefix or a glob: `type`
   * is what dispatch keys on, so "all the types starting with `billing.`" is a
   * question about a naming convention this queue does not enforce.
   */
  type: z.string().min(1).max(200).optional(),
});

export class RetryFailedDto extends createZodDto(retryFailedSchema) {}

export const resetStuckSchema = z.object({
  /**
   * Sweep rows stuck for longer than this many minutes.
   *
   * DELIBERATELY UNDEFAULTED — see the file header. Omitting it defers to the
   * `jobs.stuckThresholdMinutes` system setting, which is the behaviour the
   * cron sweep already has.
   */
  olderThanMinutes: z.coerce.number().int().min(0).max(60 * 24 * 365).optional(),
});

export class ResetStuckDto extends createZodDto(resetStuckSchema) {}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const retryFailedResultSchema = z.object({
  /** Rows moved back to `pending`. */
  retried: z.number().int(),

  /**
   * Rows left `failed` because an active job already holds their dedup key.
   *
   * Not an error: a non-zero `skipped` means the work those rows describe is
   * already queued or running, which is the outcome the retry was asking for.
   * See `job-admin.service.ts` for why this is counted rather than thrown.
   */
  skipped: z.number().int(),

  /**
   * Failed rows still matching the scope after the sweep.
   *
   * Non-zero either because the batch cap was reached (run it again) or
   * because everything left was skipped. A client can decide which by
   * comparing against `skipped`.
   */
  remaining: z.number().int(),
});

export class RetryFailedResultDto extends createZodDto(retryFailedResultSchema) {}

export const resetStuckResultSchema = z.object({
  /** Rows requeued as `pending` for another executor to claim. */
  reset: z.number().int(),
  /** Rows failed permanently because their attempt budget was spent. */
  failed: z.number().int(),
  /** The threshold actually applied, whether it came from the body or settings. */
  thresholdMinutes: z.number().int(),
});

export class ResetStuckResultDto extends createZodDto(resetStuckResultSchema) {}
