/**
 * "3 minutes ago" for a notification's timestamp.
 *
 * Issue #127, epic #109. Used by the notification centre, where an absolute
 * timestamp is the wrong unit: the question a user asks of a bell is "is this
 * new?", and `14:03` only answers it if they also know what time it is now.
 *
 * BUILT ON `Intl.RelativeTimeFormat`, not on a hand-written table of plurals.
 * It is in every browser this app supports, it gets the plural rules right for
 * languages whose plurals are not "add an s", and it is the difference between
 * localising this later by passing a locale and localising it later by
 * rewriting it.
 *
 * Falls back to the ISO string on an unparseable input rather than rendering
 * `NaN minutes ago` — a timestamp this code cannot read is still information,
 * and `Invalid Date` in a notification list looks like data loss.
 */

/**
 * Thresholds, largest unit first. The first entry whose `limit` the elapsed
 * time is under decides the unit.
 *
 * `Infinity` on the last row so the loop always terminates with a real unit —
 * a table that can fall through needs a fallback branch that will be wrong
 * exactly once, in a year's time, for the oldest row anybody ever looks at.
 */
const UNITS: { limit: number; ms: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60_000, ms: 1_000, unit: 'second' },
  { limit: 3_600_000, ms: 60_000, unit: 'minute' },
  { limit: 86_400_000, ms: 3_600_000, unit: 'hour' },
  { limit: 604_800_000, ms: 86_400_000, unit: 'day' },
  { limit: 2_629_800_000, ms: 604_800_000, unit: 'week' },
  { limit: 31_557_600_000, ms: 2_629_800_000, unit: 'month' },
  { limit: Infinity, ms: 31_557_600_000, unit: 'year' },
];

/** Under this, say "just now" rather than counting seconds. */
const JUST_NOW_MS = 45_000;

/**
 * @param iso an ISO-8601 timestamp, as every API date field in this app is.
 * @param now injectable so this is testable without freezing the clock, and so
 *        a list rendered in one pass dates every row against the same instant
 *        rather than against seven slightly different ones.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const time = then.getTime();
  if (Number.isNaN(time)) return iso;

  const elapsed = now.getTime() - time;

  // A CLOCK-SKEW GUARD, not a hypothetical: the timestamp comes from the API
  // server and is compared against the browser's clock, which is routinely
  // wrong by seconds and occasionally by hours. Without this, a notification
  // that has just arrived renders as "in 2 minutes", which reads as a bug in
  // the app rather than as a wrong clock on the machine.
  if (elapsed < JUST_NOW_MS) return 'Just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const { limit, ms, unit } of UNITS) {
    if (elapsed < limit) {
      // NEGATIVE, because the event is in the past — `RelativeTimeFormat`
      // renders a negative value as "3 minutes ago" and a positive one as
      // "in 3 minutes". Rounding toward zero (`trunc` via the negation of a
      // floor) keeps "1 hour ago" from appearing 30 minutes early.
      return formatter.format(-Math.floor(elapsed / ms), unit);
    }
  }

  // Unreachable — the last row's limit is `Infinity`. Present so the function
  // is total without a non-null assertion.
  return iso;
}

/**
 * "12 March" — an ABSOLUTE date, for a provenance line rather than a feed.
 *
 * Issue #58, epic #45. The note page states where the note came from ("Generated
 * from *Q3 planning call* using *Executive summary*, 12 March"), and "2 months
 * ago" is the wrong unit for that sentence: provenance is a fact about a
 * specific recording on a specific day, and a reader comparing the note against
 * their calendar needs the day, not an interval.
 *
 * THE YEAR APPEARS ONLY WHEN IT IS NOT THIS ONE. A date inside the current year
 * reads as "12 March"; anything older carries its year, because "12 March" on a
 * three-year-old note is a sentence that quietly lies about when the meeting
 * happened.
 *
 * `Intl.DateTimeFormat` with no locale, like `formatRelativeTime` above: the
 * browser's own ordering ("12 March" or "March 12") is the one its user expects,
 * and hardcoding either is how this becomes untranslatable.
 */
export function formatShortDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;

  const sameYear = then.getFullYear() === now.getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(then);
}
