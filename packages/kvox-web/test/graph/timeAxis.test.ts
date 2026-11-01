import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';
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
  addDaysToKey,
  dayKeyOf,
  todayDay,
  todayKey,
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

describe('the TimeBar calendar (day numbers, device zone UTC)', () => {
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
  timeZone: 'UTC',
  series: [
    { start: '2026-01-01', total: 3, byType: { Person: 2, Project: 1 } },
    { start: '2026-03-01', total: 5, byType: { Person: 1, Project: 4 } },
  ],
  byEntity: {
    joe: [
      { start: '2026-01-01', count: 2 },
      { start: '2026-03-01', count: 1 },
    ],
    productx: [
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
    expect([...activeEntities(activity, day('2026-03-01'), day('2026-04-01'))].sort()).toEqual(['ana', 'joe', 'productx']);
    expect([...activeEntities(activity, day('2026-02-01'), day('2026-03-01'))]).toEqual([]);
    expect([...activeInRange(activity, { from: '2026-01-01', to: '2026-02-01' })!].sort()).toEqual(['joe', 'productx']);
    // A window inside a month still overlaps that month's bucket.
    expect(activeEntities(activity, day('2026-03-20'), day('2026-03-21')).has('ana')).toBe(true);
  });

  it('dims the visible nodes outside the active set, and nothing when everything would dim', () => {
    const visible = ['joe', 'productx', 'ana', 'ghost'];
    expect([...dimmedFrom(visible, new Set(['joe']))!].sort()).toEqual(['ana', 'ghost', 'productx']);
    expect(dimmedFrom(visible, null)).toBeNull();
    expect(dimmedFrom(visible, new Set())).toBeNull();
  });
});

/**
 * The axis is the user's calendar (#time-zones): the API cuts buckets in the
 * requester's zone, so the same instant can sit in another bucket for a viewer
 * in Tokyo than for one in Los Angeles.
 */
describe('the TimeBar calendar in the display zone', () => {
  const TOKYO = 'Asia/Tokyo';
  const LA = 'America/Los_Angeles';
  // 20:00 UTC on 31 March: 05:00 on 1 April in Tokyo, 13:00 on 31 March in Los Angeles.
  const LATE_MARCH_UTC = '2026-03-31T20:00:00Z';

  it('reads today as the local calendar day, either side of midnight', () => {
    expect(todayKey(Date.parse(LATE_MARCH_UTC), TOKYO)).toBe('2026-04-01');
    expect(todayKey(Date.parse(LATE_MARCH_UTC), LA)).toBe('2026-03-31');
    expect(todayDay(new Date(LATE_MARCH_UTC), TOKYO)).toBe(day('2026-04-01'));
  });

  it('defaults to the display zone', () => {
    setPreferredTimeZone(TOKYO);
    expect(todayKey(Date.parse(LATE_MARCH_UTC))).toBe('2026-04-01');
    expect(dayKeyOf(LATE_MARCH_UTC)).toBe('2026-04-01');
    setPreferredTimeZone(LA);
    expect(todayKey(Date.parse(LATE_MARCH_UTC))).toBe('2026-03-31');
  });

  it('puts an instant in the bucket of its local day: April in Tokyo, March in Los Angeles', () => {
    expect(rangeForInstant(LATE_MARCH_UTC, 'month', TOKYO)).toEqual({ from: '2026-04-01', to: '2026-05-01' });
    expect(rangeForInstant(LATE_MARCH_UTC, 'month', LA)).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    // Tuesday 31 March vs Wednesday 1 April: both in the week of Monday 30 March.
    expect(rangeForInstant(LATE_MARCH_UTC, 'week', TOKYO)).toEqual({ from: '2026-03-30', to: '2026-04-06' });
    // A bare day is a calendar day already and never shifts with the zone.
    expect(rangeForInstant('2026-03-31', 'month', TOKYO)).toEqual({ from: '2026-03-01', to: '2026-04-01' });
  });

  it('starts a week on the local Monday: Sunday 23:30 in Los Angeles is still the previous week', () => {
    // 2026-03-09T06:30Z is Sunday 8 March 23:30 PDT (DST began that morning) and Monday 15:30 in Tokyo.
    expect(rangeForInstant('2026-03-09T06:30:00Z', 'week', LA)).toEqual({ from: '2026-03-02', to: '2026-03-09' });
    expect(rangeForInstant('2026-03-09T06:30:00Z', 'week', TOKYO)).toEqual({ from: '2026-03-09', to: '2026-03-16' });
  });

  it('keeps a DST week seven calendar days long (the local week is 167 or 169 hours)', () => {
    // US DST ends Sunday 1 November 2026: the week of Monday 26 October has 169 local hours.
    const week = rangeForInstant('2026-10-28T12:00:00Z', 'week', LA)!;
    expect(week).toEqual({ from: '2026-10-26', to: '2026-11-02' });
    expect(addBuckets(day(week.from), 'week', 1)).toBe(day('2026-11-02'));
    expect(bucketsBetween(day('2026-10-26'), day('2026-11-16'), 'week').map(formatDay)).toEqual([
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
    ]);
    // 00:30 local on Monday 2 November (UTC−8 after the change) is in the next week.
    expect(rangeForInstant('2026-11-02T08:30:00Z', 'week', LA)).toEqual({ from: '2026-11-02', to: '2026-11-09' });
    expect(rangeForInstant('2026-11-02T07:30:00Z', 'week', LA)).toEqual({ from: '2026-10-26', to: '2026-11-02' });
  });

  it('counts calendar days on date keys, across a DST change', () => {
    expect(addDaysToKey('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDaysToKey('2026-11-02', -30)).toBe('2026-10-03');
    expect(addDaysToKey('nope', 1)).toBeNull();
  });

  it('labels a bucket by its calendar date whatever the display zone', () => {
    setPreferredTimeZone(LA);
    expect(bucketLabel(day('2026-04-01'), 'month')).toBe('Apr 2026');
    expect(bucketLabel(day('2026-03-30'), 'week')).toBe('30 Mar 2026');
  });
});
