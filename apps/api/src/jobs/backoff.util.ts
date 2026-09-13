// =============================================================================
// Equal-jitter exponential backoff (issue #261, epic #254)
// =============================================================================
//
// One pure function, used by BOTH deferral paths in
// `job-terminal.service.ts`: the ordinary retry (base 2s, ceiling 60s) and
// the rate-limit deferral (base 30s, ceiling 15min). They differ only in the
// constants they pass, which is the point — "how long until the next try" is
// one decision with one implementation, not two similar ones that drift.
//
// -----------------------------------------------------------------------------
// WHY JITTER IS NOT OPTIONAL HERE
// -----------------------------------------------------------------------------
//
// Without it, every job deferred by one provider outage retries in the same
// millisecond. That is not a rounding detail — it is the failure mode:
//
//   A provider starts returning 429. Every job in flight against it is
//   deferred by the SAME formula from within the same second, so every one of
//   them lands on the same `scheduled_for`. The claim query is ordered and
//   batched, so at that instant the whole set becomes eligible together, the
//   workers claim as many as they have slots for, and they all hit the
//   provider simultaneously — reproducing exactly the burst that got us
//   throttled, and getting throttled again. The retries have SYNCHRONISED,
//   and pure exponential backoff keeps them synchronised forever: the same
//   input produces the same delay, so the herd stays a herd at 2s, 4s, 8s,
//   and so on, only sparser.
//
// Jitter is what breaks the herd apart: identical jobs deferred at the same
// instant get DIFFERENT delays, so they arrive spread across a window instead
// of stacked on one instant, and the provider sees a ramp rather than a wall.
//
// EQUAL JITTER specifically — `exp/2 + rand() * exp/2` — rather than the two
// obvious alternatives:
//
//   - FULL jitter (`rand() * exp`) spreads the widest, but its lower bound is
//     zero: a job can be retried essentially immediately after being deferred
//     for a reason that has not gone away yet. Half the point of backing off
//     is the waiting.
//   - DECORRELATED jitter needs the previous delay as state. Ours is
//     recomputed from `attempts` on a row that may be picked up by a
//     different process entirely, so there is no "previous delay" to carry
//     without adding a column to store it in.
//
// Equal jitter keeps a guaranteed floor of half the exponential term (the
// backoff still backs off) and spreads the other half at random (the herd
// still breaks up). It is the standard choice for this exact shape of
// problem.
//
// -----------------------------------------------------------------------------
// THE RNG IS A PARAMETER
// -----------------------------------------------------------------------------
//
// `rand` defaults to `Math.random` and is overridable, so tests assert an
// EXACT delay rather than a range. A range assertion on a jittered delay is
// nearly worthless: `delay >= 1000 && delay <= 2000` passes for a correct
// implementation and for one that ignores `attempt` entirely, which is the
// bug most worth catching here. It also has to be a parameter rather than
// module state, because two callers with different constants can be inside
// the same tick.
// =============================================================================

/**
 * DI token for the RNG the terminal service passes to `computeBackoffMs`.
 *
 * OPTIONAL and unprovided in `JobsModule` — production always gets
 * `Math.random`, exactly as `JOB_CLOCK` always gets the real clock. It exists
 * so a unit test can assert the EXACT `scheduled_for` a deferral wrote
 * instead of a range; see the "the RNG is a parameter" note above for why a
 * range assertion is nearly worthless on a jittered delay.
 */
export const JOB_RANDOM = Symbol('JOB_RANDOM');

export interface BackoffInput {
  /**
   * WHICH attempt is about to be scheduled, 1-based: `1` produces the first
   * (shortest) delay.
   *
   * ⚠ Callers pass `job.attempts`, which the claim statement already
   * incremented — so a job on its first run passes `1` and gets the base
   * delay, not double it. See §4.5 of docs/specs/job-queue.md. Values below
   * 1 are clamped rather than trusted, so a caller that reads a stale or
   * un-charged row cannot produce a fractional (sub-base) delay.
   */
  attempt: number;

  /** The delay for attempt 1, before jitter. */
  baseMs: number;

  /** Ceiling for the exponential term, before jitter and before `retryAfterMs`. */
  maxMs: number;

  /**
   * A delay the OTHER side asked for — a provider's `Retry-After`, or a
   * remote node reporting one. It is a FLOOR, not an override: a provider
   * saying "come back in 1s" does not entitle us to ignore our own backoff on
   * the fifth consecutive failure, and a provider saying "come back in an
   * hour" is obeyed even though our own ceiling is shorter. Taking the max of
   * the two is the only combination that never violates either constraint.
   */
  retryAfterMs?: number | null;

  /** Injectable RNG in `[0, 1)`. Defaults to `Math.random`. */
  rand?: () => number;
}

/**
 * Milliseconds to wait before the next attempt.
 *
 * `exp   = min(maxMs, baseMs * 2^(attempt - 1))`
 * `delay = max(retryAfterMs ?? 0, exp / 2 + rand() * exp / 2)`
 *
 * Always a non-negative integer (callers turn it into a `Date`, and a
 * fractional millisecond in a timestamp helps nobody read a job list).
 */
export function computeBackoffMs(input: BackoffInput): number {
  const { baseMs, maxMs, retryAfterMs, rand = Math.random } = input;

  // Clamped, not trusted — see `attempt` above. `Math.pow` with a negative
  // exponent would otherwise return a delay SHORTER than the base, which is
  // the opposite of what a backoff is for.
  const attempt = Math.max(1, Math.floor(input.attempt));

  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));

  // Equal jitter: a guaranteed half, plus a random half.
  const jittered = exponential / 2 + rand() * (exponential / 2);

  return Math.max(0, Math.round(Math.max(retryAfterMs ?? 0, jittered)));
}
