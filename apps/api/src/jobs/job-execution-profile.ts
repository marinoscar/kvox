// =============================================================================
// Per-type execution profiles (issue #346, epic #345)
// =============================================================================
//
// Until now every job in the queue was governed by the SAME two deployment-wide
// numbers: `JOBS_JOB_TIMEOUT_MS` (how long any one attempt may run) and
// `JOBS_MAX_ATTEMPTS` (how many attempts any job gets). That is exactly right
// for a queue whose jobs resemble each other, and exactly wrong the moment one
// does not: a six-second thumbnail and a six-hour database dump cannot share a
// timeout, and a type that must NEVER be automatically retried cannot share a
// budget with one that should be retried three times. Tuning the globals to
// suit the outlier ruins them for everything else — a ten-minute default
// stretched to six hours means a wedged thumbnail now holds its slot until
// lunchtime.
//
// A profile is that pair of numbers, declared BY THE HANDLER, for its own type.
// It is optional: a handler that declares none behaves exactly as it did
// before, on the globals, and every resolver below is written so that path is
// not merely equivalent but literally the same code it always ran.
//
// -----------------------------------------------------------------------------
// ⚠ EXACTLY TWO NUMBERS. THE LEASE AND THE RENEWAL INTERVAL ARE DERIVED.
// -----------------------------------------------------------------------------
//
// This is the decision the whole file exists to defend, so it is worth being
// blunt about what is NOT here. A profile may not declare:
//
//   - a LEASE LENGTH. The lease is how long a claimer may hold a row before
//     the reaper (#263) decides its executor died. A lease SHORTER than the
//     runtime ceiling is a job that reaps itself: it runs for its permitted
//     time, the reaper finds the lease expired, requeues the row, a second
//     executor claims it, and the same work runs twice — concurrently, on a
//     job the author explicitly told us takes a long time. `resolveJobLeaseMs`
//     derives it as `maxRuntimeMs + LEASE_GRACE_MS`, so it is longer than the
//     ceiling BY CONSTRUCTION and there is no way to write down the state
//     where it is not.
//
//   - a RENEWAL INTERVAL. A remote node extends its lease on a schedule
//     (`resolveRenewIntervalMs`). An interval at or above the lease is a
//     renewal that ALWAYS arrives after the lease it was meant to extend has
//     already expired — the node is doing the work, sending the renewals, and
//     losing the job anyway, which reads as a queue bug and is really an
//     arithmetic one. Dividing the lease by three leaves room for two missed
//     renewals before anything is lost.
//
// Both are values that can DISAGREE with `maxRuntimeMs`, and the disagreement
// is silent, remote and intermittent — the worst kind. This is the same
// argument `job-handler.interface.ts` already makes against a
// `nodeEligible: boolean` flag ("deriving eligibility from the members makes
// that wrong state unrepresentable: there is nothing to set inconsistently"),
// applied to durations rather than to capabilities. There is nothing to set
// inconsistently here because there is nothing to set.
//
// REJECTED for the same reason: a `retryBackoffMs`, a `priority`, a
// `concurrencyLimit`. Each is a real thing somebody will want, and none of
// them belongs in a struct whose promise is "these two numbers cannot
// contradict each other". Adding a third that CAN contradict them turns the
// promise into a convention, and a convention is what this file is replacing.
//
// -----------------------------------------------------------------------------
// EVERY RESOLVER IS TOTAL, BOUNDS-CHECKED, AND NEVER THROWS
// -----------------------------------------------------------------------------
//
// The same defensive posture `resolveWorkerConcurrency` and `resolveJobLeaseMs`
// already take in `job.worker.ts`, for the same two reasons: these are
// reachable from a directly-constructed test double holding a stub
// `ConfigService`, and they are reachable from a fork's handler whose profile
// is whatever that fork typed. A missing key, a `NaN`, a negative ceiling or a
// budget of zero must degrade to the SHIPPED DEFAULT — never to `NaN`, which
// downstream becomes an unwritable `lease_expires_at`, a `setTimeout(NaN)`
// that fires immediately, and an attempt comparison that is false for every
// row (silently disabling the reaper's give-up phase).
//
// An unusable profile is dropped WHOLE rather than field by field. The two
// numbers are one declaration: honouring the attempt budget an author mistyped
// while inventing a runtime ceiling they never chose is a stranger state than
// putting the type back where it was before anyone wrote a profile. It warns,
// naming the type, so the typo is fixable rather than merely survivable.
//
// -----------------------------------------------------------------------------
// THE IMPORT CYCLE WITH `job.worker.ts` IS REAL, AND INERT
// -----------------------------------------------------------------------------
//
// This module imports `resolveJobLeaseMs` from `job.worker.ts`, and that file
// imports the profile type and the readers below back. Neither module touches
// the other AT EVALUATION TIME — every use on both sides is inside a function
// body — so the cycle never observes a half-initialised module.
//
// It is deliberate rather than tolerated. The alternative is a second lease
// derivation living here, which is precisely the drift `resolveJobLeaseMs`'s
// own comment exists to forbid: one function, one number, both executors.
// =============================================================================

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import { LEASE_GRACE_MS, resolveJobLeaseMs } from './job.worker';

/**
 * What a job type declares about how it is allowed to run.
 *
 * TWO NUMBERS, AND ONLY EVER TWO — see the file header for the full argument,
 * and `JobHandler.profile` for the one-paragraph version a handler author will
 * actually read. Do not add a lease, a renewal interval, or anything else that
 * can disagree with `maxRuntimeMs`.
 */
export interface JobExecutionProfile {
  /**
   * Wall-clock ceiling for ONE attempt, in milliseconds.
   *
   * `0` means NO ceiling — the same meaning `JOBS_JOB_TIMEOUT_MS=0` already
   * has, so a profile can express "this type may run as long as it needs"
   * without the deployment having to disable timeouts for everything else.
   * The claim's lease is derived from this number, never declared beside it.
   */
  readonly maxRuntimeMs: number;

  /**
   * Attempt budget for this type, counted the way `attempts` is counted:
   * CHARGED AT CLAIM TIME (see `job-claim.service.ts`), so it means "attempts
   * started", not "failures reported".
   *
   * `1` therefore means NEVER AUTOMATICALLY RETRIED — one claim, and whatever
   * happens next is terminal. That is the reason this number is per-type at
   * all: a job that mutates something irreversible must not be handed a second
   * attempt by a deployment-wide default that knows nothing about it.
   */
  readonly maxAttempts: number;
}

/**
 * Shipped default attempt budget, repeated from `config/configuration.ts` for
 * the reason every `configNumber` fallback in this module repeats one: a stub
 * `ConfigService` must degrade to the shipped behaviour, not to `NaN`.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The renewal interval is the lease divided by this, then clamped.
 *
 * THREE, so a node may miss TWO consecutive renewals — a GC pause, a dropped
 * request, a control-plane restart — and still hold its job. Two would leave
 * no margin at all; ten would spend nine times the requests to buy margin
 * nobody needs.
 */
const RENEW_INTERVAL_DIVISOR = 3;

/**
 * Floor and ceiling for the derived renewal interval.
 *
 * The floor stops a short-lease type from turning a fleet into a renewal
 * storm; the ceiling stops a very long lease (a six-hour dump) from producing
 * an interval so long that a node which died in minute two keeps its job for
 * an hour. Neither bound is configurable, because a bound that can be set
 * wrong is the thing this file exists to remove.
 */
const MIN_RENEW_INTERVAL_MS = 5_000;
const MAX_RENEW_INTERVAL_MS = 60_000;

const logger = new Logger('JobExecutionProfile');

/**
 * Types already warned about, so a bad profile costs ONE log line rather than
 * one per claim.
 *
 * MODULE-LEVEL FOR THE SAME REASON `unknownModeWarned` IS in `job.worker.ts`:
 * these readers run on every claim and every settle, so an unlatched warning
 * would be several lines a second, forever, burying the one line an operator
 * needs to see.
 */
const warnedProfiles = new Set<string>();

/**
 * Clears the warn-once latch above.
 *
 * FOR TESTS ONLY, exactly as `resetUnknownWorkerModeWarning` is: a latch that
 * survived between cases would make "warns exactly once" pass for the first
 * case and vacuously for every case after it. Nothing in the application calls
 * this.
 */
export function resetJobProfileWarnings(): void {
  warnedProfiles.clear();
}

/**
 * A numeric setting with a defensive fallback — the same shape, and for the
 * same reason, as `JobWorker.configNumber` and `JobTerminalService.configNumber`.
 */
function configNumber(config: ConfigService, key: string, fallback: number): number {
  const value = config.get<number>(key);

  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A finite number at or above `min` — the only shape either field may take. */
function usable(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/**
 * The profile `handler` declares, or `undefined` when it declares none — or
 * declares one this process refuses to act on.
 *
 * THE SINGLE VALIDATION POINT. Every consumer of a profile goes through here,
 * so "is this profile usable" is answered once and identically for the lease,
 * the timeout and the attempt budget; three separate opinions about a
 * half-valid profile is how a type ends up with a lease derived from a ceiling
 * nothing else honours.
 *
 * `maxRuntimeMs` must be finite and non-negative (`0` is the legitimate "no
 * ceiling" value, so the floor is zero, not one); `maxAttempts` must be finite
 * and at least `1`, because a budget of zero describes a job that may never be
 * claimed — which is not a retry policy, it is a way to delete work silently.
 *
 * Returns `undefined` rather than throwing, for the reason
 * `JobHandlerRegistry.get` returns `undefined`: the caller is on a claim path
 * with a job to run, and a fork's typo in a profile must degrade that job to
 * the deployment defaults, not take the worker down.
 */
export function resolveJobProfile(handler: JobHandler | undefined): JobExecutionProfile | undefined {
  const profile = handler?.profile;

  if (!profile) {
    return undefined;
  }

  if (usable(profile.maxRuntimeMs, 0) && usable(profile.maxAttempts, 1)) {
    return profile;
  }

  if (!warnedProfiles.has(handler.type)) {
    warnedProfiles.add(handler.type);
    logger.warn(
      `Job type "${handler.type}" declares an unusable execution profile ` +
        `(maxRuntimeMs=${String(profile.maxRuntimeMs)}, ` +
        `maxAttempts=${String(profile.maxAttempts)}); ignoring it and falling back to the ` +
        'deployment-wide JOBS_JOB_TIMEOUT_MS and JOBS_MAX_ATTEMPTS. maxRuntimeMs must be a ' +
        'finite number >= 0 (0 means no ceiling) and maxAttempts a finite number >= 1.'
    );
  }

  return undefined;
}

/**
 * The attempt budget for whatever type `handler` handles: its own, or the
 * deployment's.
 *
 * READ BY BOTH GIVE-UP PATHS, and it has to be, which is the point of it
 * being a function rather than a field read at either. `JobTerminalService`
 * decides retry-or-fail for a job that reported back; `JobStuckService`
 * decides requeue-or-fail for a job whose executor died without reporting
 * anything. If only the first learned about per-type budgets, a
 * `maxAttempts: 1` job that the terminal path correctly refused to retry would
 * be found by the reaper, judged against the global 3, and REQUEUED —
 * resurrecting the exact automatic retry the profile exists to forbid, on the
 * one path nobody is watching. Both call this.
 *
 * `handler` is `JobHandler | undefined` rather than a type string because both
 * callers already hold the handler (or the registry lookup that produced
 * `undefined` for a type this process cannot run), and an unknown type has no
 * profile to consult — it takes the deployment default, which is what it took
 * before profiles existed.
 */
export function resolveMaxAttempts(config: ConfigService, handler: JobHandler | undefined): number {
  const profile = resolveJobProfile(handler);

  if (profile) {
    return profile.maxAttempts;
  }

  return configNumber(config, 'jobs.maxAttempts', DEFAULT_MAX_ATTEMPTS);
}

/**
 * How often a claimer should extend its lease, derived from the lease itself.
 *
 * DERIVED, NEVER DECLARED — the file header explains why a declared interval
 * is the one number that can be wrong in a way nobody notices until a node
 * starts losing jobs it is actively running. The clamp keeps both extremes
 * survivable: a very short lease cannot produce a renewal storm, and a very
 * long one cannot produce an interval that hides a dead node for an hour.
 *
 * Defensive against a nonsense lease for the same reason everything else here
 * is: this is the divisor of a number that came out of a config read, and a
 * `NaN` interval becomes a `setInterval(NaN)` firing every tick. An unusable
 * lease degrades to the FLOOR rather than the ceiling — renewing too often
 * costs a few requests, renewing too rarely loses the job.
 */
export function resolveRenewIntervalMs(leaseMs: number): number {
  if (!usable(leaseMs, 1)) {
    return MIN_RENEW_INTERVAL_MS;
  }

  return Math.min(
    MAX_RENEW_INTERVAL_MS,
    Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(leaseMs / RENEW_INTERVAL_DIVISOR))
  );
}

/**
 * How far into the future a lease may legitimately point, as a duration from
 * "now": the LONGEST lease any registered handler could ask for, plus one
 * grace.
 *
 * THIS IS THE REAPER'S FOURTH SIGNAL (#347), and it exists because the other
 * three stopped covering a case they used to cover by accident. Until in-process
 * renewal existed, `stuckRunningWhere`'s aged-claim clause reaped ANY row that
 * had been `running` too long, lease or no lease — which caught a corrupt
 * `lease_expires_at` for free, while also (this is the bug #347 fixes) reaping
 * jobs that were running perfectly well. Narrowing that clause to unleased rows
 * fixes the second problem and would silently drop the first: a lease pushed
 * absurdly far out — a bug in a fork's own claim path, a clock jump on the
 * writer, a hostile write — would then match NO signal at all and hold its
 * dedup key forever.
 *
 * A lease further out than the longest lease ANY REGISTERED HANDLER COULD
 * LEGITIMATELY ASK FOR is, by construction, not a live executor's promise.
 * That is a fact this process can compute from what it already knows, without
 * a new column, a new setting, or a per-row handler lookup inside the sweep.
 *
 * ⚠ THE DEPLOYMENT-WIDE LEASE IS ALWAYS IN THE MAXIMUM, even when the registry
 * is empty. A `JOBS_WORKER_MODE=off` control plane may register no handlers at
 * all and must still reap for its fleet; a `jobs` row may name a type this
 * process does not register, and such a row was claimed on the global lease.
 * Taking the max over registered handlers ALONE would give an empty registry a
 * horizon of one grace period and reap every live row on the next sweep — the
 * exact opposite of what this function is for.
 *
 * ⚠ THE TRADE-OFF, STATED HONESTLY: this ceiling MOVES WITH THE PROCESS
 * READING IT. A deployment that removes a handler (or lowers its
 * `maxRuntimeMs`, or lowers `JOBS_JOB_TIMEOUT_MS`) shortens the horizon, and
 * in-flight rows of that type carrying the older, longer lease may be reaped
 * on the next sweep. That is correct rather than merely acceptable: no process
 * in that deployment can run those rows to completion any more, so requeueing
 * them is the only outcome that is not "stuck until a human notices". It is
 * also why the horizon is computed per sweep rather than cached — see
 * `JobStuckService.leaseHorizon`.
 */
export function resolveLeaseHorizonMs(
  config: ConfigService,
  registry: JobHandlerRegistry
): number {
  const longest = registry
    .types()
    .reduce(
      (max, type) =>
        Math.max(max, resolveJobLeaseMs(config, resolveJobProfile(registry.get(type)))),
      // The floor is the lease an UNPROFILED type takes, which is also the
      // lease every unregistered type takes. See the warning above.
      resolveJobLeaseMs(config, undefined)
    );

  return longest + LEASE_GRACE_MS;
}

/**
 * One `{ type, leaseMs }` pair per eligible type, for `ClaimOptions.leases`.
 *
 * THE REASON `ClaimOptions` TAKES A LIST RATHER THAN A NUMBER. A claim is not
 * necessarily homogeneous: the in-process worker offers every registered type
 * and takes whichever row is most urgent, and a worker node claims up to its
 * concurrency ACROSS SEVERAL TYPES IN ONE STATEMENT. With per-type ceilings
 * those rows no longer share a lease, and a single batch-wide number would
 * have to be either the shortest (reaping the long job mid-run) or the longest
 * (leaving a dead executor's short job held for hours). Neither is a lease;
 * both are a compromise the caller should not have to make.
 *
 * BOTH CLAIMERS CALL THIS, which is the same "one function, one number, both
 * executors" rule `resolveJobLeaseMs` states for the scalar case. A node and
 * the API server must derive the SAME lease for the same type, because the
 * lease is not a private detail of a claimer — it is the contract the reaper
 * reads to decide a claim is dead.
 */
export function buildClaimLeases(
  config: ConfigService,
  registry: JobHandlerRegistry,
  eligibleTypes: string[]
): Array<{ type: string; leaseMs: number }> {
  return eligibleTypes.map((type) => ({
    type,
    leaseMs: resolveJobLeaseMs(config, resolveJobProfile(registry.get(type))),
  }));
}
