import {
  AS_OF_STATUSES,
  edgesAsOf,
  type TemporalEdge,
  type TemporalReviewStatus,
  type ValidRange,
} from './index';

const d = (s: string): Date => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});

function edge(over: Partial<TemporalEdge> & Pick<TemporalEdge, 'id'>): TemporalEdge {
  return {
    type: 'REPORTS_TO',
    fromId: 'joe',
    toId: 'jane',
    props: {},
    valid: null,
    precision: 'day',
    reviewStatus: 'accepted',
    ...over,
  };
}

const ids = (edges: TemporalEdge[]) => edges.map((e) => e.id);

describe('edgesAsOf — manager change (§5.4 worked example)', () => {
  // Joe REPORTS_TO Jane [2020-01-01, 2026-03-01); from March 2026, Will.
  const jane = edge({
    id: 'jane',
    toId: 'jane',
    valid: r('2020-01-01', '2026-03-01'),
    reviewStatus: 'superseded',
  });
  const will = edge({ id: 'will', toId: 'will', valid: r('2026-03-01', null) });
  const edges = [jane, will];

  it.each<[string, string, string[]]>([
    ['before either', '2019-06-01', []],
    ['at Jane’s start (inclusive)', '2020-01-01', ['jane']],
    ['as of January 2024', '2024-01-15', ['jane']],
    ['the last ms of Jane', '2026-02-28T23:59:59.999Z', ['jane']],
    ['the boundary belongs to Will', '2026-03-01', ['will']],
    ['after', '2030-01-01', ['will']],
  ])('%s (%s)', (_label, at, expected) => {
    expect(ids(edgesAsOf(edges, d(at)))).toEqual(expected);
  });

  it('reads the closed edge whether it is superseded or still accepted', () => {
    const accepted = { ...jane, reviewStatus: 'accepted' as const };
    expect(ids(edgesAsOf([accepted, will], d('2024-01-15')))).toEqual(['jane']);
  });
});

describe('edgesAsOf — promotion (§5.4 worked example)', () => {
  const engineer = edge({
    id: 'engineer',
    type: 'HAS_ROLE',
    toId: 'acme',
    props: { title: 'Engineer' },
    valid: r('2019-01-01', '2026-03-01'),
    reviewStatus: 'superseded',
  });
  const staff = edge({
    id: 'staff',
    type: 'HAS_ROLE',
    toId: 'acme',
    props: { title: 'Staff Engineer' },
    valid: r('2026-03-01', null),
    reviewStatus: 'edited',
  });

  it.each<[string, string[]]>([
    ['2018-12-31T23:59:59.999Z', []],
    ['2019-01-01', ['engineer']],
    ['2025-06-30', ['engineer']],
    ['2026-03-01', ['staff']],
    ['2040-01-01', ['staff']],
  ])('as of %s', (at, expected) => {
    expect(ids(edgesAsOf([engineer, staff], d(at)))).toEqual(expected);
  });
});

describe('edgesAsOf — review status filtering', () => {
  it.each<[TemporalReviewStatus, boolean]>([
    ['accepted', true],
    ['edited', true],
    ['superseded', true],
    ['merged', false],
    ['rejected', false],
    ['unreviewed', false],
  ])('%s → kept: %p', (status, kept) => {
    const e = edge({ id: 'e', valid: r('2020-01-01', null), reviewStatus: status });
    expect(edgesAsOf([e], d('2024-01-01'))).toHaveLength(kept ? 1 : 0);
    expect(AS_OF_STATUSES.has(status)).toBe(kept);
  });

  it('a null-range edge (non-temporal or unknown) is valid at every instant', () => {
    const e = edge({ id: 'unknown', valid: null, precision: 'unknown' });
    expect(ids(edgesAsOf([e], d('1970-01-01')))).toEqual(['unknown']);
    expect(ids(edgesAsOf([e], d('2999-01-01')))).toEqual(['unknown']);
  });

  it('keeps input order and does not mutate its input', () => {
    const a = edge({ id: 'b-second', valid: r('2020-01-01', null) });
    const b = edge({ id: 'a-first', valid: null });
    const input = Object.freeze([a, b]);
    expect(ids(edgesAsOf(input, d('2024-01-01')))).toEqual(['b-second', 'a-first']);
    expect(input).toEqual([a, b]);
  });
});
