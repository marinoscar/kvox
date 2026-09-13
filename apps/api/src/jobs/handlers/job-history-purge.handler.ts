// =============================================================================
// History purge with lifetime rollup (issue #263, epic #254)
// =============================================================================
//
// THE TEMPLATE'S FIRST REAL JOB TYPE. Everything before this in the epic was
// mechanism — the contract (#259), enqueue and claim (#260), the terminal
// state machine (#261), the worker (#262) — exercised by a handler that logs
// its payload. This one does actual work, and it is deliberately the queue's
// own housekeeping: the first thing a background-job system should be able to
// do is keep itself from growing without bound.
//
// It is written the way `handlers/README.md` tells a fork to write theirs: one
// class, self-registered from its own `onModuleInit`, no queue wiring, no
// migration, no enum arm. The only thing it adds beyond the echo example is
// that it is worth reading.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY AND GLOBAL
// -----------------------------------------------------------------------------
//
// SERVER-ONLY, by carrying NEITHER `nodeResultSchema` nor `persistNodeResult`
// — the default, and here it is also the only correct answer: this job IS a
// sequence of database statements, so there is nothing for a remote node
// without database access to compute. `JobHandlerRegistry.serverOnlyTypes()`
// therefore includes it, which means a `JOBS_WORKER_MODE=system` API server
// keeps running it while the fleet takes the node-eligible work — exactly
// right for housekeeping.
//
// GLOBAL, by having no subject (`subjectType` and `subjectId` both null). It
// is not about a user, an upload or a row; it is about the table. That also
// gives it a stable dedup key (`buildDedupKey` folds the null pair into
// `"job.history.purge::"`), so the partial unique index alone guarantees at
// most one purge is ever active — see the scheduling task for the second,
// cheaper guard in front of it.
//
// -----------------------------------------------------------------------------
// WHY THE ROLLUP EXISTS AT ALL: DELETING HISTORY MUST NOT DELETE HISTORY
// -----------------------------------------------------------------------------
//
// The naive purge is one `deleteMany` and it is wrong, because the `jobs`
// table is two things at once:
//
//   - a WORK LIST, which is only interesting while the work is recent, and
//   - the only record of THROUGHPUT — how many jobs of each type have ever
//     run, how many failed, how long they took.
//
// A plain delete keeps the first and destroys the second: all-time counts and
// average durations would silently reset every retention period, so the
// answer to "how many exports have we ever run?" would depend on when the
// last purge happened. Worse, the reset is invisible — the numbers still look
// like numbers.
//
// `JobStatsRollup` (#255) is the accumulator that survives the delete, and
// THIS HANDLER IS ITS FIRST AND ONLY WRITER. Every row it is about to delete
// is first folded into the per-type totals, so lifetime statistics are
// `rollup + the rows still in the table` — a quantity this handler is
// designed never to change. Purging becomes a pure compaction: what is
// SUMMARISED changes, what is TRUE does not.
//
// -----------------------------------------------------------------------------
// THE ROLLUP AND THE DELETE ARE ONE TRANSACTION, PER BATCH
// -----------------------------------------------------------------------------
//
// The two failure modes are not symmetric, and both are unacceptable:
//
//   - Delete first, count after: a crash in between loses the rows AND their
//     contribution. Lifetime totals shrink. The evidence needed to correct
//     them is what was just deleted, so the error is PERMANENT and silent.
//   - Count first, delete after: a crash in between counts the rows twice
//     (the next run finds them again, still past the cutoff, and folds them
//     in a second time). Lifetime totals inflate, and keep inflating on every
//     retry.
//
// Wrapping the upserts and the delete in ONE `$transaction` makes both
// impossible: the batch either fully happened or fully did not, so a killed
// process can never delete a row without counting it, nor count one without
// deleting it. `apps/api/test/jobs/job-history-purge.db.spec.ts` proves this
// against real Postgres by failing a batch mid-transaction — a `$transaction`
// rollback is not meaningfully testable against a mock.
//
// -----------------------------------------------------------------------------
// BOUNDED BATCHES, BECAUSE THE QUEUE IS STILL RUNNING
// -----------------------------------------------------------------------------
//
// The loop takes 5000 rows at a time rather than deleting everything in one
// statement. This job runs on a worker slot in a live application: a single
// `DELETE` over a year of history holds row locks for as long as it takes,
// and the claim query (`FOR UPDATE SKIP LOCKED`) that other slots are running
// every few seconds has to wait behind it. Short transactions mean the purge
// yields the table between batches and the queue keeps flowing while it runs.
// The loop is what makes the total work unbounded while each STEP stays
// bounded — the same reason it is a job rather than a single cron statement.
//
// -----------------------------------------------------------------------------
// ⚠ PENDING AND RUNNING ROWS ARE NEVER TOUCHED, AT ANY AGE
// -----------------------------------------------------------------------------
//
// The `where` filters on terminal statuses FIRST and age second, and that
// order is the rule, not an implementation detail. A `pending` job is WORK
// THAT HAS NOT BEEN DONE. Its age says something about the queue — a backlog,
// a paused worker, a `scheduledFor` far in the future, a deployment that was
// down over the weekend — and nothing whatsoever about whether the work is
// still wanted. Deleting it would silently cancel it: no failure, no audit
// row, no retry, just an export nobody ever receives.
//
// A `running` row is worse still: deleting it orphans an executor that is
// about to write a terminal update for a row that no longer exists, and it
// removes precisely the rows the lease reaper exists to reclaim. Age is a
// retention criterion for FINISHED work only. An old `pending` row is the
// reaper's business, or an operator's — never the purge's.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, JobStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { JobHandler } from '../job-handler.interface';
import { JobHandlerRegistry } from '../job-handler.registry';

/**
 * The handler key, and therefore the `Job.type` value every purge row carries.
 *
 * Dotted and lowercase per `JobHandler.type`'s contract, product-neutral, and
 * PERMANENT: rows outlive handlers, so renaming this orphans every historical
 * purge row and every purge already queued under the old name.
 *
 * Exported because the scheduling task needs the exact same string to ask "is
 * one already queued?", and two literals is one typo away from a task that
 * enqueues a duplicate every midnight forever.
 */
export const JOB_HISTORY_PURGE_TYPE = 'job.history.purge';

/**
 * Rows per batch. See the file header: this is a lock-duration bound, not a
 * throughput knob. Large enough that a big backlog clears in a sane number of
 * round trips, small enough that no single transaction holds locks long
 * enough for the claim query to notice.
 */
const PURGE_BATCH_SIZE = 5000;

/**
 * A safety stop on the batch loop.
 *
 * At 5000 rows a batch this is 5 million rows in one run — far more than any
 * single retention period should produce, and if a deployment genuinely has
 * more, the next nightly run continues where this one stopped. It exists
 * because the loop's exit condition depends on rows actually disappearing:
 * were a future change ever to make the delete a no-op for some row (a `where`
 * that no longer matches what was selected, say), an unbounded loop would spin
 * on the same batch forever inside a worker slot. A bounded one stops, having
 * done real work, and says so.
 */
const MAX_BATCHES_PER_RUN = 1000;

/** The two statuses that mean "this job is over". */
const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed'];

/** What one batch contributes to one type's lifetime totals. */
interface RollupDelta {
  succeeded: number;
  failed: number;
  sumDurationMs: number;
  durationSamples: number;
}

/** The columns a purge candidate is read with — everything the fold needs. */
type PurgeCandidate = Pick<Job, 'id' | 'type' | 'status' | 'startedAt' | 'finishedAt'>;

@Injectable()
export class JobHistoryPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(JobHistoryPurgeHandler.name);

  readonly type = JOB_HISTORY_PURGE_TYPE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly registry: JobHandlerRegistry
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Folds terminal history older than the retention window into
   * `JobStatsRollup` and deletes it, in batches.
   *
   * THROWS TO FAIL, like every handler: a database error here is not caught,
   * so the queue's own retry and backoff apply and a failed purge shows up in
   * the job list with a message. There is nothing to clean up on failure —
   * each batch is atomic, so a run that dies half way through has simply done
   * fewer batches than it meant to, and the next run continues from the same
   * cutoff.
   */
  async process(job: Job): Promise<void> {
    const policy = await this.systemSettings.getJobsPolicy();

    if (!policy.history.purgeEnabled) {
      // CHECKED HERE AS WELL AS IN THE SCHEDULING TASK, deliberately. The task
      // is not the only way a purge row appears — an admin "run it now"
      // control, a rerun of a historical row, or a fork's own scheduler can
      // all enqueue one, and a job that ran because it was queued before the
      // switch was flipped would be a purge an operator believes they turned
      // off. The setting is a statement about whether this deployment deletes
      // history, so it is enforced where the deleting happens.
      this.logger.log(
        `Job history purge is disabled (jobs.history.purgeEnabled); job ${job.id} is a no-op`
      );

      return;
    }

    const retentionDays = policy.history.retentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    let deleted = 0;
    let batches = 0;

    for (; batches < MAX_BATCHES_PER_RUN; batches += 1) {
      const candidates = await this.prisma.job.findMany({
        where: purgeableWhere(cutoff),
        select: { id: true, type: true, status: true, startedAt: true, finishedAt: true },
        // Oldest first, so an interrupted run always leaves the NEWEST history
        // behind — which is the half anybody is likely to be looking at.
        orderBy: { finishedAt: 'asc' },
        take: PURGE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        break;
      }

      await this.applyBatch(candidates);

      deleted += candidates.length;

      // A short batch means the table has no more candidates; skip the extra
      // round trip that would prove it.
      if (candidates.length < PURGE_BATCH_SIZE) {
        batches += 1;
        break;
      }
    }

    if (batches >= MAX_BATCHES_PER_RUN) {
      this.logger.warn(
        `Job history purge stopped at its ${MAX_BATCHES_PER_RUN}-batch safety limit ` +
          `after deleting ${deleted} row(s); the next run continues from the same cutoff.`
      );
    }

    this.logger.log(
      `Job history purge removed ${deleted} terminal job row(s) finished before ` +
        `${cutoff.toISOString()} (retention ${retentionDays} day(s)) in ${batches} batch(es); ` +
        `their totals are preserved in the lifetime rollup.`
    );
  }

  /**
   * Counts one batch into the rollup and deletes it, ATOMICALLY.
   *
   * The whole correctness argument of this file is in the single
   * `$transaction` below — see the header for the two ways a non-atomic
   * version corrupts lifetime totals, one silently and permanently.
   */
  private async applyBatch(candidates: PurgeCandidate[]): Promise<void> {
    const deltas = foldDeltas(candidates);
    const ids = candidates.map((row) => row.id);

    await this.prisma.$transaction(async (tx) => {
      for (const [type, delta] of deltas) {
        // UPSERT, because a type's first ever purge has no rollup row and
        // every later one does. `increment` rather than a computed absolute
        // value: two purges cannot run concurrently (the dedup index sees to
        // that), but `increment` is also the only form that stays correct if
        // some future writer — the "maintained incrementally as jobs finish"
        // path the `JobStatsRollup` model anticipates — ever updates the same
        // row between our read and our write.
        await tx.jobStatsRollup.upsert({
          where: { type },
          create: {
            type,
            succeededCount: delta.succeeded,
            failedCount: delta.failed,
            sumDurationMs: delta.sumDurationMs,
            durationSamples: delta.durationSamples,
          },
          update: {
            succeededCount: { increment: delta.succeeded },
            failedCount: { increment: delta.failed },
            sumDurationMs: { increment: delta.sumDurationMs },
            durationSamples: { increment: delta.durationSamples },
          },
        });
      }

      // DELETE BY THE EXACT IDS JUST COUNTED, not by re-running the `where`.
      // Re-running it would delete rows that became terminal between the
      // select and this statement — rows nothing has counted — which is
      // precisely the "deleted uncounted" outcome the transaction exists to
      // prevent.
      await tx.job.deleteMany({ where: { id: { in: ids } } });
    });
  }
}

/**
 * Which rows a purge may take: TERMINAL, and finished before the cutoff.
 *
 * The status filter comes first for the reason the file header gives at
 * length — age is a retention criterion for finished work only, and a
 * `pending` job is work not yet done at any age.
 *
 * The age test has two arms because `finishedAt` is written by
 * `JobTerminalService` but is not enforced by the database:
 *
 *   - `finishedAt < cutoff` — the ordinary case, and the one the
 *     `[createdAt desc]` / duration indexes are shaped for.
 *   - `finishedAt IS NULL AND createdAt < cutoff` — a terminal row with no
 *     finish time, from a restored backup, an external control plane, or a
 *     partially applied write. `NULL < cutoff` is NULL, never true, so
 *     without this arm such a row is UNPURGEABLE FOREVER and the table grows
 *     without bound in exactly the deployment that already had a problem. It
 *     is the same reasoning as the reaper's zombie signal
 *     (`stuckRunningWhere`), applied to the other end of a job's life.
 *
 * Exported for the tests, which assert on the shape rather than the query.
 */
export function purgeableWhere(cutoff: Date): Prisma.JobWhereInput {
  return {
    status: { in: [...TERMINAL_STATUSES] },
    OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, createdAt: { lt: cutoff } }],
  };
}

/**
 * Folds a batch into one delta per `Job.type`.
 *
 * DURATION SAMPLES COME FROM SUCCEEDED ROWS ONLY, and that is a deliberate
 * definition rather than an omission. `jobs_succeeded_duration_idx` — the
 * partial index the schema builds for exactly this computation — is
 * `WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS
 * NOT NULL`, so the live half of "average duration for this type" is computed
 * over successes; folding failures into the rollup's accumulators would make
 * the purged half mean something different from the live half, and the
 * average would drift every time history was trimmed. It is also the more
 * useful number: a failure's duration measures how long it took to break,
 * which is dominated by timeouts and says nothing about how long the work
 * takes.
 *
 * Both counts, by contrast, include everything — `succeededCount` and
 * `failedCount` are throughput, and a failure is a job that ran.
 *
 * Exported so the arithmetic can be tested directly, without a database.
 */
export function foldDeltas(candidates: PurgeCandidate[]): Map<string, RollupDelta> {
  const deltas = new Map<string, RollupDelta>();

  for (const row of candidates) {
    let delta = deltas.get(row.type);

    if (!delta) {
      delta = { succeeded: 0, failed: 0, sumDurationMs: 0, durationSamples: 0 };
      deltas.set(row.type, delta);
    }

    if (row.status === 'succeeded') {
      delta.succeeded += 1;

      if (row.startedAt && row.finishedAt) {
        const durationMs = row.finishedAt.getTime() - row.startedAt.getTime();

        // A negative duration is impossible from a clock that only moves
        // forward and entirely possible from one that does not (an NTP step
        // backwards between the claim and the terminal write, a restored row
        // with hand-edited timestamps). Dropping the SAMPLE as well as the sum
        // keeps `sumDurationMs / durationSamples` honest — counting a sample
        // whose duration was discarded would drag the average towards zero.
        if (durationMs >= 0) {
          delta.sumDurationMs += durationMs;
          delta.durationSamples += 1;
        }
      }
    } else {
      delta.failed += 1;
    }
  }

  return deltas;
}
