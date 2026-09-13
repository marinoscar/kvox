// =============================================================================
// The housekeeping enqueue — one shape for every maintenance cron (issue #353,
// epic #345)
// =============================================================================
//
// Epic #345 decision 1 says every long-running activity is a queue job. #351
// and #352 moved the database backup; this file is what made moving the other
// SEVEN housekeeping crons cost six lines each instead of sixty.
//
// Before #353 each of those crons did its own deleting, sweeping and pruning
// INLINE, on the scheduler's thread. The work was invisible in the admin job
// list, occupied no worker slot, had no timeout, got no retry, and the only
// answer to "did the token cleanup run last night?" was a log grep on whichever
// process happened to hold the timer. `jobs/tasks/job-history-purge.task.ts`
// had already established the correct shape — THE CRON DECIDES WHETHER WORK IS
// DUE AND ENQUEUES IT; A HANDLER DOES THE WORK — and this function is that
// shape, extracted, so the seven conversions cannot drift apart from each other.
//
// -----------------------------------------------------------------------------
// WHY A FUNCTION AND NOT A BASE CLASS
// -----------------------------------------------------------------------------
//
// The obvious alternative is an `abstract class HousekeepingTask` the seven
// tasks extend, with `@Cron` on an inherited method. Rejected: `@Cron` on an
// inherited method registers ONE timer per subclass only if Nest walks the
// prototype chain for decorators, which is a detail of the scheduler nobody
// should be betting seven maintenance jobs on — and the schedules genuinely
// differ (midnight, 2am, 3am, 4am, every ten minutes), so the decorator has to
// stay on each subclass anyway. What is actually shared is fifteen lines of
// "ask whether one is already in flight, enqueue, never throw", and a function
// shares those without anybody inheriting anything.
//
// -----------------------------------------------------------------------------
// TWO GUARDS, AND NEITHER IS REDUNDANT — the argument `JobHistoryPurgeTask`
// makes, now made once for all of them
// -----------------------------------------------------------------------------
//
//   1. "IS ONE ALREADY PENDING OR RUNNING?" — a cheap indexed lookup that keeps
//      the log honest. The active-dedup unique index ALREADY guarantees at most
//      one active job per (type, subject), and every type routed through here is
//      GLOBAL (no subject), so its dedup key is constant and `JobsService
//      .enqueue` would quietly collapse a second call onto the row already in
//      flight. Without this check, a sweep that legitimately runs past its next
//      tick would log "queued" every ten minutes without queueing anything.
//   2. THE DEDUP INDEX ITSELF — which is what actually closes the race between
//      two API replicas ticking at the same instant. The lookup above cannot:
//      it is a read followed by a write, and two replicas can both read "none".
//
// The first guard is for the LOG, the second is for CORRECTNESS. Deleting
// either leaves a real defect, which is why both are here.
//
// -----------------------------------------------------------------------------
// IT NEVER THROWS
// -----------------------------------------------------------------------------
//
// A throw out of a `@Cron` handler is an unhandled rejection, and an unhandled
// rejection terminates the process by default. Every task this replaces already
// swallowed its own errors for that reason; centralising the enqueue would
// otherwise centralise a way to lose that property. The next tick would have
// run anyway, so a database blip costs one log line and nothing else.
// =============================================================================

import { Logger } from '@nestjs/common';
import type { Job } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { JobsService } from './jobs.service';

/**
 * The queue priority every housekeeping job takes.
 *
 * ⚠ ASCENDING IS MORE URGENT — the `Job` model's own comment and the claim's
 * `ORDER BY priority ASC, created_at ASC` both say so — so 100 is LOW priority,
 * not high. That is the whole point: housekeeping must never be claimed ahead
 * of user-facing work. Every ordinary job takes the column default (`0`) and
 * therefore outranks these, so a fleet sweep waits for a quiet moment by
 * construction rather than by being scheduled for one.
 *
 * The same number `JobHistoryPurgeTask` chose in #263, now shared rather than
 * repeated: seven copies of a priority constant is seven chances for one of
 * them to be `-100` and starve the queue with a token cleanup.
 */
export const HOUSEKEEPING_PRIORITY = 100;

/** What one enqueue attempt needs. All four are required. */
export interface HousekeepingEnqueueOptions {
  jobs: JobsService;
  prisma: PrismaService;
  /** The caller's own logger, so the line is attributed to the task. */
  logger: Logger;
  /** The `JobHandler.type` to queue. */
  type: string;
  /** A human phrase for the log line ("device code cleanup"). Lower case. */
  what: string;
}

/**
 * Queues one global housekeeping job of `type`, unless one is already in
 * flight.
 *
 * @returns the queued job, or `null` when nothing was queued — because one was
 * already pending/running, or because the enqueue failed. Callers use the
 * return value for their own logging only; NOTHING should branch on it in a
 * way that matters, because "already queued" and "queued" are equally healthy
 * outcomes.
 */
export async function enqueueHousekeepingJob(
  options: HousekeepingEnqueueOptions
): Promise<Job | null> {
  const { jobs, prisma, logger, type, what } = options;

  try {
    const active = await prisma.job.findFirst({
      where: { type, status: { in: ['pending', 'running'] } },
      select: { id: true, status: true },
    });

    if (active) {
      logger.warn(
        `A ${what} job is already ${active.status} (job ${active.id}); skipping this ` +
          'tick rather than queueing a second one'
      );

      return null;
    }

    const job = await jobs.enqueue({
      type,
      // `backfill` is the closest of the three reasons: scheduled maintenance
      // over existing rows, not a response to an upload and not a human asking
      // for something to be run again.
      reason: 'backfill',
      // GLOBAL — no subject. Both nulls are what makes the dedup key constant
      // for the type, which is what makes the index a real single-flight
      // guarantee rather than a hint.
      priority: HOUSEKEEPING_PRIORITY,
    });

    logger.log(`Queued ${what} job ${job.id}`);

    return job;
  } catch (error) {
    // SWALLOWED — see the file header. The next tick would have run anyway.
    logger.error(
      `Could not queue the ${what} job: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );

    return null;
  }
}
