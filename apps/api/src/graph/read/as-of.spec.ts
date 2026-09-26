import { fromPgRange, isValidAt, type ValidRange } from '../temporal';
import { AsOfParseError, itemValidAt, itemValidAtSql, parseAsOf, relationValidAt, relationValidAtSql } from './as-of';

// =============================================================================
// as-of.ts (#370): parsing, and parity with #353's `isValidAt()`
// =============================================================================
//
// The SQL fragments are run against real `tstzrange` values in
// `test/graph/graph-neighborhood.db.spec.ts`; here the TypeScript mirrors are
// pinned to the engine over the same kind of fixture table, and the fragments'
// text is pinned so an edit to one side is visible.
// =============================================================================

const NOW = new Date('2026-09-26T12:34:56.789Z');

const asOfRequest = {
  invalid: ['2024-02-30', '2024-13-01', '2024-1-5', '2024-01-15T10:00:00', 'yesterday', '15/01/2024', '2024-01-15T25:00:00Z'],
};

const RANGES: (string | null)[] = [
  '[2020-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)',
  '[2020-01-01T00:00:00.000Z,)',
  '(,2026-03-01T00:00:00.000Z)',
  '(,)',
  '[2024-01-15T00:00:00.000Z,2024-01-16T00:00:00.000Z)',
  null, // `unknown` precision: valid IS NULL
];

const INSTANTS = [
  '1900-01-01T00:00:00.000Z',
  '2019-12-31T23:59:59.999Z',
  '2020-01-01T00:00:00.000Z',
  '2024-01-15T00:00:00.000Z',
  '2024-01-16T00:00:00.000Z',
  '2026-02-28T23:59:59.999Z',
  '2026-03-01T00:00:00.000Z',
  '2099-01-01T00:00:00.000Z',
];

/** Every (range literal, instant) pair. */
function asOfCases(): [string | null, string][] {
  return RANGES.flatMap((r) => INSTANTS.map((i) => [r, i] as [string | null, string]));
}


describe('parseAsOf', () => {
  it('defaults to the now it is given, as a copy', () => {
    const at = parseAsOf(undefined, NOW);
    expect(at.toISOString()).toBe(NOW.toISOString());
    expect(at).not.toBe(NOW);
    expect(parseAsOf(null, NOW).toISOString()).toBe(NOW.toISOString());
    expect(parseAsOf('', NOW).toISOString()).toBe(NOW.toISOString());
  });

  it('reads a bare date as 00:00:00Z that day', () => {
    expect(parseAsOf('2024-01-15', NOW).toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(parseAsOf('2024-02-29', NOW).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(parseAsOf('0099-03-01', NOW).getUTCFullYear()).toBe(99);
  });

  it('reads a datetime with an offset as that instant', () => {
    expect(parseAsOf('2024-01-15T10:00:00Z', NOW).toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(parseAsOf('2024-01-15T10:00:00+02:00', NOW).toISOString()).toBe('2024-01-15T08:00:00.000Z');
    expect(parseAsOf('2024-01-15T10:00:00.123-05:00', NOW).toISOString()).toBe('2024-01-15T15:00:00.123Z');
  });

  it.each(asOfRequest.invalid)('refuses %p', (raw) => {
    expect(() => parseAsOf(raw, NOW)).toThrow(AsOfParseError);
  });
});

describe('as-of predicates agree with the temporal engine', () => {
  const cases = asOfCases();

  it.each(cases)('relation %s at %s', (literal, at) => {
    const range: ValidRange | null = literal === null ? null : fromPgRange(literal);
    expect(relationValidAt(range, new Date(at))).toBe(isValidAt(range, new Date(at)));
  });

  it.each(cases)('item %s at %s also requires occurred_at <= as_of', (literal, at) => {
    const range: ValidRange | null = literal === null ? null : fromPgRange(literal);
    const instant = new Date(at);
    expect(itemValidAt({ valid: range, occurredAt: null }, instant)).toBe(isValidAt(range, instant));
    expect(itemValidAt({ valid: range, occurredAt: instant }, instant)).toBe(isValidAt(range, instant));
    expect(itemValidAt({ valid: range, occurredAt: new Date(instant.getTime() + 1) }, instant)).toBe(false);
  });

  it('is inclusive at the lower bound and exclusive at the upper', () => {
    const range = fromPgRange('[2020-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)');
    expect(relationValidAt(range, new Date('2020-01-01T00:00:00.000Z'))).toBe(true);
    expect(relationValidAt(range, new Date('2026-03-01T00:00:00.000Z'))).toBe(false);
    expect(relationValidAt(null, new Date('1900-01-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('SQL fragments', () => {
  const at = new Date('2024-01-15T00:00:00.000Z');

  it('spell the half-open containment with a NULL range valid everywhere', () => {
    const rel = relationValidAtSql('r', at);
    expect(rel.sql).toBe('(r.valid IS NULL OR r.valid @> ?::timestamptz)');
    expect(rel.values).toEqual([at]);

    const item = itemValidAtSql('i', at);
    expect(item.sql).toBe(
      '((i.valid IS NULL OR i.valid @> ?::timestamptz) AND (i.occurred_at IS NULL OR i.occurred_at <= ?::timestamptz))',
    );
    expect(item.values).toEqual([at, at]);
  });

  it('never turns an alias into an injection point', () => {
    expect(() => relationValidAtSql('r; DROP TABLE x', at)).toThrow('invalid SQL alias');
    expect(() => itemValidAtSql('I', at)).toThrow('invalid SQL alias');
  });
});
