// =============================================================================
// Valid-range algebra (issue #353; docs/specs/ontology.md §5.4)
// =============================================================================
//
// Construction from a (string, precision) pair, the Postgres `tstzrange`
// literal both ways, the point/overlap/containment predicates, and the
// human rendering. Ranges are HALF-OPEN `[from, to)`; `null` is unbounded.
//
// Every calendar computation uses the UTC getters/setters, so the output never
// depends on the process time zone. PURE: no Prisma, no Nest, no clock read.
// =============================================================================

import { TemporalInputError, type ValidPrecision, type ValidRange } from './types';

type Granularity = 'year' | 'month' | 'day';

const GRANULARITIES: readonly Granularity[] = ['year', 'month', 'day'];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Calendar helpers (UTC only)
// ---------------------------------------------------------------------------

/**
 * UTC midnight of (year, monthIndex, day). `setUTCFullYear` rather than
 * `Date.UTC`, because the latter maps years 0–99 onto 1900–1999. Month and
 * day overflow roll over exactly as `Date.UTC` would (month 12 = next Jan).
 */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysInMonth(year: number, monthIndex: number): number {
  return utcDate(year, monthIndex + 1, 0).getUTCDate();
}

/** The start of the next unit after the unit that starts at `start`. */
function addUnit(start: Date, unit: Granularity): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  switch (unit) {
    case 'year':
      return utcDate(y + 1, 0, 1);
    case 'month':
      return utcDate(y, m + 1, 1);
    case 'day':
      return new Date(start.getTime() + MS_PER_DAY);
  }
}

function isAligned(d: Date, unit: Granularity): boolean {
  const midnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  switch (unit) {
    case 'year':
      return midnight && d.getUTCMonth() === 0 && d.getUTCDate() === 1;
    case 'month':
      return midnight && d.getUTCDate() === 1;
    case 'day':
      return midnight;
  }
}

function assertValidDate(d: Date, what: string): void {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new TemporalInputError(`${what} is not a valid date`);
  }
}

function assertOrdered(range: ValidRange): void {
  if (range.from) assertValidDate(range.from, 'range.from');
  if (range.to) assertValidDate(range.to, 'range.to');
  if (range.from && range.to && range.from.getTime() >= range.to.getTime()) {
    throw new TemporalInputError(
      `empty range: from (${range.from.toISOString()}) must be before to (${range.to.toISOString()})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const PRECISION_PATTERNS: Record<Granularity, RegExp> = {
  year: /^(\d{4})$/,
  month: /^(\d{4})-(\d{2})$/,
  day: /^(\d{4})-(\d{2})-(\d{2})$/,
};

/** Parse a date string written at `precision` to the START of its unit. */
function parseAtPrecision(value: string, precision: Granularity, side: 'from' | 'to'): Date {
  const match = PRECISION_PATTERNS[precision].exec(value);
  if (!match) {
    throw new TemporalInputError(`${side} '${value}' does not match precision '${precision}'`);
  }
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (month < 1 || month > 12) {
    throw new TemporalInputError(`${side} '${value}' has no month ${month}`);
  }
  if (day < 1 || day > daysInMonth(year, month - 1)) {
    throw new TemporalInputError(`${side} '${value}' has no day ${day} in that month`);
  }
  return utcDate(year, month - 1, day);
}

export interface RangeFromPrecisionOptions {
  /**
   * `from` alone normally means a POINT fact, expanded to its precision unit
   * ("in 2026" → `[2026, 2027)`). Set this for a CONTINUING state stated only
   * by its start ("has worked there since 2019") to get `[2019, )` instead.
   * Contradicts a given `to`, which throws.
   */
  openEnded?: boolean;
}

/**
 * Build a range from date strings written at `precision`.
 *
 * - `'unknown'` → `range: null`, whatever strings were passed (§5.4: never guess).
 * - `from` is the START of its unit (`'2026-03'` → 2026-03-01).
 * - `to` is the END of its unit (`'2026'` → 2027-01-01): an inclusive
 *   "through 2026" becomes the half-open upper bound.
 * - `to` null: a point fact spanning `from`'s one unit, or `[from, )` with
 *   `options.openEnded`.
 *
 * Throws `TemporalInputError` on a string that does not match its precision
 * (`'2026-13'`, `'2026-02-30'`), on `from >= to`, and on a known precision
 * with neither bound.
 */
export function rangeFromPrecision(
  from: string | null,
  to: string | null,
  precision: ValidPrecision,
  options: RangeFromPrecisionOptions = {},
): { range: ValidRange | null; precision: ValidPrecision } {
  if (precision === 'unknown') return { range: null, precision: 'unknown' };
  if (!GRANULARITIES.includes(precision)) {
    throw new TemporalInputError(`unknown precision '${String(precision)}'`);
  }
  if (from === null && to === null) {
    throw new TemporalInputError(`a '${precision}' range needs at least one bound; use precision 'unknown'`);
  }
  if (options.openEnded && to !== null) {
    throw new TemporalInputError('openEnded contradicts an explicit to');
  }

  const fromDate = from === null ? null : parseAtPrecision(from, precision, 'from');
  let toDate: Date | null;
  if (to !== null) {
    toDate = addUnit(parseAtPrecision(to, precision, 'to'), precision);
  } else if (fromDate !== null && !options.openEnded) {
    toDate = addUnit(fromDate, precision);
  } else {
    toDate = null;
  }

  const range: ValidRange = { from: fromDate, to: toDate };
  assertOrdered(range);
  return { range, precision };
}

// ---------------------------------------------------------------------------
// Postgres `tstzrange` literals
// ---------------------------------------------------------------------------

/**
 * `'[2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)'`, `'[a,)'` when open
 * above, `'(,b)'` when unbounded below (Postgres' own spelling of an infinite
 * lower bound), `'(,)'` when unbounded on both sides. Throws on an empty or
 * inverted range, which `tstzrange` could only store as `'empty'`.
 */
export function toPgRange(range: ValidRange): string {
  assertOrdered(range);
  const lower = range.from ? `[${range.from.toISOString()}` : '(';
  const upper = range.to ? `${range.to.toISOString()})` : ')';
  return `${lower},${upper}`;
}

const PG_TIMESTAMP =
  /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})?$/i;

/** Parse one bound as Postgres prints it (`2019-01-01 00:00:00+00`) or as ISO. No offset = UTC. */
function parsePgTimestamp(raw: string): Date {
  const m = PG_TIMESTAMP.exec(raw);
  if (!m) throw new TemporalInputError(`'${raw}' is not a timestamp`);
  const [, y, mo, d, hh = '0', mi = '0', ss = '0', frac = '', tz] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(y), month - 1)) {
    throw new TemporalInputError(`'${raw}' is not a calendar date`);
  }
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  let t =
    utcDate(Number(y), month - 1, day).getTime() + ((Number(hh) * 60 + Number(mi)) * 60 + Number(ss)) * 1000 + ms;
  if (tz && tz.toUpperCase() !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    const digits = tz.slice(1).replace(/:/g, '');
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4) || '0');
    const offS = Number(digits.slice(4, 6) || '0');
    t -= sign * ((offH * 60 + offM) * 60 + offS) * 1000;
  }
  return new Date(t);
}

function parseBound(raw: string): Date | null {
  const unquoted = raw.trim().replace(/^"(.*)"$/, '$1').trim();
  if (unquoted === '' || /^[+-]?infinity$/i.test(unquoted)) return null;
  return parsePgTimestamp(unquoted);
}

/**
 * Inverse of `toPgRange`, also accepting what Postgres prints (quoted,
 * space-separated, `+00` offsets). Exclusive `(` lower and inclusive `]` upper
 * bounds are normalised to `[ )` at this module's millisecond resolution: a
 * finite `(a` becomes `[a+1ms`, a finite `b]` becomes `b+1ms)`. An infinite
 * bound is `null` whatever its bracket. Throws on `'empty'` and on garbage.
 */
export function fromPgRange(literal: string): ValidRange {
  const text = literal.trim();
  if (/^empty$/i.test(text)) throw new TemporalInputError("an 'empty' range has no valid time");
  const open = text.charAt(0);
  const close = text.charAt(text.length - 1);
  if ((open !== '[' && open !== '(') || (close !== ')' && close !== ']')) {
    throw new TemporalInputError(`'${literal}' is not a range literal`);
  }
  const parts = text.slice(1, -1).split(',');
  if (parts.length !== 2) throw new TemporalInputError(`'${literal}' is not a range literal`);

  let from = parseBound(parts[0]);
  let to = parseBound(parts[1]);
  if (from && open === '(') from = new Date(from.getTime() + 1);
  if (to && close === ']') to = new Date(to.getTime() + 1);

  const range: ValidRange = { from, to };
  assertOrdered(range);
  return range;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The precision's own unit, or finer when `d` does not sit on its boundary. */
function granularityFor(d: Date, precision: Granularity): Granularity {
  let i = GRANULARITIES.indexOf(precision);
  while (i < GRANULARITIES.length - 1 && !isAligned(d, GRANULARITIES[i])) i++;
  return GRANULARITIES[i];
}

function formatAt(d: Date, g: Granularity): string {
  const year = String(d.getUTCFullYear());
  const month = MONTH_NAMES[d.getUTCMonth()];
  switch (g) {
    case 'year':
      return year;
    case 'month':
      return `${month} ${year}`;
    case 'day':
      return `${month} ${d.getUTCDate()}, ${year}`;
  }
}

/**
 * Human rendering, the inverse of `rangeFromPrecision`:
 * `[2026, 2027)` year → `'2026'`; `[2026-03-01, )` month → `'Mar 2026 → present'`;
 * `[2019, 2026)` year → `'2019 → 2025'` (the upper bound is shown as the LAST
 * unit included, because `to` is exclusive); `null` or `'unknown'` → `'unknown'`.
 *
 * A bound that does not sit on its precision's boundary (a year-precision
 * edge closed at 2026-03-01) is shown at the finest unit it needs:
 * `'2019 → Feb 2026'`. An unbounded lower side renders as `'…'`.
 */
export function formatValid(range: ValidRange | null, precision: ValidPrecision): string {
  if (range === null || precision === 'unknown') return 'unknown';
  const p: Granularity = GRANULARITIES.includes(precision) ? precision : 'day';

  const fromText = range.from ? formatAt(range.from, granularityFor(range.from, p)) : '…';
  if (range.to === null) return `${fromText} → present`;

  const lastIncluded = new Date(range.to.getTime() - 1);
  const toText = formatAt(lastIncluded, granularityFor(range.to, p));
  if (range.from && fromText === toText) return fromText;
  return `${fromText} → ${toText}`;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Inclusive at `from`, exclusive at `to`. A `null` range — a non-temporal
 * relation, or an `unknown`-precision fact — is valid at every instant; this
 * is the same contract as the SQL `(valid IS NULL OR valid @> $asOf)`.
 */
export function isValidAt(range: ValidRange | null, at: Date): boolean {
  if (range === null) return true;
  const t = at.getTime();
  if (range.from !== null && t < range.from.getTime()) return false;
  if (range.to !== null && t >= range.to.getTime()) return false;
  return true;
}

/** Half-open overlap: touching ranges `[a,b)` and `[b,c)` do NOT overlap. */
export function rangesOverlap(a: ValidRange, b: ValidRange): boolean {
  const aStartsBeforeBEnds = a.from === null || b.to === null || a.from.getTime() < b.to.getTime();
  const bStartsBeforeAEnds = b.from === null || a.to === null || b.from.getTime() < a.to.getTime();
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** `inner` lies entirely within `outer` (equal ranges contain each other). */
export function rangeContainsRange(outer: ValidRange, inner: ValidRange): boolean {
  const lowerOk =
    outer.from === null || (inner.from !== null && outer.from.getTime() <= inner.from.getTime());
  const upperOk = outer.to === null || (inner.to !== null && inner.to.getTime() <= outer.to.getTime());
  return lowerOk && upperOk;
}

/** Still open: no upper bound. */
export function isOpen(range: ValidRange): boolean {
  return range.to === null;
}

/** Same bounds on both sides. */
export function rangesEqual(a: ValidRange, b: ValidRange): boolean {
  const same = (x: Date | null, y: Date | null) => (x === null ? y === null : y !== null && x.getTime() === y.getTime());
  return same(a.from, b.from) && same(a.to, b.to);
}
