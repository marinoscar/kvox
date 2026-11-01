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
 * ⚠ BOUNDARIES ARE CALENDAR DAYS IN THE READER'S DISPLAY TIME ZONE, NOT 24-HOUR
 * WINDOWS. "Yesterday" means the previous calendar date in the zone the reader
 * chose in their profile (the platform's display-zone store,
 * `@marinoscar/platform-web/timezone/headless`; the device's zone when they
 * chose none or the host syncs no profile), not "between 24 and 48 hours ago" —
 * a recording made at 11pm is "Yesterday" at 1am, not "Today", and a reader in
 * Costa Rica and one in Berlin can legitimately group the same row differently.
 * That is correct: the label is about the reader's day, and the underlying
 * `updatedAt` is unambiguous UTC either way. The zone is an optional argument,
 * so a test (or a caller with a zone of its own) can name it.
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

import {
  formatDate,
  getDisplayTimeZone,
  zonedDateKey,
} from '@marinoscar/platform-web/timezone/headless';

/**
 * One date bucket, in feed order.
 *
 * @stability experimental
 */
export interface FeedDateGroup<T> {
  /** Stable across renders and unique within one grouping — safe as a React key. */
  key: string;
  /** What the separator says: "Today", "Yesterday", "March 2026". */
  label: string;
  /** Items. */
  items: T[];
}

/**
 * The only thing this module needs to know about a row.
 *
 * @stability experimental
 */
export interface DatedFeedRow {
  /** When the value was last changed, ISO-8601, or `null`. */
  updatedAt: string;
}

/** A `YYYY-MM-DD` key as a UTC midnight, so two keys subtract to whole days. */
function keyToUtcMidnight(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Whole calendar days in `timeZone` between two instants — 0 means "same date". */
function daysBetween(nowKey: string, thenKey: string): number {
  // Calendar days, computed from the two dates' keys in the zone (each read
  // back as a UTC midnight), so a DST shift cannot make "yesterday" read as
  // 0.96 days and round to today.
  return Math.round((keyToUtcMidnight(nowKey) - keyToUtcMidnight(thenKey)) / 86_400_000);
}

/**
 * The date group a row belongs to.
 *
 * @stability experimental
 */
export interface FeedDateBucket {
  /** Stable key of the group: rows with the same key sit under one separator. */
  key: string;
  /** The separator text, for example `Today` or `Yesterday`. */
  label: string;
}

/**
 * Which bucket `updatedAt` falls in, as a `{ key, label }` pair.
 *
 * Exported for the tests, which assert the boundaries directly rather than
 * through a rendered list.
 *
 * @param updatedAt - The row's ISO-8601 timestamp.
 * @param now - The instant the feed is dated against.
 * @param timeZone - The IANA zone whose calendar days bound the buckets; default
 *   the display zone (`getDisplayTimeZone()`: the user's choice, else the device's).
 * @returns The bucket.
 *
 * @stability experimental
 */
export function feedDateBucket(updatedAt: string, now: Date, timeZone?: string): FeedDateBucket {
  const zone = timeZone ?? getDisplayTimeZone();
  const thenKey = zonedDateKey(updatedAt, zone);
  const nowKey = zonedDateKey(now, zone);

  // An unparseable timestamp is not a reason to drop a row from the feed. It
  // gets its own terminal bucket and the reader still sees the recording.
  if (thenKey === null || nowKey === null) return { key: 'unknown', label: 'Undated' };

  const days = daysBetween(nowKey, thenKey);

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
  const key = `m-${thenKey.slice(0, 7)}`;
  const label = formatDate(updatedAt, { month: 'long', year: 'numeric', timeZone: zone });
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
 *
 * @param items - The feed, `updatedAt` descending.
 * @param now - The instant the feed is dated against.
 * @param timeZone - The IANA zone whose calendar days bound the groups; default
 *   the display zone. A component passes `useDisplayTimeZone()` so a saved
 *   profile re-groups the feed.
 * @returns The groups, in feed order.
 *
 * @stability experimental
 */
export function groupFeedByDate<T extends DatedFeedRow>(
  items: readonly T[],
  now: Date,
  timeZone?: string,
): FeedDateGroup<T>[] {
  const zone = timeZone ?? getDisplayTimeZone();
  const groups: FeedDateGroup<T>[] = [];
  let current: FeedDateGroup<T> | null = null;

  for (const item of items) {
    const bucket = feedDateBucket(item.updatedAt, now, zone);
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
 *
 * @stability experimental
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
