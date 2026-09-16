/**
 * The search data layer — issue #176, epic #164.
 *
 * One hook over `GET /api/search`, shaped like every other data hook in this
 * repository (`useNotes`, `useTranscripts`, `useTranscriptSearch`): hand-rolled
 * rather than `react-query`, and its contract is that it RESOLVES rather than
 * throws — a failure is a STRING the page renders.
 *
 * It is `useTranscriptSearch`'s sibling more than `useNotes`': both are a
 * search box rather than a list, so the debounce lives HERE rather than in the
 * caller's input state. `useNotes`/`useTranscripts` push their debounce out to
 * the view because their `q` is one filter among several on a list that also
 * polls; this hook's query IS the request, and a caller that forgot to debounce
 * it would issue a ranked full-text query per keystroke.
 *
 * =============================================================================
 * A SUPERSEDED REQUEST IS ABORTED, NOT MERELY IGNORED
 * =============================================================================
 *
 * Two guards, and they do different jobs:
 *
 *   • **The token.** Every first-page request takes a number; a response whose
 *     number is stale drops itself. This is what stops a slow `bud` settling
 *     after a fast `budget` and painting the older answer over the newer one —
 *     the classic search race, which an every-keystroke box makes routine.
 *
 *   • **The `AbortSignal`.** The token alone would leave the old request open,
 *     still costing a ranked query on the database and a response body on the
 *     wire, for as long as it takes to arrive. `services/api.ts` passes a
 *     `signal` straight through to `fetch`, so the keystroke that supersedes a
 *     request genuinely cancels it.
 *
 * The token is still needed with the abort in place: `fetch` rejects
 * asynchronously, and a response can already be in flight through
 * `readResponse` when the abort lands.
 *
 * =============================================================================
 * ⚠ THE CURSOR IS OPAQUE, AND A 400 FROM ONE IS A RESET
 * =============================================================================
 *
 * `nextCursor` is passed back verbatim and is never constructed, parsed or
 * compared here — see `services/search.ts`. The server ties a cursor to the
 * exact search that produced it and answers **400** when it is presented
 * against a different one, rather than silently serving page one again. That
 * refusal is a feature, and this hook has to cooperate with it rather than
 * report it:
 *
 *   A relevance-ordered page one is INDISTINGUISHABLE from a real page two.
 *   If the server restarted silently, "Load more" would append the same rows
 *   the user is already looking at, and they would scroll forever believing
 *   they were making progress. So the server refuses, and the CLIENT — which
 *   is the only party that knows a human just pressed a button — starts the
 *   search over from page one and says nothing. A red alert here would be
 *   telling a user about a protocol detail they cannot act on, in exchange for
 *   a list that was about to fix itself anyway.
 *
 * The recognition is `isStaleCursorError`, and it is deliberately narrow: only
 * a request that actually CARRIED a cursor can have been refused for having a
 * stale one, so a 400 about `q` or `limit` stays a visible error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { isStaleCursorError, search } from '../services/search';
import type { SearchResult, SearchResponse, SearchType } from '../services/search';
import { useIsMounted } from './useIsMounted';

/**
 * Idle time before a keystroke becomes a ranked full-text query.
 *
 * The same 300 ms the two library views already wait before filtering their
 * lists — one box, one pause, one number, so the two sources this box switches
 * between respond on the same beat rather than one feeling laggier.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/** Results per page. The endpoint's own default. */
export const SEARCH_PAGE_SIZE = 20;

/**
 * Turn any thrown value into the sentence the page will render.
 *
 * 403 IS NAMED because it is the one failure with a remedy that is not "try
 * again": the endpoint answers it only to a caller holding NEITHER
 * `transcripts:read` nor `notes:read`. Holding one of the two is not an error
 * at all — it comes back 200 with a narrowed `searchedTypes`, which the view
 * reports for itself.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to search';
    return err.message || fallback;
  }
  return fallback;
}

/** An abort is this hook's own doing, never a failure to report. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

interface SearchState {
  results: SearchResult[];
  nextCursor: string | null;
  matchedDocuments: number;
  truncated: boolean;
  degraded: 'stopwords' | null;
  /**
   * `null` until a response has landed — NOT `[]`.
   *
   * The two are different claims and a view acts on the difference: `[]` after
   * an answer would mean "the server searched nothing you are allowed to
   * search", which deserves a sentence on screen, while `null` means nobody has
   * asked yet. Collapsing them would put a permissions message in front of
   * every user for the moment before their first result arrives.
   */
  searchedTypes: SearchType[] | null;
}

const EMPTY_STATE: SearchState = {
  results: [],
  nextCursor: null,
  matchedDocuments: 0,
  truncated: false,
  degraded: null,
  searchedTypes: null,
};

function adopt(response: SearchResponse): SearchState {
  return {
    results: response.results,
    nextCursor: response.nextCursor,
    matchedDocuments: response.matchedDocuments,
    truncated: response.truncated,
    degraded: response.degraded,
    searchedTypes: response.searchedTypes,
  };
}

export interface UseSearchOptions {
  /** The raw box contents. Trimmed here; an all-whitespace box is no search. */
  q: string;
  /** The types this view cares about. One value, for both current callers. */
  types: SearchType[];
  limit?: number;
  /** `0` runs the query immediately — what a test passes. */
  debounceMs?: number;
}

export interface UseSearchResult {
  results: SearchResult[];
  /** True from the keystroke until this query's first page settles. */
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  /**
   * Documents in the server's candidate window.
   *
   * ⚠ NOT A TOTAL when {@link truncated} is true — see `services/search.ts`.
   */
  matchedDocuments: number;
  truncated: boolean;
  degraded: 'stopwords' | null;
  /** `null` until an answer lands. See {@link SearchState.searchedTypes}. */
  searchedTypes: SearchType[] | null;
  /** True when the box is empty (or all whitespace): no search is running. */
  isIdle: boolean;
  loadMore: () => Promise<void>;
}

export function useSearch(options: UseSearchOptions): UseSearchResult {
  const { q, types, limit = SEARCH_PAGE_SIZE, debounceMs = SEARCH_DEBOUNCE_MS } = options;

  /**
   * The types as a stable primitive.
   *
   * Callers write `types={['transcript']}`, a fresh array on every render, so
   * depending on the array itself would re-run the effect — and re-issue the
   * search — on every keystroke in an unrelated field. The CSV is also exactly
   * what goes on the wire.
   */
  const typesKey = types.join(',');

  const [state, setState] = useState<SearchState>(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /** Identifies the latest first-page request. See the file header. */
  const token = useRef(0);
  /** The request this hook currently has open, so a new question can cancel it. */
  const inFlight = useRef<AbortController | null>(null);

  const loadFirstPage = useCallback(
    async (query: string, typeList: SearchType[]) => {
      const mine = (token.current += 1);
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setIsLoading(true);
      try {
        const response = await search({
          q: query,
          types: typeList,
          limit,
          signal: controller.signal,
        });
        if (!isMounted() || mine !== token.current) return;
        setState(adopt(response));
        setError(null);
      } catch (err) {
        if (isAbort(err) || !isMounted() || mine !== token.current) return;
        // A failed search shows no rows rather than the PREVIOUS query's rows
        // under an error banner, which would read as "these matched, and also
        // something went wrong".
        setState(EMPTY_STATE);
        setError(messageFor(err, 'The search failed'));
      } finally {
        if (isMounted() && mine === token.current) setIsLoading(false);
      }
    },
    [isMounted, limit],
  );

  // THE QUESTION-CHANGED EFFECT, and the debounce. It runs on mount and
  // whenever the query or the type filter changes.
  //
  // `setIsLoading(true)` happens SYNCHRONOUSLY here rather than inside the
  // timer, so the gap between a keystroke and the request is a spinner and not
  // a "no matches" panel over results the user has not asked for yet.
  //
  // The cleanup aborts as well as clearing the timer: without the abort, a
  // request that had already left would stay open — and keep costing a ranked
  // query — until the NEXT one superseded it 300 ms later.
  useEffect(() => {
    const query = q.trim();

    if (!query) {
      // An empty box is not a search with no results; it is no search. Bump
      // the token so anything still in flight drops its answer on arrival.
      token.current += 1;
      inFlight.current?.abort();
      inFlight.current = null;
      setState(EMPTY_STATE);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    const typeList = typesKey.split(',') as SearchType[];
    const timer = setTimeout(() => void loadFirstPage(query, typeList), debounceMs);

    return () => {
      clearTimeout(timer);
      inFlight.current?.abort();
    };
  }, [debounceMs, loadFirstPage, q, typesKey]);

  const { nextCursor } = state;

  const loadMore = useCallback(async () => {
    const query = q.trim();
    if (!query || !nextCursor || isLoadingMore) return;

    // NOT a new token: `loadMore` asks a later page of the SAME question, so it
    // must not invalidate the first page it is appending to.
    const mine = token.current;
    const controller = new AbortController();
    inFlight.current = controller;
    const typeList = typesKey.split(',') as SearchType[];

    setIsLoadingMore(true);
    try {
      const response = await search({
        q: query,
        types: typeList,
        limit,
        // Verbatim, and never inspected. See the file header.
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (!isMounted() || mine !== token.current) return;
      setState((current) => {
        // Deduped on `type:id`: the two document types have independent id
        // spaces, so an id alone is not a key, and React would warn while
        // rendering a row twice.
        const seen = new Set(current.results.map((item) => `${item.type}:${item.id}`));
        return {
          ...current,
          results: [
            ...current.results,
            ...response.results.filter((item) => !seen.has(`${item.type}:${item.id}`)),
          ],
          nextCursor: response.nextCursor,
          matchedDocuments: response.matchedDocuments,
          truncated: response.truncated,
          degraded: response.degraded,
          searchedTypes: response.searchedTypes,
        };
      });
      setError(null);
    } catch (err) {
      if (isAbort(err) || !isMounted() || mine !== token.current) return;
      if (isStaleCursorError(err, true)) {
        // START OVER FROM PAGE ONE, SILENTLY. The server refused a cursor that
        // belongs to a different search rather than restarting behind our back
        // — see the file header for why it refuses — and page one is the only
        // page a client can ask for without one.
        setIsLoadingMore(false);
        await loadFirstPage(query, typeList);
        return;
      }
      setError(messageFor(err, 'Failed to load more results'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [isLoadingMore, isMounted, limit, loadFirstPage, nextCursor, q, typesKey]);

  return {
    results: state.results,
    isLoading,
    isLoadingMore,
    error,
    nextCursor: state.nextCursor,
    matchedDocuments: state.matchedDocuments,
    truncated: state.truncated,
    degraded: state.degraded,
    searchedTypes: state.searchedTypes,
    isIdle: q.trim().length === 0,
    loadMore,
  };
}

export default useSearch;
