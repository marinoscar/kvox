import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  formatValid,
  fromPgRange,
  isOpen,
  isValidAt,
  rangeContainsRange,
  rangeFromPrecision,
  rangesEqual,
  rangesOverlap,
  TemporalInputError,
  toPgRange,
  type ValidPrecision,
  type ValidRange,
} from './index';

/** UTC midnight of a `YYYY-MM-DD` string, or a full ISO instant as given. */
const d = (s: string): Date => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});
const iso = (range: ValidRange | null) =>
  range === null ? null : [range.from?.toISOString() ?? null, range.to?.toISOString() ?? null];

describe('rangeFromPrecision', () => {
  it.each<
    [string | null, string | null, Exclude<ValidPrecision, 'unknown'>, string | null, string | null]
  >([
    // point facts: `to` null spans exactly one unit
    ['2026', null, 'year', '2026-01-01', '2027-01-01'],
    ['2026-03', null, 'month', '2026-03-01', '2026-04-01'],
    ['2026-12', null, 'month', '2026-12-01', '2027-01-01'],
    ['2026-03-02', null, 'day', '2026-03-02', '2026-03-03'],
    ['2026-12-31', null, 'day', '2026-12-31', '2027-01-01'],
    // `to` expands to the END of its unit
    ['2019', '2025', 'year', '2019-01-01', '2026-01-01'],
    ['2019', '2019', 'year', '2019-01-01', '2020-01-01'],
    ['2019-01', '2026-02', 'month', '2019-01-01', '2026-03-01'],
    ['2020-01-01', '2020-01-31', 'day', '2020-01-01', '2020-02-01'],
    ['2026-03-02', '2026-03-02', 'day', '2026-03-02', '2026-03-03'],
    // unbounded below
    [null, '2025', 'year', null, '2026-01-01'],
    [null, '2025-06', 'month', null, '2025-07-01'],
    // leap days
    ['2024-02-29', null, 'day', '2024-02-29', '2024-03-01'],
    ['2000-02-29', null, 'day', '2000-02-29', '2000-03-01'],
    ['2024-02', null, 'month', '2024-02-01', '2024-03-01'],
    ['2024', null, 'year', '2024-01-01', '2025-01-01'],
  ])('(%p, %p, %p) → [%p, %p)', (from, to, precision, expFrom, expTo) => {
    const out = rangeFromPrecision(from, to, precision);
    expect(out.precision).toBe(precision);
    expect(iso(out.range)).toEqual([
      expFrom === null ? null : d(expFrom).toISOString(),
      expTo === null ? null : d(expTo).toISOString(),
    ]);
  });

  it("the acceptance example: '2026' year → [2026-01-01, 2027-01-01), rendered '2026'", () => {
    const { range, precision } = rangeFromPrecision('2026', null, 'year');
    expect(range).toEqual(r('2026-01-01', '2027-01-01'));
    expect(formatValid(range, precision)).toBe('2026');
  });

  it.each<[string | null, string | null]>([
    ['2026', null],
    [null, null],
    ['not a date', 'neither'],
    ['2026-13', '2026-02-30'],
  ])("'unknown' never guesses: (%p, %p) → null range", (from, to) => {
    expect(rangeFromPrecision(from, to, 'unknown')).toEqual({ range: null, precision: 'unknown' });
    expect(formatValid(null, 'unknown')).toBe('unknown');
  });

  it.each<[string, { openEnded?: boolean }, string, string | null]>([
    ['2019', { openEnded: true }, '2019-01-01', null],
    ['2026-03', { openEnded: true }, '2026-03-01', null],
    ['2026-03-02', { openEnded: true }, '2026-03-02', null],
    ['2026-03', { openEnded: false }, '2026-03-01', '2026-04-01'],
  ])('openEnded: (%p, %p) → [%p, %p)', (from, options, expFrom, expTo) => {
    const precision: ValidPrecision =
      from.length === 4 ? 'year' : from.length === 7 ? 'month' : 'day';
    const { range } = rangeFromPrecision(from, null, precision, options);
    expect(range).toEqual(r(expFrom, expTo));
  });

  it.each<[string | null, string | null, ValidPrecision, string]>([
    ['2026-13', null, 'month', 'month 13'],
    ['2026-00', null, 'month', 'month 0'],
    ['2026-02-30', null, 'day', 'Feb 30'],
    ['2023-02-29', null, 'day', 'non-leap Feb 29'],
    ['1900-02-29', null, 'day', 'century non-leap'],
    ['2026-04-31', null, 'day', 'Apr 31'],
    ['2026-01-00', null, 'day', 'day 0'],
    ['26', null, 'year', 'two-digit year'],
    ['2026-3', null, 'month', 'unpadded month'],
    ['2026-03', null, 'year', 'month string at year precision'],
    ['2026', null, 'day', 'year string at day precision'],
    ['2026-03-02', null, 'month', 'day string at month precision'],
    ['2026-03-02T00:00:00Z', null, 'day', 'a timestamp is not a day'],
    [' 2026', null, 'year', 'whitespace'],
    ['2026', '2025', 'year', 'from after to'],
    ['2026-03-02', '2026-03-01', 'day', 'from after to (day)'],
    ['2026', '2026-13', 'year', 'bad to'],
    [null, null, 'year', 'known precision with no bound'],
    ['2026', null, 'week' as ValidPrecision, 'not a precision'],
  ])('throws TemporalInputError on (%p, %p, %p) — %s', (from, to, precision) => {
    expect(() => rangeFromPrecision(from, to, precision)).toThrow(TemporalInputError);
  });

  it('throws when openEnded contradicts an explicit to', () => {
    expect(() => rangeFromPrecision('2019', '2025', 'year', { openEnded: true })).toThrow(
      TemporalInputError
    );
  });

  it('TemporalInputError is an Error with its own name', () => {
    try {
      rangeFromPrecision('2026-13', null, 'month');
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(TemporalInputError);
      expect((e as Error).name).toBe('TemporalInputError');
    }
  });
});

describe('time-zone independence', () => {
  // Jest hands each test a COPY of process.env, so assigning TZ inside a test
  // never reaches the real process clock. The only honest way to run this
  // module "with TZ set to America/Los_Angeles" is a child process started
  // with it — which is what this does, then compares against the UTC answers.
  const probe = `
    const m = require(${JSON.stringify(join(__dirname, 'valid-range.ts'))});
    const year = m.rangeFromPrecision('2026', null, 'year');
    const month = m.rangeFromPrecision('2026-03', null, 'month', { openEnded: true });
    const day = m.rangeFromPrecision('2026-03-01', null, 'day');
    process.stdout.write(JSON.stringify({
      offset: new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset(),
      year: [year.range.from.toISOString(), year.range.to.toISOString()],
      yearText: m.formatValid(year.range, 'year'),
      monthText: m.formatValid(month.range, 'month'),
      dayText: m.formatValid(day.range, 'day'),
      dayPg: m.toPgRange(day.range),
      parsed: m.fromPgRange('["2026-03-01 00:00:00+00",)').from.toISOString(),
      lastMs: m.isValidAt(day.range, new Date('2026-03-01T23:59:59.999Z')),
      nextDay: m.isValidAt(day.range, new Date('2026-03-02T00:00:00.000Z')),
    }));
  `;

  function runIn(tz: string): Record<string, unknown> {
    const out = execFileSync(
      process.execPath,
      ['-r', require.resolve('ts-node/register/transpile-only'), '-e', probe],
      {
        env: {
          ...process.env,
          TZ: tz,
          // Transpile-only, with no project: the module is plain TypeScript.
          TS_NODE_SKIP_PROJECT: 'true',
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
          }),
        },
        encoding: 'utf8',
      }
    );
    return JSON.parse(out) as Record<string, unknown>;
  }

  it('constructs, renders and converts identically under America/Los_Angeles', () => {
    const la = runIn('America/Los_Angeles');
    // Guard: the child really ran in a non-UTC zone.
    expect(la.offset).toBe(480);
    expect(la).toMatchObject({
      year: ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
      yearText: '2026',
      monthText: 'Mar 2026 → present',
      dayText: 'Mar 1, 2026',
      dayPg: '[2026-03-01T00:00:00.000Z,2026-03-02T00:00:00.000Z)',
      parsed: '2026-03-01T00:00:00.000Z',
      lastMs: true,
      nextDay: false,
    });
    const utc = runIn('UTC');
    expect(utc.offset).toBe(0);
    expect({ ...la, offset: 0 }).toEqual(utc);
  });
});

describe('toPgRange / fromPgRange', () => {
  it.each<[string, ValidRange, string]>([
    [
      'bounded',
      r('2019-01-01', '2026-03-01'),
      '[2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)',
    ],
    ['right-open', r('2019-01-01', null), '[2019-01-01T00:00:00.000Z,)'],
    ['left-open', r(null, '2026-03-01'), '(,2026-03-01T00:00:00.000Z)'],
    ['fully open', r(null, null), '(,)'],
    [
      'sub-day',
      r('2026-03-01T12:34:56.789Z', '2026-03-01T12:34:56.790Z'),
      '[2026-03-01T12:34:56.789Z,2026-03-01T12:34:56.790Z)',
    ],
  ])('%s round-trips', (_label, range, literal) => {
    expect(toPgRange(range)).toBe(literal);
    expect(fromPgRange(literal)).toEqual(range);
    expect(fromPgRange(toPgRange(range))).toEqual(range);
  });

  it.each<[string, ValidRange]>([
    // what Postgres itself prints for a tstzrange
    ['["2019-01-01 00:00:00+00","2026-03-01 00:00:00+00")', r('2019-01-01', '2026-03-01')],
    ['["2019-01-01 00:00:00+00",)', r('2019-01-01', null)],
    ['(,"2026-03-01 00:00:00+00")', r(null, '2026-03-01')],
    ['["2019-01-01 05:30:00+05:30",)', r('2019-01-01', null)],
    ['["2018-12-31 16:00:00-08",)', r('2019-01-01', null)],
    ['["2019-01-01 00:00:00.123456+00",)', r('2019-01-01T00:00:00.123Z', null)],
    ['[2019-01-01T00:00:00Z,infinity)', r('2019-01-01', null)],
    ['[-infinity,2026-03-01T00:00:00Z)', r(null, '2026-03-01')],
    ['[,2026-03-01T00:00:00Z)', r(null, '2026-03-01')],
    ['[ 2019-01-01T00:00:00Z , )', r('2019-01-01', null)],
    ['[2019-01-01,2020-01-01)', r('2019-01-01', '2020-01-01')],
    // exclusive lower and inclusive upper bounds normalise to [ ) at ms resolution
    ['(2019-01-01T00:00:00.000Z,)', r('2019-01-01T00:00:00.001Z', null)],
    [
      '[2019-01-01T00:00:00.000Z,2020-01-01T00:00:00.000Z]',
      r('2019-01-01', '2020-01-01T00:00:00.001Z'),
    ],
    [
      '[2019-01-01T00:00:00.000Z,2019-01-01T00:00:00.000Z]',
      r('2019-01-01', '2019-01-01T00:00:00.001Z'),
    ],
    ['(,]', r(null, null)],
  ])('fromPgRange(%p)', (literal, expected) => {
    expect(fromPgRange(literal)).toEqual(expected);
  });

  it.each([
    'empty',
    '',
    '2019-01-01',
    '[2019-01-01T00:00:00Z)',
    '[a,b)',
    '[2026-03-01T00:00:00Z,2019-01-01T00:00:00Z)',
    '[2019-01-01T00:00:00Z,2019-01-01T00:00:00Z)',
    '[2019-02-30T00:00:00Z,)',
    '{2019-01-01T00:00:00Z,)',
  ])('fromPgRange rejects %p', (literal) => {
    expect(() => fromPgRange(literal)).toThrow(TemporalInputError);
  });

  it.each<[string, ValidRange]>([
    ['inverted', r('2026-01-01', '2019-01-01')],
    ['empty', r('2026-01-01', '2026-01-01')],
    ['invalid date', { from: new Date(Number.NaN), to: null }],
  ])('toPgRange rejects an %s range', (_label, range) => {
    expect(() => toPgRange(range)).toThrow(TemporalInputError);
  });
});

describe('formatValid', () => {
  it.each<[ValidRange | null, ValidPrecision, string]>([
    [null, 'unknown', 'unknown'],
    [null, 'year', 'unknown'],
    [r('2019-01-01', null), 'unknown', 'unknown'],
    [r('2026-01-01', '2027-01-01'), 'year', '2026'],
    [r('2026-03-01', '2026-04-01'), 'month', 'Mar 2026'],
    [r('2026-03-02', '2026-03-03'), 'day', 'Mar 2, 2026'],
    [r('2026-03-01', null), 'month', 'Mar 2026 → present'],
    [r('2019-01-01', null), 'year', '2019 → present'],
    [r('2019-01-01', '2026-01-01'), 'year', '2019 → 2025'],
    [r('2019-01-01', '2026-03-01'), 'year', '2019 → Feb 2026'],
    [r('2019-01-01', '2026-03-15'), 'year', '2019 → Mar 14, 2026'],
    [r('2019-01-01', '2026-03-01'), 'month', 'Jan 2019 → Feb 2026'],
    [r('2019-06-01', '2026-01-01'), 'year', 'Jun 2019 → 2025'],
    [r('2020-01-01', '2020-02-01'), 'day', 'Jan 1, 2020 → Jan 31, 2020'],
    [r(null, '2026-01-01'), 'year', '… → 2025'],
    [r(null, null), 'year', '… → present'],
    [r('2026-03-01T12:00:00.000Z', null), 'day', 'Mar 1, 2026 → present'],
  ])('formatValid(%p, %p) → %p', (range, precision, expected) => {
    expect(formatValid(range, precision)).toBe(expected);
  });

  it.each<[string | null, string | null, Exclude<ValidPrecision, 'unknown'>, string]>([
    ['2019', '2025', 'year', '2019 → 2025'],
    ['2019-01', '2026-02', 'month', 'Jan 2019 → Feb 2026'],
    ['2020-01-01', '2020-01-31', 'day', 'Jan 1, 2020 → Jan 31, 2020'],
    ['2024-02-29', null, 'day', 'Feb 29, 2024'],
    [null, '2025', 'year', '… → 2025'],
  ])('is the inverse of rangeFromPrecision(%p, %p, %p)', (from, to, precision, expected) => {
    expect(formatValid(rangeFromPrecision(from, to, precision).range, precision)).toBe(expected);
  });
});

describe('isValidAt', () => {
  const range = r('2019-01-01', '2026-03-01');
  it.each<[string, ValidRange | null, string, boolean]>([
    ['inclusive at from', range, '2019-01-01', true],
    ['one ms before from', range, '2018-12-31T23:59:59.999Z', false],
    ['inside', range, '2024-01-15', true],
    ['one ms before to', range, '2026-02-28T23:59:59.999Z', true],
    ['exclusive at to', range, '2026-03-01', false],
    ['after', range, '2030-01-01', false],
    ['right-open, far future', r('2019-01-01', null), '2999-01-01', true],
    ['right-open, before', r('2019-01-01', null), '2018-01-01', false],
    ['left-open, far past', r(null, '2026-03-01'), '1900-01-01', true],
    ['left-open, at to', r(null, '2026-03-01'), '2026-03-01', false],
    ['fully open', r(null, null), '2026-03-01', true],
    ['null range (non-temporal / unknown)', null, '1970-01-01', true],
  ])('%s', (_label, rng, at, expected) => {
    expect(isValidAt(rng, d(at))).toBe(expected);
  });
});

describe('rangesOverlap', () => {
  it.each<[string, ValidRange, ValidRange, boolean]>([
    ['touching [a,b) [b,c)', r('2019-01-01', '2024-01-01'), r('2024-01-01', '2025-01-01'), false],
    ['disjoint', r('2019-01-01', '2020-01-01'), r('2021-01-01', '2022-01-01'), false],
    ['partial', r('2019-01-01', '2024-01-01'), r('2023-01-01', '2025-01-01'), true],
    ['contained', r('2019-01-01', '2026-01-01'), r('2020-01-01', '2021-01-01'), true],
    ['equal', r('2019-01-01', '2020-01-01'), r('2019-01-01', '2020-01-01'), true],
    ['open vs later bounded', r('2019-01-01', null), r('2030-01-01', '2031-01-01'), true],
    [
      'open vs earlier bounded touching',
      r('2019-01-01', null),
      r('2015-01-01', '2019-01-01'),
      false,
    ],
    ['two open', r('2019-01-01', null), r('2026-01-01', null), true],
    ['left-open vs later', r(null, '2019-01-01'), r('2019-01-01', null), false],
    ['left-open vs overlapping', r(null, '2019-01-02'), r('2019-01-01', null), true],
    ['fully open vs anything', r(null, null), r('2019-01-01', '2019-01-02'), true],
    ['one ms of overlap', r('2019-01-01', '2020-01-01T00:00:00.001Z'), r('2020-01-01', null), true],
  ])('%s', (_label, a, b, expected) => {
    expect(rangesOverlap(a, b)).toBe(expected);
    expect(rangesOverlap(b, a)).toBe(expected);
  });
});

describe('rangeContainsRange / rangesEqual / isOpen', () => {
  it.each<[string, ValidRange, ValidRange, boolean]>([
    ['strictly inside', r('2019-01-01', '2026-01-01'), r('2020-01-01', '2021-01-01'), true],
    ['equal', r('2019-01-01', '2026-01-01'), r('2019-01-01', '2026-01-01'), true],
    ['shares from', r('2019-01-01', '2026-01-01'), r('2019-01-01', '2020-01-01'), true],
    ['shares to', r('2019-01-01', '2026-01-01'), r('2025-01-01', '2026-01-01'), true],
    ['straddles end', r('2019-01-01', '2024-01-01'), r('2023-01-01', '2025-01-01'), false],
    ['starts before', r('2019-01-01', '2024-01-01'), r('2018-01-01', '2020-01-01'), false],
    ['open outer holds open inner', r('2019-01-01', null), r('2020-01-01', null), true],
    [
      'closed outer never holds open inner',
      r('2019-01-01', '2026-01-01'),
      r('2020-01-01', null),
      false,
    ],
    [
      'bounded outer never holds left-open inner',
      r('2019-01-01', '2026-01-01'),
      r(null, '2020-01-01'),
      false,
    ],
    ['fully open holds everything', r(null, null), r(null, null), true],
  ])('%s', (_label, outer, inner, expected) => {
    expect(rangeContainsRange(outer, inner)).toBe(expected);
  });

  it('rangesEqual compares both bounds by instant', () => {
    expect(rangesEqual(r('2019-01-01', null), r('2019-01-01', null))).toBe(true);
    expect(rangesEqual(r('2019-01-01', null), r('2019-01-01', '2020-01-01'))).toBe(false);
    expect(rangesEqual(r(null, null), r(null, null))).toBe(true);
    expect(rangesEqual(r(null, '2020-01-01'), r('2019-01-01', '2020-01-01'))).toBe(false);
  });

  it('isOpen means no upper bound', () => {
    expect(isOpen(r('2019-01-01', null))).toBe(true);
    expect(isOpen(r(null, null))).toBe(true);
    expect(isOpen(r('2019-01-01', '2020-01-01'))).toBe(false);
  });
});
