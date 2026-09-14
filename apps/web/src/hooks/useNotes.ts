/**
 * The notes data layer — issue #57, epic #45.
 *
 * Two hooks, one file, for the reason `useTranscripts.ts` gives about its own
 * four: they are two views of one surface and what they share is a contract —
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
import { getNote, getNotes } from '../services/notes';
import type { Note, NoteListItem, NoteListParams, NoteStatus } from '../services/notes';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

/** While a generation is running. Fast enough that a status chip looks alive. */
export const NOTE_ACTIVE_POLL_MS = 5_000;

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
}

/**
 * One page of notes, with a cursor for the rest.
 *
 * CURSOR-PAGINATED, never offset: the list is ordered by `updatedAt` and every
 * generation and every save rewrite that column, so offset paging over it skips
 * rows and repeats others while a user scrolls. `loadMore` APPENDS and
 * `refresh` resets to the first page — two different operations, deliberately
 * not sharing one state setter, because that is how a "load more" quietly
 * starts truncating the list.
 */
export function useNotes(options: UseNotesOptions = {}): UseNotesResult {
  const { q, status, sourceTranscriptId, pollIntervalMs } = options;

  const [notes, setNotes] = useState<NoteListItem[]>([]);
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
   * search race, which an every-keystroke filter makes routine rather than rare.
   */
  const requestToken = useRef(0);

  const load = useCallback(
    async (showLoading: boolean) => {
      const token = (requestToken.current += 1);
      if (showLoading) setIsLoading(true);
      try {
        const params: NoteListParams = {
          q,
          status,
          sourceTranscriptId,
          limit: NOTE_PAGE_SIZE,
        };
        const response = await getNotes(params);
        if (!isMounted() || token !== requestToken.current) return;
        setNotes(response.items);
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (err) {
        if (!isMounted() || token !== requestToken.current) return;
        setError(messageFor(err, 'Failed to load notes'));
      } finally {
        if (isMounted() && token === requestToken.current) setIsLoading(false);
      }
    },
    [isMounted, q, sourceTranscriptId, status],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // Derived, not constant — see the file header. `0` is "no interval at all",
  // which `useVisiblePolling` treats as a no-op rather than as "poll instantly".
  const anyInFlight = useMemo(
    () => notes.some((note) => isNoteInFlight(note.status)),
    [notes],
  );
  const interval = pollIntervalMs ?? (anyInFlight ? NOTE_ACTIVE_POLL_MS : 0);

  // A POLL DOES NOT RAISE THE LOADING FLAG — the rows stay on screen and keep
  // their scroll offset. A spinner every five seconds over data that is already
  // correct is the fastest way to make a live list unusable.
  useVisiblePolling(() => void load(false), interval);

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
      setNotes((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...response.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(response.nextCursor);
      setError(null);
    } catch (err) {
      if (isMounted()) setError(messageFor(err, 'Failed to load more notes'));
    } finally {
      if (isMounted()) setIsLoadingMore(false);
    }
  }, [isLoadingMore, isMounted, nextCursor, q, sourceTranscriptId, status]);

  const refresh = useCallback(() => load(false), [load]);

  return { notes, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh };
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
