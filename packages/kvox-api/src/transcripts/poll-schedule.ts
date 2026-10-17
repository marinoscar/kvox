// =============================================================================
// The `transcription.poll` backoff schedule and hard deadline (issue #25)
// =============================================================================
//
// Four pure functions and three constants, deliberately separated from the
// handler that uses them. The schedule is the part of the poll chain that is
// easy to get subtly wrong and impossible to observe going wrong: a delay that
// is slightly too short only shows up as a provider bill, and a deadline that
// never fires only shows up as a transcript stuck on `processing` forever with
// nothing in any log saying so. Pure functions over explicit numbers can be
// tested against the spec's own table; the same arithmetic inlined into a
// handler could only be tested through a mocked provider and a fake clock.
//
// -----------------------------------------------------------------------------
// WHY THE FIRST DELAY IS PROPORTIONAL TO THE RECORDING
// -----------------------------------------------------------------------------
//
// A 90-second voice memo and a six-hour meeting do not finish transcribing on
// the same timescale, and a fixed 30-second poll would burn hundreds of
// pointless round trips against the long one before anything could plausibly
// have changed. Five percent of the media's own duration is the spec's figure
// (§1.5.2–4), clamped at both ends: never less than 30 seconds (so a 10-second
// clip does not get hammered), never more than five minutes (so a ten-hour
// recording is not left unobserved for half an hour before the first check).
//
// ⚠ DURATION IS OFTEN UNKNOWN AT FIRST POLL. `transcripts.duration_ms` is null
// until either the transcode probe or the provider's own `audio_duration`
// fills it in, and the first poll is frequently scheduled before either has
// happened. `firstPollDelayMs(null)` therefore falls back to the floor rather
// than to zero or to the cap — an unknown-length recording is polled as though
// it were short, which is wrong only in the cheap direction.
// =============================================================================

/** Never poll sooner than this after the previous check. */
export const MIN_POLL_DELAY_MS = 30_000;

/** Never wait longer than this between checks, however long the recording is. */
export const MAX_POLL_DELAY_MS = 5 * 60_000;

/** The first delay, as a fraction of the media's own duration. */
export const FIRST_POLL_DURATION_FRACTION = 0.05;

/** Each delay is this multiple of the one before, until the cap. */
export const POLL_BACKOFF_FACTOR = 1.5;

/**
 * The floor on the hard deadline, for a recording whose duration is short or
 * unknown. Six hours: long enough that a provider queueing behind other
 * customers' work is not mistaken for a provider that lost the job.
 */
export const MIN_POLL_DEADLINE_MS = 6 * 60 * 60 * 1000;

/** The deadline is at least this multiple of the recording's own duration. */
export const POLL_DEADLINE_DURATION_FACTOR = 3;

/** `value`, pulled inside `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How long to wait before the FIRST status check.
 *
 * `durationMs` is the media's length when it is known and `null` when it is
 * not — see the file header for why an unknown length polls at the floor.
 */
export function firstPollDelayMs(durationMs: number | null | undefined): number {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return MIN_POLL_DELAY_MS;
  }

  return Math.round(
    clamp(
      durationMs * FIRST_POLL_DURATION_FRACTION,
      MIN_POLL_DELAY_MS,
      MAX_POLL_DELAY_MS,
    ),
  );
}

/**
 * How long to wait before the NEXT check, given the previous delay.
 *
 * ⚠ TOTAL OVER GARBAGE INPUT. The previous delay arrives from a job payload —
 * JSONB written by an earlier process, possibly an earlier build — so it is
 * `unknown` in practice however it is typed. A missing, negative or
 * non-numeric value restarts at the floor rather than producing `NaN`, which
 * would become a `scheduledFor` of `Invalid Date` and a job nothing ever
 * claims.
 */
export function nextPollDelayMs(previousDelayMs: number | null | undefined): number {
  if (
    typeof previousDelayMs !== 'number' ||
    !Number.isFinite(previousDelayMs) ||
    previousDelayMs <= 0
  ) {
    // RESTART AT THE FLOOR, not "the floor times 1.5". An unreadable previous
    // delay means the chain's backoff state is gone, and the honest thing to
    // do is begin a fresh schedule rather than resume one from a number nobody
    // wrote down.
    return MIN_POLL_DELAY_MS;
  }

  return Math.round(
    clamp(previousDelayMs * POLL_BACKOFF_FACTOR, MIN_POLL_DELAY_MS, MAX_POLL_DELAY_MS),
  );
}

/**
 * The instant past which this transcript's poll chain gives up.
 *
 * `max(6h, 3 × duration)` from `submittedAt`. Below it, "still processing" is
 * a normal answer; past it, the provider has either lost the job or is taking
 * pathologically long, and polling forever would leave a transcript silently
 * `processing` with nothing telling its owner it will never finish.
 */
export function pollDeadline(
  submittedAt: Date,
  durationMs: number | null | undefined,
): Date {
  const fromDuration =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs * POLL_DEADLINE_DURATION_FACTOR
      : 0;

  return new Date(submittedAt.getTime() + Math.max(MIN_POLL_DEADLINE_MS, fromDuration));
}

/** Has the chain run out of patience? Exclusive of the deadline instant itself. */
export function isPastPollDeadline(
  submittedAt: Date,
  durationMs: number | null | undefined,
  now: Date,
): boolean {
  return now.getTime() > pollDeadline(submittedAt, durationMs).getTime();
}
