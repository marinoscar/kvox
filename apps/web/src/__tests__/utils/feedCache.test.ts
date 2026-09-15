/**
 * Keeping a library feed alive across a drill-down — issue #168, epic #162.
 *
 * Two things are under test and they fail in different ways, so they are two
 * describes:
 *
 *  1. The STORE — read/write/evict, and the rule that an absent key means
 *     "caching disabled" rather than "one shared global entry". Getting that
 *     wrong would let two unrelated surfaces silently swap feeds.
 *  2. The HOOK — seeding, write-through, and the behaviour that actually
 *     motivates this module: what happens the instant the cache KEY changes.
 *     That one is asserted on the FIRST render after the change, not
 *     eventually, because rendering the previous filter's rows under the new
 *     filter's heading for even one frame is the flicker #168 exists to
 *     remove.
 *
 * ⚠ `clearFeedCache()` runs before every test. The cache is module-level and
 * lives for the tab by design, which in a test runner means it lives for the
 * FILE unless something resets it — and a leaked entry would make these tests
 * pass or fail depending on the order they ran in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  clearFeedCache,
  feedCacheKey,
  readFeedCache,
  useCachedFeedState,
  writeFeedCache,
} from '../../utils/feedCache';
import type { FeedState } from '../../utils/feedReconcile';

interface Row {
  id: string;
  updatedAt: string;
}

function feed(ids: string[], nextCursor: string | null = null): FeedState<Row> {
  return {
    items: ids.map((id) => ({ id, updatedAt: '2026-01-01T00:00:00.000Z' })),
    nextCursor,
  };
}

const ids = (state: FeedState<Row>) => state.items.map((row) => row.id);

beforeEach(() => {
  clearFeedCache();
});

describe('feedCacheKey', () => {
  it('includes every part, so two filter sets never share an entry', () => {
    expect(feedCacheKey('transcripts', ['owned', 'budget', 'failed'])).not.toBe(
      feedCacheKey('transcripts', ['shared', 'budget', 'failed']),
    );
    expect(feedCacheKey('transcripts', ['owned', 'budget', undefined])).not.toBe(
      feedCacheKey('transcripts', ['owned', 'budget', 'failed']),
    );
  });

  it('collapses null and undefined to one stable key', () => {
    // "No status filter" must be ONE key, not two that alternate depending on
    // which absent value a caller happened to pass.
    expect(feedCacheKey('notes', ['q', undefined])).toBe(feedCacheKey('notes', ['q', null]));
  });

  it('separates the surfaces', () => {
    expect(feedCacheKey('transcripts', ['a'])).not.toBe(feedCacheKey('notes', ['a']));
  });
});

describe('the store', () => {
  it('reads back what it wrote', () => {
    writeFeedCache('k', feed(['a', 'b'], 'c2'));

    expect(ids(readFeedCache<Row>('k'))).toEqual(['a', 'b']);
    expect(readFeedCache<Row>('k').nextCursor).toBe('c2');
  });

  it('answers an empty feed for a key it has never seen', () => {
    expect(readFeedCache<Row>('nothing-here')).toEqual({ items: [], nextCursor: null });
  });

  it('treats an ABSENT key as caching-disabled, never as a shared entry', () => {
    // The failure this rules out: two callers that both pass `undefined`
    // sharing one global entry, so a transcript detail page listing notes for
    // one transcript would hand its rows to the notes library.
    writeFeedCache(undefined, feed(['a']));

    expect(readFeedCache<Row>(undefined)).toEqual({ items: [], nextCursor: null });
  });

  it('hands out a fresh empty feed each time, so a caller cannot poison the blank', () => {
    const first = readFeedCache<Row>('absent');
    first.items.push({ id: 'oops', updatedAt: '2026-01-01T00:00:00.000Z' });

    expect(readFeedCache<Row>('absent').items).toEqual([]);
  });

  it('evicts the least recently written past the bound', () => {
    for (let i = 0; i < 13; i += 1) writeFeedCache(`k${i}`, feed([`row-${i}`]));

    expect(readFeedCache<Row>('k0').items).toEqual([]);
    expect(ids(readFeedCache<Row>('k12'))).toEqual(['row-12']);
  });

  it('a re-write counts as a touch, so a live feed is not evicted as though idle', () => {
    // A polling feed writes constantly. Without the delete-then-set, `k0` would
    // keep its original insertion position and be evicted while it is the very
    // feed the user is looking at.
    writeFeedCache('k0', feed(['first']));
    for (let i = 1; i < 12; i += 1) writeFeedCache(`k${i}`, feed([`row-${i}`]));
    writeFeedCache('k0', feed(['touched']));
    writeFeedCache('k99', feed(['newest']));

    expect(ids(readFeedCache<Row>('k0'))).toEqual(['touched']);
    expect(readFeedCache<Row>('k1').items).toEqual([]);
  });

  it('clearFeedCache really clears everything', () => {
    writeFeedCache('k', feed(['a']));
    clearFeedCache();

    expect(readFeedCache<Row>('k').items).toEqual([]);
  });
});

describe('useCachedFeedState', () => {
  it('seeds from the cache on mount — the drill-down return', () => {
    writeFeedCache('k', feed(['a', 'b', 'c'], 'c2'));

    const { result } = renderHook(() => useCachedFeedState<Row>('k'));

    expect(ids(result.current[0])).toEqual(['a', 'b', 'c']);
    expect(result.current[0].nextCursor).toBe('c2');
  });

  it('starts empty when there is nothing cached', () => {
    const { result } = renderHook(() => useCachedFeedState<Row>('k'));

    expect(result.current[0]).toEqual({ items: [], nextCursor: null });
  });

  it('writes through, so unmounting and remounting restores the feed', () => {
    const { result, unmount } = renderHook(() => useCachedFeedState<Row>('k'));

    act(() => {
      result.current[1](feed(['a', 'b'], 'c2'));
    });
    unmount();

    const { result: remounted } = renderHook(() => useCachedFeedState<Row>('k'));
    expect(ids(remounted.current[0])).toEqual(['a', 'b']);
    expect(remounted.current[0].nextCursor).toBe('c2');
  });

  it('supports a functional update, which is how the hooks reconcile', () => {
    writeFeedCache('k', feed(['a']));
    const { result } = renderHook(() => useCachedFeedState<Row>('k'));

    act(() => {
      result.current[1]((current) => ({
        items: [...current.items, { id: 'b', updatedAt: '2026-01-01T00:00:00.000Z' }],
        nextCursor: current.nextCursor,
      }));
    });

    expect(ids(result.current[0])).toEqual(['a', 'b']);
    expect(ids(readFeedCache<Row>('k'))).toEqual(['a', 'b']);
  });

  it('swaps to the new key\'s feed on the FIRST render after the key changes', () => {
    // The whole point of adjusting state during render rather than in an
    // effect. An effect would leave one painted frame showing the OLD filter's
    // rows under the NEW filter — the flicker this issue is about, moved from
    // back-navigation to filter-switching.
    writeFeedCache('owned', feed(['mine-1', 'mine-2']));
    writeFeedCache('shared', feed(['theirs-1']));

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useCachedFeedState<Row>(key),
      { initialProps: { key: 'owned' } },
    );
    expect(ids(result.current[0])).toEqual(['mine-1', 'mine-2']);

    rerender({ key: 'shared' });

    expect(ids(result.current[0])).toEqual(['theirs-1']);
  });

  it('empties on a key change with no cached answer, rather than showing stale rows', () => {
    writeFeedCache('owned', feed(['mine-1']));

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useCachedFeedState<Row>(key),
      { initialProps: { key: 'owned' } },
    );

    rerender({ key: 'q=budget' });

    expect(result.current[0]).toEqual({ items: [], nextCursor: null });
  });

  it('files a late update under the key its STATE belongs to, not the current one', () => {
    // A request in flight when a filter changes must not drop its rows into the
    // new filter's cache entry, where they would be replayed as though they
    // answered the new question.
    writeFeedCache('a', feed(['a-1']));

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useCachedFeedState<Row>(key),
      { initialProps: { key: 'a' } },
    );

    const setFromKeyA = result.current[1];
    rerender({ key: 'b' });

    act(() => {
      setFromKeyA(feed(['late-from-a']));
    });

    expect(readFeedCache<Row>('b').items).toEqual([]);
    expect(ids(readFeedCache<Row>('a'))).toEqual(['late-from-a']);
  });

  it('does not touch the cache at all without a key', () => {
    const { result } = renderHook(() => useCachedFeedState<Row>(undefined));

    act(() => {
      result.current[1](feed(['a']));
    });

    // The value is still live in state for this mount...
    expect(ids(result.current[0])).toEqual(['a']);
    // ...but nothing was persisted, so a remount starts clean.
    const { result: remounted } = renderHook(() => useCachedFeedState<Row>(undefined));
    expect(remounted.current[0].items).toEqual([]);
  });
});
