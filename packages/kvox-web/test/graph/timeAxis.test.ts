import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  addBuckets,
  bucketForSpan,
  bucketLabel,
  bucketStart,
  bucketsBetween,
  formatDay,
  parseDay,
  parseRangeParams,
  quarterBuckets,
  rangeForInstant,
  rangeLabel,
  snapRange,
  zoomDomain,
} from '../../src/graph/ui/components/explorer/timebar/timeAxis.js';
import {
  activeEntities,
  activeInRange,
  buildColumns,
  dimmedFrom,
  stackOrder,
} from '../../src/graph/ui/components/explorer/timebar/timeBarModel.js';
import type { GraphActivityResponse } from '../../src/graph/headless/clients/graph.js';

const day = (value: string) => parseDay(value)!;

describe('the TimeBar calendar (UTC)', () => {
  it('parses only real calendar days', () => {
    expect(parseDay('2026-02-28')).not.toBeNull();
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('2026-2-3')).toBeNull();
    expect(parseDay(null)).toBeNull();
    expect(formatDay(day('2026-03-09'))).toBe('2026-03-09');
  });

  it('starts a week on Monday and a month on the 1st, like the API', () => {
    // 2026-03-04 is a Wednesday.
    expect(formatDay(bucketStart(day('2026-03-04'), 'week'))).toBe('2026-03-02');
    expect(formatDay(bucketStart(day('2026-03-08'), 'week'))).toBe('2026-03-02');
    expect(formatDay(bucketStart(day('2026-03-09'), 'week'))).toBe('2026-03-09');
    expect(formatDay(bucketStart(day('2026-03-31'), 'month'))).toBe('2026-03-01');
  });

  it('adds buckets across month and year ends', () => {
    expect(formatDay(addBuckets(day('2026-11-01'), 'month', 3))).toBe('2027-02-01');
    expect(formatDay(addBuckets(day('2026-01-01'), 'month', -1))).toBe('2025-12-01');
    expect(formatDay(addBuckets(day('2026-03-02'), 'week', 2))).toBe('2026-03-16');
    expect(quarterBuckets('month')).toBe(3);
    expect(quarterBuckets('week')).toBe(13);
  });

  it('lists every bucket start in a span', () => {
    const starts = bucketsBetween(day('2026-01-15'), day('2026-04-02'), 'month').map(formatDay);
    expect(starts).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('switches to weeks when the visible span is short', () => {
    expect(bucketForSpan(100 * DAY_MS)).toBe('week');
    expect(bucketForSpan(240 * DAY_MS)).toBe('week');
    expect(bucketForSpan(241 * DAY_MS)).toBe('month');
  });

  it('reads the from and to parameters only when both are dates in order', () => {
    expect(parseRangeParams('2026-01-01', '2026-04-01')).toEqual({ from: '2026-01-01', to: '2026-04-01' });
    expect(parseRangeParams('2026-04-01', '2026-01-01')).toBeNull();
    expect(parseRangeParams('2026-04-01', '2026-04-01')).toBeNull();
    expect(parseRangeParams('nope', '2026-04-01')).toBeNull();
    expect(parseRangeParams('2026-04-01', null)).toBeNull();
  });

  it('snaps a drag outward to whole buckets and never to an empty range', () => {
    expect(snapRange(day('2026-01-20'), day('2026-03-10'), 'month')).toEqual({ from: '2026-01-01', to: '2026-04-01' });
    expect(snapRange(day('2026-03-10'), day('2026-01-20'), 'month')).toEqual({ from: '2026-01-01', to: '2026-04-01' });
    expect(snapRange(day('2026-03-10'), day('2026-03-10'), 'month')).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    expect(snapRange(day('2026-03-04'), day('2026-03-04'), 'week')).toEqual({ from: '2026-03-02', to: '2026-03-09' });
  });

  it('turns an event date into its bucket for "Show in TimeBar"', () => {
    expect(rangeForInstant('2026-03-14')).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    expect(rangeForInstant('2026-03-14T23:59:00Z')).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    expect(rangeForInstant('2026-03-14', 'week')).toEqual({ from: '2026-03-09', to: '2026-03-16' });
    expect(rangeForInstant('not a date')).toBeNull();
  });

  it('labels buckets and ranges, ending on the last included day', () => {
    expect(bucketLabel(day('2026-03-01'), 'month')).toBe('Mar 2026');
    expect(bucketLabel(day('2026-03-09'), 'week')).toBe('9 Mar 2026');
    expect(rangeLabel({ from: '2026-03-01', to: '2026-04-01' }, 'month')).toBe('Mar 2026');
    expect(rangeLabel({ from: '2026-01-01', to: '2026-04-01' }, 'month')).toBe('Jan 2026 to Mar 2026');
    expect(rangeLabel({ from: '2026-03-02', to: '2026-03-09' }, 'week')).toBe('Week of 2 Mar 2026');
  });

  it('zooms around the anchor, within limits and never below four weeks', () => {
    const limits: [number, number] = [day('2025-01-01'), day('2026-01-01')];
    const [a, b] = zoomDomain(limits, 0.5, 0.5, limits);
    expect(b - a).toBeCloseTo((limits[1] - limits[0]) / 2, -3);
    expect(a + (b - a) / 2).toBeCloseTo(limits[0] + (limits[1] - limits[0]) / 2, -3);
    const [c, d] = zoomDomain([day('2025-06-01'), day('2025-06-10')], 0.5, 0.1, limits);
    expect(d - c).toBe(28 * DAY_MS);
    // Zooming out past the limits stays inside them.
    const [e, f] = zoomDomain([day('2025-03-01'), day('2025-04-01')], 0, 100, limits);
    expect(e).toBe(limits[0]);
    expect(f).toBe(limits[1]);
  });
});

const activity: GraphActivityResponse = {
  bucket: 'month',
  series: [
    { start: '2026-01-01', total: 3, byType: { Person: 2, Project: 1 } },
    { start: '2026-03-01', total: 5, byType: { Person: 1, Project: 4 } },
  ],
  byEntity: {
    joe: [
      { start: '2026-01-01', count: 2 },
      { start: '2026-03-01', count: 1 },
    ],
    copilot: [
      { start: '2026-01-01', count: 1 },
      { start: '2026-03-01', count: 4 },
    ],
    ana: [{ start: '2026-03-01', count: 1 }],
  },
};

describe('the TimeBar model', () => {
  it('builds one column per bucket, empty ones included, with the selection overlaid', () => {
    const columns = buildColumns(activity, [day('2026-01-01'), day('2026-05-01')], 'month', ['joe', 'ana']);
    expect(columns.map((c) => formatDay(c.start))).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(columns.map((c) => c.total)).toEqual([3, 0, 5, 0]);
    expect(columns.map((c) => c.overlay)).toEqual([2, 0, 2, 0]);
    expect(columns[2].byType).toEqual({ Person: 1, Project: 4 });
  });

  it('stacks the busiest type first, with a stable tie-break', () => {
    expect(stackOrder(activity.series)).toEqual(['Project', 'Person']);
    expect(stackOrder([{ start: '2026-01-01', total: 2, byType: { B: 1, A: 1 } }])).toEqual(['A', 'B']);
  });

  it('finds the entities with evidence in a window by bucket overlap', () => {
    expect([...activeEntities(activity, day('2026-03-01'), day('2026-04-01'))].sort()).toEqual(['ana', 'copilot', 'joe']);
    expect([...activeEntities(activity, day('2026-02-01'), day('2026-03-01'))]).toEqual([]);
    expect([...activeInRange(activity, { from: '2026-01-01', to: '2026-02-01' })!].sort()).toEqual(['copilot', 'joe']);
    // A window inside a month still overlaps that month's bucket.
    expect(activeEntities(activity, day('2026-03-20'), day('2026-03-21')).has('ana')).toBe(true);
  });

  it('dims the visible nodes outside the active set, and nothing when everything would dim', () => {
    const visible = ['joe', 'copilot', 'ana', 'ghost'];
    expect([...dimmedFrom(visible, new Set(['joe']))!].sort()).toEqual(['ana', 'copilot', 'ghost']);
    expect(dimmedFrom(visible, null)).toBeNull();
    expect(dimmedFrom(visible, new Set())).toBeNull();
  });
});
