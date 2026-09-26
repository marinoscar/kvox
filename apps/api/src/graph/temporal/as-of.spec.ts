import { edgesAsOf, type TemporalEdge, type TemporalReviewStatus, type ValidRange } from './index';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const r = (from: string | null, to: string | null): ValidRange => ({
  from: from === null ? null : d(from),
  to: to === null ? null : d(to),
});
const edge = (
  id: string,
  type: string,
  toId: string,
  valid: ValidRange | null,
  reviewStatus: TemporalReviewStatus = 'accepted',
  props: Record<string, unknown> = {}
): TemporalEdge => ({
  id,
  type,
  fromId: 'joe',
  toId,
  props,
  valid,
  precision: valid ? 'month' : 'unknown',
  reviewStatus,
});
const ids = (edges: TemporalEdge[]): string[] => edges.map((e) => e.id);

describe('edgesAsOf — manager change (§5.4)', () => {
  // Jane [2020-01-01, 2026-03-01), superseded by Will [2026-03-01, ).
  const edges = [
    edge('jane', 'REPORTS_TO', 'jane', r('2020-01-01', '2026-03-01'), 'superseded'),
    edge('will', 'REPORTS_TO', 'will', r('2026-03-01', null)),
  ];

  it.each<[string, string[]]>([
    ['2019-12-31', []], // before
    ['2020-01-01', ['jane']], // lower boundary, inclusive
    ['2024-01-15', ['jane']], // inside — the spec's "as of January 2024"
    ['2026-02-28', ['jane']], // last day inside
    ['2026-03-01', ['will']], // upper boundary: exclusive for Jane, inclusive for Will
    ['2030-01-01', ['will']], // after
  ])('as of %s → %j', (at, expected) => {
    expect(ids(edgesAsOf(edges, d(at)))).toEqual(expected);
  });
});

describe('edgesAsOf — promotion (§5.4)', () => {
  const edges = [
    edge('engineer', 'HAS_ROLE', 'acme', r('2019-01-01', '2026-03-01'), 'superseded', {
      title: 'Engineer',
    }),
    edge('staff', 'HAS_ROLE', 'acme', r('2026-03-01', null), 'accepted', {
      title: 'Staff Engineer',
    }),
  ];

  it.each<[string, string[]]>([
    ['2018-06-01', []],
    ['2019-01-01', ['engineer']],
    ['2023-06-15', ['engineer']],
    ['2026-03-01', ['staff']],
    ['2027-01-01', ['staff']],
  ])('as of %s → %j', (at, expected) => {
    expect(ids(edgesAsOf(edges, d(at)))).toEqual(expected);
  });
});

describe('edgesAsOf — review-status filtering', () => {
  it.each<[TemporalReviewStatus, boolean]>([
    ['accepted', true],
    ['edited', true],
    ['superseded', true],
    ['merged', false],
    ['rejected', false],
    ['unreviewed', false],
  ])('%s is kept: %s', (status, kept) => {
    const e = edge('x', 'WORKS_FOR', 'acme', r('2019-01-01', null), status);
    expect(edgesAsOf([e], d('2020-01-01'))).toEqual(kept ? [e] : []);
  });

  it('keeps a null-range (unknown precision) edge at every date', () => {
    const e = edge('u', 'WORKS_FOR', 'acme', null);
    expect(edgesAsOf([e], d('1900-01-01'))).toEqual([e]);
    expect(edgesAsOf([e], d('2100-01-01'))).toEqual([e]);
  });

  it('preserves input order and does not mutate its input', () => {
    const edges = Object.freeze([
      edge('b', 'WORKS_FOR', 'beta', r('2019-01-01', null)),
      edge('a', 'WORKS_FOR', 'acme', r('2018-01-01', null)),
    ]);
    expect(ids(edgesAsOf(edges, d('2020-01-01')))).toEqual(['b', 'a']);
  });
});
