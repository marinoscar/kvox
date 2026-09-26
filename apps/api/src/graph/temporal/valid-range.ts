// =============================================================================
// Valid-range algebra: construction, predicates, Postgres conversion, display
// =============================================================================
//
// docs/specs/ontology.md §5.4 "Ranges with precision". Half-open `[from, to)`,
// `null` = unbounded, every instant UTC. Every calendar computation below uses
// the UTC accessors, so the output never depends on the process's time zone.
// =============================================================================

import { TemporalInputError, type ValidPrecision, type ValidRange } from './types';

// ---------------------------------------------------------------------------
// Calendar helpers (UTC only)
// ---------------------------------------------------------------------------

/**
 * UTC midnight of `year-month-day` (month 0-based). `setUTCFullYear` rather
 * than `Date.UTC` because the latter maps years 0–99 onto 1900–1999.
 */
function utcDate(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const PATTERNS: Record<Exclude<ValidPrecision, 'unknown'>, RegExp> = {
  year: /^(\d{4})$/,
  month: /^(\d{4})-(\d{2})$/,
  day: /^(\d{4})-(\d{2})-(\d{2})$/,
};

/** The start of the precision unit `value` names, validated. */
function parseUnitStart(
  value: string,
  precision: Exclude<ValidPrecision, 'unknown'>,
  side: 'from' | 'to'
): Date {
  const m = PATTERNS[precision].exec(value);
  if (!m) {
    throw new TemporalInputError(
      `valid.${side} '${value}' does not match precision '${precision}'`
    );
  }
  const year = Number(m[1]);
  const month = m[2] === undefined ? 1 : Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  if (month < 1 || month > 12) {
    throw new TemporalInputError(`valid.${side} '${value}' has no month ${month}`);
  }
  const date = utcDate(year, month - 1, day);
  // Round-trip check: 2026-02-30 silently rolls over to March otherwise.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TemporalInputError(`valid.${side} '${value}' is not a calendar date`);
  }
  return date;
}

/** The first instant AFTER the precision unit that starts at `start`. */
function unitEnd(start: Date, precision: Exclude<ValidPrecision, 'unknown'>): Date {
  const y = start.getUTCFullYear();
  const mo = start.getUTCMonth();
  const d = start.getUTCDate();
  switch (precision) {
    case 'year':
      return utcDate(y + 1, 0, 1);
    case 'month':
      return utcDate(y, mo + 1, 1);
    case 'day':
      return utcDate(y, mo, d + 1);
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface RangeFromPrecisionOptions {
  /**
   * `true` builds an OPEN range `[from, )` — "since March 2026" — when `to` is
   * null. The default (`false`) treats a lone `from` as a POINT at its
   * precision: "in 2026" → `[2026-01-01, 2027-01-01)`. Ignored when `to` is set.
   */
  open?: boolean;
}

/**
 * Build a range from the extractor's date strings and their precision.
 *
 * - `unknown` → `range: null`, whatever the strings say (§5.4: never guess).
 * - `from` alone → the whole precision unit (a point fact), or `[from, )`
 *   with `{ open: true }`.
 * - `to` given → `to` expands to the END of its unit: `'2026'` as `to` means
 *   "through 2026", i.e. an exclusive bound of `2027-01-01`.
 *
 * Throws `TemporalInputError` on a string that does not match its precision,
 * an impossible calendar date, `from >= to`, or a known precision with
 * neither bound.
 */
export function rangeFromPrecision(
  from: string | null,
  to: string | null,
  precision: ValidPrecision,
  options: RangeFromPrecisionOptions = {}
): { range: ValidRange | null; precision: ValidPrecision } {
  if (precision === 'unknown') return { range: null, precision: 'unknown' };
  if (!(precision in PATTERNS)) {
    throw new TemporalInputError(`unknown precision '${String(precision)}'`);
  }
  if (from === null && to === null) {
    throw new TemporalInputError(
      `precision '${precision}' needs at least one bound; use 'unknown' when the source states none`
    );
  }

  const fromStart = from === null ? null : parseUnitStart(from, precision, 'from');
  let toEnd: Date | null;
  if (to !== null) {
    toEnd = unitEnd(parseUnitStart(to, precision, 'to'), precision);
  } else if (fromStart !== null && !options.open) {
    toEnd = unitEnd(fromStart, precision);
  } else {
    toEnd = null;
  }

  if (fromStart !== null && toEnd !== null && fromStart.getTime() >= toEnd.getTime()) {
    throw new TemporalInputError(`valid.from '${from}' is not before valid.to '${to}'`);
  }
  return { range: { from: fromStart, to: toEnd }, precision };
}

// ---------------------------------------------------------------------------
// Postgres `tstzrange` literals
// ---------------------------------------------------------------------------

/**
 * `'[2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)'`, or `'[a,)'` /
 * `'[,b)'` / `'[,)'` for unbounded sides. Always `[ )`, always ISO UTC — a
 * valid `::tstzrange` literal for `$executeRaw`.
 */
export function toPgRange(range: ValidRange): string {
  assertOrdered(range);
  const lo = range.from === null ? '' : range.from.toISOString();
  const hi = range.to === null ? '' : range.to.toISOString();
  return `[${lo},${hi})`;
}

const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function parsePgInstant(raw: string, literal: string): Date | null {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1).replace(/\\(.)/g, '$1').replace(/""/g, '"');
  }
  if (text === '' || text === 'infinity' || text === '-infinity') return null;
  const m = PG_TIMESTAMP.exec(text);
  if (!m) {
    throw new TemporalInputError(`'${literal}' has an unparseable bound '${raw}'`);
  }
  const [, date, hh, mi, ss = '00', frac = '', zone] = m;
  if (zone === undefined) {
    throw new TemporalInputError(`'${literal}' bound '${raw}' carries no UTC offset`);
  }
  const [y, mo, dd] = date.split('-').map(Number);
  const cal = utcDate(y, mo - 1, dd);
  if (
    cal.getUTCFullYear() !== y ||
    cal.getUTCMonth() !== mo - 1 ||
    cal.getUTCDate() !== dd ||
    Number(hh) > 23 ||
    Number(mi) > 59 ||
    Number(ss) > 59
  ) {
    throw new TemporalInputError(`'${literal}' bound '${raw}' is not a calendar instant`);
  }
  let offset = zone;
  if (offset !== 'Z') {
    const digits = offset.replace(':', '');
    offset = `${digits.slice(0, 3)}:${digits.length > 3 ? digits.slice(3) : '00'}`;
  }
  // JS dates carry milliseconds; Postgres microseconds are truncated.
  const ms = (frac + '000').slice(0, 3);
  const instant = new Date(`${date}T${hh}:${mi}:${ss}.${ms}${offset}`);
  if (Number.isNaN(instant.getTime())) {
    throw new TemporalInputError(`'${literal}' bound '${raw}' is not a valid instant`);
  }
  return instant;
}

/**
 * Inverse of `toPgRange`, and also accepts Postgres's own output
 * (`["2019-01-01 00:00:00+00",)`). Bounds are normalised to `[ )`: an
 * exclusive lower bound `(a` becomes `[a+1ms`, an inclusive upper bound `b]`
 * becomes `b+1ms)` — exact at the millisecond resolution a JS `Date` has.
 * `empty` has no half-open representation and throws.
 */
export function fromPgRange(literal: string): ValidRange {
  const text = literal.trim();
  if (text.toLowerCase() === 'empty') {
    throw new TemporalInputError(`'${literal}' is an empty range`);
  }
  const open = text[0];
  const close = text[text.length - 1];
  if ((open !== '[' && open !== '(') || (close !== ')' && close !== ']')) {
    throw new TemporalInputError(`'${literal}' is not a range literal`);
  }
  const body = text.slice(1, -1);
  const comma = splitOutsideQuotes(body);
  if (comma === -1) {
    throw new TemporalInputError(`'${literal}' has no ',' separating its bounds`);
  }
  let from = parsePgInstant(body.slice(0, comma), literal);
  let to = parsePgInstant(body.slice(comma + 1), literal);
  if (from !== null && open === '(') from = new Date(from.getTime() + 1);
  if (to !== null && close === ']') to = new Date(to.getTime() + 1);
  const range = { from, to };
  assertOrdered(range);
  return range;
}

function splitOutsideQuotes(body: string): number {
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      return i;
    }
  }
  return -1;
}

function assertOrdered(range: ValidRange): void {
  if (range.from !== null && range.to !== null && range.from.getTime() >= range.to.getTime()) {
    throw new TemporalInputError(
      `range [${range.from.toISOString()}, ${range.to.toISOString()}) is empty or inverted`
    );
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function label(instant: Date, precision: Exclude<ValidPrecision, 'unknown'>): string {
  const y = String(instant.getUTCFullYear()).padStart(4, '0');
  const mon = MONTHS[instant.getUTCMonth()];
  switch (precision) {
    case 'year':
      return y;
    case 'month':
      return `${mon} ${y}`;
    case 'day':
      return `${mon} ${instant.getUTCDate()}, ${y}`;
  }
}

/**
 * Render a range at its precision: `'2026'`, `'Mar 2026 → present'`,
 * `'2019 → 2025'`, `'unknown'`. The upper bound is shown as the LAST unit the
 * range still covers (`to` minus one millisecond), so this is the inverse of
 * `rangeFromPrecision`: `[2019-01-01, 2026-01-01)` at `year` reads
 * `'2019 → 2025'`, and a range exactly one unit wide reads as that unit alone.
 * Locale- and time-zone-independent by construction.
 */
export function formatValid(range: ValidRange | null, precision: ValidPrecision): string {
  if (range === null || precision === 'unknown') return 'unknown';
  if (range.from === null && range.to === null) return 'always';
  const start = range.from === null ? null : label(range.from, precision);
  const end = range.to === null ? null : label(new Date(range.to.getTime() - 1), precision);
  if (start !== null && end === null) return `${start} → present`;
  if (start === null) return `until ${end}`;
  return start === end ? start : `${start} → ${end}`;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const lo = (d: Date | null): number => (d === null ? -Infinity : d.getTime());
const hi = (d: Date | null): number => (d === null ? Infinity : d.getTime());

/**
 * `from <= at < to`. A `null` range is `true` — not temporal, or `unknown`
 * precision — which is the contract #370's SQL mirrors:
 * `(valid IS NULL OR valid @> $asOf)`.
 */
export function isValidAt(range: ValidRange | null, at: Date): boolean {
  if (range === null) return true;
  const t = at.getTime();
  return lo(range.from) <= t && t < hi(range.to);
}

/** Half-open overlap: touching ranges `[a,b)` and `[b,c)` do NOT overlap. */
export function rangesOverlap(a: ValidRange, b: ValidRange): boolean {
  return lo(a.from) < hi(b.to) && lo(b.from) < hi(a.to);
}

/** Every instant of `inner` lies in `outer`. */
export function rangeContainsRange(outer: ValidRange, inner: ValidRange): boolean {
  return lo(outer.from) <= lo(inner.from) && hi(inner.to) <= hi(outer.to);
}

/** Still open: no upper bound. */
export function isOpen(range: ValidRange): boolean {
  return range.to === null;
}

/** Same bounds on both sides. */
export function rangesEqual(a: ValidRange, b: ValidRange): boolean {
  return lo(a.from) === lo(b.from) && hi(a.to) === hi(b.to);
}
