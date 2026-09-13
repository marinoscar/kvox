// =============================================================================
// The lease reaper's primitives (issue #263, epic #254; #347)
// =============================================================================
//
// A job whose executor died is `running` forever. Nothing else in the queue
// can notice: the worker that held it is gone, so there is nobody left to
// write the terminal row, and the slot it occupied is only freed inside a
// process that no longer exists. The row itself looks exactly like a job that
// is going perfectly well — same status, same claim, same `attempts` — and
// the ONLY thing that distinguishes the two is time.
//
// This file is what turns "time" into a decision, and it is deliberately
// several separate pieces rather than one method:
//
//   - `getStuckThresholdMinutes()` — how long is too long, from settings.
//   - `leaseHorizon()`             — how far out a lease may plausibly point.
//   - `stuckRunningWhere()`        — which rows are stuck, as a `where`.
//   - `resetStuck()`               — what to do about them.
//
// ⚠ SINCE #347, "TIME" IS NOT THE ONLY THING THAT DISTINGUISHES THE TWO, and
// that is the point of that issue. A live executor now RENEWS its lease on a
// schedule — the in-process worker through `JobLeaseService`, a node through
// `POST …/renew` — so a healthy long-running job is distinguished from a dead
// one by evidence it produces while it works, not merely by how long it has
// been at it. The signals below were re-cut around that: age is now only
// consulted for rows that carry NO lease at all.
//
// -----------------------------------------------------------------------------
// WHY THESE LIVE HERE AND NOT IN AN ADMIN SERVICE
// -----------------------------------------------------------------------------
//
// The obvious home for "reset the stuck jobs" is the admin jobs service — a
// human clicking a button in a dashboard is the caller you think of first,
// and the endpoint has to exist anyway. Putting them there would be wrong,
// and the reason is a deployment rather than a taste:
//
//     JOBS_WORKER_MODE=off + an external node fleet
//
// That is an API server acting as a PURE CONTROL PLANE. It claims nothing and
// runs nothing; every job executes on a machine it does not own. It is also
// the deployment where dead leases are most likely by a wide margin — a
// laptop closing its lid, a spot instance reclaimed, a node process killed by
// its own OOM killer are all NORMAL events in a fleet, not edge cases. If the
// reaper could only reach these primitives through the admin service, then
// reaping would be coupled to the admin surface being mounted and reachable,
// and the one deployment that needs it most would be the one least likely to
// have it.
//
// So the dependency points the other way round, permanently: the reaper task
// and (later) the admin endpoint both depend on THIS service, and this
// service depends on nothing but Prisma, config and settings. Reaping is a
// CONTROL-PLANE DUTY, not a worker duty — which is also why the task that
// drives it honours `JOBS_REAPER_ENABLED` and never looks at
// `JOBS_WORKER_MODE`.
//
// -----------------------------------------------------------------------------
// THE GIVE-UP PHASE ONLY WORKS BECAUSE `attempts` IS CHARGED AT CLAIM TIME
// -----------------------------------------------------------------------------
//
// `resetStuck` has two phases, and the second one (fail the rows that have
// spent their budget) is the whole reason a poison pill is bounded rather
// than eternal. A job that reliably kills its executor — an OOM, a segfault
// in a native dependency, a `process.exit()` in a library — never reaches
// `JobTerminalService` at all, so nothing on the terminal path can ever count
// it. If the reaper simply requeued it, the sequence would be:
//
//     claim → executor dies → reaped → claim → executor dies → …
//
// forever, at one crash per stuck threshold, with the container restarting
// under it each time. The ONLY reason this loop terminates is that
// `job-claim.service.ts` increments `attempts` in the claiming UPDATE itself
// (§4.5 of docs/specs/job-queue.md: `attempts` means "attempts STARTED", not
// "attempts that reported back"). The count therefore survives the death of
// the process that was running the job, and after `JOBS_MAX_ATTEMPTS` deaths
// the reaper can say "this has had its budget" with evidence.
//
// Charge `attempts` on failure instead and this phase becomes unimplementable
// — there is nothing to compare against — which is why that decision and this
// one are the same decision seen from two ends.
//
// -----------------------------------------------------------------------------
// ⚠ THE BUDGET IT COMPARES AGAINST IS PER TYPE (#346)
// -----------------------------------------------------------------------------
//
// A job type may declare its own `maxAttempts` (`JobExecutionProfile`), and
// `maxAttempts: 1` means "never automatically retried". `JobTerminalService`
// honours that for a job that reported back — but this file is the path for
// the job that DIDN'T, and the two must reach the same conclusion or the
// profile is worth nothing: a one-attempt job whose executor died would be
// found here, judged against the deployment-wide default, and requeued,
// running a second time for work whose author said it must not. Both paths
// therefore read the budget through the SAME `resolveMaxAttempts`, and both
// phases below group by it. See `attemptBudgets`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { resolveLeaseHorizonMs, resolveMaxAttempts } from './job-execution-profile';
import { JobHandlerRegistry } from './job-handler.registry';

/** What `resetStuck` did, split by which phase claimed each row. */
export interface ResetStuckResult {
  /** Rows put back to `pending` for another executor to claim. */
  reset: number;

  /** Rows that had spent their attempt budget and were marked `failed`. */
  failed: number;
}

/**
 * The `where` that identifies an abandoned `running` job, as FOUR OR'd
 * recovery signals.
 *
 * All four are real, and each one is the only signal that catches its own
 * failure mode. Dropping any of them leaves a class of dead row unreapable:
 *
 *   1. `leaseExpiresAt IS NULL AND startedAt < threshold` — THE AGED,
 *      UNLEASED CLAIM. A row that was properly stamped when it was claimed,
 *      has been running longer than any job of any type should, and carries
 *      NO LEASE AT ALL: a fork's own claim path, a row hand-inserted by an
 *      operator, a migration that pre-dates leases. Nothing about such a row
 *      says when its owner promised to be back, so age is the only evidence
 *      there is.
 *
 *   2. `leaseExpiresAt IS NULL AND startedAt IS NULL AND createdAt < threshold`
 *      — THE ZOMBIE. A row that is `running` and has no start time at all. It
 *      looks impossible, because the claim writes `started_at = now()` in the
 *      same statement that writes `status = 'running'` — and it is exactly the
 *      state a partially-applied write, a restored backup, or an external
 *      control plane setting the status without the timestamp leaves behind.
 *      Signal 1 cannot see it (`NULL < threshold` is NULL, never true) and
 *      neither can signal 3, since the lease was never written either, so
 *      without this clause such a row is stuck FOREVER and its dedup key is
 *      held forever with it. `createdAt` is the substitute age, and it is
 *      always present.
 *
 *   3. `leaseExpiresAt < now` — THE DEAD OWNER. The fastest and most precise
 *      signal, and the only one that does not have to wait out the stuck
 *      threshold: whoever claimed this row promised to renew or settle it
 *      before this instant, and did not. It covers a server replica killed
 *      mid-job and a remote node that went away — the lid-closing laptop —
 *      identically, because the lease says nothing about WHERE the executor
 *      was.
 *
 *   4. `leaseExpiresAt > leaseHorizon` — THE IMPLAUSIBLE LEASE. A lease
 *      pointing further into the future than the longest lease any registered
 *      handler could legitimately ask for. See `resolveLeaseHorizonMs` for how
 *      that ceiling is computed, and the section below for why this clause is
 *      not optional.
 *
 * -----------------------------------------------------------------------------
 * ⚠ WHY SIGNALS 1 AND 2 ARE RESTRICTED TO `leaseExpiresAt IS NULL` (#347)
 * -----------------------------------------------------------------------------
 *
 * They were not, and that was the defect. Signal 1 used to be a bare
 * `startedAt < threshold`, and its own docstring gave it TWO jobs: catching a
 * job that had been running too long, and catching a row whose
 * `lease_expires_at` was never written. Only the second is load-bearing; the
 * first is precisely what made a long job unsafe.
 *
 * The reason is that "running too long" was a proxy for "its executor died",
 * and it was a proxy chosen when NOTHING RENEWED A LEASE — the in-process
 * worker wrote one at claim time and never touched the row again (#347 gives
 * it `JobLeaseService` and a ticker). With renewal in place the proxy is not
 * merely redundant, it is WRONG: a job that renewed one second ago was still
 * requeued the moment it passed `jobs.stuckThresholdMinutes`, a second
 * executor claimed it, and the same work ran twice — concurrently, on exactly
 * the long-running job whose author had said it takes a long time. For a
 * database backup that is two `pg_dump`s streaming into one storage key, both
 * exiting 0, and an unrestorable archive with no error anywhere.
 *
 * Restricting these two clauses to `leaseExpiresAt IS NULL` keeps the job that
 * was load-bearing (a row nobody ever leased is still reaped on age) and drops
 * only the one that was a proxy for a signal the queue now measures directly.
 * A leased row is judged by its lease, by clause 3 or clause 4 — never by its
 * age.
 *
 * -----------------------------------------------------------------------------
 * ⚠ CLAUSE 4 IS WHAT REPLACES THE PROTECTION THAT WAS DROPPED
 * -----------------------------------------------------------------------------
 *
 * Narrowing 1 and 2 alone would leave a real gap. Before, a corrupt or
 * malicious `lease_expires_at` — a clock jump on the writer, a fork's claim
 * path multiplying instead of adding, a hostile write — was caught anyway,
 * because the bare age clause did not care about the lease. Afterwards it
 * would match NOTHING: clause 3 wants an expired lease and it has a lease
 * expiring in the year 2400, and clauses 1 and 2 now want no lease at all. The
 * row would sit `running` forever, holding its dedup key with it, which is the
 * failure the zombie clause exists to prevent arriving through a different
 * door.
 *
 * `leaseHorizon` closes it, and the trade-off it carries — a deployment that
 * removes a handler shortens the ceiling and may reap that type's in-flight
 * rows on the next sweep, which is correct, since no process there can run
 * them anyway — is argued in full at `resolveLeaseHorizonMs`.
 *
 * -----------------------------------------------------------------------------
 *
 * ⚠ THE COMPARISONS USE THREE DIFFERENT INSTANTS ON PURPOSE. Signals 1 and 2
 * are "older than the threshold"; signal 3 is "past its deadline, now"; signal
 * 4 is "further out than anything could legitimately be". A single instant for
 * all of them would either reap live jobs (using `now` for the age) or leave an
 * expired lease sitting for another whole threshold (using `threshold` for the
 * deadline). All three are passed in rather than read from the clock inside, so
 * every row in one sweep is judged against the same set of instants and a test
 * can pin them.
 *
 * Exported as a pure function, not a private method, for the reason the file
 * header gives: the admin surface, the reaper and any later node-plane
 * sweeper must ask the same question, and the only way to guarantee that is
 * for there to be one copy of it.
 */
export function stuckRunningWhere(
  threshold: Date,
  now: Date,
  leaseHorizon: Date
): Prisma.JobWhereInput {
  return {
    status: 'running',
    OR: [
      // 1. Aged and UNLEASED: claimed and stamped by something that never
      //    wrote a lease, running too long. A leased row is judged by 3 or 4.
      { leaseExpiresAt: null, startedAt: { lt: threshold } },
      // 2. Zombie: claimed, never stamped, never leased — aged by `createdAt`.
      { leaseExpiresAt: null, startedAt: null, createdAt: { lt: threshold } },
      // 3. Dead owner: the lease its claimer took has run out (server OR node).
      { leaseExpiresAt: { lt: now } },
      // 4. Implausible lease: further out than any handler could have asked for.
      { leaseExpiresAt: { gt: leaseHorizon } },
    ],
  };
}

@Injectable()
export class JobStuckService {
  private readonly logger = new Logger(JobStuckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemSettings: SystemSettingsService,
    // Injected for ONE question, the same one `JobTerminalService` injects it
    // for: what is this job type's attempt budget (#346). See
    // `attemptBudgets` below for why the reaper cannot be allowed to answer it
    // with the deployment-wide number.
    private readonly registry: JobHandlerRegistry
  ) {}

  /**
   * How long a `running` job may go without progress before it is treated as
   * abandoned, from the `jobs.stuckThresholdMinutes` system setting.
   *
   * READ THROUGH THE NARROW SETTINGS ACCESSOR (`getJobsPolicy`), not with a
   * `system_settings` query of its own: the accessor projects one column, does
   * not create the row, and is the single read path for this value — see its
   * doc comment. A second read path here is how "the reaper uses a different
   * threshold than the dashboard shows" starts.
   *
   * NEVER THROWS. This is called from a cron tick with no caller to report to,
   * and a settings read that failed is not a reason to stop reaping — it is a
   * reason to reap on the shipped default, loudly. The fallback is
   * `DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes` rather than a literal,
   * so there is still exactly one place the number lives.
   */
  async getStuckThresholdMinutes(): Promise<number> {
    try {
      const policy = await this.systemSettings.getJobsPolicy();
      const minutes = policy.stuckThresholdMinutes;

      if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
        return minutes;
      }
    } catch (error) {
      this.logger.warn(
        `Could not read jobs.stuckThresholdMinutes; falling back to ` +
          `${DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes} minutes: ${describe(error)}`
      );
    }

    return DEFAULT_SYSTEM_SETTINGS.jobs.stuckThresholdMinutes;
  }

  /**
   * The instant past which a `lease_expires_at` cannot be a live executor's
   * promise — `now` plus the longest lease any registered handler could ask
   * for, plus one grace.
   *
   * PUBLIC, AND THAT IS WHY IT IS A METHOD RATHER THAN A LOCAL IN `resetStuck`.
   * `stuckRunningWhere` needs three instants, and the admin surface
   * (`JobAdminService.stats`, which counts `stuckRunning` with this same
   * predicate) has to produce the same third one or the dashboard would report
   * a different number from the sweep that runs ten minutes later. That service
   * injects neither `ConfigService` nor `JobHandlerRegistry` — it holds this
   * one, which already holds both — so exposing the answer here is what keeps
   * "the reaper and the dashboard ask the same question" true without giving
   * the admin service two dependencies it has no other use for.
   *
   * COMPUTED PER SWEEP, NEVER CACHED. It depends on which handlers are
   * registered and on `JOBS_JOB_TIMEOUT_MS`, and both are re-read rather than
   * captured everywhere else in this queue for the same reason: a value baked
   * in at bootstrap is a value that quietly disagrees with the process it is
   * meant to describe. It is two in-memory reads and a `Math.max` over single
   * digits of registered types — nothing next to the query it precedes.
   *
   * @param now the sweep's single instant — passed in rather than read here,
   * so every clause of one sweep is judged against the same clock reading.
   */
  leaseHorizon(now: Date): Date {
    return new Date(now.getTime() + resolveLeaseHorizonMs(this.config, this.registry));
  }

  /**
   * Reclaims every abandoned `running` job, in TWO PHASES.
   *
   * PHASE 1 — GIVE UP. Rows at or over THEIR OWN TYPE'S attempt budget are
   * marked `failed`. These have already been started that many times and have
   * killed their executor every time; another requeue buys nothing but another
   * crash. See the file header for why this phase is only implementable at
   * all, and `attemptBudgets` for why the budget is per type.
   *
   * Done ONE ROW AT A TIME, deliberately, and not as a single `updateMany`.
   * The message written to `lastError` names THAT job's own attempt count
   * ("after 3 attempt(s)"), which is the number a human needs to tell an
   * unlucky job from a poison pill, and a bulk update can only write one
   * string for every row it touches. The phase is bounded by how many jobs
   * exhausted their budget while nobody was watching — a handful, in any
   * healthy deployment — so N small updates is the right trade for a message
   * that is actually true.
   *
   * PHASE 2 — REQUEUE. Rows still under budget go back to `pending` with the
   * claim, the lease and the executor released, so any worker (this server,
   * another replica, a node) may take them. ONE `updateMany` PER DISTINCT
   * BUDGET — one in total for a deployment where no handler declares a
   * profile, which is the shape this phase has always had — because every row
   * in a group gets the same treatment and the same message, and only the
   * number they are compared against differs.
   *
   * `attempts` IS NOT TOUCHED BY EITHER PHASE. It was charged at claim time
   * and the attempt genuinely happened — the executor started the work and
   * died doing it. Un-charging it here (as the rate-limit deferral in
   * `JobTerminalService` deliberately does) would erase the only evidence a
   * poison pill leaves behind and make phase 1 unreachable.
   *
   * @param olderThanMinutes override for the configured threshold — what an
   * operator passes from an admin "reset jobs stuck for more than N minutes"
   * control. Omitted, the system setting decides.
   */
  async resetStuck(olderThanMinutes?: number): Promise<ResetStuckResult> {
    const minutes =
      typeof olderThanMinutes === 'number' && Number.isFinite(olderThanMinutes)
        ? Math.max(0, olderThanMinutes)
        : await this.getStuckThresholdMinutes();

    // ONE `now` for the whole sweep. Reading the clock per phase would let a
    // row that is stuck by the lease signal fall between the two queries, and
    // makes the phases untestable without freezing timers.
    const now = new Date();
    const threshold = new Date(now.getTime() - minutes * 60_000);
    // The third instant, taken from the SAME `now` as the other two for the
    // reason stated just above: one sweep, one set of instants, so a row
    // cannot be judged live by one clause and dead by the next.
    const where = stuckRunningWhere(threshold, now, this.leaseHorizon(now));

    const budgets = this.attemptBudgets();

    // ---- Phase 1: the rows that have spent their budget -------------------
    //
    // One read, whose `where` is the UNION of "over budget" across every
    // distinct budget in play. With no profiles declared there is exactly one
    // group and this is the same single `attempts: { gte: n }` clause it has
    // always been; the OR'd form only appears once a type actually asks for a
    // different number, so nothing about the ordinary deployment's query
    // changes. `AND` rather than a second top-level `OR`, because `where`
    // already carries one (the three recovery signals) and they must both
    // hold, not either.
    const exhausted = await this.prisma.job.findMany({
      where:
        budgets.length === 1
          ? { ...where, attempts: { gte: budgets[0].maxAttempts } }
          : {
              ...where,
              AND: [
                {
                  OR: budgets.map((budget) => ({
                    ...budget.typeFilter,
                    attempts: { gte: budget.maxAttempts },
                  })),
                },
              ],
            },
      select: { id: true, type: true, attempts: true },
    });

    let failed = 0;

    for (const row of exhausted) {
      // THIS ROW'S OWN budget, for this row's own message — the phase already
      // runs one update per row so that "after N attempt(s)" is true, and the
      // cap quoted beside it has to be true in the same way.
      const maxAttempts = resolveMaxAttempts(this.config, this.registry.get(row.type));

      // The `where` is re-applied alongside the id rather than updating by id
      // alone: between the read above and this write the job may have been
      // settled by an executor that was alive after all (a long GC pause, a
      // network partition that healed). Re-asserting "still stuck" makes the
      // update a no-op in that case instead of stamping `failed` over a
      // perfectly good `succeeded`.
      const result = await this.prisma.job.updateMany({
        where: { ...where, id: row.id },
        data: {
          status: 'failed',
          finishedAt: now,
          lastError:
            `Abandoned by its executor and reclaimed by the lease reaper ` +
            `after ${row.attempts} attempt(s); the attempt budget ` +
            `(${maxAttempts}) is spent, so it will not be retried.`,
          scheduledFor: null,
          // A terminal row must not appear to be held by anybody. `executor`
          // is deliberately KEPT — which side the job died on is exactly the
          // thing you want to still know later — matching
          // `JobTerminalService.failPermanently`.
          claimedByNodeId: null,
          leaseExpiresAt: null,
        },
      });

      failed += result.count;

      if (result.count > 0) {
        this.logger.warn(
          `Job ${row.id} (${row.type}) was abandoned by its executor on all ` +
            `${row.attempts} of its attempts; failing it permanently rather than requeueing.`
        );
      }
    }

    // ---- Phase 2: the rows that still have budget -------------------------
    //
    // The same `where` and the same `now`, so a row can match exactly one
    // phase: phase 1 took `attempts >= its budget`, this takes the rest.
    //
    // ⚠ THE COMPARISON MUST BE PER TYPE, AND THIS IS THE SWEEP WHERE GETTING
    // IT WRONG UNDOES THE PROFILE ENTIRELY. A type declaring `maxAttempts: 1`
    // is saying it must never be retried automatically. The terminal path
    // honours that for a job that reported back — but the reaper's whole
    // purpose is the job that DIDN'T, and if this sweep judged it against the
    // deployment-wide 3 it would find a one-attempt job sitting at
    // `attempts: 1`, decide it still has budget, and REQUEUE it: the exact
    // automatic retry the profile forbids, resurrected on the one path nobody
    // is watching, for work whose author said it must not run twice. One
    // `updateMany` per distinct budget is what closes that.
    //
    // Bounded by the number of REGISTERED TYPES (single digits), not by the
    // size of the stuck set, because the groups come from the registry rather
    // than from the rows: a sweep that found ten thousand abandoned jobs still
    // issues one update per distinct budget.
    let reset = 0;

    for (const budget of budgets) {
      const requeued = await this.prisma.job.updateMany({
        where: { ...where, ...budget.typeFilter, attempts: { lt: budget.maxAttempts } },
        data: {
          status: 'pending',
          // Release every live ownership assertion. `executor` IS cleared here,
          // unlike on the terminal path: this row is going to be claimed again,
          // possibly by the other side entirely, and a stale "node" on a job the
          // server is about to run is a lie rather than history.
          claimedByNodeId: null,
          leaseExpiresAt: null,
          executor: null,
          // Eligible immediately — the job has already waited out the whole
          // stuck threshold, which is longer than any retry backoff would be.
          scheduledFor: null,
          finishedAt: null,
          lastError:
            'Abandoned by its executor and requeued by the lease reaper. ' +
            'Its attempt was already charged at claim time.',
          // `startedAt` is left as it was: the next claim overwrites it, and
          // until then it records when the run that died began.
        },
      });

      reset += requeued.count;
    }

    if (reset > 0 || failed > 0) {
      this.logger.log(
        `Lease reaper: ${reset} job(s) requeued, ${failed} failed ` +
          `permanently (stuck threshold ${minutes} minute(s)).`
      );
    }

    return { reset, failed };
  }

  /**
   * The distinct attempt budgets in play, each with the types it governs.
   *
   * GROUPED BY BUDGET RATHER THAN BY TYPE, which is the same answer expressed
   * in the fewest queries: types sharing a number share an `updateMany`, and
   * in the overwhelmingly common case — no handler in the process declares a
   * profile at all — there is exactly ONE group carrying no type filter
   * whatsoever, so both phases issue precisely the query they issued before
   * profiles existed. That is not an optimisation; it is the guarantee that
   * this change is invisible to a deployment that did not ask for it.
   *
   * The FIRST entry is always the fallback group, and it is expressed as
   * "every type EXCEPT the ones with a budget of their own" rather than as an
   * explicit list. A `jobs` row can legitimately name a type this process does
   * not register — a handler that was removed, a type only some deployments
   * register, a row from a fork — and such a row must still be reaped. An
   * `in` list built from `registry.types()` would silently exclude every one
   * of them, quietly making the reaper blind to exactly the rows most likely
   * to be abandoned.
   */
  private attemptBudgets(): Array<{
    typeFilter: Prisma.JobWhereInput;
    maxAttempts: number;
  }> {
    const fallback = resolveMaxAttempts(this.config, undefined);
    const overrides = new Map<number, string[]>();

    for (const type of this.registry.types()) {
      const budget = resolveMaxAttempts(this.config, this.registry.get(type));

      // A profile that happens to restate the deployment default is not an
      // override — folding it in keeps the single-group fast path intact.
      if (budget === fallback) {
        continue;
      }

      const bucket = overrides.get(budget);

      if (bucket) {
        bucket.push(type);
      } else {
        overrides.set(budget, [type]);
      }
    }

    const overridden = [...overrides.values()].flat();

    return [
      {
        typeFilter: overridden.length > 0 ? { type: { notIn: overridden } } : {},
        maxAttempts: fallback,
      },
      ...[...overrides.entries()].map(([maxAttempts, types]) => ({
        typeFilter: { type: { in: types } } as Prisma.JobWhereInput,
        maxAttempts,
      })),
    ];
  }

}

/** Whatever was thrown, rendered for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
