/**
 * The transcripts data layer — issue #30, epic #19.
 *
 * Four hooks, one file, for the reason `useJobs.ts` gives about its own three:
 * they are four views of one surface, the viewer mounts two of them together,
 * and what they genuinely share is a contract — every function resolves rather
 * than throws, and a failure is a STRING the page renders.
 *
 * HAND-ROLLED, NOT `react-query`. This repository has no query library and
 * adding one for three endpoints would be a dependency whose cache, retry and
 * invalidation semantics every future hook then has to be written against.
 * Every other data hook here (`useJobs`, `useWorkerNodes`, `useUsers`,
 * `usePushConfig`) is shaped like this, and matching them is worth more than
 * the boilerplate saved.
 *
 * =============================================================================
 * WHY `useTranscript` POLLS, AND WHY IT ALSO LISTENS
 * =============================================================================
 *
 * A processing transcript changes with nobody touching it: the transcode
 * finishes, the provider answers, the ingest lands. The viewer has to notice.
 * Two mechanisms, and BOTH are needed:
 *
 *   1. **Polling**, through `useVisiblePolling` — the same hook the jobs and
 *      worker pages use, so a background tab stops asking (see its header for
 *      the overnight-dashboard arithmetic). The cadence is adaptive: 5 s while
 *      the transcript is in flight, 20 s once it is not. A ready transcript
 *      still polls because somebody else may be editing it (#31) and because
 *      the ETag makes an unchanged answer nearly free.
 *
 *   2. **The SSE notification stream** already open for the bell (#127). The
 *      API raises `transcripts.transcript_ready` and
 *      `transcripts.transcript_failed`, and a user watching the stepper should
 *      see it advance the moment the event lands rather than up to five
 *      seconds later. This costs NOTHING extra — no second connection, no
 *      second endpoint — because the stream is already there and already
 *      delivering these events to the notification centre.
 *
 * The two overlap deliberately. The stream is the fast path and the poll is the
 * floor: a stream that drops, reconnects, or was never established (a proxy
 * that buffers, a browser with the tab discarded and restored) must not leave a
 * transcript frozen mid-pipeline with nothing to unstick it.
 *
 * =============================================================================
 * THE ETAG IS WHAT MAKES THE 5-SECOND CADENCE DEFENSIBLE
 * =============================================================================
 *
 * `GET /:id` and `GET /:id/segments` answer `W/"v<currentVersion>"`. Both hooks
 * keep the last validator in a REF and send it back as `If-None-Match`; a `304`
 * is a no-op that leaves state — and therefore the rendered list, its scroll
 * position and the player's place in it — completely untouched. Without that,
 * a 6,000-segment transcript would re-ship its whole segment list every five
 * seconds and re-render the virtualized list under the user's finger.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  getTranscript,
  getTranscriptSegments,
  getTranscriptSummary,
  getTranscripts,
} from '../services/transcripts';
import type {
  TranscriptDetail,
  TranscriptListItem,
  TranscriptListParams,
  TranscriptScope,
  TranscriptSegment,
  TranscriptStatus,
  TranscriptSummary,
} from '../services/transcripts';
import { isTranscriptInFlight } from '../utils/transcriptDisplay';
import { useNotifications } from '../contexts/NotificationContext';
import { useIsMounted } from './useIsMounted';
import { mergeFeedPage, planFeedRevalidate } from './mergeFeedPage';
import { useVisiblePolling } from './useVisiblePolling';

/** Re-exported so a page takes its polling from the module it already imports. */
export { useVisiblePolling };

/** While the pipeline is moving. Fast enough that the stepper looks alive. */
export const TRANSCRIPT_ACTIVE_POLL_MS = 5_000;

/**
 * Once it has settled.
 *
 * Not zero. A ready transcript can still change under the reader — #31's
 * corrections bump `currentVersion` — and the ETag means the overwhelmingly
 * common answer costs a request line and a header block rather than a payload.
 */
export const TRANSCRIPT_IDLE_POLL_MS = 20_000;

/** The registry-key prefix whose events mean "re-read this transcript". */
export const TRANSCRIPT_EVENT_PREFIX = 'transcripts.';

/**
 * Transcripts per page. The API's own default; stated here so the cursor tests
 * can pin it, exactly as `NOTE_PAGE_SIZE` does in `useNotes.ts`.
 */
export const TRANSCRIPT_PAGE_SIZE = 20;

/** Turn any thrown value into the sentence the page will render. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // 403 and 404 are named because their remedies are not "try again".
    // A transcript the caller cannot reach answers 404, never 403 (the
    // controller's own rule: the existence of an id is information), so this
    // wording has to cover both "gone" and "never yours".
    if (err.status === 403) return 'You do not have permission to view transcripts';
    if (err.status === 404) return 'This transcript does not exist, or you no longer have access to it';
    return err.message || fallback;
  }
  return fallback;
}

/**
 * The id of the most recent `transcripts.*` notification, or `null`.
 *
 * A STRING, not a counter or a callback. The notification centre re-renders for
 * reasons of its own (a read receipt, an unrelated event), and a hook that
 * refetched on every one of those would turn the bell into a second, unthrottled
 * poll. An id changes exactly when a NEW transcript event arrives, which makes
 * it safe to use directly as an effect dependency.
 *
 * Returns `null` when no `NotificationProvider` is mounted — `useNotifications`
 * is deliberately tolerant — so these hooks work in a test, in the visual
 * harness, and on any surface that has no bell.
 */
function useLatestTranscriptEventId(): string | null {
  const notifications = useNotifications();
  return useMemo(() => {
    const match = notifications?.notifications.find((notification) =>
      notification.eventKey.startsWith(TRANSCRIPT_EVENT_PREFIX),
    );
    return match?.id ?? null;
  }, [notifications?.notifications]);
}

// =============================================================================
// The list
// =============================================================================

export interface UseTranscriptsResult {
  transcripts: TranscriptListItem[];
  isLoading: boolean;
  error: string | null;
  /** The cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /** True while `loadMore` is in flight, so the button can spin. */
  isLoadingMore: boolean;
  /** Append the next page. A no-op when there is none, or while one is loading. */
  loadMore: () => Promise<void>;
  /**
   * Revalidate the loaded span in place — ⚠ NOT a reset to page one (#167).
   * Every accumulated row stays; changed rows update, deleted rows go.
   */
  refresh: () => Promise<void>;
}

export interface UseTranscriptsOptions {
  /** Substring of the title. Debouncing belongs to the caller's input. */
  q?: string;
  status?: TranscriptStatus;
  /** `0` disables polling — what a test passes. */
  pollIntervalMs?: number;
}

/**
 * One page of transcripts, with a cursor for the rest.
 *
 * CURSOR-PAGINATED, never offset: the list is ordered by `updatedAt` and every
 * pipeline transition rewrites that column, so offset paging over it skips rows
 * and repeats others while a user scrolls. `loadMore` APPENDS rather than
 * replacing — the two are different operations and sharing one state setter
 * between them is how a "load more" quietly starts truncating the list.
 *
 * ⚠ THREE OPERATIONS, NOT TWO (issue #167). A RESET (`load(true)` — first
 * mount, a filter change, a scope change) reads one page and replaces
 * everything. An APPEND (`loadMore`) adds a page. A REVALIDATION
 * (`load(false)` — the poll, the tab-refocus fetch, the notification effect,
 * `refresh()` after a row action) RECONCILES against what is on screen and must
 * never truncate it. `refresh` is a revalidation and NOT a reset, deliberately:
 * a user who deletes row three of eighty asked to lose one row, not sixty.
 *
 * `mergeFeedPage.ts` carries the merge rule and the reasoning; `useNotes.ts`
 * has the same three operations, calls the same two helpers, and is meant to
 * stay readable side by side with this.
 */
export function useTranscripts(
  scope: TranscriptScope,
  options: UseTranscriptsOptions = {},
): UseTranscriptsResult {
  const { q, status, pollIntervalMs = TRANSCRIPT_IDLE_POLL_MS } = options;

  const [transcripts, setTranscripts] = useState<TranscriptListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /**
   * A monotonically increasing token identifying the LATEST first-page request.
   *
   * Without it, a slow request for `q: "bud"` can settle after a fast one for
   * `q: "budget"` and overwrite the newer results with older ones — the classic
   * search race, and the one an every-keystroke filter makes routine rather
   * than rare. A settled request whose token is stale drops its own answer.
   */
  const requestToken = useRef(0);

  /**
   * How many rows are on screen, as a REF.
   *
   * ⚠ A REF AND NOT THE STATE ITSELF, and that is load-bearing rather than
   * stylistic: `load` needs this number to size its re-read, and putting
   * `transcripts` in `load`'s dependency array would give `load` a new identity
   * on every list change — which the mount effect below (`useEffect(() =>
   * load(true), [load])`) would answer by resetting to page one, forever, in a
   * loop. The one consumer is an async request that begins after a commit, so
   * the effect's one-tick lag is immaterial.
   */
  const loadedCount = useRef(0);
  useEffect(() => {
    loadedCount.current = transcripts.length;
  }, [transcripts]);

  /**
   * Bumped whenever the accumulated list stops being the one a revalidation in
   * flight planned against: an APPEND commits, or the query changes.
   *
   * ⚠ SEPARATE FROM `requestToken`, which `loadMore` deliberately does not
   * touch. A revalidation that was planned against twenty rows and settles
   * after `loadMore` has made it forty computed its plan — and, critically, its
   * `cursorIsAuthoritative` — against a list that no longer exists. Adopting
   * that plan's `nextCursor` would rewind the cursor to just past row twenty
   * and make every subsequent `loadMore` re-fetch page two forever, stranding
   * page three. So a revalidation whose generation moved under it DROPS ITS
   * ANSWER; another poll is at most one interval away, and `loadMore` has just
   * delivered fresh rows anyway.
   *
   * The other direction needs no guard: a revalidation that lands DURING a
   * `loadMore` merges through a functional setter, and `loadMore`'s own append
   * then dedupes against whatever it finds. Neither clobbers the other.
   *
   * Folding this into `requestToken` was rejected: `loadMore` bumping that
   * counter would also drop an in-flight `load(true)`, so changing the filter
   * and then pressing "Load more" (the button still renders the old filter's
   * cursor for a frame) would leave the old filter's rows on screen.
   */
  const listGeneration = useRef(0);

  /**
   * Whether the rows on screen belong to the CURRENT query.
   *
   * ⚠ WITHOUT THIS, MERGING INTRODUCES A BUG THAT REPLACING COULD NOT HAVE.
   * The query-change effect below clears it, and only a reset's answer sets it
   * again. In the window between — a filter change whose first page has not
   * landed, or one whose request failed and left the previous rows up under an
   * error banner — a revalidation holds rows for the NEW query while the screen
   * holds rows for the OLD one, and merging the two would render both filters
   * at once. There is nothing to reconcile against, so a revalidation in that
   * window REPLACES, exactly as a reset does, and asks for one page rather than
   * re-reading a span that belongs to a query it is not for.
   *
   * A boolean rather than a second counter: query provenance is the only thing
   * it answers, and `listGeneration` already answers everything else.
   */
  const listMatchesQuery = useRef(false);

  const load = useCallback(
    async (showLoading: boolean) => {
      const token = (requestToken.current += 1);
      const generation = listGeneration.current;
      // ⚠ A RESET READS ONE PAGE AND REPLACES; A REVALIDATION RE-READS THE
      // LOADED SPAN AND MERGES. See `mergeFeedPage.ts` for why, and for why
      // the span is capped at 100. A revalidation fired while no rows of this
      // query are on screen is a reset — see `listMatchesQuery` above.
      const isReset = showLoading || !listMatchesQuery.current;
      const plan = isReset
        ? { limit: TRANSCRIPT_PAGE_SIZE, cursorIsAuthoritative: true }
        : planFeedRevalidate(loadedCount.current, TRANSCRIPT_PAGE_SIZE);
      if (showLoading) setIsLoading(true);
      try {
        const params: TranscriptListParams = { scope, q, status, limit: plan.limit };
        const response = await getTranscripts(params);
        if (!isMounted() || token !== requestToken.current) return;
        if (isReset) {
          // The reset path, byte-for-byte what it always did: a first load, a
          // filter change or a scope change has nothing worth reconciling
          // with — and neither has a revalidation that arrives before this
          // query's first page has landed. ⚠ `isLoading` is still governed by
          // `showLoading` alone, so a revalidation taking this branch replaces
          // the rows without ever raising the skeleton over them.
          setTranscripts(response.items);
          setNextCursor(response.nextCursor);
          listMatchesQuery.current = true;
        } else if (generation === listGeneration.current) {
          // ⚠ MERGE, NEVER REPLACE (issue #167). `setTranscripts(response.items)`
          // here was the bug: load two hundred rows, look away for twenty
          // seconds — the idle poll is unconditional and runs on a settled
          // library — and have twenty again, under a scroll position pointing
          // at nothing. Functional, so a `loadMore` that committed a frame ago
          // is merged with rather than overwritten.
          setTranscripts((current) => mergeFeedPage(current, response.items, plan.limit));
          if (plan.cursorIsAuthoritative) setNextCursor(response.nextCursor);
        }
        setError(null);
      } catch (err) {
        if (!isMounted() || token !== requestToken.current) return;
        setError(messageFor(err, 'Failed to load transcripts'));
      } finally {
        if (isMounted() && token === requestToken.current) setIsLoading(false);
      }
    },
    [isMounted, q, scope, status],
  );

  // ⚠ A NEW QUERY INVALIDATES BOTH GUARDS ABOVE, and it must do so BEFORE the
  // reset is issued: a revalidation still in flight for the previous filter
  // has to drop its answer rather than replace this query's first page with
  // the last one's, and a revalidation issued while this reset is in flight
  // has to replace rather than merge into rows that are not its own.
  useEffect(() => {
    listGeneration.current += 1;
    listMatchesQuery.current = false;
    void load(true);
  }, [load]);

  // A POLL DOES NOT RAISE THE LOADING FLAG — the rows stay on screen and keep
  // their scroll offset. A spinner every twenty seconds over data that is
  // already correct is the fastest way to make a live list unusable.
  useVisiblePolling(() => void load(false), pollIntervalMs);

  // The stream's fast path. Same refetch, no loading flag, for the same reason.
  const latestEventId = useLatestTranscriptEventId();
  useEffect(() => {
    if (!latestEventId) return;
    void load(false);
  }, [latestEventId, load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const response = await getTranscripts({
        scope,
        q,
        status,
        limit: TRANSCRIPT_PAGE_SIZE,
        cursor: nextCursor,
      });
      if (!isMounted()) return;
      // ⚠ The generation bump tells an in-flight revalidation that the plan it
      // was built on is gone — see `listGeneration` above.
      listGeneration.current += 1;
      // Deduped on append. A row whose `updatedAt` moved between the two
      // requests can legitimately appear on both pages — cursor paging bounds
      // the window, it does not freeze the ordering — and React would then
      // warn about a duplicate key while rendering the row twice.
      setTranscripts((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load more transcripts'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [isLoadingMore, isMounted, nextCursor, q, scope, status]);

  const refresh = useCallback(() => load(false), [load]);

  return { transcripts, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh };
}

// =============================================================================
// The home page's summary
// =============================================================================

export interface UseTranscriptSummaryResult {
  summary: TranscriptSummary | null;
  /** Only true for the FIRST read. A poll never raises it — see below. */
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The one request the home page makes — issue #32, epic #19.
 *
 * ONE CALL, THREE LISTS AND FOUR COUNTS. `GET /api/transcripts/summary` exists
 * precisely so this page is a single round trip on a phone rather than four
 * (`?scope=owned`, `?scope=shared`, `?status=processing`, and a count) racing
 * each other over a cellular link and rendering in whatever order they land.
 * Do NOT add a second data fetch to the home page to answer a question this
 * endpoint could answer; extend the endpoint.
 *
 * =============================================================================
 * IT POLLS ONLY WHILE SOMETHING IS MOVING
 * =============================================================================
 *
 * `pollIntervalMs` is derived from the answer, not from a constant: with
 * `inProgress` non-empty the page is a progress display and the numbers must
 * move, and with it empty there is nothing on this screen that changes without
 * the user doing something. A home page polling every five seconds forever is
 * the overnight-dashboard arithmetic `useVisiblePolling`'s own header does — a
 * tab left open on a second monitor — except that this is the LANDING PAGE, so
 * it is the tab most likely to be the one left open.
 *
 * The notification stream stays wired up regardless, and that is what covers
 * the gap the conditional poll opens: a transcript that finishes elsewhere (or
 * a new share) raises a `transcripts.*` event that refetches immediately, so an
 * idle home page still notices — it just does not ask every five seconds when
 * it has no reason to.
 *
 * A POLL DOES NOT RAISE `isLoading`, for the same reason the list hook's does
 * not: the skeleton must appear once, not every five seconds over content that
 * is already correct.
 */
export function useTranscriptSummary(): UseTranscriptSummaryResult {
  const [summary, setSummary] = useState<TranscriptSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      try {
        const response = await getTranscriptSummary();
        if (!isMounted()) return;
        setSummary(response);
        setError(null);
      } catch (err) {
        // The HELD SUMMARY IS NOT CLEARED on a failed poll. A refresh that
        // 500s or times out mid-visit would otherwise replace a correct page
        // with an error banner and nothing else; leaving the rows up and
        // recording the error is the honest state ("this may be stale"),
        // matching how the list hook treats `loadMore`.
        if (isMounted()) setError(messageFor(err, 'Failed to load your transcripts'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const hasInFlight = (summary?.inProgress.length ?? 0) > 0;
  useVisiblePolling(
    () => void load(false),
    hasInFlight ? TRANSCRIPT_ACTIVE_POLL_MS : 0,
  );

  const latestEventId = useLatestTranscriptEventId();
  useEffect(() => {
    if (!latestEventId) return;
    void load(false);
  }, [latestEventId, load]);

  const refresh = useCallback(() => load(false), [load]);

  return { summary, isLoading, error, refresh };
}

// =============================================================================
// One transcript
// =============================================================================

export interface UseTranscriptResult {
  transcript: TranscriptDetail | null;
  isLoading: boolean;
  error: string | null;
  /** Replace the held transcript — what a rename or a retry hands back. */
  setTranscript: (next: TranscriptDetail) => void;
  refresh: () => Promise<void>;
}

/**
 * One transcript, kept current.
 *
 * `id` may be `undefined` (the route param before it resolves), which disables
 * every fetch rather than issuing `GET /transcripts/undefined`.
 */
export function useTranscript(id: string | undefined): UseTranscriptResult {
  const [transcript, setTranscriptState] = useState<TranscriptDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /**
   * The last validator seen, for `If-None-Match`.
   *
   * A REF and not state, for two reasons: writing it must not re-render (the
   * ETag is not rendered anywhere), and the polling closure has to read the
   * CURRENT value rather than the one captured when the interval was built.
   */
  const etag = useRef<string | null>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id) return;
      if (showLoading) setIsLoading(true);
      try {
        const result = await getTranscript(id, etag.current);
        if (!isMounted()) return;
        if (result.status === 'ok') {
          etag.current = result.etag;
          setTranscriptState(result.data);
        }
        // `not-modified` deliberately touches NOTHING — not the transcript,
        // not the ETag (it is still valid), not a re-render. That is the whole
        // point of the conditional request.
        setError(null);
      } catch (err) {
        if (isMounted()) setError(messageFor(err, 'Failed to load this transcript'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [id, isMounted],
  );

  // A NEW id is a new resource: the old validator describes a different
  // transcript entirely, and sending it would make the server compare versions
  // across two rows and — when both happen to be at v1 — answer 304 with the
  // PREVIOUS transcript still on screen.
  useEffect(() => {
    etag.current = null;
    setTranscriptState(null);
    setIsLoading(true);
    void load(true);
  }, [load]);

  const pollIntervalMs = isTranscriptInFlight(transcript)
    ? TRANSCRIPT_ACTIVE_POLL_MS
    : TRANSCRIPT_IDLE_POLL_MS;

  useVisiblePolling(() => void load(false), id ? pollIntervalMs : 0);

  const latestEventId = useLatestTranscriptEventId();
  useEffect(() => {
    if (!latestEventId) return;
    void load(false);
  }, [latestEventId, load]);

  /**
   * Adopt a transcript handed back by a write (rename, retry, cancel).
   *
   * THE ETAG IS CLEARED, not guessed at. A write changes `currentVersion`, so
   * the validator in hand is stale by definition — keeping it would make the
   * next poll send a version the server has moved past, which is harmless, or
   * (after a retry that did not bump the version) one it still matches, which
   * would answer 304 and re-freeze the row this write just changed.
   */
  const setTranscript = useCallback((next: TranscriptDetail) => {
    etag.current = null;
    setTranscriptState(next);
  }, []);

  const refresh = useCallback(() => load(false), [load]);

  return { transcript, isLoading, error, setTranscript, refresh };
}

// =============================================================================
// A transcript's segments
// =============================================================================

export interface UseTranscriptSegmentsResult {
  segments: TranscriptSegment[];
  /** The version the held segments belong to — pairs a list with a transcript. */
  version: number | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Every segment of one transcript, in reading order, WITHOUT word timings.
 *
 * The whole list in one request, and that is the API's own choice (see the
 * controller): words are excluded precisely so this response stays a few
 * hundred kilobytes for a six-hour recording rather than tens of megabytes, and
 * the viewer virtualizes the rows rather than paginating them — a reader
 * scrubbing to 4:12:00 must not wait for pages 1 through 40.
 *
 * `enabled` exists because there is nothing to fetch until the transcript is
 * ready: a processing transcript has no segments, and asking every five seconds
 * for an empty list is a request per poll for a guaranteed answer.
 */
export function useTranscriptSegments(
  id: string | undefined,
  enabled = true,
): UseTranscriptSegmentsResult {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const etag = useRef<string | null>(null);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id || !enabled) return;
      if (showLoading) setIsLoading(true);
      try {
        const result = await getTranscriptSegments(id, etag.current);
        if (!isMounted()) return;
        if (result.status === 'ok') {
          etag.current = result.etag;
          setSegments(result.data.segments);
          setVersion(result.data.currentVersion);
        }
        setError(null);
      } catch (err) {
        if (isMounted()) setError(messageFor(err, 'Failed to load this transcript'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [enabled, id, isMounted],
  );

  useEffect(() => {
    etag.current = null;
    setSegments([]);
    setVersion(null);
    if (!id || !enabled) {
      // Not loading, and not an error either: there is simply nothing to fetch
      // yet. Leaving `isLoading` true would render a spinner over the pipeline
      // stepper, which is the one thing a waiting user wants to look at.
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void load(true);
  }, [enabled, id, load]);

  const latestEventId = useLatestTranscriptEventId();
  useEffect(() => {
    if (!latestEventId || !enabled) return;
    void load(false);
  }, [enabled, latestEventId, load]);

  const refresh = useCallback(() => load(false), [load]);

  return { segments, version, isLoading, error, refresh };
}
