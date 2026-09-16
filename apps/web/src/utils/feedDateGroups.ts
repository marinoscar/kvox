/**
 * Cutting a library feed into date groups — issue #190, epic #162.
 *
 * =============================================================================
 * WHY A FEED THIS LONG NEEDS A DATE AXIS
 * =============================================================================
 *
 * Both library feeds are ordered `updatedAt` descending, and epic #162 is about
 * holding hundreds of rows. Three hundred cards in one undifferentiated column
 * throw away the one thing the ordering already knows and the one thing users
 * actually remember about a recording: roughly WHEN it was. "The one from last
 * Tuesday" is how people look for these, and nothing on screen said so.
 *
 * So the feed is cut into Today / Yesterday / This week / This month / then one
 * group per calendar month, which is the coarseness a scrolling thumb can
 * actually use. Finer than this (one heading per day) produces a heading for
 * every row or two on an active account; coarser (just "Older") stops helping
 * exactly where the feed gets long.
 *
 * =============================================================================
 * PURE, AND THE CLOCK IS AN ARGUMENT
 * =============================================================================
 *
 * `groupFeedByDate` takes `now` rather than calling `Date.now()`. That is not
 * test convenience for its own sake — every boundary here is a MIDNIGHT, so the
 * interesting cases are all "a row 40 seconds either side of one", and a
 * function that reads the wall clock can only be tested by pretending to move
 * it. The callers pass a real `new Date()`.
 *
 * ⚠ BOUNDARIES ARE LOCAL CALENDAR DAYS, NOT 24-HOUR WINDOWS. "Yesterday" means
 * the previous calendar date in the READER's timezone, not "between 24 and 48
 * hours ago" — a recording made at 11pm is "Yesterday" at 1am, not "Today", and
 * a reader in Costa Rica and one in Berlin can legitimately group the same row
 * differently. That is correct: the label is about the reader's day, and the
 * underlying `updatedAt` is unambiguous UTC either way.
 *
 * =============================================================================
 * THE OUTPUT SHAPE IS FLAT, ON PURPOSE
 * =============================================================================
 *
 * `groupFeedByDate` returns groups, but the VIEW renders the headings as
 * separators among the rows rather than nesting each group in its own list.
 * Both library feeds are a single `<ul>` whose rows are `<li>` with an `<h2>`
 * inside, asserted by the axe passes in `TranscriptsPage.test.tsx` and
 * `NotesPage.test.tsx`; wrapping groups in sub-lists would add a nesting level
 * those passes would have to be taught about, and a heading level between the
 * page's `h1` and the row's `h2` that does not exist today. A group with no
 * rows is never produced, so no bare heading can render.
 */

/** One date bucket, in feed order. */
export interface FeedDateGroup<T> {
  /** Stable across renders and unique within one grouping — safe as a React key. */
  key: string;
  /** What the separator says: "Today", "Yesterday", "March 2026". */
  label: string;
  items: T[];
}

/** The only thing this module needs to know about a row. */
export interface DatedFeedRow {
  updatedAt: string;
}

/** Midnight at the start of `date`'s local calendar day. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole local calendar days between two instants — 0 means "same date". */
function daysBetween(now: Date, then: Date): number {
  const ms = startOfDay(now).getTime() - startOfDay(then).getTime();
  // Calendar days, computed from midnights, so a DST shift cannot make
  // "yesterday" read as 0.96 days and round to today.
  return Math.round(ms / 86_400_000);
}

/**
 * Which bucket `updatedAt` falls in, as a `{ key, label }` pair.
 *
 * Exported for the tests, which assert the boundaries directly rather than
 * through a rendered list.
 */
export function feedDateBucket(updatedAt: string, now: Date): { key: string; label: string } {
  const then = new Date(updatedAt);

  // An unparseable timestamp is not a reason to drop a row from the feed. It
  // gets its own terminal bucket and the reader still sees the recording.
  if (Number.isNaN(then.getTime())) return { key: 'unknown', label: 'Undated' };

  const days = daysBetween(now, then);

  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  // 2-6 rather than "same ISO week": a Monday reader should still see the
  // previous Thursday as recent, which a week-boundary rule would push into
  // "This month" for no reason the reader would recognise.
  if (days <= 6) return { key: 'this-week', label: 'This week' };
  if (days <= 30) return { key: 'this-month', label: 'This month' };

  // Past a month, the calendar month IS the useful granularity, and it is named
  // rather than relative — "September 2026" stays true tomorrow, where
  // "2 months ago" silently becomes wrong the moment the page is left open.
  const key = `m-${then.getFullYear()}-${String(then.getMonth() + 1).padStart(2, '0')}`;
  const label = then.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return { key, label };
}

/**
 * Cut a feed into date groups, preserving order.
 *
 * The feed arrives sorted `updatedAt` descending, so groups are emitted in the
 * order their first row appears and no sorting happens here — re-sorting would
 * be a second, quieter opinion about the ordering the API already fixed, and
 * the two could disagree.
 *
 * A group is only created when a row lands in it, so an empty bucket never
 * produces a bare heading.
 */
export function groupFeedByDate<T extends DatedFeedRow>(
  items: readonly T[],
  now: Date,
): FeedDateGroup<T>[] {
  const groups: FeedDateGroup<T>[] = [];
  let current: FeedDateGroup<T> | null = null;

  for (const item of items) {
    const bucket = feedDateBucket(item.updatedAt, now);
    // Compared against the PREVIOUS group only, not looked up in a map: the
    // input is already ordered, so a bucket can only be entered once, and a map
    // would silently merge two runs of the same label if it ever were not —
    // reordering rows behind the caller's back.
    if (!current || current.key !== bucket.key) {
      current = { key: bucket.key, label: bucket.label, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }

  return groups;
}

/**
 * "42 transcripts", "1 note matching "budget"", "No notes match "budget"".
 *
 * ONE function for both feeds, because the wording is the same question with a
 * different noun and two copies would drift. The count is `total` from the API,
 * never `items.length` — the feed holds the pages the user has loaded, and a
 * line that said "20 transcripts" under a list of 20 of 300 would be actively
 * wrong rather than merely unhelpful.
 *
 * ⚠ AN EMPTY LIBRARY GETS AN EMPTY STRING, NOT "No transcripts yet". Both views
 * already render a full empty state for that case — a heading, an explanation
 * and a call to action — and a count line saying the same words immediately
 * above it is the same sentence twice, which is worse than useless when the
 * second copy is in a live region a screen reader will read out. A search that
 * matched nothing is the opposite case and DOES get a line: there the empty
 * state is about the filter rather than the library, and naming the term the
 * user typed is the whole point.
 */
export function feedCountLabel(
  total: number,
  noun: { one: string; many: string },
  query?: string,
): string {
  const term = query?.trim();
  const plural = total === 1 ? noun.one : noun.many;

  if (term) {
    return total === 0
      ? `No ${noun.many} match “${term}”`
      : `${total} ${plural} matching “${term}”`;
  }

  return total === 0 ? '' : `${total} ${plural}`;
}
