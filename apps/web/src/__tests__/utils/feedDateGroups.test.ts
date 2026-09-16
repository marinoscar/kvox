/**
 * Date groups and the result-count line — issue #190, epic #162.
 *
 * Every interesting case here is a MIDNIGHT, which is exactly why
 * `groupFeedByDate` takes `now` as an argument instead of reading the clock: a
 * function that called `Date.now()` could only be tested by pretending to move
 * time, and the assertions would be about the fake timer rather than about the
 * boundary.
 *
 * ⚠ The buckets are LOCAL CALENDAR DAYS, not 24-hour windows. These tests build
 * their fixtures with the local-time `Date` constructor for that reason — using
 * UTC literals would make them pass or fail depending on the runner's timezone,
 * which is the one thing a date test must never do.
 */

import { describe, it, expect } from 'vitest';

import {
  feedCountLabel,
  feedDateBucket,
  groupFeedByDate,
} from '../../utils/feedDateGroups';

/** A local-time instant, so these tests read the same in every timezone. */
function at(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min);
}

/** A row with a local-time `updatedAt`, serialized the way the API would. */
function row(date: Date, id = 'r') {
  return { id, updatedAt: date.toISOString() };
}

const NOW = at(2026, 9, 15, 14, 30);

describe('feedDateBucket', () => {
  it('calls the same calendar date Today, however many hours ago', () => {
    expect(feedDateBucket(at(2026, 9, 15, 0, 1).toISOString(), NOW).label).toBe('Today');
    expect(feedDateBucket(at(2026, 9, 15, 14, 29).toISOString(), NOW).label).toBe('Today');
  });

  it('calls the previous calendar date Yesterday, not "24 hours ago"', () => {
    // 11pm the night before is Yesterday at 1am — a 2-hour gap. A 24-hour
    // window would call it Today, which is not what the reader means.
    expect(feedDateBucket(at(2026, 9, 14, 23, 0).toISOString(), at(2026, 9, 15, 1, 0)).label).toBe(
      'Yesterday',
    );
    expect(feedDateBucket(at(2026, 9, 14, 0, 5).toISOString(), NOW).label).toBe('Yesterday');
  });

  it('groups 2 to 6 days back as This week', () => {
    expect(feedDateBucket(at(2026, 9, 13).toISOString(), NOW).label).toBe('This week');
    expect(feedDateBucket(at(2026, 9, 9).toISOString(), NOW).label).toBe('This week');
  });

  it('groups 7 to 30 days back as This month', () => {
    expect(feedDateBucket(at(2026, 9, 8).toISOString(), NOW).label).toBe('This month');
    expect(feedDateBucket(at(2026, 8, 16).toISOString(), NOW).label).toBe('This month');
  });

  it('names the calendar month past 30 days, rather than a relative phrase', () => {
    // "August 2026" stays true tomorrow; "2 months ago" silently becomes wrong
    // the moment the page is left open.
    const bucket = feedDateBucket(at(2026, 8, 10).toISOString(), NOW);
    expect(bucket.key).toBe('m-2026-08');
    expect(bucket.label).toMatch(/2026/);
  });

  it('separates the same month in different years', () => {
    expect(feedDateBucket(at(2025, 8, 10).toISOString(), NOW).key).toBe('m-2025-08');
    expect(feedDateBucket(at(2026, 8, 10).toISOString(), NOW).key).toBe('m-2026-08');
  });

  it('buckets a future timestamp as Today rather than dropping it', () => {
    // Clock skew between the server and the reader's device is real, and a row
    // that vanishes from the feed because of it would be a far worse bug than
    // one filed under the wrong heading.
    expect(feedDateBucket(at(2026, 9, 16).toISOString(), NOW).label).toBe('Today');
  });

  it('gives an unparseable timestamp its own bucket rather than crashing', () => {
    expect(feedDateBucket('not-a-date', NOW)).toEqual({ key: 'unknown', label: 'Undated' });
  });
});

describe('groupFeedByDate', () => {
  it('cuts a feed into runs, preserving the order it was given', () => {
    const items = [
      row(at(2026, 9, 15), 'a'),
      row(at(2026, 9, 15, 9), 'b'),
      row(at(2026, 9, 14), 'c'),
      row(at(2026, 9, 12), 'd'),
      row(at(2026, 8, 3), 'e'),
    ];

    const groups = groupFeedByDate(items, NOW);

    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'This week',
      groups[3].label,
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
      ['e'],
    ]);
  });

  it('never produces an empty group, so no bare heading can render', () => {
    const groups = groupFeedByDate([row(at(2026, 9, 15), 'a')], NOW);

    expect(groups).toHaveLength(1);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it('returns nothing for an empty feed', () => {
    expect(groupFeedByDate([], NOW)).toEqual([]);
  });

  it('keeps every row — grouping never drops one', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      row(at(2026, 9, 15 - Math.floor(i / 2)), `r${i}`),
    );

    const grouped = groupFeedByDate(items, NOW).flatMap((g) => g.items);

    expect(grouped.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('gives every group a key unique within the grouping', () => {
    // They are React keys. A duplicate would silently drop a whole run of rows.
    const items = [
      row(at(2026, 9, 15), 'a'),
      row(at(2026, 9, 14), 'b'),
      row(at(2026, 9, 11), 'c'),
      row(at(2026, 9, 1), 'd'),
      row(at(2026, 8, 1), 'e'),
      row(at(2026, 7, 1), 'f'),
    ];

    const keys = groupFeedByDate(items, NOW).map((g) => g.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('feedCountLabel', () => {
  it('counts with the right plural', () => {
    expect(feedCountLabel(42, { one: 'transcript', many: 'transcripts' })).toBe('42 transcripts');
    expect(feedCountLabel(1, { one: 'transcript', many: 'transcripts' })).toBe('1 transcript');
  });

  it('names the search term when one is active', () => {
    expect(feedCountLabel(3, { one: 'note', many: 'notes' }, 'budget')).toBe(
      '3 notes matching “budget”',
    );
    expect(feedCountLabel(1, { one: 'note', many: 'notes' }, 'budget')).toBe(
      '1 note matching “budget”',
    );
  });

  it('names the term when a search matched nothing', () => {
    // The empty state below is about the FILTER here, and naming what the user
    // typed is the whole point of the line.
    expect(feedCountLabel(0, { one: 'note', many: 'notes' }, 'budget')).toBe(
      'No notes match “budget”',
    );
  });

  it('says NOTHING for an empty library, leaving the empty state to speak', () => {
    // Both views already render a heading, an explanation and a call to action
    // for this case. A count line repeating it would be the same sentence
    // twice — and the second copy sits in a live region a screen reader reads
    // out.
    expect(feedCountLabel(0, { one: 'note', many: 'notes' })).toBe('');
    expect(feedCountLabel(0, { one: 'note', many: 'notes' }, '  ')).toBe('');
  });

  it('treats a whitespace-only term as no term at all', () => {
    expect(feedCountLabel(5, { one: 'note', many: 'notes' }, '   ')).toBe('5 notes');
  });
});
