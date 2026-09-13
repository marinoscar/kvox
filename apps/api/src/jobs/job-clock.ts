// =============================================================================
// The queue's injectable clock (issue #261, epic #254)
// =============================================================================
//
// Two things in the terminal path are time: "what is now" (which decides the
// `scheduled_for` a deferral writes, and whether a provider cooldown has
// elapsed) and "wait a moment" (the cooperative throttle gate's hold, and
// `safeTerminalUpdate`'s single retry pause). Both are behind this one tiny
// interface so a test can drive them, because the alternative is tests that
// prove nothing:
//
//   - A test that asserts a rate-limit deferral scheduled the job "about
//     thirty seconds out" against a real `Date.now()` has to assert a RANGE,
//     and a range assertion passes just as happily for an off-by-a-factor-of
//     -sixty bug that lands inside it. With `now()` pinned, the expected
//     `scheduled_for` is a single exact timestamp.
//   - A test for "the gate makes a sibling job wait" against a real
//     `setTimeout` either sleeps for the real cooldown (thirty seconds of
//     wall clock per case, so nobody writes the case) or shrinks the cooldown
//     until the test proves something other than the shipped behaviour.
//
// It is a plain object rather than a class so a test can pass an object
// literal, and it is injected through an OPTIONAL Nest token so production
// wiring stays "provide nothing and get the real clock" — no test double can
// reach a running application by accident.
//
// The randomness the retry backoff needs is deliberately NOT here: it is a
// parameter of `computeBackoffMs` instead (see `backoff.util.ts`), because a
// pure function that takes its own RNG is testable without any injection at
// all, and jitter is the one thing in this area that has nothing to do with
// the passage of time.
// =============================================================================

/** What the queue is allowed to know about time. */
export interface JobClock {
  /** Milliseconds since the epoch, exactly as `Date.now()` reports it. */
  now(): number;

  /**
   * Resolves after (at least) `ms`.
   *
   * Implementations MUST NOT hold the process open — see `systemJobClock`
   * for why the real one unrefs its timer.
   */
  sleep(ms: number): Promise<void>;
}

/**
 * DI token for `JobClock`.
 *
 * OPTIONAL everywhere it is injected: nothing provides it in
 * `JobsModule`, so the application always runs on `systemJobClock` below and
 * a fork cannot accidentally ship a stubbed clock. Tests construct the
 * services directly and pass their own.
 */
export const JOB_CLOCK = Symbol('JOB_CLOCK');

/**
 * The real clock: wall time, and a timer that CANNOT KEEP THE PROCESS ALIVE.
 *
 * `unref()` matters more than it looks. Both sleepers in this area are
 * "waiting on something that has already gone wrong" — a provider that is
 * throttling us for the next fifteen minutes, or a database that just refused
 * a write. A pending 15-minute refed timer would hold a shutting-down worker
 * open for fifteen minutes after the last request, turning a graceful deploy
 * into an orchestrator kill. Unref'd, the wait simply never completes if
 * nothing else is keeping the process alive, which is the correct outcome:
 * there is nothing left to defer a job on behalf of.
 *
 * The `typeof` guard is for environments whose `setTimeout` returns a number
 * rather than a Node `Timeout` (jsdom, and some fake-timer configurations).
 */
export const systemJobClock: JobClock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);

      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    }),
};
