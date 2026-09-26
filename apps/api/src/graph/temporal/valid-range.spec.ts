import {
  TemporalInputError,
  formatValid,
  fromPgRange,
  isOpen,
  isValidAt,
  rangeContainsRange,
  rangeFromPrecision,
  rangesEqual,
  rangesOverlap,
  toPgRange,
  type ValidPrecision,
  type ValidRange,
} from './index';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});

describe('rangeFromPrecision', () => {
  it.each<[string | null, string | null, ValidPrecision, ValidRange]>([
    ['2026', null, 'year', r('2026-01-01', '2027-01-01')],
    ['2026-03', null, 'month', r('2026-03-01', '2026-04-01')],
    ['2026-12', null, 'month', r('2026-12-01', '2027-01-01')],
    ['2026-03-02', null, 'day', r('2026-03-02', '2026-03-03')],
    ['2026-12-31', null, 'day', r('2026-12-31', '2027-01-01')],
    ['2019', '2025', 'year', r('2019-01-01', '2026-01-01')],
    ['2026', '2026', 'year', r('2026-01-01', '2027-01-01')],
    ['2019-01', '2026-02', 'month', r('2019-01-01', '2026-03-01')],
    ['2020-01-01', '2020-01-31', 'day', r('2020-01-01', '2020-02-01')],
    [null, '2020', 'year', r(null, '2021-01-01')],
    [null, '2020-06', 'month', r(null, '2020-07-01')],
  ])('%s → %s at %s', (from, to, precision, expected) => {
    expect(rangeFromPrecision(from, to, precision)).toEqual({ range: expected, precision });
  });

  it('builds an open range with { open: true }', () => {
    expect(rangeFromPrecision('2019', null, 'year', { open: true }).range).toEqual(
      r('2019-01-01', null)
    );
    expect(rangeFromPrecision('2026-03', null, 'month', { open: true }).range).toEqual(
      r('2026-03-01', null)
    );
  });

  it('ignores { open: true } when `to` is given', () => {
    expect(rangeFromPrecision('2019', '2020', 'year', { open: true }).range).toEqual(
      r('2019-01-01', '2021-01-01')
    );
  });

  it.each<[string | null, string | null]>([
    ['2026', null],
    ['garbage', 'also garbage'],
    [null, null],
  ])('unknown precision never guesses (%s, %s)', (from, to) => {
    expect(rangeFromPrecision(from, to, 'unknown')).toEqual({ range: null, precision: 'unknown' });
  });

  it('handles the leap day', () => {
    expect(rangeFromPrecision('2024-02-29', null, 'day').range).toEqual(
      r('2024-02-29', '2024-03-01')
    );
    expect(rangeFromPrecision('2024-02', null, 'month').range).toEqual(
      r('2024-02-01', '2024-03-01')
    );
    expect(() => rangeFromPrecision('2023-02-29', null, 'day')).toThrow(TemporalInputError);
  });

  it.each<[string | null, string | null, ValidPrecision]>([
    ['2026-13', null, 'month'],
    ['2026-00', null, 'month'],
    ['2026-02-30', null, 'day'],
    ['2026-04-31', null, 'day'],
    ['2026-01-00', null, 'day'],
    ['2026-03', null, 'year'],
    ['2026', null, 'month'],
    ['2026-03', null, 'day'],
    ['2026-03-02', null, 'month'],
    ['26', null, 'year'],
    ['2026-3', null, 'month'],
    [' 2026', null, 'year'],
    ['2026', 'March', 'year'],
    ['2026', '2025', 'year'],
    ['2026-03', '2026-02', 'month'],
    ['2026-03-02', '2026-03-01', 'day'],
    [null, null, 'year'],
  ])('rejects %s → %s at %s', (from, to, precision) => {
    expect(() => rangeFromPrecision(from, to, precision)).toThrow(TemporalInputError);
  });

  it('rejects an unrecognised precision', () => {
    expect(() => rangeFromPrecision('2026', null, 'week' as ValidPrecision)).toThrow(
      TemporalInputError
    );
  });

  it('TemporalInputError is an Error subclass', () => {
    const e = new TemporalInputError('x');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TemporalInputError);
    expect(e.name).toBe('TemporalInputError');
  });
});

describe('time-zone independence', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata', 'UTC'])(
    'produces identical UTC output under TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      const { range } = rangeFromPrecision('2026-03', null, 'month');
      expect(range!.from!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(range!.to!.toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(formatValid(range, 'month')).toBe('Mar 2026');
      expect(formatValid(r('2026-01-01', null), 'day')).toBe('Jan 1, 2026 → present');
      expect(toPgRange(range!)).toBe('[2026-03-01T00:00:00.000Z,2026-04-01T00:00:00.000Z)');
    }
  );
});

describe('toPgRange / fromPgRange', () => {
  it.each<[string, ValidRange, string]>([
    [
      'bounded',
      r('2019-01-01', '2026-03-01'),
      '[2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)',
    ],
    ['right-open', r('2019-01-01', null), '[2019-01-01T00:00:00.000Z,)'],
    ['left-open', r(null, '2026-03-01'), '[,2026-03-01T00:00:00.000Z)'],
    ['fully open', r(null, null), '[,)'],
  ])('round-trips a %s range', (_name, range, literal) => {
    expect(toPgRange(range)).toBe(literal);
    expect(fromPgRange(literal)).toEqual(range);
    expect(fromPgRange(toPgRange(range))).toEqual(range);
  });

  it('refuses to serialise an inverted or empty range', () => {
    expect(() => toPgRange(r('2026-01-01', '2026-01-01'))).toThrow(TemporalInputError);
    expect(() => toPgRange(r('2026-01-02', '2026-01-01'))).toThrow(TemporalInputError);
  });

  it("parses Postgres's own tstzrange output", () => {
    expect(fromPgRange('["2019-01-01 00:00:00+00","2026-03-01 00:00:00+00")')).toEqual(
      r('2019-01-01', '2026-03-01')
    );
    expect(fromPgRange('["2019-01-01 00:00:00+00",)')).toEqual(r('2019-01-01', null));
    expect(fromPgRange('(,"2026-03-01 00:00:00+00")')).toEqual(r(null, '2026-03-01'));
    expect(fromPgRange('(,)')).toEqual(r(null, null));
  });

  it('applies non-UTC offsets and truncates microseconds', () => {
    expect(fromPgRange('["2019-01-01 02:00:00+02",)').from).toEqual(d('2019-01-01'));
    expect(fromPgRange('["2018-12-31 19:00:00-05:00",)').from).toEqual(d('2019-01-01'));
    expect(fromPgRange('["2019-01-01 05:30:00+0530",)').from).toEqual(d('2019-01-01'));
    expect(fromPgRange('["2019-01-01 00:00:00.123456+00",)').from).toEqual(
      new Date('2019-01-01T00:00:00.123Z')
    );
  });

  it('treats infinity bounds as unbounded', () => {
    expect(fromPgRange('[-infinity,infinity)')).toEqual(r(null, null));
  });

  it('normalises ( and ] bounds to [ ) at millisecond resolution', () => {
    const range = fromPgRange('(2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z]');
    expect(range.from!.toISOString()).toBe('2019-01-01T00:00:00.001Z');
    expect(range.to!.toISOString()).toBe('2026-03-01T00:00:00.001Z');
    expect(isValidAt(range, d('2019-01-01'))).toBe(false);
    expect(isValidAt(range, d('2026-03-01'))).toBe(true);
  });

  it.each([
    'empty',
    '',
    '2019-01-01',
    '[2019-01-01T00:00:00.000Z)',
    '{2019-01-01T00:00:00.000Z,)',
    '[not a date,)',
    '[2019-01-01 00:00:00,)',
    '[2026-03-01T00:00:00.000Z,2019-01-01T00:00:00.000Z)',
    '[2019-02-30T00:00:00.000Z,)',
  ])('rejects %p', (literal) => {
    expect(() => fromPgRange(literal)).toThrow(TemporalInputError);
  });
});

describe('formatValid', () => {
  it.each<[ValidRange | null, ValidPrecision, string]>([
    [r('2026-01-01', '2027-01-01'), 'year', '2026'],
    [r('2026-03-01', '2026-04-01'), 'month', 'Mar 2026'],
    [r('2026-03-02', '2026-03-03'), 'day', 'Mar 2, 2026'],
    [r('2026-03-01', null), 'month', 'Mar 2026 → present'],
    [r('2019-01-01', null), 'year', '2019 → present'],
    [r('2019-01-01', '2026-01-01'), 'year', '2019 → 2025'],
    [r('2019-01-01', '2026-03-01'), 'month', 'Jan 2019 → Feb 2026'],
    [r(null, '2021-01-01'), 'year', 'until 2020'],
    [r(null, null), 'year', 'always'],
    [null, 'unknown', 'unknown'],
    [null, 'year', 'unknown'],
    [r('2019-01-01', null), 'unknown', 'unknown'],
  ])('%j at %s → %s', (range, precision, expected) => {
    expect(formatValid(range, precision)).toBe(expected);
  });

  it('is the inverse of rangeFromPrecision', () => {
    for (const [from, to, p] of [
      ['2026', null, 'year'],
      ['2019', '2025', 'year'],
      ['2024-02', '2024-11', 'month'],
      ['2024-02-29', null, 'day'],
    ] as const) {
      const { range } = rangeFromPrecision(from, to, p);
      expect(formatValid(range, p)).toBe(
        to === null
          ? formatValid(rangeFromPrecision(from, null, p).range, p)
          : `${formatValid(rangeFromPrecision(from, null, p).range, p)} → ${formatValid(rangeFromPrecision(to, null, p).range, p)}`
      );
    }
  });
});

describe('predicates', () => {
  const closed = r('2019-01-01', '2026-03-01');

  it.each<[ValidRange | null, string, boolean]>([
    [closed, '2019-01-01', true],
    [closed, '2018-12-31', false],
    [closed, '2026-02-28', true],
    [closed, '2026-03-01', false],
    [r('2019-01-01', null), '2999-01-01', true],
    [r(null, '2019-01-01'), '1000-01-01', true],
    [r(null, '2019-01-01'), '2019-01-01', false],
    [r(null, null), '2019-01-01', true],
    [null, '2019-01-01', true],
  ])('isValidAt(%j, %s) = %s', (range, at, expected) => {
    expect(isValidAt(range, d(at))).toBe(expected);
  });

  it('isValidAt is exclusive at `to` down to the millisecond', () => {
    expect(isValidAt(closed, new Date(d('2026-03-01').getTime() - 1))).toBe(true);
  });

  it.each<[ValidRange, ValidRange, boolean]>([
    [r('2019-01-01', '2020-01-01'), r('2020-01-01', '2021-01-01'), false],
    [r('2019-01-01', '2020-01-02'), r('2020-01-01', '2021-01-01'), true],
    [r('2019-01-01', null), r('2030-01-01', null), true],
    [r(null, '2019-01-01'), r('2019-01-01', null), false],
    [r(null, null), r('2019-01-01', '2019-01-02'), true],
    [r('2023-01-01', '2025-01-01'), r('2019-01-01', '2024-01-01'), true],
    [r('2010-01-01', '2011-01-01'), r('2019-01-01', '2024-01-01'), false],
  ])('rangesOverlap(%j, %j) = %s and is symmetric', (a, b, expected) => {
    expect(rangesOverlap(a, b)).toBe(expected);
    expect(rangesOverlap(b, a)).toBe(expected);
  });

  it.each<[ValidRange, ValidRange, boolean]>([
    [r('2019-01-01', '2026-01-01'), r('2020-01-01', '2020-01-02'), true],
    [r('2019-01-01', '2026-01-01'), r('2019-01-01', '2026-01-01'), true],
    [r('2019-01-01', '2026-01-01'), r('2025-06-01', '2026-06-01'), false],
    [r('2019-01-01', '2026-01-01'), r('2020-01-01', null), false],
    [r('2019-01-01', null), r('2020-01-01', null), true],
    [r('2019-01-01', null), r(null, '2020-01-01'), false],
    [r(null, null), r(null, '2020-01-01'), true],
  ])('rangeContainsRange(%j, %j) = %s', (outer, inner, expected) => {
    expect(rangeContainsRange(outer, inner)).toBe(expected);
  });

  it('isOpen and rangesEqual', () => {
    expect(isOpen(r('2019-01-01', null))).toBe(true);
    expect(isOpen(r(null, '2019-01-01'))).toBe(false);
    expect(rangesEqual(r('2019-01-01', null), r('2019-01-01', null))).toBe(true);
    expect(rangesEqual(r('2019-01-01', null), r('2019-01-01', '2020-01-01'))).toBe(false);
    expect(rangesEqual(r(null, null), r(null, null))).toBe(true);
  });
});
