// =============================================================================
// The queue's admin read/repair surface (issue #264, epic #254)
// =============================================================================
//
// Everything a human does to the queue from outside it: look at the summary,
// page through the rows, and — when something has gone wrong — retry, reset or
// delete. It is a deliberately SMALL service that owns exactly one thing of
// its own (the stats roll-up and its cache) and borrows everything else.
//
// -----------------------------------------------------------------------------
// WHAT THIS SERVICE IS NOT ALLOWED TO REIMPLEMENT
// -----------------------------------------------------------------------------
//
// `stuckRunningWhere()`, `getStuckThresholdMinutes()` and `resetStuck()` all
// live in `job-stuck.service.ts` and are CALLED from here, never copied. That
// file's header explains why they cannot live in an admin service — a
// `JOBS_WORKER_MODE=off` control plane must be able to reap without the admin
// surface being mounted — and this is the other half of the same argument: if
// the dashboard asked "which rows are stuck?" with its own `where`, then the
// number on the screen and the rows the reaper actually touches would be two
// independent opinions, and they would diverge the first time either changed.
//
// That is not hypothetical. The reaper's `where` is three OR'd recovery
// signals, and the second of them — a `running` row with a NULL `startedAt`,
// aged by `createdAt` instead — is the one an independent implementation
// always forgets, because it describes a state the claim statement cannot
// produce. A dashboard missing that clause would report "0 stuck" for the
// exact rows that are stuck forever.
//
// -----------------------------------------------------------------------------
// THE STATS CACHE: ~2 SECONDS, IN-PROCESS, DELIBERATELY DUMB
// -----------------------------------------------------------------------------
//
// `stats()` runs four aggregates. A dashboard polls it, several operators may
// have that dashboard open, and several API replicas may serve them — so the
// query rate is (tabs x replicas / poll interval) and none of those three
// factors is bounded by anything this code controls. The cache exists to bound
// it anyway.
//
// The TTL is SHORTER THAN THE POLL INTERVAL, on purpose. A cache at or above
// the poll interval would make the dashboard's refresh a coin flip — half the
// polls would return the previous poll's numbers and the page would appear to
// update every other tick. Two seconds against a poll of five or more means a
// deliberate refresh always sees fresh counts, while a burst of tabs arriving
// together collapses into one query.
//
// It is in-process and per-replica, with no invalidation and no coalescing of
// concurrent misses, and all three of those are choices:
//
//   - PER-REPLICA is fine because the value is a monotonic-ish count, not a
//     decision. Two replicas disagreeing by two seconds of queue activity is
//     invisible; a shared cache would mean a Redis dependency for a number
//     that is stale by construction anyway.
//   - NO INVALIDATION, even from this service's own writes. A retry that
//     appeared in the counts instantly and a retry that appeared two seconds
//     later are indistinguishable to a human clicking a button, and an
//     invalidation hook is a thing that gets forgotten by the next writer.
//   - NO COALESCING. Two concurrent misses run two queries. Sharing an
//     in-flight promise would save one query per two-second window in the
//     worst case and adds a rejected-promise-poisoning-the-cache failure mode
//     that is strictly worse than the query it saves.
//
// The clock behind the TTL is the injected `JobClock`, optional exactly as it
// is everywhere else in this module (see `job-clock.ts`): production provides
// nothing and gets `Date.now()`, and a test can prove the entry expires
// without sleeping for two real seconds — the only alternative being a test
// that sleeps, which nobody writes, so the expiry would go unproven.
//
// -----------------------------------------------------------------------------
// A RETRY CAN COLLIDE WITH THE DEDUP INDEX, AND THAT IS A 409, NOT A 500
// -----------------------------------------------------------------------------
//
// `jobs_active_dedup_uniq_idx` is UNIQUE over `dedup_key` where the row is
// `pending` or `running`. A `failed` row has dropped out of that predicate, so
// its key is free — which is the whole point of the filter — but moving it
// BACK to `pending` re-enters the index, and if some other job has taken that
// key in the meantime the write is a unique violation.
//
// This is a normal outcome, not a defect: the collision means equivalent work
// is already queued or running, which is precisely what the operator was
// trying to arrange. So a single retry answers 409 with the id of the row that
// holds the key, and a bulk retry COUNTS the collisions as `skipped` and keeps
// going. The one behaviour that would be wrong is letting a P2002 escape as a
// 500, which is what happens if nobody thinks about the index — and the reason
// the bulk sweep is a loop of single-row updates rather than one `updateMany`:
// a single violation anywhere in an `updateMany` aborts the entire statement,
// so one already-queued duplicate would block the retry of every other failed
// job in the queue.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Job, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { JOB_CLOCK, JobClock, systemJobClock } from './job-clock';
import { ACTIVE_DEDUP_INDEX_NAME } from './jobs.service';
import { JobStuckService, stuckRunningWhere } from './job-stuck.service';
import { jobTypeLabel } from './job-type-labels';
import {
  JobListQuery,
  PROCESSED_WITHIN_MS,
} from './dto/job-list-query.dto';
import { JobStatusName } from './dto/job-response.dto';
import { JobStatsResult } from './dto/job-stats.dto';
import { countOf, foldTypeCounts, sumCounts, zeroCounts } from './job-counts.util';

/** How long a stats roll-up may be reused. See the file header for the sizing. */
export const STATS_CACHE_TTL_MS = 2_000;

/**
 * The most failed rows one `retry-failed` call will touch.
 *
 * A cap exists because the sweep is a loop of single-row updates (header), so
 * its cost is linear in the number of failed jobs — and "how many jobs failed"
 * is not a number this code gets to bound. Without a cap, one click against a
 * queue that has been failing all weekend would hold a request open for
 * minutes and time out somewhere in the middle, having done an unknown amount
 * of work.
 *
 * The response reports `remaining`, so the honest answer to a queue with more
 * failures than this is "press it again", which is safe: the sweep is
 * idempotent, and a row it already retried is no longer `failed` and is no
 * longer a candidate.
 */
export const RETRY_FAILED_BATCH_LIMIT = 500;

/** The list's page, in the flat shape every paginated list in this API uses. */
export interface JobListResult {
  items: JobListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** A row as the list publishes it: the projection below, plus `typeLabel`. */
export type JobListItem = Omit<Job, 'payload'> & { typeLabel: string };

export interface RetryFailedResult {
  retried: number;
  skipped: number;
  remaining: number;
}

export interface ResetStuckAdminResult {
  reset: number;
  failed: number;
  thresholdMinutes: number;
}

/**
 * Every `Job` column EXCEPT `payload`.
 *
 * Written out rather than expressed as an omission because Prisma's `select`
 * has no "everything but" form — and writing it out is what makes the
 * exclusion visible at the query, where a future reader adding a column will
 * see that a choice was made. The reasoning for leaving `payload` out is in
 * `dto/job-response.dto.ts`.
 */
const JOB_LIST_SELECT = {
  id: true,
  type: true,
  subjectType: true,
  subjectId: true,
  dedupKey: true,
  status: true,
  reason: true,
  priority: true,
  providerKey: true,
  modelVersion: true,
  attempts: true,
  lastError: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  scheduledFor: true,
  rateLimitedAt: true,
  rateLimitHits: true,
  claimedByNodeId: true,
  leaseExpiresAt: true,
  executor: true,
} as const satisfies Record<keyof Omit<Job, 'payload'>, true>;

/**
 * The complete reset a retry writes, as ONE object shared by the single-row
 * and bulk paths.
 *
 * Shared because "retry" must mean the same thing however it was asked for. A
 * bulk sweep that forgot to clear `leaseExpiresAt` would requeue rows that the
 * lease reaper then immediately reclaims as stuck — a loop between two
 * subsystems that only shows up under load, and only in the path that was
 * written second.
 *
 * WHY EACH FIELD IS HERE:
 *
 *   - `status: 'pending'` — the point of the operation.
 *   - `attempts: 0` — a human asked for a fresh start, and the row's whole
 *     history of attempts is what they are overriding. This is the ONE place
 *     in the queue that resets the counter: `JobStuckService` explicitly does
 *     not (its give-up phase depends on the count surviving), and the rate-
 *     limit deferral un-charges exactly one attempt rather than clearing them.
 *     Leaving it would mean a job at its budget goes straight back to `failed`
 *     on its next claim, so the button would appear to do nothing.
 *   - `lastError: null` — it describes a run that is being discarded. Kept, it
 *     would sit on a `pending` row and read as a fresh failure.
 *   - `startedAt`, `finishedAt` — the previous run's stamps.
 *   - `scheduledFor: null` — eligible NOW. A retry is an operator overriding
 *     the backoff they can see on the screen; honouring it would make the
 *     button do nothing visible for up to the remaining delay.
 *   - `rateLimitHits: 0`, `rateLimitedAt: null` — the second budget
 *     (`JOBS_RATELIMIT_MAX_ATTEMPTS`), reset for the same reason as the first.
 *   - `claimedByNodeId`, `leaseExpiresAt`, `executor` — every ownership
 *     assertion released, so ANY worker may take the row. `executor` is
 *     cleared here exactly as `resetStuck`'s requeue phase clears it and
 *     unlike the terminal path, which keeps it as history: this row is going
 *     to run again, possibly on the other side, and a stale `executor` on a
 *     pending row is a lie rather than a record.
 *
 * `dedupKey` is deliberately NOT cleared — see the file header. Clearing it
 * would make every retry succeed by removing the row from the active-dedup
 * index, at the cost of silently allowing a duplicate of work that is already
 * running.
 *
 * WHY THE *Unchecked* INPUT TYPE. `claimedByNodeId` became a real relation
 * (`Job.claimedByNode`) in #267, and Prisma's *Checked* input types
 * (`JobUpdateManyMutationInput`) deliberately hide the raw foreign-key scalar
 * behind a relation operation (`claimedByNode: { disconnect: true }`) — they
 * exist to stop a caller writing an FK that points at nothing. This object
 * writes the SCALAR directly and on purpose: it is a bulk `updateMany` reset
 * that clears the column to `null`, which is exactly the "set the foreign key
 * myself" case the Unchecked variants exist for, and `updateMany` cannot
 * express nested relation operations at all. Narrowing this back to the
 * Checked type does not make anything safer here; it makes this reset
 * unexpressible.
 */
const RETRY_RESET = {
  status: 'pending',
  attempts: 0,
  lastError: null,
  startedAt: null,
  finishedAt: null,
  scheduledFor: null,
  rateLimitHits: 0,
  rateLimitedAt: null,
  claimedByNodeId: null,
  leaseExpiresAt: null,
  executor: null,
} as const satisfies Prisma.JobUncheckedUpdateManyInput;

@Injectable()
export class JobAdminService {
  private readonly logger = new Logger(JobAdminService.name);

  /** The last roll-up and the millisecond it was taken. `null` until the first. */
  private statsCache: { at: number; value: JobStatsResult } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stuck: JobStuckService,
    @Optional() @Inject(JOB_CLOCK) private readonly clock: JobClock = systemJobClock
  ) {}

  // =========================================================================
  // Read
  // =========================================================================

  /**
   * The queue summary, from cache when it is younger than
   * {@link STATS_CACHE_TTL_MS}.
   *
   * FOUR QUERIES, and the shape of each is chosen for the index it can use:
   *
   *   1. `groupBy(['status'])` and
   *   2. `groupBy(['type', 'status'])` are both UNCONDITIONAL — no `where` at
   *      all — so Postgres can answer them with an index-only scan of
   *      `jobs(status, type, id)`, the covering index added for exactly this
   *      pair in `schema.prisma`. Adding a filter to either (a date window,
   *      say) would push them onto the heap and turn the cheapest part of this
   *      response into the most expensive.
   *   3. the `scheduled` count uses `jobs(status, scheduled_for, priority,
   *      created_at)` — the same index the claim query walks.
   *   4. the `stuckRunning` count uses `jobs(status, lease_expires_at)` for the
   *      lease signals — which since #347 are three of the predicate's four
   *      clauses, so this count leans on that index harder than it used to.
   *
   * `total` is SUMMED FROM (1) rather than asked for as a fifth `count()`:
   * a separate count would be taken at a different instant from the breakdown
   * it heads, so on a busy queue the tile would not equal the sum of the tiles
   * beneath it — the one arithmetic error a person reading a dashboard always
   * notices and never forgives.
   */
  async stats(): Promise<JobStatsResult> {
    const now = this.clock.now();
    const cached = this.statsCache;

    if (cached && now - cached.at < STATS_CACHE_TTL_MS) {
      return cached.value;
    }

    const thresholdMinutes = await this.stuck.getStuckThresholdMinutes();
    const takenAt = new Date(this.clock.now());
    const threshold = new Date(takenAt.getTime() - thresholdMinutes * 60_000);

    const [byStatusRows, byTypeRows, scheduled, stuckRunning] = await Promise.all([
      this.prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.job.groupBy({ by: ['type', 'status'], _count: { _all: true } }),
      this.prisma.job.count({
        where: { status: 'pending', scheduledFor: { gt: takenAt } },
      }),
      // The reaper's own predicate, called and not copied. See the header.
      //
      // ⚠ THE LEASE HORIZON COMES FROM `JobStuckService` TOO (#347), not from
      // a second derivation here. The predicate now needs three instants, and
      // the third one depends on the registered handlers and the configured
      // timeout — so a copy of that arithmetic living in this file would let
      // the dashboard's `stuckRunning` tile disagree with the sweep that runs
      // ten minutes later, which is the one number on the page whose whole
      // value is that it predicts what the reaper is about to do.
      this.prisma.job.count({
        where: stuckRunningWhere(threshold, takenAt, this.stuck.leaseHorizon(takenAt)),
      }),
    ]);

    const byStatus = zeroCounts();
    let total = 0;

    for (const row of byStatusRows) {
      const count = countOf(row);
      byStatus[row.status as JobStatusName] = count;
      total += count;
    }

    const byType = [...foldTypeCounts(byTypeRows).entries()]
      .map(([type, counts]) => ({
        type,
        label: jobTypeLabel(type),
        total: sumCounts(counts),
        byStatus: counts,
      }))
      // Busiest first, then alphabetical. The tie-break is what keeps two
      // polls that see identical counts from rendering the rows in a
      // different order — `Map` iteration order follows whatever the database
      // returned, which is not stable.
      .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));

    const value: JobStatsResult = {
      total,
      byStatus,
      byType,
      scheduled,
      stuckRunning,
      stuckThresholdMinutes: thresholdMinutes,
      generatedAt: takenAt,
    };

    this.statsCache = { at: this.clock.now(), value };

    return value;
  }

  /**
   * One page of rows, newest first.
   *
   * `orderBy: { createdAt: 'desc' }` is served by the dedicated
   * `jobs(created_at DESC)` index, and it is the only ordering offered: the
   * question this table answers is "what has been happening", and a sortable
   * column set would need an index per column to stay usable at the sizes a
   * queue reaches.
   */
  async list(query: JobListQuery): Promise<JobListResult> {
    const { page, pageSize } = query;
    const where = this.buildListWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        select: JOB_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.job.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({ ...row, typeLabel: jobTypeLabel(row.type) })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Translates the query parameters into one `where`.
   *
   * Extracted from `list` so that the precedence rule below is stated once and
   * can be asserted directly by a test, rather than only through a query the
   * test has to reconstruct.
   */
  private buildListWhere(query: JobListQuery): Prisma.JobWhereInput {
    const where: Prisma.JobWhereInput = {};

    if (query.type) where.type = query.type;
    if (query.subjectType) where.subjectType = query.subjectType;
    if (query.subjectId) where.subjectId = query.subjectId;

    if (query.scheduled === true) {
      // `scheduled=true` OVERRIDES `status`, it does not intersect with it —
      // see `dto/job-list-query.dto.ts` for why answering a contradiction
      // with an empty page is the worse behaviour. A row in backoff is
      // `pending` by definition, so no other status can be meant.
      where.status = 'pending';
      where.scheduledFor = { gt: new Date(this.clock.now()) };
    } else if (query.status) {
      where.status = query.status;
    }

    if (query.processedWithin !== 'all') {
      const since = new Date(this.clock.now() - PROCESSED_WITHIN_MS[query.processedWithin]);

      // `COALESCE(finished_at, created_at) >= since`, as the two disjoint
      // cases Prisma can express. The second pins `finishedAt: null`, so the
      // arms cannot both match one row and `count` is not inflated.
      where.OR = [{ finishedAt: { gte: since } }, { finishedAt: null, createdAt: { gte: since } }];
    }

    return where;
  }

  // =========================================================================
  // Repair
  // =========================================================================

  /**
   * Puts every failed job (optionally of one type) back to `pending`.
   *
   * A LOOP OF SINGLE-ROW UPDATES, not one `updateMany`, and the header says
   * why: a dedup collision anywhere in a bulk statement aborts all of it, so a
   * single duplicate would block the retry of every other failed row. Here a
   * collision is one `skipped`, counted and stepped over.
   *
   * Each update re-asserts `status: 'failed'` alongside the id rather than
   * updating by id alone. Between the `findMany` that produced the candidate
   * list and the write, another admin's click or a concurrent enqueue may
   * already have moved the row; re-asserting makes that a no-op instead of
   * resetting `attempts` on a job that is now happily running — the same
   * defensive shape `JobStuckService`'s give-up phase uses.
   *
   * Idempotent: nothing is `failed` after a successful sweep, so an immediate
   * second call finds no candidates and reports zeroes.
   */
  async retryFailed(type?: string): Promise<RetryFailedResult> {
    const scope: Prisma.JobWhereInput = { status: 'failed', ...(type ? { type } : {}) };

    const candidates = await this.prisma.job.findMany({
      where: scope,
      select: { id: true },
      // Newest first: if the batch cap truncates the sweep, the rows an
      // operator is most likely to be looking at are the ones that got done.
      orderBy: { createdAt: 'desc' },
      take: RETRY_FAILED_BATCH_LIMIT,
    });

    let retried = 0;
    let skipped = 0;

    for (const { id } of candidates) {
      try {
        const result = await this.prisma.job.updateMany({
          where: { id, status: 'failed' },
          data: RETRY_RESET,
        });

        retried += result.count;
      } catch (error) {
        if (!isActiveDedupConflict(error)) throw error;

        // Equivalent work is already queued or running. That is the state the
        // retry was trying to reach, so it is a skip and not a failure.
        skipped += 1;
      }
    }

    const remaining = await this.prisma.job.count({ where: scope });

    if (retried > 0 || skipped > 0) {
      this.logger.log(
        `Retry-failed sweep${type ? ` (type ${type})` : ''}: ${retried} job(s) requeued, ` +
          `${skipped} skipped as already active, ${remaining} still failed`
      );
    }

    return { retried, skipped, remaining };
  }

  /**
   * Reclaims abandoned `running` jobs, by DELEGATING to
   * `JobStuckService.resetStuck` — the same two-phase sweep the lease reaper's
   * cron runs, reached through the same method.
   *
   * The threshold is resolved HERE, once, so that the response can report the
   * number that was actually applied. Resolving it means calling
   * `getStuckThresholdMinutes()` when the body omitted `olderThanMinutes` —
   * the single read path for that setting — and then handing the resolved
   * value down. That is not a second default: the value still comes from
   * settings, it is just observed on the way past. Letting `resetStuck` read it
   * again instead would leave this method with no honest number to publish, and
   * a re-read could in principle return a different one.
   */
  async resetStuck(olderThanMinutes?: number): Promise<ResetStuckAdminResult> {
    const thresholdMinutes =
      typeof olderThanMinutes === 'number'
        ? olderThanMinutes
        : await this.stuck.getStuckThresholdMinutes();

    const { reset, failed } = await this.stuck.resetStuck(thresholdMinutes);

    return { reset, failed, thresholdMinutes };
  }

  /**
   * Retries ONE job.
   *
   * 404 when there is no such row, 400 when it is `running`. The running case
   * is a refusal rather than a force-reset because there may be an executor
   * alive on the other end of that claim: resetting the row would give a
   * second worker the same job while the first is still working on it, and the
   * dedup index cannot stop that — the row's key moves with the row. An
   * operator who believes the executor is gone has a correct tool for exactly
   * that, `reset-stuck`, which checks the lease before it acts.
   *
   * The guard is a re-read followed by a conditional write rather than a
   * check-then-update by id, so a job that starts running in between is
   * refused by the WRITE (count 0) instead of being reset under a live
   * executor. Both paths answer 400, so the race is invisible to the caller.
   */
  async retry(id: string): Promise<JobListItem> {
    const existing = await this.prisma.job.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!existing) throw jobNotFound(id);
    if (existing.status === 'running') throw jobIsRunning(id, 'retried');

    let updated: Prisma.BatchPayload;

    try {
      updated = await this.prisma.job.updateMany({
        where: { id, status: { not: 'running' } },
        data: RETRY_RESET,
      });
    } catch (error) {
      if (!isActiveDedupConflict(error)) throw error;

      throw new ConflictException({
        message:
          'This job cannot be retried: another job with the same deduplication key is ' +
          'already pending or running, so the work it describes is already queued.',
        details: { jobId: id, reason: 'active_dedup_conflict' },
      });
    }

    // Zero rows means the status changed under us — it can only have become
    // `running`, because nothing else is excluded by the `where`.
    if (updated.count === 0) throw jobIsRunning(id, 'retried');

    const row = await this.prisma.job.findUnique({ where: { id }, select: JOB_LIST_SELECT });

    // Deleted between the write and the read. Vanishingly unlikely and still
    // not a 500: the caller's row is gone, which is a 404.
    if (!row) throw jobNotFound(id);

    return { ...row, typeLabel: jobTypeLabel(row.type) };
  }

  /**
   * Deletes ONE job.
   *
   * The same 404/400 pair as {@link retry}, and the running refusal matters
   * more here: deleting a claimed row does not stop the executor that holds it.
   * The work carries on, and its terminal write then updates zero rows and is
   * swallowed by `safeTerminalUpdate` — so the job runs to completion with no
   * record that it ever existed, and its dedup key is freed while it is still
   * running, letting a duplicate be enqueued underneath it.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.job.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!existing) throw jobNotFound(id);
    if (existing.status === 'running') throw jobIsRunning(id, 'deleted');

    const deleted = await this.prisma.job.deleteMany({
      where: { id, status: { not: 'running' } },
    });

    if (deleted.count === 0) throw jobIsRunning(id, 'deleted');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether `error` is a unique violation on the active-dedup index specifically.
 *
 * Attributed to THAT index by name rather than treating every P2002 on `jobs`
 * as a dedup collision, for the reason `jobs.service.ts` gives when it does the
 * same: a fork may add unique constraints of its own, and swallowing their
 * violations as "already queued" would report success for a write that did not
 * happen.
 *
 * The `target` Prisma reports is the index name for a named index but can also
 * be the column list, so both are accepted. A P2002 that matches neither is
 * re-thrown.
 */
function isActiveDedupConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const parts = Array.isArray(target) ? target.map(String) : [String(target ?? '')];

  return parts.some((part) => part === ACTIVE_DEDUP_INDEX_NAME || part === 'dedup_key');
}

function jobNotFound(id: string): NotFoundException {
  return new NotFoundException({
    message: `Job ${id} was not found.`,
    details: { jobId: id },
  });
}

/**
 * The 400 both repair routes answer for a `running` job.
 *
 * The machine-readable half goes in `details` and nowhere else:
 * `common/filters/http-exception.filter.ts` rebuilds every error body from a
 * fixed allowlist of keys (`code`, `message`, `details`) and DERIVES `code`
 * from the status, discarding any that an exception supplied. A field added at
 * the top level of this payload would simply not reach the client.
 */
function jobIsRunning(id: string, action: 'retried' | 'deleted'): BadRequestException {
  return new BadRequestException({
    message:
      `Job ${id} is currently running and cannot be ${action}. An executor may still be ` +
      `working on it. If you believe its executor is gone, use reset-stuck, which checks ` +
      `the job's lease before reclaiming it.`,
    details: { jobId: id, status: 'running', reason: 'job_running' },
  });
}
