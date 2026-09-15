import { describe, it, expect } from 'vitest';

import {
  FEED_MAX_PAGE_SIZE,
  mergeFeedPage,
  planFeedRevalidate,
  type FeedRow,
} from '../../hooks/mergeFeedPage';

/**
 * `mergeFeedPage.ts`'s two pure functions — issue #167.
 *
 * These pin the merge rule directly, with no hook, timer or mocked service in
 * the way: `planFeedRevalidate` decides how big a re-read to ask for and
 * whether its cursor can be believed, and `mergeFeedPage` folds that answer
 * back into the accumulated list. `useTranscripts.test.tsx` and
 * `useNotes.test.tsx` cover the same rules again through the hooks that call
 * these — that duplication is deliberate (the pure tests pin the rule, the
 * hook tests pin that the hook actually calls it correctly), not redundant.
 */

function row(id: string): FeedRow {
  return { id };
}

describe('planFeedRevalidate', () => {
  it('asks for one page when nothing is loaded yet — the same shape a first load uses', () => {
    expect(planFeedRevalidate(0, 20)).toEqual({ limit: 20, cursorIsAuthoritative: true });
  });

  it('re-reads the whole loaded span when it is under the API ceiling', () => {
    expect(planFeedRevalidate(60, 20)).toEqual({ limit: 60, cursorIsAuthoritative: true });
  });

  it('caps at FEED_MAX_PAGE_SIZE and reports the cursor as unbelievable past it', () => {
    // ⚠ 150 loaded rows must NOT become `limit: 150` — that is a 400 against
    // the API's own `.max(100)`/`MAX_PAGE_SIZE` ceiling, not a bigger page.
    const plan = planFeedRevalidate(150, 20);
    expect(plan.limit).toBe(FEED_MAX_PAGE_SIZE);
    expect(plan.cursorIsAuthoritative).toBe(false);
  });

  it('treats exactly the ceiling as still fully covered', () => {
    // The boundary: 100 loaded rows fit in one re-read of 100, so the
    // response's cursor is still authoritative — only PAST the ceiling does a
    // tail survive.
    const plan = planFeedRevalidate(100, 20);
    expect(plan).toEqual({ limit: 100, cursorIsAuthoritative: true });
  });
});

describe('mergeFeedPage', () => {
  it('returns fresh verbatim when the re-read covered everything (no tail)', () => {
    const current = [row('a'), row('b')];
    const fresh = [row('a2'), row('b2')];

    expect(mergeFeedPage(current, fresh, 2)).toEqual(fresh);
  });

  it('keeps the surviving tail after fresh, in its existing order', () => {
    const current = [row('a'), row('b'), row('c'), row('d')];
    const fresh = [row('a'), row('b')];

    expect(mergeFeedPage(current, fresh, 2).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dedupes a row that slid from the tail up into the fresh window', () => {
    // 'b' was deleted server-side, so 'c' — previously the first row of the
    // tail — slides up into the re-read window and comes back in `fresh`.
    // Without the dedupe it would render twice: once from `fresh`, once from
    // the stale tail — which is exactly the duplicate-key warning React would
    // raise, and the bug this filter exists to prevent.
    const current = [row('a'), row('b'), row('c')];
    const fresh = [row('a'), row('c')];

    const result = mergeFeedPage(current, fresh, 2);

    expect(result.map((r) => r.id)).toEqual(['a', 'c']);
    expect(result.filter((r) => r.id === 'c')).toHaveLength(1);
  });

  it('drops a row deleted from within the covered window while keeping the tail untouched', () => {
    // 'b' (inside the re-read window) was deleted server-side, so `fresh` is
    // shorter than `coveredCount`. The tail ('d', 'e') was never part of this
    // request at all and must survive exactly as held.
    const current = [row('a'), row('b'), row('c'), row('d'), row('e')];
    const fresh = [row('a'), row('c')];

    const result = mergeFeedPage(current, fresh, 3);

    expect(result.map((r) => r.id)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('is pure — neither input array is mutated', () => {
    const current = [row('a'), row('b'), row('c')];
    const fresh = [row('a2')];
    const currentCopy = [...current];
    const freshCopy = [...fresh];

    mergeFeedPage(current, fresh, 1);

    expect(current).toEqual(currentCopy);
    expect(fresh).toEqual(freshCopy);
  });
});
