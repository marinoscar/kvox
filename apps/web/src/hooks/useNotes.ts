/**
 * The notes data layer — issue #57, epic #45; the home summary is #107.
 *
 * Three hooks, one file, for the reason `useTranscripts.ts` gives about its own
 * four: they are three views of one surface and what they share is a contract —
 * every function RESOLVES rather than throws, and a failure is a STRING the
 * page renders.
 *
 * HAND-ROLLED, NOT `react-query`, matching every other data hook in this
 * repository (`useTranscripts`, `useJobs`, `useWorkerNodes`, `useUsers`). The
 * boilerplate saved by a query library is not worth being the one surface whose
 * cache, retry and invalidation semantics differ from the rest of the app.
 *
 * =============================================================================
 * POLLING IS CONDITIONAL, AND THE CONDITION IS "SOMETHING IS MOVING"
 * =============================================================================
 *
 * A generating note changes with nobody touching it, and a settled one does
 * not. So `pollIntervalMs` is DERIVED from the answer rather than being a
 * constant: fast while anything is `draft`/`generating`, off once nothing is.
 * The arithmetic is `useVisiblePolling`'s own — a library tab left open on a
 * second monitor overnight is thousands of discarded queries — and it applies
 * with more force here than on the transcripts list, because the notes list has
 * no ETag to make an unchanged answer cheap.
 *
 * ⚠ THE POLL IS NOT THE LIVE VIEW. Watching a note being written is
 * `connectNoteStream` (`services/noteGenerationStream.ts`), a second,
 * short-lived SSE connection owned by the page that is watching. This poll is
 * the FLOOR under it: a stream that drops, or was never established, must not
 * leave a note frozen mid-generation with nothing to unstick it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { getNote, getNoteSummary, getNotes } from '../services/notes';
import type {
  Note,
  NoteListItem,
  NoteListParams,
  NoteStatus,
  NoteSummary,
} from '../services/notes';
import { reconcileFeed } from '../utils/feedReconcile';
import { useCachedFeedState } from '../utils/feedCache';
import { useNotifications } from '../contexts/NotificationContext';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

/** While a generation is running. Fast enough that a status chip looks alive. */
export const NOTE_ACTIVE_POLL_MS = 5_000;

/** The registry-key prefix whose events mean "re-read the caller's notes". */
export const NOTE_EVENT_PREFIX = 'notes.';

/** Notes per page. The API's own default; stated here so the cursor tests can pin it. */
export const NOTE_PAGE_SIZE = 20;

/** The two statuses that mean "this note is still being written". */
export function isNoteInFlight(status: NoteStatus): boolean {
  return status === 'draft' || status === 'generating';
}

/**
 * Turn any thrown value into the sentence the page will render.
 *
 * 404 IS NAMED because its remedy is not "try again" — and because a note the
 * caller cannot reach answers 404 rather than 403 (the controller's own rule:
 * the existence of a specific note id is itself something a stranger has no
 * business learning), so this wording has to cover both "gone" and "never
 * yours" without implying which.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to view notes';
    if (err.status === 404) {
      return 'This note does not exist, or you no longer have access to it';
    }
    return err.message || fallback;
  }
  return fallback;
}

/**
 * The id of the most recent `notes.*` notification, or `null`.
 *
 * A STRING, not a counter or a callback — the same shape, and the same
 * reasoning, as `useLatestTranscriptEventId` in `useTranscripts.ts`. The
 * notification centre re-renders for reasons of its own (a read receipt, an
 * unrelated event), and a hook that refetched on every one of those would turn
 * the bell into a second, unthrottled poll. An id changes exactly when a NEW
 * note event arrives, which makes it safe to use directly as an effect
 * dependency.
 *
 * Returns `null` when no `NotificationProvider` is mounted — `useNotifications`
 * is deliberately tolerant, and the `?.` below is load-bearing rather than
 * defensive — so this works in a test, in the visual harness, and on any
 * surface that has no bell.
 */
function useLatestNoteEventId(): string | null {
  const notifications = useNotifications();
  return useMemo(() => {
    const match = notifications?.notifications.find((notification) =>
      notification.eventKey.startsWith(NOTE_EVENT_PREFIX),
    );
    return match?.id ?? null;
  }, [notifications?.notifications]);
}

// =============================================================================
// The list
// =============================================================================

export interface UseNotesResult {
  notes: NoteListItem[];
  isLoading: boolean;
  error: string | null;
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
  /**
   * Re-read page one INTO the accumulated list — a revalidation, not a reset.
   *
   * It used to reset to the first page, and that was issue #167: a `refresh()`
   * after a row action threw away every page the user had pressed "Load more"
   * for. New notes appear at the top, changed ones update in place, notes
   * removed from page one's window disappear, and everything already loaded
   * below that window stays loaded. See `utils/feedReconcile.ts`.
   */
  refresh: () => Promise<void>;
}

export interface UseNotesOptions {
  /** Substring of the title. Debouncing belongs to the caller's input. */
  q?: string;
  status?: NoteStatus;
  /** Every note generated from one transcript — what a transcript page asks for. */
  sourceTranscriptId?: string;
  /** `0` disables polling outright — what a test passes. */
  pollIntervalMs?: number;
  /**
   * Where this feed's loaded pages survive a drill-down (issue #168).
   *
   * OPT-IN, and the transcript detail page's note list is exactly why: it calls
   * this hook with a `sourceTranscriptId` and has no business participating in,
   * or evicting entries from, the library's cache. `undefined` — the default —
   * means no caching at all. Build it with `feedCacheKey` and include EVERY
   * active filter; see `utils/feedCache.ts` for why that is not optional.
   */
  cacheKey?: string;
}

/**
 * One page of notes, with a cursor for the rest.
 *
 * CURSOR-PAGINATED, never offset: the list is ordered by `updatedAt` and every
 * generation and every save rewrite that column, so offset paging over it skips
 * rows and repeats others while a user scrolls.
 *
 * =============================================================================
 * A BACKGROUND READ REVALIDATES; ONLY A NEW QUESTION RESETS
 * =============================================================================
 *
 * Issue #167, and the fix is deliberately IDENTICAL to `useTranscripts`' —
 * these two list hooks are twins, they had the same bug, and a merge rule that
 * lands in one shape here and another shape there is a merge rule that drifts.
 * The full argument is in `useTranscripts.ts`'s copy of this banner and in
 * `utils/feedReconcile.ts`; the short form:
 *
 * This list is live — the poll, the tab-refocus fetch, and a `refresh()` after
 * every row action all re-read PAGE ONE — and replacing the held rows with that
 * page silently collapsed two `loadMore` presses' worth of notes back to twenty.
 * So `load` takes an explicit MODE rather than a `showLoading` boolean:
 *
 *   • `'reset'` — the question changed AND nothing is held for the new one.
 *     Adopt the page wholesale, raise `isLoading`.
 *   • `'revalidate'` — the same question, asked again in the background. Merge
 *     the page into what is held, through `reconcileFeed`, no loading flag.
 *
 * THE MODE IS THE RIGHT DISCRIMINATOR because `load`'s identity changes exactly
 * when the query does — `q`, `status` and `sourceTranscriptId` are its only
 * deps — so the one effect that chooses a mode runs precisely when the question
 * changed. Reconciling a genuinely new question would splice notes matching the
 * OLD filter into the answer to a new one.
 *
 * ⚠ THAT EFFECT DOES NOT ALWAYS RESET, since #168 — same rule, same reasoning
 * and same `utils/feedCache.ts` as `useTranscripts`, which carries the long
 * form. With a `cacheKey` whose entry holds this question's own previous
 * answer, the effect revalidates rather than resetting, because those rows are
 * the feed the user paged through rather than a stale answer to a different
 * question.
 *
 * `loadMore` APPENDS, and it is still a different operation from both: it reads
 * a LATER page and dedupes on id. The state it shares with them is one object
 * (`{ items, nextCursor }`) so the rows and the cursor that describes where
 * they stop can never be updated in two places and disagree.
 */
export function useNotes(options: UseNotesOptions = {}): UseNotesResult {
  const { q, status, sourceTranscriptId, pollIntervalMs, cacheKey } = options;

  /**
   * The rows and their cursor, in ONE state value, seeded from the feed cache.
   *
   * Not two `useState`s. Every write below is a FUNCTIONAL update, because
   * `load` is a `useCallback` whose deps deliberately exclude the list — a
   * closure over `notes`/`nextCursor` here would be stale on exactly the poll
   * that matters and would reintroduce the truncation this fixes.
   *
   * With a `cacheKey` this is `useCachedFeedState` rather than a bare
   * `useState`, so a feed the user already paged through comes back on the
   * first frame after a drill-down (#168). Without one it behaves exactly like
   * the `useState` it replaced. `useTranscripts` carries the same pair.
   */
  const [feed, setFeed] = useCachedFeedState<NoteListItem>(cacheKey);
  const { items: notes, nextCursor } = feed;

  /**
   * A cache HIT must never flash a spinner over rows that are already painted,
   * and must never RESET — see the banner above. Both decisions come from this
   * one ref so they cannot disagree; it is a ref rather than state because it
   * is read inside the effect below and changing it must not itself render.
   */
  const seededFromCache = useRef(notes.length > 0);
  seededFromCache.current = notes.length > 0;

  const [isLoading, setIsLoading] = useState(() => notes.length === 0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  /**
   * A monotonically increasing token identifying the LATEST first-page request.
   *
   * Without it, a slow request for `q: "bud"` can settle after a fast one for
   * `q: "budget"` and overwrite the newer results with older ones — the classic
   * search race, which an every-keystroke filter makes routine rather than rare.
   */
  const requestToken = useRef(0);

  const load = useCallback(
    async (mode: 'reset' | 'revalidate') => {
      const token = (requestToken.current += 1);
      if (mode === 'reset') setIsLoading(true);
      try {
        const params: NoteListParams = {
          q,
          status,
          sourceTranscriptId,
          limit: NOTE_PAGE_SIZE,
        };
        const response = await getNotes(params);
        if (!isMounted() || token !== requestToken.current) return;
        if (mode === 'reset') {
          // A new question. Whatever was accumulated answered a different one.
          setFeed({ items: response.items, nextCursor: response.nextCursor });
        } else {
          // The same question. Merge page one back into the accumulated list —
          // items and cursor together, inside one updater, so they cannot
          // disagree. See `utils/feedReconcile.ts` for what the merge buys.
          setFeed((current) => reconcileFeed(current, response));
        }
        setError(null);
      } catch (err) {
        if (!isMounted() || token !== requestToken.current) return;
        setError(messageFor(err, 'Failed to load notes'));
      } finally {
        if (isMounted() && token === requestToken.current) setIsLoading(false);
      }
    },
    [isMounted, setFeed, q, sourceTranscriptId, status],
  );

  // THE QUESTION-CHANGED EFFECT. It fires on mount and again whenever `load`'s
  // identity changes, which is exactly when `q`/`status`/`sourceTranscriptId`
  // do — so "this effect ran" and "the question changed" are the same event.
  //
  // It RESETS only when there is nothing to keep. With a cache hit (#168) the
  // seeded rows are this exact question's own previous answer, and resetting
  // would throw them away and truncate the feed — #167's bug through a
  // different door. `reconcileFeed`'s first clause already makes a revalidation
  // behave identically to a reset when the held list is empty, so the rule is
  // simply: revalidate when there is something to revalidate.
  //
  // `cacheKey` is in the deps as well as `load`. In practice it is derived from
  // the same filters `load` is, so it never changes alone — but if it ever did,
  // omitting it would leave the newly-swapped rows sitting there with nothing
  // scheduled to revalidate them.
  useEffect(() => {
    void load(seededFromCache.current ? 'revalidate' : 'reset');
  }, [cacheKey, load]);

  // Derived, not constant — see the file header. `0` is "no interval at all",
  // which `useVisiblePolling` treats as a no-op rather than as "poll instantly".
  const anyInFlight = useMemo(
    () => notes.some((note) => isNoteInFlight(note.status)),
    [notes],
  );
  const interval = pollIntervalMs ?? (anyInFlight ? NOTE_ACTIVE_POLL_MS : 0);

  // A POLL REVALIDATES — it does not raise the loading flag, and it does not
  // throw away pages the user loaded. The rows stay on screen and keep their
  // scroll offset. A spinner every five seconds over data that is already
  // correct is the fastest way to make a live list unusable.
  useVisiblePolling(() => void load('revalidate'), interval);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const response = await getNotes({
        q,
        status,
        sourceTranscriptId,
        limit: NOTE_PAGE_SIZE,
        cursor: nextCursor,
      });
      if (!isMounted()) return;
      // Deduped on append. A row whose `updatedAt` moved between the two
      // requests can legitimately appear on both pages — cursor paging bounds
      // the window, it does not freeze the ordering — and React would then warn
      // about a duplicate key while rendering the row twice.
      setFeed((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return {
          items: [...current.items, ...response.items.filter((item) => !seen.has(item.id))],
          // This page's own cursor, unlike a revalidation's: `loadMore` is the
          // operation that actually advances the window.
          nextCursor: response.nextCursor,
        };
      });
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load more notes'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [isLoadingMore, setFeed, isMounted, nextCursor, q, sourceTranscriptId, status]);

  const refresh = useCallback(() => load('revalidate'), [load]);

  return { notes, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh };
}

// =============================================================================
// The home page's summary
// =============================================================================

export interface UseNoteSummaryResult {
  summary: NoteSummary | null;
  /** Only true for the FIRST read. A poll never raises it — see below. */
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export interface UseNoteSummaryOptions {
  /**
   * `false` issues NO request at all and reports `{ null, false, null }`.
   *
   * This is the `notes:read` gate, and it has to live here rather than in the
   * page's JSX: a hook cannot be mounted conditionally, so a caller that wanted
   * to skip the read would otherwise have to render a second component tree
   * just to avoid firing a request the API is going to answer 403 to. `false`
   * also leaves `isLoading` FALSE rather than stuck true, because there is
   * nothing to wait for — a spinner that never resolves is worse than no
   * section.
   */
  enabled?: boolean;
}

/**
 * The notes half of the home page — issue #107.
 *
 * ⚠ A SECOND REQUEST BESIDE `useTranscriptSummary`, DELIBERATELY. `HomePage`'s
 * header carries the full argument; the short form is that `GET
 * /api/notes/summary` and `GET /api/transcripts/summary` are gated on two
 * different permissions (`notes:read`, `transcripts:read`), so an aggregate
 * endpoint would have to answer partially for a user holding one of them. The
 * two are fired in parallel and neither waits on the other.
 *
 * Shaped after `useTranscriptSummary` line for line, and that twinning is the
 * point: two summary hooks feeding one page that diverged on when they poll,
 * whether a poll raises the skeleton, or what a failed refresh does to the rows
 * already on screen would make one page behave two ways depending on which
 * section you were looking at.
 *
 * =============================================================================
 * IT POLLS ONLY WHILE SOMETHING IS GENERATING
 * =============================================================================
 *
 * `pollIntervalMs` is derived from the answer, not from a constant: with
 * `inProgress` non-empty the page is a progress display and the chips must
 * move, and with it empty there is nothing on this screen that changes without
 * the user doing something. This is the LANDING PAGE — the tab most likely to
 * be the one left open on a second monitor overnight — so the arithmetic in
 * `useVisiblePolling`'s own header applies here with full force.
 *
 * The notification stream covers the gap the conditional poll opens: a note
 * that finishes elsewhere raises a `notes.*` event that refetches immediately,
 * so an idle home page still notices — it just does not ask every five seconds
 * when it has no reason to.
 *
 * A POLL DOES NOT RAISE `isLoading`, and A FAILED POLL KEEPS THE LAST GOOD
 * SUMMARY, for the two reasons `useTranscriptSummary` states: the skeleton must
 * appear once rather than every five seconds over content that is already
 * correct, and a refresh that 500s mid-visit must not replace a correct list
 * with an error banner and nothing else. Holding the rows and recording the
 * error is the honest state ("this may be stale").
 */
export function useNoteSummary(options: UseNoteSummaryOptions = {}): UseNoteSummaryResult {
  const { enabled = true } = options;

  const [summary, setSummary] = useState<NoteSummary | null>(null);
  // Starts false when disabled, so a page with no `notes:read` never renders a
  // loading state for a request that is never going to be made.
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!enabled) return;
      if (showLoading) setIsLoading(true);
      try {
        const response = await getNoteSummary();
        if (!isMounted()) return;
        setSummary(response);
        setError(null);
      } catch (err) {
        // The HELD SUMMARY IS NOT CLEARED — see the header.
        if (isMounted()) setError(messageFor(err, 'Failed to load your notes'));
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [enabled, isMounted],
  );

  useEffect(() => {
    if (!enabled) {
      // Reset rather than leave whatever a previously-enabled mount read: a
      // page that loses the permission mid-session must not keep rendering the
      // rows it was allowed to see a moment ago.
      setSummary(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    void load(true);
  }, [enabled, load]);

  const hasInFlight = (summary?.inProgress.length ?? 0) > 0;
  useVisiblePolling(
    () => void load(false),
    enabled && hasInFlight ? NOTE_ACTIVE_POLL_MS : 0,
  );

  const latestEventId = useLatestNoteEventId();
  useEffect(() => {
    if (!latestEventId || !enabled) return;
    void load(false);
  }, [enabled, latestEventId, load]);

  const refresh = useCallback(() => load(false), [load]);

  return { summary, isLoading, error, refresh };
}

// =============================================================================
// One note
// =============================================================================

export interface UseNoteResult {
  note: Note | null;
  /** Only true for the FIRST read. A poll never raises it. */
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Replace the held note without a round trip — for a regenerate's own answer. */
  setNote: (note: Note) => void;
}

/**
 * One note, polled while it is being written.
 *
 * NO ETag, unlike `useTranscript`. `GET /api/notes/{id}` does answer a weak
 * validator, and using it would be a real saving on a page that polled forever
 * — but this poll STOPS the moment the note settles (see `interval` below), so
 * the request that the ETag would make cheap is a request this hook does not
 * make at all. Adding the conditional path would be a second, subtler copy of
 * `services/transcripts.ts`'s raw-fetch deviation to buy nothing.
 */
export function useNote(id: string | undefined, pollIntervalMs?: number): UseNoteResult {
  const [note, setNote] = useState<Note | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (!id) return;
      if (showLoading) setIsLoading(true);
      try {
        const next = await getNote(id);
        if (!isMounted()) return;
        setNote(next);
        setError(null);
      } catch (err) {
        if (!isMounted()) return;
        setError(messageFor(err, 'Failed to load this note'));
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [id, isMounted],
  );

  useEffect(() => {
    // Reset rather than keep the previous note on screen: `/notes/a` →
    // `/notes/b` must not render a's body under b's heading for a frame.
    setNote(null);
    setIsLoading(true);
    void load(true);
  }, [load]);

  const interval =
    pollIntervalMs ?? (note && isNoteInFlight(note.status) ? NOTE_ACTIVE_POLL_MS : 0);

  useVisiblePolling(() => void load(false), interval);

  const refresh = useCallback(() => load(false), [load]);

  return { note, isLoading, error, refresh, setNote };
}
