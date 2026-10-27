/**
 * The TimeBar's calendar arithmetic (GIC-15, #676). Pure, no clock.
 *
 * The axis runs in CALENDAR DAYS of the user's display time zone, because the
 * API cuts its activity buckets in the requester's zone (weeks start Monday
 * there, months on the 1st; the response echoes the zone as `timeZone`). A day
 * is written as a date key `YYYY-MM-DD`, and handled in arithmetic as a "day
 * number": the UTC midnight of that calendar date in ms. A day number is a
 * floating calendar date, never an instant, so adding `n * DAY_MS` is plain
 * calendar arithmetic and is DST-safe (UTC has no DST; a 23- or 25-hour local
 * day is still one day). Only two functions meet real instants: {@link todayDay}
 * (the clock) and {@link dayKeyOf} (an ISO instant), and both read them in a
 * zone.
 *
 * A brush is a half-open range `[from, to)` of whole buckets, both ends
 * `YYYY-MM-DD`. `to` is the START of the bucket after the last one selected,
 * which is also the calendar date the explorer evaluates the graph at (`as_of`).
 * A bare day sent as `from`/`to`/`since` is read by the API as that day's local
 * midnight, so the URL holds the user's calendar days.
 */

import { getDisplayTimeZone, zonedDateKey } from '@marinoscar/platform-web/timezone/headless';

import type { GraphActivityBucket } from '../../../../headless/clients/graph.js';

export const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Above this span the axis counts in months; at or below it, in weeks. */
export const WEEK_SPAN_DAYS = 240;
/** The narrowest and widest visible span, in days. */
export const MIN_SPAN_DAYS = 28;

/**
 * A brush range: whole buckets, `[from, to)`.
 *
 * @stability experimental
 */
export interface TimeRange {
  /** First day of the first selected bucket, `YYYY-MM-DD` (a calendar day of the display zone). */
  from: string;
  /** First day of the bucket after the last selected one, `YYYY-MM-DD` (a calendar day of the display zone). Exclusive. */
  to: string;
}

/** A date key `YYYY-MM-DD` to its day number (UTC midnight of the calendar date, in ms); `null` when it is not a real calendar date. */
export function parseDay(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return formatDay(ms) === value ? ms : null;
}

/** A day number to its date key `YYYY-MM-DD`. */
export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The calendar day a value falls on in `timeZone`, as `YYYY-MM-DD`: a bare
 * `YYYY-MM-DD` is already a calendar day and is returned as is; an ISO instant
 * (or a `Date`, or epoch ms) is read in the zone. `null` for a value that is no date.
 *
 * @param value - A date key, an ISO instant, a `Date` or epoch ms.
 * @param timeZone - An IANA zone; default the display zone.
 */
export function dayKeyOf(value: string | number | Date, timeZone?: string): string | null {
  if (typeof value === 'string' && value.length === 10) return parseDay(value) === null ? null : value;
  return zonedDateKey(value, timeZone ?? getDisplayTimeZone());
}

/**
 * Today in `timeZone`, as a day number: the clock read as the user's calendar day.
 *
 * @param now - The clock; default now.
 * @param timeZone - An IANA zone; default the display zone.
 */
export function todayDay(now: number | Date = Date.now(), timeZone?: string): number {
  const ms = typeof now === 'number' ? now : now.getTime();
  // An unreadable clock (NaN) falls back to the UTC day rather than throwing.
  return parseDay(dayKeyOf(ms, timeZone)) ?? ms - (ms % DAY_MS);
}

/** Today in `timeZone` as a date key (`YYYY-MM-DD`); see {@link todayDay}. */
export function todayKey(now: number | Date = Date.now(), timeZone?: string): string {
  return formatDay(todayDay(now, timeZone));
}

/** The date key `n` calendar days after (negative: before) `key`; `null` for a key that is no date. */
export function addDaysToKey(key: string, n: number): string | null {
  const day = parseDay(key);
  return day === null ? null : formatDay(day + n * DAY_MS);
}

/** The start of the bucket holding the day number `ms`: the Monday of its week, or the 1st of its month. */
export function bucketStart(ms: number, bucket: GraphActivityBucket): number {
  const date = new Date(ms);
  if (bucket === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS;
}

/** The start of the bucket `n` buckets after (or, negative, before) the one starting at `start`. */
export function addBuckets(start: number, bucket: GraphActivityBucket, n: number): number {
  if (bucket === 'week') return start + n * 7 * DAY_MS;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1);
}

/** A "quarter" step: 13 weeks, or 3 months. */
export function quarterBuckets(bucket: GraphActivityBucket): number {
  return bucket === 'week' ? 13 : 3;
}

/** Every bucket start in `[start, end)`, oldest first. Capped, so a mistaken domain cannot build a huge list. */
export function bucketsBetween(start: number, end: number, bucket: GraphActivityBucket, cap = 1500): number[] {
  const out: number[] = [];
  let at = bucketStart(start, bucket);
  while (at < end && out.length < cap) {
    out.push(at);
    at = addBuckets(at, bucket, 1);
  }
  return out;
}

/** Weeks when the visible span is short, months otherwise. */
export function bucketForSpan(spanMs: number): GraphActivityBucket {
  return spanMs / DAY_MS <= WEEK_SPAN_DAYS ? 'week' : 'month';
}

/**
 * Reads the `from` and `to` URL parameters: both must be real dates with
 * `from < to`, or there is no range. Anything else (a hand-edited URL) is ignored.
 */
export function parseRangeParams(from: string | null, to: string | null): TimeRange | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null || a >= b) return null;
  return { from: formatDay(a), to: formatDay(b) };
}

/** The range that snaps `from`/`to` outward to whole buckets, never empty. */
export function snapRange(fromMs: number, toMs: number, bucket: GraphActivityBucket): TimeRange {
  const a = bucketStart(Math.min(fromMs, toMs), bucket);
  let b = bucketStart(Math.max(fromMs, toMs), bucket);
  if (b < Math.max(fromMs, toMs)) b = addBuckets(b, bucket, 1);
  if (b <= a) b = addBuckets(a, bucket, 1);
  return { from: formatDay(a), to: formatDay(b) };
}

/**
 * The one-bucket range holding a date or instant (`Show in TimeBar`). A bare
 * `YYYY-MM-DD` is a calendar day; an instant is read as the calendar day it
 * falls on in `timeZone` (default the display zone), so it lands in the bucket
 * the API counted it in. `null` for a value that is no date.
 */
export function rangeForInstant(
  value: string,
  bucket: GraphActivityBucket = 'month',
  timeZone?: string,
): TimeRange | null {
  const ms = parseDay(dayKeyOf(value, timeZone));
  if (ms === null) return null;
  const start = bucketStart(ms, bucket);
  return { from: formatDay(start), to: formatDay(addBuckets(start, bucket, 1)) };
}

/** `[start, end)` overlap test, in day numbers (or any ms). */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * "Mar 2026" for a month bucket, "9 Mar 2026" for a week one. `start` is a day
 * number, so its UTC fields ARE the calendar date (of whatever zone cut it):
 * reading it in another zone would shift the label a day.
 */
export function bucketLabel(start: number, bucket: GraphActivityBucket): string {
  const date = new Date(start);
  const month = MONTHS[date.getUTCMonth()];
  return bucket === 'month'
    ? `${month} ${date.getUTCFullYear()}`
    : `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/** A readable range: "Mar 2026" for one month, "Jan to Mar 2026" otherwise. The end shown is the last included day. */
export function rangeLabel(range: TimeRange, bucket: GraphActivityBucket): string {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  if (from === null || to === null) return '';
  const last = to - DAY_MS;
  if (bucket === 'month') {
    const a = bucketLabel(from, 'month');
    const b = bucketLabel(bucketStart(last, 'month'), 'month');
    return a === b ? a : `${a} to ${b}`;
  }
  const a = bucketLabel(from, 'week');
  const b = bucketLabel(bucketStart(last, 'week'), 'week');
  return a === b ? `Week of ${a}` : `${a} to ${b}`;
}

/** A tick label for an axis position: the year at the start of a year, else the month. */
export function tickLabel(start: number, bucket: GraphActivityBucket): string {
  const date = new Date(start);
  if (date.getUTCMonth() === 0 && (bucket === 'month' || date.getUTCDate() <= 7)) return String(date.getUTCFullYear());
  return bucket === 'month' ? MONTHS[date.getUTCMonth()] : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Zooms a visible domain around `anchor` (0 at its left edge, 1 at its right).
 * `factor` below 1 zooms in. The result stays inside `limits` and no narrower
 * than {@link MIN_SPAN_DAYS}.
 */
export function zoomDomain(
  domain: readonly [number, number],
  anchor: number,
  factor: number,
  limits: readonly [number, number],
): [number, number] {
  const span = domain[1] - domain[0];
  const maxSpan = Math.max(limits[1] - limits[0], MIN_SPAN_DAYS * DAY_MS);
  const nextSpan = Math.min(maxSpan, Math.max(MIN_SPAN_DAYS * DAY_MS, span * factor));
  const pivot = domain[0] + span * Math.min(1, Math.max(0, anchor));
  const wanted = pivot - nextSpan * Math.min(1, Math.max(0, anchor));
  const start = Math.min(Math.max(limits[0], limits[1] - nextSpan), Math.max(limits[0], wanted));
  return [start, start + nextSpan];
}
