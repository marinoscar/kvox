/**
 * The TimeBar's calendar arithmetic (GIC-15, #676). Pure, UTC only, no clock:
 * the API buckets in UTC (weeks start Monday, months on the 1st), so the axis
 * does too, and a range written to the URL means the same thing for every
 * viewer wherever they are.
 *
 * A brush is a half-open range `[from, to)` of whole buckets, both ends
 * `YYYY-MM-DD`. `to` is the START of the bucket after the last one selected,
 * which is also the instant the explorer evaluates the graph at (`as_of`).
 */

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
  /** First day of the first selected bucket, `YYYY-MM-DD` (UTC). */
  from: string;
  /** First day of the bucket after the last selected one, `YYYY-MM-DD` (UTC). Exclusive. */
  to: string;
}

/** `YYYY-MM-DD` to UTC midnight in ms; `null` when it is not a real calendar date. */
export function parseDay(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return formatDay(ms) === value ? ms : null;
}

/** UTC ms to `YYYY-MM-DD`. */
export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The start (UTC midnight) of the bucket holding `ms`: the Monday of its week, or the 1st of its month. */
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

/** The one-bucket range holding a date or instant (`Show in TimeBar`). `null` for a value that is no date. */
export function rangeForInstant(value: string, bucket: GraphActivityBucket = 'month'): TimeRange | null {
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) return null;
  const start = bucketStart(ms, bucket);
  return { from: formatDay(start), to: formatDay(addBuckets(start, bucket, 1)) };
}

/** `[start, end)` overlap test, in ms. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** "Mar 2026" for a month bucket, "9 Mar 2026" for a week one. */
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
