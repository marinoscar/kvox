/**
 * Merging a freshly-read page one back into an accumulated feed — issue #167,
 * epic #162.
 *
 * =============================================================================
 * THE BUG THIS EXISTS TO MAKE UNREPRESENTABLE
 * =============================================================================
 *
 * `useTranscripts` and `useNotes` are cursor-paginated lists with a "Load more"
 * button, and they are ALSO live: a 20-second `useVisiblePolling` interval, an
 * immediate fetch when the tab regains focus, a `transcripts.*`/`notes.*`
 * notification effect, and a `refresh()` after every row action all re-read
 * PAGE ONE. Before this module they re-read it with `setItems(response.items)`
 * — a full replace — so a user who had pressed "Load more" twice watched 60
 * rows collapse back to 20, with no interaction of their own, up to three times
 * a minute. The scroll position survived; the rows under it did not.
 *
 * The fix is not "poll less". It is that a re-read of page one is a
 * REVALIDATION of the window the client already holds, not a new answer that
 * replaces it. That is what `reconcileFeed` below expresses, and the reason it
 * lives in a pure module rather than inside either hook: the two hooks are
 * twins by design (both file headers say so), and a merge rule implemented
 * twice is a merge rule that drifts. Pure — no React, no services, no clock —
 * so the interesting cases are unit-testable without rendering anything.
 *
 * =============================================================================
 * WHAT EACH CLAUSE OF THE MERGE BUYS
 * =============================================================================
 *
 * Read this before "simplifying" `reconcileFeed`. Every clause is paying for a
 * specific observable behaviour, and dropping any one of them reintroduces a
 * bug that a passing render test will not catch.
 *
 *   • **New rows appear at the top.** They arrive inside `page.items`, which is
 *     prepended whole. Nothing special happens for them at all — that is the
 *     point of merging page one rather than diffing ids.
 *
 *   • **Changed rows update in place.** `page.items` carries the fresh copy of
 *     every row page one covers, and the tail filter's clause (a) drops the
 *     stale duplicate still sitting further down the accumulated list. Without
 *     (a), a row that was edited and therefore jumped to the top of an
 *     `updatedAt DESC` feed would render TWICE — two different bodies, one
 *     duplicate React key, and a console warning as the only clue.
 *
 *   • **Removed rows disappear.** A row that WAS inside page one's window and
 *     is absent from the new `page.items` fails clause (b) — it is not older
 *     than the new boundary — and is dropped.
 *
 *     The honest limit: a row deleted from deep in the accumulated TAIL is not
 *     detected, because page one is the only thing the server was asked about.
 *     It disappears on the next filter change, navigation, or `loadMore`.
 *     Revalidating every loaded page instead would be a correct fix and is a
 *     REJECTED one: fifteen requests every twenty seconds for a 300-row feed is
 *     exactly the cellular-data cost epic #162 rejected auto-infinite-scroll
 *     over. A briefly-stale row far below the fold is the cheaper wrong thing.
 *
 *   • **`nextCursor` stays the CURRENT one, not the page's.** Clause 3 keeps
 *     paging where the user left it. Overwriting it with page one's cursor
 *     would rewind `loadMore` to page two, so the next press re-fetches rows
 *     already on screen (the dedupe-on-append then swallows them) and the feed
 *     appears to stop growing. Note the trade this makes: when a tail row moves
 *     up into page one, the held cursor is encoded from an `updatedAt` that has
 *     since changed, so the server may re-serve a few rows around the seam.
 *     `loadMore` already dedupes on id, so that costs a few wasted bytes and
 *     never a duplicate row.
 *
 * =============================================================================
 * WHY IT IS SAFE TO COMPARE `updatedAt` AS A STRING
 * =============================================================================
 *
 * Every date on this API's wire is an ISO-8601 instant in UTC, serialized by
 * Prisma/`JSON.stringify` as `2026-03-12T14:03:07.120Z` — fixed-width fields,
 * most-significant first, one timezone. For that format, and ONLY for that
 * format, LEXICOGRAPHIC ORDER IS CHRONOLOGICAL ORDER. That is the load-bearing
 * assumption of `compareFeedRows`, and it is what lets the boundary test be a
 * string comparison rather than two `Date` allocations per row per poll.
 *
 * It stops being true the moment a field arrives with a local offset
 * (`+02:00`), without milliseconds on some rows and with them on others, or as
 * an epoch number. If a future feed's timestamp is any of those, parse it here
 * rather than teaching the call sites to pre-normalize.
 */

/**
 * The only thing this module needs to know about a feed row.
 *
 * Deliberately two fields. `TranscriptListItem` and `NoteListItem` both satisfy
 * it structurally, and keeping the constraint this narrow is what stops the
 * merge rule from quietly acquiring a dependency on either feed's shape.
 */
export interface FeedRow {
  id: string;
  updatedAt: string;
}

/** One page as the API returns it — `{ items, total, nextCursor }`. */
export interface FeedPage<T> {
  items: T[];
  nextCursor: string | null;
  /**
   * How many rows match the current filters, ignoring paging (#190).
   *
   * A property of the QUESTION, not of the page, which is why every clause of
   * the merge below takes it from `page` unconditionally — including the one
   * that deliberately keeps the client's own `nextCursor`. The page is the only
   * thing here that has just asked the server, so its count is the freshest
   * answer available even when its rows are only the top of what is held.
   */
  total: number;
}

/**
 * Everything a paginated feed holds, in ONE value.
 *
 * The items and the cursor are a pair: the cursor is only meaningful as "where
 * this exact list of items stops". The hooks hold them in a single `useState`
 * for precisely that reason — two setters can be updated in two places and
 * disagree, and a cursor that disagrees with its items is a "Load more" that
 * fetches the wrong window.
 */
export interface FeedState<T> {
  items: T[];
  nextCursor: string | null;
  /** The most recent answer to "how many match", from whichever page last landed. */
  total: number;
}

/**
 * The API's own ordering, in the client.
 *
 * Mirrors `orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]` in
 * `apps/api/src/transcripts/transcripts.service.ts` and
 * `apps/api/src/notes/notes.service.ts` — and the keyset predicate their
 * cursors encode, which uses the same compound `(updatedAt, id)` tie-break
 * because `updatedAt` alone is not unique and two rows sharing a millisecond
 * would otherwise make one of them unreachable.
 *
 * Returns `< 0` when `a` is NEWER than `b` (sorts first), matching
 * `Array.prototype.sort`'s convention for a descending feed.
 */
export function compareFeedRows(a: FeedRow, b: FeedRow): number {
  // String comparison, not `Date` arithmetic — see the header. `localeCompare`
  // would be wrong here as well as slower: these are machine timestamps, and a
  // locale-aware collation is free to order punctuation however it likes.
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * Merge a freshly-read PAGE ONE into an accumulated feed.
 *
 * `page` MUST be page one (no cursor was sent). Handing this a later page would
 * treat that page's oldest row as the boundary and delete everything above it.
 * Appending a later page is `loadMore`'s dedupe-on-append, a different
 * operation that deliberately does not share this code.
 *
 * Pure: no mutation of `current` or `page`, and the same inputs always give the
 * same output.
 */
export function reconcileFeed<T extends FeedRow>(
  current: FeedState<T>,
  page: FeedPage<T>,
): FeedState<T> {
  // 1. NOTHING ACCUMULATED, NOTHING TO RECONCILE. The first read of a mounted
  //    hook, and the state after a filter change cleared the list. Adopt the
  //    page wholesale, cursor included.
  if (current.items.length === 0) {
    return { items: page.items, nextCursor: page.nextCursor, total: page.total };
  }

  // 2. THE SERVER JUST SAID THIS PAGE IS THE WHOLE RESULT SET. A null
  //    `nextCursor` is not "we ran out of rows to send", it is "there is
  //    nothing after these" — so anything the client still holds beyond this
  //    page no longer matches the query and must go. This clause is also the
  //    only way a shrinking list shrinks: delete rows until the remainder fits
  //    in one page and the accumulated tail is discarded here, wholesale,
  //    rather than row by row.
  if (page.nextCursor === null) {
    return { items: page.items, nextCursor: null, total: page.total };
  }

  // 3. A FULL PAGE WITH MORE BEHIND IT. The page is authoritative for its own
  //    window; the tail is everything the client holds BELOW that window and
  //    was not asked about.
  //
  //    The boundary is the page's LAST item — the oldest row page one covers.
  //    Everything the server would have placed above it is, by definition, in
  //    `page.items` already.
  const boundary = page.items[page.items.length - 1];

  // A page with a non-null cursor and no items is not something this API
  // produces (the cursor is encoded FROM the last item), but the read above is
  // typed as possibly-undefined and inventing a boundary would be worse than
  // declining to reconcile. Adopt the page and keep paging.
  if (!boundary) {
    return { items: page.items, nextCursor: current.nextCursor, total: page.total };
  }

  const pageIds = new Set(page.items.map((item) => item.id));

  const tail = current.items.filter(
    (row) =>
      // (a) Not a stale duplicate of a row the page just re-sent. The page's
      //     copy is the fresh one and it is already at the front.
      !pageIds.has(row.id) &&
      // (b) Strictly OLDER than the boundary. A held row that is NOT older than
      //     the boundary sat inside the window the server just described in
      //     full; the server did not return it, so it is gone (deleted, or
      //     filtered out by a change to the row). Dropping it here is what
      //     makes a removal visible without a second request.
      compareFeedRows(row, boundary) > 0,
  );

  // The CURRENT cursor, never the page's — see the header's fourth bullet. The
  // PAGE's total, though: the cursor describes where the client's own list
  // stops, and the count describes the question, which only the server can
  // answer.
  return { items: [...page.items, ...tail], nextCursor: current.nextCursor, total: page.total };
}
