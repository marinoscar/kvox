/**
 * Reconciling a background revalidation against an accumulated feed — issue #167.
 *
 * =============================================================================
 * THE BUG THIS EXISTS TO MAKE UNREPRESENTABLE
 * =============================================================================
 *
 * `useTranscripts` and `useNotes` are cursor-paginated feeds that ACCUMULATE:
 * `loadMore` appends a page, so after four presses the user is looking at
 * eighty rows. Both hooks also revalidate in the background — an interval, the
 * immediate fetch `useVisiblePolling` issues on tab re-focus, the notification
 * stream's `latestEventId` effect, and `refresh()` after a row action — and
 * every one of those paths used to call the SAME `load()` that a first load
 * calls, which ended in `setItems(response.items)`.
 *
 * ⚠ That is a FULL REPLACE of the accumulated list with page one. Load two
 * hundred rows, look away for twenty seconds, look back and have twenty. The
 * user did nothing, touched nothing, and the list silently truncated under a
 * scroll position that no longer points at anything. The transcripts list made
 * this routine rather than rare: its idle poll is unconditional and fires every
 * twenty seconds on a completely settled library.
 *
 * A revalidation is not a first load. It must RECONCILE against what is on
 * screen: rows that changed update in place, rows deleted server-side
 * disappear, newly created rows appear at the top, and THE ACCUMULATED ROW
 * COUNT IS PRESERVED. That is what this module does, and it is a pure function
 * over two arrays precisely so it can be reasoned about and tested without a
 * hook, a timer, or a fake server.
 *
 * =============================================================================
 * THE MERGE RULE, AND WHY IT IS A RE-READ RATHER THAN A DIFF
 * =============================================================================
 *
 * A revalidation RE-READS THE SPAN THE USER HAS ACTUALLY LOADED, not page one.
 * If forty rows are on screen, it asks for forty. The fresh answer is then
 * authoritative for that whole span and simply replaces it — no per-row diffing,
 * no merge policy to get subtly wrong, and every one of the four required
 * behaviours falls out of "the server's first N rows ARE the first N rows":
 *
 *   - a changed row arrives changed;
 *   - a deleted row is absent, and the row that was at N+1 slides up into the
 *     window, so the count holds;
 *   - a newly created row arrives at the top, because the list is ordered by
 *     `updatedAt` descending;
 *   - the count holds because we asked for the count we had.
 *
 * ⚠ THE RE-READ IS CAPPED AT `FEED_MAX_PAGE_SIZE` (100), which is the API's own
 * ceiling on `limit` — `MAX_PAGE_SIZE` in `apps/api/src/notes/dto/note.dto.ts`
 * and the `.max(100)` on the transcripts list query. Asking for 200 is not a
 * bigger page, it is a 400, and a revalidation that 400s would put an error
 * banner over a correct list every twenty seconds.
 *
 * So past a hundred loaded rows the re-read covers the FIRST hundred and the
 * rest is a TAIL we keep as-is, deduped by `id` against the fresh set with the
 * fresh copy winning. The tail is stale — it was last read whenever its page
 * was fetched — and that is the honest trade: a user who has paged that far is
 * reading, and the alternative (five requests per poll to keep row 173 current)
 * is a background poll that costs more than the screen it is refreshing.
 *
 * ⚠ WHEN A TAIL SURVIVES, THE RESPONSE'S `nextCursor` MUST BE IGNORED. It
 * points just past row one hundred — i.e. INTO the tail we still hold — so
 * adopting it would make the next `loadMore` re-fetch rows already on screen
 * (harmless, they dedupe) and, worse, permanently strand everything past the
 * tail: the cursor would walk the same hundred-to-two-hundred span forever.
 * `planFeedRevalidate` reports this as `cursorIsAuthoritative`, and it is only
 * true when the re-read covered the entire loaded list.
 *
 * =============================================================================
 * REJECTED
 * =============================================================================
 *
 * **Per-row patching of page one into the held list** (update matching ids,
 * prepend unseen ones, keep everything else). It preserves the count, but it
 * can never notice a DELETION: a row that vanished server-side is simply absent
 * from page one, which is indistinguishable from "it is on page three". A list
 * that never forgets a deleted row is a list that accumulates tombstones for as
 * long as the tab stays open.
 *
 * **Re-fetching every loaded page by cursor on each poll.** Correct, and five
 * round trips per tick for a user who paged deep. The whole reason the idle
 * poll is defensible at twenty seconds is that it is one cheap request.
 *
 * **Not revalidating at all once the user has paged.** Freezes the live-ness
 * the poll exists to provide precisely for the users most invested in the page.
 */

/** The only thing this module needs to know about a feed row. */
export interface FeedRow {
  id: string;
}

/**
 * The API's ceiling on `limit`, for both feeds.
 *
 * ⚠ Mirrored from the server, not chosen here: `MAX_PAGE_SIZE` in
 * `apps/api/src/notes/dto/note.dto.ts` and the `.max(100)` on the transcripts
 * list query. Raising it here without raising it there turns every deep-scrolled
 * revalidation into a 400.
 */
export const FEED_MAX_PAGE_SIZE = 100;

export interface FeedRevalidatePlan {
  /** The `limit` to send. Never below one page, never above the API's ceiling. */
  limit: number;
  /**
   * Whether the response's `nextCursor` may be adopted.
   *
   * True only when `limit` covered the WHOLE loaded list. False means a tail
   * survives past the re-read window and the held cursor still points past it —
   * see the header.
   */
  cursorIsAuthoritative: boolean;
}

/**
 * How much of the loaded list a revalidation should re-read, and whether the
 * cursor it comes back with can be believed.
 *
 * `loadedCount` of zero (nothing on screen yet) asks for one page, which is
 * exactly what a first load asks for.
 */
export function planFeedRevalidate(loadedCount: number, pageSize: number): FeedRevalidatePlan {
  const limit = Math.min(Math.max(loadedCount, pageSize), FEED_MAX_PAGE_SIZE);
  return { limit, cursorIsAuthoritative: loadedCount <= limit };
}

/**
 * Fold a freshly re-read span back into the accumulated list.
 *
 * `coveredCount` is the `limit` the request was issued with — the number of
 * LEADING rows of `current` that `fresh` is authoritative for. Everything at or
 * past that index is the tail, kept in its existing order and filtered against
 * the fresh ids so a row that slid up into the re-read window is not rendered
 * twice (React would warn about the duplicate key, which is how this class of
 * bug usually announces itself).
 *
 * Pure, total, and order-preserving: fresh set first, surviving tail after.
 */
export function mergeFeedPage<T extends FeedRow>(
  current: readonly T[],
  fresh: readonly T[],
  coveredCount: number,
): T[] {
  const tail = current.slice(coveredCount);
  if (tail.length === 0) return [...fresh];

  const seen = new Set(fresh.map((row) => row.id));
  return [...fresh, ...tail.filter((row) => !seen.has(row.id))];
}
