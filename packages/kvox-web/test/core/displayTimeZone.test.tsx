/**
 * Times in the reader's display time zone — the platform's display-zone store
 * (`@marinoscar/platform-web/timezone/headless`) read by the core date helpers
 * and by a packaged component.
 *
 * Every case is an instant that falls on DIFFERENT calendar days in Tokyo
 * (UTC+9) and Los Angeles (UTC−7 in October): the grouping and the rendered day
 * must follow the zone, never the runner's (`TZ=UTC`, `vitest.config.ts`).
 */

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';

import { feedDateBucket, groupFeedByDate } from '../../src/core/headless/utils/feedDateGroups.js';
import { formatShortDate } from '../../src/core/headless/utils/relativeTime.js';
import { EntityMergedFromList } from '../../src/graph/ui/components/EntityMergedFromList.js';
import type { EntityMergeRow } from '../../src/graph/headless/clients/graph.js';

const TOKYO = 'Asia/Tokyo';
const LA = 'America/Los_Angeles';

// 16:00 UTC on 20 Oct 2026: 01:00 on the 21st in Tokyo, 09:00 on the 20th in LA.
const NOW = new Date('2026-10-20T16:00:00.000Z');
// 14:30 UTC: 23:30 on the 20th in Tokyo (the evening before NOW there), 07:30 on the 20th in LA.
const LATE_EVENING_IN_TOKYO = '2026-10-20T14:30:00.000Z';

describe('feed day grouping across midnight', () => {
  it('calls a row Yesterday in Tokyo and Today in Los Angeles', () => {
    expect(feedDateBucket(LATE_EVENING_IN_TOKYO, NOW, TOKYO).key).toBe('yesterday');
    expect(feedDateBucket(LATE_EVENING_IN_TOKYO, NOW, LA).key).toBe('today');
  });

  it('cuts the same feed into different groups per zone', () => {
    const rows = [
      { id: 'a', updatedAt: '2026-10-20T15:30:00.000Z' }, // Tokyo 00:30 on the 21st, LA 08:30 on the 20th
      { id: 'b', updatedAt: LATE_EVENING_IN_TOKYO }, // Tokyo 23:30 on the 20th, LA 07:30 on the 20th
      { id: 'c', updatedAt: '2026-10-20T06:00:00.000Z' }, // Tokyo 15:00 on the 20th, LA 23:00 on the 19th
    ];

    const tokyo = groupFeedByDate(rows, NOW, TOKYO);
    expect(tokyo.map((group) => [group.label, group.items.map((row) => row.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b', 'c']],
    ]);

    const la = groupFeedByDate(rows, NOW, LA);
    expect(la.map((group) => [group.label, group.items.map((row) => row.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
    ]);
  });

  it('names an old row by its month in the zone', () => {
    // 20:00 UTC on 31 Aug: 05:00 on 1 Sep in Tokyo, 13:00 on 31 Aug in LA.
    const old = '2026-08-31T20:00:00.000Z';
    expect(feedDateBucket(old, NOW, TOKYO)).toEqual({ key: 'm-2026-09', label: expect.stringMatching(/September 2026/) });
    expect(feedDateBucket(old, NOW, LA)).toEqual({ key: 'm-2026-08', label: expect.stringMatching(/August 2026/) });
  });

  it('defaults to the display zone the user chose', () => {
    setPreferredTimeZone(TOKYO);
    expect(feedDateBucket(LATE_EVENING_IN_TOKYO, NOW).key).toBe('yesterday');
    setPreferredTimeZone(LA);
    expect(groupFeedByDate([{ updatedAt: LATE_EVENING_IN_TOKYO }], NOW)[0]?.key).toBe('today');
  });

  it('still files an unparseable timestamp as Undated', () => {
    expect(feedDateBucket('not a date', NOW, TOKYO)).toEqual({ key: 'unknown', label: 'Undated' });
  });
});

describe('formatShortDate in a zone', () => {
  it('dates the moment by the zone’s calendar', () => {
    expect(formatShortDate(LATE_EVENING_IN_TOKYO, NOW, TOKYO)).toMatch(/20/);
    expect(formatShortDate('2026-10-20T15:30:00.000Z', NOW, TOKYO)).toMatch(/21/);
    expect(formatShortDate('2026-10-20T15:30:00.000Z', NOW, LA)).toMatch(/20/);
  });

  it('adds the year only when it is not the zone’s current year', () => {
    // 1 Jan 2027 03:00 in Tokyo is still 2026 in LA: the year shows in neither.
    const newYear = new Date('2026-12-31T18:00:00.000Z');
    expect(formatShortDate(newYear.toISOString(), newYear, TOKYO)).not.toMatch(/2027/);
    expect(formatShortDate(newYear.toISOString(), newYear, LA)).not.toMatch(/2026/);
    // Seen from LA's 2026, a Tokyo-2027 instant read in Tokyo carries its year.
    expect(formatShortDate(newYear.toISOString(), new Date('2026-06-01T00:00:00.000Z'), TOKYO)).toMatch(/2027/);
  });

  it('returns the input when it does not parse', () => {
    expect(formatShortDate('garbage', NOW, TOKYO)).toBe('garbage');
  });
});

describe('a packaged component renders its day in the display zone', () => {
  const merges: EntityMergeRow[] = [
    {
      mergeId: '00000000-0000-4000-8000-000000000001',
      mergedEntity: { id: '00000000-0000-4000-8000-000000000002', label: 'Ana Diaz', type: 'Person' },
      // 20:00 UTC on 20 Oct: 05:00 on the 21st in Tokyo, 13:00 on the 20th in LA.
      createdAt: '2026-10-20T20:00:00.000Z',
      reversedAt: null,
      reversible: true,
    },
  ];

  const day = (timeZone: string) =>
    `Merged ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone }).format(new Date(merges[0]!.createdAt))}`;

  it('shows the Tokyo day, then re-renders when the user picks another zone', () => {
    expect(day(TOKYO)).not.toBe(day(LA));
    setPreferredTimeZone(TOKYO);
    render(<EntityMergedFromList merges={merges} canUndo={false} onUndo={() => {}} />);
    expect(screen.getByText(day(TOKYO))).toBeInTheDocument();

    act(() => setPreferredTimeZone(LA));
    expect(screen.getByText(day(LA))).toBeInTheDocument();
    expect(screen.queryByText(day(TOKYO))).not.toBeInTheDocument();
  });
});
