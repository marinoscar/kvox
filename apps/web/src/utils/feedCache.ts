/**
 * Keeping a library feed alive across a drill-down — issue #168, epic #162.
 *
 * =============================================================================
 * THE BUG THIS EXISTS TO FIX
 * =============================================================================
 *
 * `/transcripts` and `/notes` are card feeds you page through with "Load more",
 * and then you tap a row. The page unmounts, and with it goes every page the
 * user loaded — the rows live in `useState` inside `useTranscripts`/`useNotes`,
 * which die with the tree. Press back and you are looking at twenty rows,
 * scrolled to the top, after every single item you open. Getting back to row 45
 * means two taps and a scroll, every time.
 *
 * This is a SEPARATE defect from #167 and survives its fix. #167 stopped a
 * background poll from truncating a list that was still mounted; nothing about
 * it helps a list that was torn down.
 *
 * Four facts about this app decide the implementation:
 *
 *  1. **The page fully unmounts on drill-down.** So the state cannot live in
 *     component state, a ref, or a context — all three die with the tree. It
 *     has to outlive the route, which means module scope.
 *
 *  2. **IN MEMORY, NOT `sessionStorage`** — the opposite choice from
 *     `useScrollRestoration`, which shares this problem and stores its offset
 *     in `sessionStorage`. That asymmetry is deliberate: an offset is one
 *     number, and a feed is up to 300 rows each carrying a title, a status and
 *     (for notes) an excerpt. Serializing that on every poll would be a
 *     measurable synchronous write on a phone, several times a minute, for a
 *     value whose whole purpose is to make the app feel faster.
 *
 *     The consequence, stated honestly: a HARD RELOAD starts the feed at page
 *     one again. Back-navigation inside the SPA is what the issue is about and
 *     is fully preserved. The degradation is safe rather than merely tolerable
 *     — `useScrollRestoration` only scrolls once the document is genuinely tall
 *     enough to honour the saved offset, so a restored offset over a
 *     freshly-short list leaves the reader at the top rather than somewhere
 *     arbitrary.
 *
 *  3. **KEYED BY THE ACTIVE FILTERS, always.** A cache keyed by surface alone
 *     would replay the "Mine" tab's rows under "Shared with me", or a previous
 *     search's results under a new term — rows that demonstrably do not match
 *     the question on screen. So the key carries the scope, the search term and
 *     the status, and changing any of them is a cache MISS that correctly
 *     starts over. `useScrollRestoration` is given the same key, which is what
 *     makes each filter remember its own scroll position.
 *
 *  4. **BOUNDED, at twelve entries.** Every settled search term mints a key,
 *     and an unbounded map of 300-row feeds is a leak that only shows up for
 *     the users who page the furthest. Twelve is comfortably more than the
 *     handful of filter combinations anybody moves between in one session, and
 *     small enough that the worst case is bounded rather than merely unlikely.
 *     Eviction is least-recently-written, which for this access pattern is the
 *     same as least-recently-used: every read of a live feed is followed by
 *     writes as it polls.
 *
 * ⚠ A CACHED FEED IS STALE BY CONSTRUCTION, and that is handled elsewhere. The
 * hooks revalidate page one immediately on mount, through `reconcileFeed`, so
 * what the reader sees is their loaded feed with a fresh top — never a frozen
 * snapshot. That is the entire reason this module can be as simple as it is:
 * it has no TTL, no invalidation and no notion of freshness, because it is not
 * the thing responsible for being correct.
 */

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { FeedState } from './feedReconcile';

/** See fact 4 above. */
const MAX_ENTRIES = 12;

/**
 * Insertion-ordered, which is what makes eviction a one-liner.
 *
 * A `Map` iterates in insertion order and `delete`-then-`set` moves a key to
 * the end, so "evict the least recently written" is "delete the first key".
 */
const cache = new Map<string, FeedState<unknown>>();

/**
 * Build the key for one feed.
 *
 * Parts are joined with a separator that cannot appear in a uuid or a status,
 * and `undefined`/`null` collapse to the empty string so "no status filter" is
 * one stable key rather than two. A raw search term CAN contain the separator,
 * which is harmless here: the worst outcome is two different searches sharing
 * an entry, and the very next revalidation replaces its contents anyway.
 */
export function feedCacheKey(
  surface: string,
  parts: readonly (string | undefined | null)[],
): string {
  return [surface, ...parts.map((part) => part ?? '')].join('|');
}

/** A fresh empty feed. Never shared, so a caller cannot mutate the blank. */
function emptyFeed<T>(): FeedState<T> {
  return { items: [], nextCursor: null, total: 0 };
}

/**
 * What is cached for `key`, or an empty feed.
 *
 * `undefined` means CACHING IS DISABLED for this caller and always answers an
 * empty feed — never a shared global entry, which is what a bare `''` key would
 * quietly become.
 */
export function readFeedCache<T>(key: string | undefined): FeedState<T> {
  if (!key) return emptyFeed<T>();
  const hit = cache.get(key);
  return hit ? (hit as FeedState<T>) : emptyFeed<T>();
}

/** Store `state` under `key`, evicting the oldest entry past the bound. */
export function writeFeedCache<T>(key: string | undefined, state: FeedState<T>): void {
  if (!key) return;
  // Delete first so a re-write moves the key to the end of the iteration order
  // — otherwise a feed that is polled constantly would still be evicted as
  // though it had not been touched since it was first written.
  cache.delete(key);
  cache.set(key, state as FeedState<unknown>);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Reset everything. Exported for tests, which must not leak into each other. */
export function clearFeedCache(): void {
  cache.clear();
}

/**
 * `[feed, setFeed]`, seeded from the cache and writing through to it.
 *
 * A drop-in replacement for the `useState<FeedState<T>>` the list hooks hold,
 * so nothing downstream of it changes.
 *
 * =============================================================================
 * WHY THE KEY CHANGE IS HANDLED DURING RENDER RATHER THAN IN AN EFFECT
 * =============================================================================
 *
 * When a filter changes, `cacheKey` changes, and the rows for the OLD key are
 * wrong from that instant. Swapping them in a `useEffect` would render one
 * frame with the previous filter's rows sitting under the new filter's
 * heading — which is precisely the flicker this issue exists to remove, moved
 * from back-navigation to filter-switching.
 *
 * So the swap happens during render, using React's own documented "adjusting
 * state when a prop changes" pattern: store the key alongside the value, and
 * when the incoming key disagrees, call `setState` during rendering. React
 * discards the in-progress output and re-renders immediately, before the
 * browser paints anything — it is a sanctioned pattern, not a workaround. The
 * value returned on that one render is read straight from the cache so the
 * render doing the adjusting is already consistent with the new key.
 */
export function useCachedFeedState<T>(
  cacheKey: string | undefined,
): [FeedState<T>, Dispatch<SetStateAction<FeedState<T>>>] {
  const [entry, setEntry] = useState<{ key: string | undefined; feed: FeedState<T> }>(() => ({
    key: cacheKey,
    feed: readFeedCache<T>(cacheKey),
  }));

  const feed = entry.key === cacheKey ? entry.feed : readFeedCache<T>(cacheKey);

  if (entry.key !== cacheKey) {
    setEntry({ key: cacheKey, feed });
  }

  /**
   * ⚠ THIS SETTER BELONGS TO A KEY, and deliberately is not stable across a key
   * change.
   *
   * `loadMore` has no request-token guard (only `load` does), so a "Load more"
   * that was in flight when the user switched tabs settles AFTER the key moved.
   * A stable setter would read the key out of current state — which by then is
   * the NEW key — and file the old tab's rows under the new tab's entry, where
   * they would be replayed as though they answered the new question. That is
   * the one way this cache could show a user rows that demonstrably do not
   * match what is on screen, so it is closed off structurally: the key is
   * captured when the setter is created, and every path below uses the captured
   * one rather than whatever `cacheKey` is when the update lands.
   *
   * A late update still lands in ITS OWN key's entry (the user's loaded page is
   * not thrown away) but does NOT become live state unless that key is still
   * the one on screen.
   */
  const setFeed = useCallback<Dispatch<SetStateAction<FeedState<T>>>>(
    (update) => {
      setEntry((current) => {
        const base = current.key === cacheKey ? current.feed : readFeedCache<T>(cacheKey);
        const next =
          typeof update === 'function'
            ? (update as (prev: FeedState<T>) => FeedState<T>)(base)
            : update;
        writeFeedCache(cacheKey, next);
        return current.key === cacheKey ? { key: cacheKey, feed: next } : current;
      });
    },
    [cacheKey],
  );

  return [feed, setFeed];
}
