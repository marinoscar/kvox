/**
 * Merging a re-read page one back into an accumulated feed — issue #167,
 * epic #162.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE HOOK SUITES
 * =============================================================================
 *
 * The bug #167 fixes was invisible to every test that existed. `loadMore`'s
 * append semantics were covered; `load`'s reset semantics were covered; the
 * INTERACTION between them — a background poll landing on a list that had been
 * grown by "Load more" — was not, and that is precisely where sixty rows
 * silently became twenty, several times a minute, with no error and no spinner.
 *
 * `reconcileFeed` is the pure function that interaction now goes through, so
 * this suite pins the merge rule itself: no React, no timers, no service mocks,
 * just `{ id, updatedAt }` objects in and out. Every clause of the merge is
 * paying for one specific observable behaviour (see the module's own header),
 * so each of those behaviours gets its own named test rather than being folded
 * into one "it merges correctly" — a future reader deleting a clause should be
 * told by the test name exactly what they broke.
 *
 * ⚠ ONE TEST HERE ASSERTS A LIMITATION RATHER THAN A CAPABILITY. A row deleted
 * from deep in the accumulated TAIL survives a revalidation, because page one
 * is the only thing the server was asked about. That is a documented, deliberate
 * trade (the alternative is re-reading every loaded page every twenty seconds),
 * and it is asserted here so that changing it is a decision somebody makes on
 * purpose rather than a test that starts failing for unclear reasons.
 */

import { describe, it, expect } from 'vitest';

import { compareFeedRows, reconcileFeed } from '../../utils/feedReconcile';
import type { FeedState } from '../../utils/feedReconcile';

/** A minimal feed row. Both real row types satisfy `FeedRow` structurally. */
interface Row {
  id: string;
  updatedAt: string;
  title: string;
}

/**
 * `n` rows, newest first, one minute apart.
 *
 * `row-000` is the newest. Minute-spaced rather than millisecond-spaced so the
 * ISO strings differ in a visible field and a failure message is readable.
 */
function feed(n: number, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const index = offset + i;
    const minute = String(600 - index).padStart(3, '0');
    return {
      id: `row-${String(index).padStart(3, '0')}`,
      updatedAt: `2026-03-12T14:${minute.slice(1)}:00.000Z`,
      title: `Row ${index}`,
    };
  });
}

function state(items: Row[], nextCursor: string | null): FeedState<Row> {
  return { items, nextCursor };
}

const ids = (rows: Row[]) => rows.map((row) => row.id);

describe('compareFeedRows', () => {
  it('sorts NEWER first, matching the API\'s `updatedAt` DESC', () => {
    const newer = { id: 'a', updatedAt: '2026-03-12T14:05:00.000Z' };
    const older = { id: 'b', updatedAt: '2026-03-12T14:00:00.000Z' };

    expect(compareFeedRows(newer, older)).toBeLessThan(0);
    expect(compareFeedRows(older, newer)).toBeGreaterThan(0);
  });

  it('breaks an `updatedAt` tie on `id` DESC, never leaving a row unreachable', () => {
    // The compound tie-break is not decoration: `updatedAt` alone is not
    // unique, and two rows sharing a millisecond under a bare timestamp cursor
    // would make one of them permanently unreachable by paging.
    const at = '2026-03-12T14:00:00.000Z';

    expect(compareFeedRows({ id: 'b', updatedAt: at }, { id: 'a', updatedAt: at })).toBeLessThan(0);
    expect(compareFeedRows({ id: 'a', updatedAt: at }, { id: 'b', updatedAt: at })).toBeGreaterThan(0);
  });

  it('reports 0 for the same row', () => {
    const row = { id: 'a', updatedAt: '2026-03-12T14:00:00.000Z' };
    expect(compareFeedRows(row, row)).toBe(0);
  });

  it('sorts an array into the exact order the API returns', () => {
    const at = '2026-03-12T14:00:00.000Z';
    const later = '2026-03-12T14:01:00.000Z';
    const shuffled = [
      { id: 'a', updatedAt: at },
      { id: 'z', updatedAt: at },
      { id: 'm', updatedAt: later },
    ];

    expect(shuffled.slice().sort(compareFeedRows).map((r) => r.id)).toEqual(['m', 'z', 'a']);
  });
});

describe('reconcileFeed — clause 1, nothing accumulated', () => {
  it('adopts the page and its cursor when the held list is empty', () => {
    const page = { items: feed(20), nextCursor: 'cursor-2' };

    const result = reconcileFeed(state([], null), page);

    expect(result.items).toEqual(page.items);
    expect(result.nextCursor).toBe('cursor-2');
  });
});

describe('reconcileFeed — clause 2, the page IS the whole result set', () => {
  it('drops the accumulated tail when the server answers a null cursor', () => {
    // 60 rows held; the server now says only 5 match. Those 55 no longer
    // satisfy the query, and this clause is the ONLY way a shrinking list
    // shrinks — nothing else in the merge removes rows below page one.
    const held = state(feed(60), 'cursor-4');

    const result = reconcileFeed(held, { items: feed(5), nextCursor: null });

    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it('empties the feed entirely when nothing matches any more', () => {
    const result = reconcileFeed(state(feed(40), 'cursor-3'), { items: [], nextCursor: null });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

describe('reconcileFeed — clause 3, a full page with more behind it', () => {
  it('KEEPS 60 accumulated rows when page one is re-read — the bug #167 fixed', () => {
    // The whole issue in one assertion: three pages loaded, a background poll
    // lands, and the answer is still 60 rows rather than the 20 the poll asked
    // for.
    const held = state(feed(60), 'cursor-4');

    const result = reconcileFeed(held, { items: feed(20), nextCursor: 'cursor-2' });

    expect(result.items).toHaveLength(60);
    expect(ids(result.items)).toEqual(ids(feed(60)));
  });

  it('keeps the CURRENT cursor, never the page\'s, so paging does not rewind', () => {
    // Taking the page's cursor would point `loadMore` back at page two: the
    // next press re-fetches rows already on screen, the dedupe swallows them,
    // and the feed appears to stop growing.
    const result = reconcileFeed(state(feed(60), 'cursor-4'), {
      items: feed(20),
      nextCursor: 'cursor-2',
    });

    expect(result.nextCursor).toBe('cursor-4');
  });

  it('puts a NEW row at the top without disturbing anything below it', () => {
    const held = state(feed(60), 'cursor-4');
    const fresh: Row = {
      id: 'row-new',
      updatedAt: '2026-03-12T14:99:00.000Z'.replace('99', '59'),
      title: 'Brand new',
    };
    // A new row pushes the page's oldest row out of the window, exactly as the
    // server would.
    const page = { items: [fresh, ...feed(19)], nextCursor: 'cursor-2' };

    const result = reconcileFeed(held, page);

    expect(result.items[0]).toBe(fresh);
    expect(result.items).toHaveLength(61);
    expect(new Set(ids(result.items)).size).toBe(61);
  });

  it('updates a CHANGED row in place and leaves no stale duplicate behind', () => {
    // Row 45 was edited, so `updatedAt DESC` puts it at the top. Without the
    // "drop ids the page re-sent" clause it would render twice — two different
    // titles, one duplicate React key, and a console warning as the only clue.
    const held = state(feed(60), 'cursor-4');
    const moved: Row = {
      id: 'row-045',
      updatedAt: '2026-03-12T15:00:00.000Z',
      title: 'Edited just now',
    };
    const page = { items: [moved, ...feed(19)], nextCursor: 'cursor-2' };

    const result = reconcileFeed(held, page);

    const matches = result.items.filter((row) => row.id === 'row-045');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Edited just now');
    expect(result.items[0].id).toBe('row-045');
  });

  it('REMOVES a row that was inside page one\'s window and is now absent', () => {
    const held = state(feed(60), 'cursor-4');
    // row-007 was deleted elsewhere; the server backfills row-020 into the
    // window it vacated.
    const page = {
      items: [...feed(7), ...feed(12, 8), ...feed(1, 20)],
      nextCursor: 'cursor-2',
    };

    const result = reconcileFeed(held, page);

    expect(ids(result.items)).not.toContain('row-007');
    expect(result.items).toHaveLength(59);
  });

  it('keeps a row deleted from deep in the TAIL — the documented limit, not a bug', () => {
    // Page one is the only thing the server was asked about, so a row at
    // position 45 that vanished elsewhere is invisible to this merge. It goes
    // on the next filter change, navigation or `loadMore`. Re-reading every
    // loaded page instead would be correct and is REJECTED: fifteen requests
    // every twenty seconds for a 300-row feed is the cellular cost epic #162
    // rejected auto-infinite-scroll over.
    const held = state(feed(60), 'cursor-4');

    const result = reconcileFeed(held, { items: feed(20), nextCursor: 'cursor-2' });

    expect(ids(result.items)).toContain('row-045');
  });

  it('adopts the page and keeps paging if a cursor arrives with no items', () => {
    // Not something this API produces — the cursor is encoded FROM the last
    // item — but inventing a boundary from an empty page would delete the whole
    // tail, so the merge declines instead.
    const held = state(feed(60), 'cursor-4');

    const result = reconcileFeed(held, { items: [], nextCursor: 'cursor-2' });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe('cursor-4');
  });
});

describe('reconcileFeed — purity', () => {
  it('mutates neither input', () => {
    const heldItems = feed(60);
    const pageItems = feed(20);
    const heldSnapshot = ids(heldItems);
    const pageSnapshot = ids(pageItems);

    reconcileFeed(state(heldItems, 'cursor-4'), { items: pageItems, nextCursor: 'cursor-2' });

    expect(ids(heldItems)).toEqual(heldSnapshot);
    expect(ids(pageItems)).toEqual(pageSnapshot);
  });

  it('is deterministic — the same inputs give the same answer', () => {
    const held = state(feed(60), 'cursor-4');
    const page = { items: feed(20), nextCursor: 'cursor-2' };

    expect(reconcileFeed(held, page)).toEqual(reconcileFeed(held, page));
  });
});
