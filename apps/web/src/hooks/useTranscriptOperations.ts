/**
 * The correction queue — issue #31, epic #19.
 *
 * One hook owns every write a transcript editor can make: it applies the change
 * locally first so the screen never waits for the network, batches a burst of
 * typing into ONE `POST /:id/operations` (and therefore one version), retries a
 * failed send with the same idempotency key, resolves a 409 without throwing
 * away what the user typed, survives going offline, and refuses to let the tab
 * close while anything is unsaved.
 *
 * =============================================================================
 * WHY TEXT IS DEBOUNCED AND EVERYTHING ELSE FLUSHES IMMEDIATELY
 * =============================================================================
 *
 * A version is a unit of history a person will later read in the history page
 * ("Edited 4 segments", "Merged Speaker C into Speaker A"). Typing produces
 * dozens of intermediate states that are not history — nobody wants to restore
 * "Hello wor". So `updateText` coalesces per segment into a pending map and
 * flushes after `DEBOUNCE_MS` of idle, on blur, or when any other action
 * happens.
 *
 * Every other action is a decision the user made once, and each one FLUSHES THE
 * PENDING TEXT FIRST and then sends alone. That ordering is not tidiness, it is
 * correctness: each op carries the `rev` it expects, applying a text edit bumps
 * that segment's `rev`, and a batch containing `update_text(rev 1)` followed by
 * `split(rev 1)` on the same segment would have its second op rejected by the
 * server's own check. Flushing first means the structural op is built from
 * revs the server has just confirmed.
 *
 * =============================================================================
 * THE OUTBOX, AND WHY IT IS A REF
 * =============================================================================
 *
 * Batches queue in `outbox` — a ref, drained by one `drain()` loop that is
 * never re-entered. A send is not cancellable and its result must be applied in
 * order (each response carries the full, authoritative segment list), so two
 * overlapping drains would race to decide what the transcript says. The ref
 * also means enqueuing does not re-render; the render-visible facts (`saveState`,
 * `pendingCount`, `isOffline`) are separate state updated deliberately.
 *
 * A batch keeps its `clientBatchId` across retries, ON PURPOSE. That is the
 * whole point of the key: a save that succeeded but whose response was lost
 * (a dropped connection, a backgrounded tab) is retried with the identical key
 * and the server returns the ORIGINAL result rather than creating a second
 * version. A fresh key per attempt would turn one correction into two.
 *
 * =============================================================================
 * ADOPTING SERVER STATE — ONLY WHEN CLEAN, AND ONLY WHEN NEWER
 * =============================================================================
 *
 * The page polls `GET /:id` and `GET /:id/segments` every few seconds. Adopting
 * a poll's answer while local edits are pending would erase them under the
 * user's fingers, so the working copy adopts server state only when the outbox
 * and the pending map are both empty AND the server's version is at least the
 * one already held — the second condition covers the window between our own
 * save landing and the parent's next poll noticing it, where the parent's state
 * is legitimately older than ours.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  applyOperations,
  newClientBatchId,
  OP_TYPES,
  parseOperationsConflict,
  restoreTranscriptVersion,
} from '../services/transcriptEditing';
import type {
  MergeUndo,
  OperationsResult,
  TranscriptOp,
  UpdateTextOp,
} from '../services/transcriptEditing';
import { getTranscript, getTranscriptSegments } from '../services/transcripts';
import type { TranscriptSegment, TranscriptSpeaker } from '../services/transcripts';
import { useIsMounted } from './useIsMounted';

/** Idle time before a burst of typing becomes one batch. */
export const DEBOUNCE_MS = 1_500;

/** Attempts per batch before it is abandoned and reported. */
export const MAX_SEND_ATTEMPTS = 5;

/** First retry delay; doubles per attempt, capped at `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 800;
export const RETRY_MAX_MS = 15_000;

/** What the save indicator says. */
export type SaveState = 'saved' | 'pending' | 'saving' | 'offline' | 'error';

/**
 * One unresolved collision, phrased as the two things the user must choose
 * between rather than as the `rev` numbers that caused it.
 */
export interface EditConflict {
  entity: 'segment' | 'speaker';
  id: string;
  /** What this editor typed and has NOT lost. */
  mine: string;
  /** What the transcript says right now, because somebody else saved first. */
  theirs: string;
  /** The entity's current `rev`, or null when the other editor DELETED it. */
  currentRev: number | null;
  /** Who is speaking, for a segment — context the text alone does not give. */
  label: string;
}

interface WorkingState {
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  version: number;
}

interface Batch {
  clientBatchId: string;
  ops: TranscriptOp[];
  attempts: number;
}

export interface UseTranscriptOperationsOptions {
  transcriptId: string | undefined;
  /** Server-held speakers, from `useTranscript`. */
  speakers: readonly TranscriptSpeaker[];
  /** Server-held segments, from `useTranscriptSegments`. */
  segments: readonly TranscriptSegment[];
  /** The version those two belong to, or null before the first read. */
  version: number | null;
  /** False for a viewer: every action becomes a no-op and nothing is queued. */
  enabled?: boolean;
  /** Overridable so a test does not have to wait 1.5 real seconds. */
  debounceMs?: number;
}

export interface UseTranscriptOperationsResult {
  /** The transcript AS EDITED — what the page renders, never the raw server copy. */
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  version: number;

  saveState: SaveState;
  /** Ops waiting to be sent, including the debounced ones. */
  pendingCount: number;
  isOffline: boolean;
  /** A sentence to render, or null. Not thrown — every action resolves. */
  error: string | null;
  dismissError: () => void;
  conflicts: EditConflict[];
  resolveConflict: (id: string, choice: 'mine' | 'theirs') => void;

  /** Debounced. Safe to call on every keystroke. */
  updateText: (segmentId: string, text: string) => void;
  /** Flush whatever is pending now — what a blur and the unload guard call. */
  flush: () => Promise<void>;

  setSpeaker: (segmentId: string, speakerId: string) => Promise<void>;
  splitSegment: (
    segmentId: string,
    atCharOffset: number,
    newSpeakerId?: string | null,
  ) => Promise<void>;
  joinWithNext: (segmentId: string) => Promise<void>;
  deleteSegment: (segmentId: string) => Promise<void>;
  renameSpeaker: (speakerId: string, displayName: string) => Promise<void>;
  /** Resolves with the speaker the SERVER created — id and colour are its choice. */
  createSpeaker: (displayName: string) => Promise<TranscriptSpeaker | null>;
  mergeSpeakers: (
    sourceIds: string[],
    targetId: string,
    keepName: boolean,
  ) => Promise<void>;
  replaceAll: (params: {
    find: string;
    replace: string;
    matchCase: boolean;
    wholeWord: boolean;
    speakerId?: string | null;
  }) => Promise<void>;
  /** Replace ONE occurrence, by offsets into that segment's current text. */
  replaceOne: (
    segmentId: string,
    start: number,
    end: number,
    replacement: string,
  ) => void;

  /** The most recent merge, while it is still undoable. */
  undoableMerge: { merges: MergeUndo[]; version: number; summary: string } | null;
  undoMerge: () => Promise<void>;
  dismissUndo: () => void;
}

// =============================================================================
// Local reducers — the optimistic half
// =============================================================================

/**
 * The id a locally-split segment carries until the server answers.
 *
 * Prefixed and obviously not a UUID so it can never be mistaken for one and
 * sent back in an op: the only thing that ever references it is React's own key
 * for a row that exists for a few hundred milliseconds.
 */
function localSegmentId(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Apply one op to the working copy, the way the server will.
 *
 * DELIBERATELY NOT A SECOND IMPLEMENTATION OF THE REDUCERS. It is a preview:
 * every batch's response carries the authoritative `speakers` and `segments`
 * and replaces this wholesale, so the only requirement here is that the frame
 * between the keystroke and the response looks right. Word re-alignment,
 * ordinal arithmetic and `rev` bumps are all the server's, and guessing at them
 * here would be inventing a second source of truth for the sake of 200ms.
 */
function applyLocally(state: WorkingState, op: TranscriptOp): WorkingState {
  switch (op.op) {
    case OP_TYPES.UPDATE_TEXT: {
      return {
        ...state,
        segments: state.segments.map((segment) =>
          segment.id === op.segmentId
            ? { ...segment, text: op.text, origin: 'user' }
            : segment,
        ),
      };
    }
    case OP_TYPES.SET_SPEAKER: {
      return {
        ...state,
        segments: state.segments.map((segment) =>
          segment.id === op.segmentId
            ? { ...segment, speakerId: op.speakerId, origin: 'user' }
            : segment,
        ),
      };
    }
    case OP_TYPES.SPLIT: {
      const index = state.segments.findIndex((segment) => segment.id === op.segmentId);
      if (index < 0) return state;
      const segment = state.segments[index];
      const offset = Math.max(0, Math.min(segment.text.length, op.atCharOffset ?? 0));
      const head = segment.text.slice(0, offset).trimEnd();
      const tail = segment.text.slice(offset).trimStart();
      const next = state.segments[index + 1];
      // The midpoint of the gap, which is exactly what the server does — gap
      // ordinals exist so an insert needs no renumbering (spec §3.4).
      const ordinal = next
        ? (segment.ordinal + next.ordinal) / 2
        : segment.ordinal + 1000;
      const second: TranscriptSegment = {
        ...segment,
        id: localSegmentId(),
        ordinal,
        text: tail,
        speakerId: op.newSpeakerId ?? segment.speakerId,
        origin: 'user',
        rev: 1,
      };
      const segments = [...state.segments];
      segments.splice(index, 1, { ...segment, text: head, origin: 'user' }, second);
      return { ...state, segments };
    }
    case OP_TYPES.JOIN: {
      const [firstId, secondId] = op.segmentIds;
      const first = state.segments.find((segment) => segment.id === firstId);
      const second = state.segments.find((segment) => segment.id === secondId);
      if (!first || !second) return state;
      return {
        ...state,
        segments: state.segments
          .filter((segment) => segment.id !== secondId)
          .map((segment) =>
            segment.id === firstId
              ? {
                  ...segment,
                  text: `${first.text} ${second.text}`.trim(),
                  endMs: Math.max(first.endMs, second.endMs),
                  origin: 'user',
                }
              : segment,
          ),
      };
    }
    case OP_TYPES.DELETE: {
      return {
        ...state,
        segments: state.segments.filter((segment) => segment.id !== op.segmentId),
      };
    }
    case OP_TYPES.RENAME_SPEAKER: {
      return {
        ...state,
        speakers: state.speakers.map((speaker) =>
          speaker.id === op.speakerId
            ? { ...speaker, displayName: op.displayName }
            : speaker,
        ),
      };
    }
    case OP_TYPES.MERGE_SPEAKERS: {
      const sources = new Set(op.sourceIds);
      const target = state.speakers.find((speaker) => speaker.id === op.targetId);
      const firstSource = state.speakers.find((speaker) => speaker.id === op.sourceIds[0]);
      return {
        ...state,
        speakers: state.speakers
          .filter((speaker) => !sources.has(speaker.id))
          .map((speaker) =>
            speaker.id === op.targetId && op.keepName === false && firstSource
              ? // The colour stays the TARGET's: a merge that repainted every
                // surviving line would undo the one cue that makes a speaker
                // recognisable at a glance.
                { ...speaker, displayName: firstSource.displayName }
              : speaker,
          ),
        segments: state.segments.map((segment) =>
          sources.has(segment.speakerId)
            ? { ...segment, speakerId: target?.id ?? segment.speakerId }
            : segment,
        ),
      };
    }
    // `speaker.create` mints an id and a colour server-side, and
    // `transcript.find_replace` is expanded server-side into concrete text ops.
    // Previewing either means inventing the server's answer, so neither has a
    // local preview — both are sent immediately and the response is the update.
    default:
      return state;
  }
}

/** Backoff for attempt `n` (1-based), doubling with a cap. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

// =============================================================================
// The hook
// =============================================================================

export function useTranscriptOperations(
  options: UseTranscriptOperationsOptions,
): UseTranscriptOperationsResult {
  const {
    transcriptId,
    speakers,
    segments,
    version,
    enabled = true,
    debounceMs = DEBOUNCE_MS,
  } = options;

  const isMounted = useIsMounted();

  /** segmentId → the text the user has typed but not yet sent. */
  const pendingText = useRef(new Map<string, string>());
  const outbox = useRef<Batch[]>([]);
  const draining = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [working, setWorking] = useState<WorkingState>({
    speakers: [...speakers],
    segments: [...segments],
    version: version ?? 0,
  });

  /**
   * The last server tuple this hook adopted, by IDENTITY.
   *
   * Adoption happens DURING RENDER rather than in an effect, and the difference
   * is visible: an effect would commit one frame showing the old (usually
   * empty) list and then re-render with the real one, which is a flash on every
   * load and — worse — a frame in which the page can be observed with no
   * segments in it. React re-runs the render function immediately for a
   * render-phase `setState` on the SAME component and commits only the second
   * result, so this costs a render pass and no frame.
   */
  /**
   * The working copy, mirrored for the CALLBACKS.
   *
   * ⚠ WRITTEN EAGERLY BY `commitWorking`, not only on re-render. Every action
   * builds its ops from `workingRef.current` — `segment.delete` needs the `rev`
   * the batch before it just returned — and React has not re-rendered yet at
   * the moment an `await`ed flush resolves inside one user action. A ref that
   * only caught up on render would hand the next op the `rev` the server has
   * already moved past, which is a 409 the user did nothing to deserve.
   */
  const workingRef = useRef(working);
  workingRef.current = working;

  const adoptedSource = useRef<{
    speakers: readonly TranscriptSpeaker[];
    segments: readonly TranscriptSegment[];
    version: number | null;
  }>({ speakers, segments, version });

  const sourceChanged =
    adoptedSource.current.speakers !== speakers ||
    adoptedSource.current.segments !== segments ||
    adoptedSource.current.version !== version;

  if (sourceChanged) {
    adoptedSource.current = { speakers, segments, version };
    const dirty = pendingText.current.size > 0 || outbox.current.length > 0;
    // Both conditions, and both are load-bearing — see the file header.
    const stale = version !== null && version < working.version;
    if (!dirty && !draining.current && !stale) {
      const next: WorkingState = {
        speakers: [...speakers],
        segments: [...segments],
        version: version ?? working.version,
      };
      workingRef.current = next;
      setWorking(next);
    }
  }

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [pendingCount, setPendingCount] = useState(0);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine === false : false,
  );
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<EditConflict[]>([]);
  const [undoableMerge, setUndoableMerge] = useState<
    { merges: MergeUndo[]; version: number; summary: string } | null
  >(null);

  const publishPending = useCallback(() => {
    const count =
      pendingText.current.size +
      outbox.current.reduce((total, batch) => total + batch.ops.length, 0);
    setPendingCount(count);
    return count;
  }, []);

  /** Write the working copy to BOTH the ref and the state — see `workingRef`. */
  const commitWorking = useCallback(
    (next: WorkingState | ((current: WorkingState) => WorkingState)) => {
      const value = typeof next === 'function' ? next(workingRef.current) : next;
      workingRef.current = value;
      setWorking(value);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Offline
  // ---------------------------------------------------------------------------
  const drainRef = useRef<() => void>(() => {});

  useEffect(() => {
    const goOnline = () => {
      setIsOffline(false);
      // The whole reason the banner exists: reconnecting must SEND, not merely
      // stop complaining.
      drainRef.current();
    };
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // The unload guard
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (pendingCount === 0) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Assigning `returnValue` as well as calling `preventDefault` is what
      // older browsers actually honour; the string itself is never shown by
      // anything current, which is why there is no message to translate.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [pendingCount]);

  // ---------------------------------------------------------------------------
  // Conflict handling
  // ---------------------------------------------------------------------------

  /**
   * Re-read the transcript, KEEP the user's text, and raise a card per
   * collision.
   *
   * The refetch is what makes "keep mine" possible at all: resolving in the
   * user's favour means re-sending their text against the `rev` that won, and
   * this is where that `rev` comes from.
   */
  const handleConflict = useCallback(
    async (batch: Batch, conflict: { conflicts: { entity: 'segment' | 'speaker'; id: string; current: number | null }[] }) => {
      if (!transcriptId) return;

      const mineByEntity = new Map<string, string>();
      for (const op of batch.ops) {
        if (op.op === OP_TYPES.UPDATE_TEXT) mineByEntity.set(op.segmentId, op.text);
        if (op.op === OP_TYPES.RENAME_SPEAKER) mineByEntity.set(op.speakerId, op.displayName);
      }

      let fresh: WorkingState | null = null;
      try {
        const [detail, segmentsResult] = await Promise.all([
          getTranscript(transcriptId, null),
          getTranscriptSegments(transcriptId, null),
        ]);
        if (detail.status === 'ok' && segmentsResult.status === 'ok') {
          fresh = {
            speakers: detail.data.speakers,
            segments: segmentsResult.data.segments,
            version: segmentsResult.data.currentVersion,
          };
        }
      } catch {
        // A refetch that fails leaves the working copy — and therefore the
        // user's text — exactly where it was. That is the safe direction.
      }
      if (!isMounted()) return;

      const cards: EditConflict[] = [];
      const base = fresh ?? workingRef.current;

      for (const entry of conflict.conflicts) {
        const mine = mineByEntity.get(entry.id);
        if (mine === undefined) continue;
        if (entry.entity === 'segment') {
          const server = base.segments.find((segment) => segment.id === entry.id);
          const speaker = base.speakers.find((item) => item.id === server?.speakerId);
          cards.push({
            entity: 'segment',
            id: entry.id,
            mine,
            theirs: server?.text ?? '',
            currentRev: entry.current,
            label: speaker?.displayName ?? 'This line',
          });
        } else {
          const server = base.speakers.find((item) => item.id === entry.id);
          cards.push({
            entity: 'speaker',
            id: entry.id,
            mine,
            theirs: server?.displayName ?? '',
            currentRev: entry.current,
            label: 'Speaker name',
          });
        }
      }

      if (fresh) {
        // The user's text survives the refetch — that is the promise this whole
        // path exists to keep. The server copy is still available inside the
        // card as "theirs", so nothing is lost either way.
        const conflicted = new Map(cards.map((card) => [card.id, card]));
        commitWorking({
          ...fresh,
          segments: fresh.segments.map((segment) => {
            const card = conflicted.get(segment.id);
            return card && card.entity === 'segment'
              ? { ...segment, text: card.mine }
              : segment;
          }),
          speakers: fresh.speakers.map((speaker) => {
            const card = conflicted.get(speaker.id);
            return card && card.entity === 'speaker'
              ? { ...speaker, displayName: card.mine }
              : speaker;
          }),
        });
      }

      setConflicts((current) => {
        const merged = [...current.filter((card) => !cards.some((next) => next.id === card.id))];
        return [...merged, ...cards];
      });
    },
    [commitWorking, isMounted, transcriptId],
  );

  // ---------------------------------------------------------------------------
  // The drain loop
  // ---------------------------------------------------------------------------

  const adoptResult = useCallback((result: OperationsResult) => {
    commitWorking({
      speakers: result.speakers,
      segments: result.segments,
      version: result.version,
    });
    if (result.merges.length > 0 && !result.idempotentReplay) {
      setUndoableMerge({
        merges: result.merges,
        version: result.version,
        summary: result.summary,
      });
    }
  }, [commitWorking]);

  const drain = useCallback(async (): Promise<void> => {
    if (draining.current || !transcriptId) return;
    if (outbox.current.length === 0) {
      setSaveState((current) => (current === 'error' ? current : 'saved'));
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setIsOffline(true);
      setSaveState('offline');
      return;
    }

    draining.current = true;
    setSaveState('saving');

    try {
      while (outbox.current.length > 0) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setIsOffline(true);
          setSaveState('offline');
          return;
        }

        const batch = outbox.current[0];
        batch.attempts += 1;
        try {
          const result = await applyOperations(transcriptId, {
            baseVersion: workingRef.current.version,
            clientBatchId: batch.clientBatchId,
            ops: batch.ops,
          });
          outbox.current.shift();
          if (!isMounted()) return;
          adoptResult(result);
          setError(null);
          publishPending();
        } catch (err) {
          const conflict = parseOperationsConflict(err);
          if (conflict) {
            outbox.current.shift();
            publishPending();
            await handleConflict(batch, conflict);
            continue;
          }

          const status = err instanceof ApiError ? err.status : 0;
          // A 4xx is a verdict, not a hiccup: the same bytes will be refused
          // the same way forever, so retrying is only a slower way to lose the
          // batch. 403 in particular is an editor whose ROLE lacks
          // `transcripts:write` — a real state this app must show rather than
          // swallow.
          const permanent = status >= 400 && status < 500;
          if (permanent || batch.attempts >= MAX_SEND_ATTEMPTS) {
            outbox.current.shift();
            if (!isMounted()) return;
            setError(
              status === 403
                ? 'You can read this transcript but not change it. Ask the owner for edit access.'
                : err instanceof ApiError
                  ? err.message
                  : 'Your changes could not be saved. They are still here — try again.',
            );
            setSaveState('error');
            publishPending();
            continue;
          }

          // Same `clientBatchId`, deliberately — see the file header.
          if (!isMounted()) return;
          setSaveState('pending');
          const delay = retryDelayMs(batch.attempts);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            drainRef.current();
          }, delay);
          return;
        }
      }

      if (isMounted()) {
        setSaveState((current) => (current === 'error' ? current : 'saved'));
      }
    } finally {
      draining.current = false;
      // A batch enqueued while this loop was running — a debounce that fired
      // mid-send, a conflict resolution — would otherwise sit in the outbox
      // until the NEXT action happened to drain it. `drain()` refuses to
      // re-enter itself, so the re-check belongs here, after the flag drops.
      if (
        outbox.current.length > 0 &&
        retryTimer.current === null &&
        !(typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        queueMicrotask(() => drainRef.current());
      }
    }
  }, [adoptResult, handleConflict, isMounted, publishPending, transcriptId]);

  const drainNow = useCallback(() => {
    void drain();
  }, [drain]);
  drainRef.current = drainNow;

  // ---------------------------------------------------------------------------
  // Enqueuing
  // ---------------------------------------------------------------------------

  /** Move the debounced text edits into a batch. Returns true if it queued one. */
  const queuePendingText = useCallback((): boolean => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (pendingText.current.size === 0) return false;

    const ops: UpdateTextOp[] = [];
    for (const [segmentId, text] of pendingText.current) {
      const segment = workingRef.current.segments.find((item) => item.id === segmentId);
      if (!segment) continue;
      ops.push({ op: OP_TYPES.UPDATE_TEXT, segmentId, rev: segment.rev, text });
    }
    pendingText.current.clear();
    if (ops.length === 0) return false;

    outbox.current.push({ clientBatchId: newClientBatchId(), ops, attempts: 0 });
    return true;
  }, []);

  const flush = useCallback(async () => {
    queuePendingText();
    publishPending();
    await drain();
  }, [drain, publishPending, queuePendingText]);

  /**
   * Flush the pending text, then send `build()`'s ops as their own batch.
   *
   * `build` is a FUNCTION rather than an op array because it must run AFTER the
   * flush: the revs it needs are the ones the flush's response just delivered,
   * and an array built before the await would carry the stale ones.
   */
  const runImmediate = useCallback(
    async (build: () => TranscriptOp[] | null) => {
      if (!enabled || !transcriptId) return;
      queuePendingText();
      publishPending();
      await drain();
      if (!isMounted()) return;

      const ops = build();
      if (!ops || ops.length === 0) return;

      commitWorking((current) => ops.reduce(applyLocally, current));
      outbox.current.push({ clientBatchId: newClientBatchId(), ops, attempts: 0 });
      publishPending();
      await drain();
    },
    [commitWorking, drain, enabled, isMounted, publishPending, queuePendingText, transcriptId],
  );

  // ---------------------------------------------------------------------------
  // The actions
  // ---------------------------------------------------------------------------

  const updateText = useCallback(
    (segmentId: string, text: string) => {
      if (!enabled) return;
      const segment = workingRef.current.segments.find((item) => item.id === segmentId);
      if (!segment || segment.text === text) return;

      // Coalesced per segment: a hundred keystrokes on one line is ONE op, not
      // a hundred, and a burst across three lines is one batch of three.
      pendingText.current.set(segmentId, text);
      commitWorking((current) =>
        applyLocally(current, { op: OP_TYPES.UPDATE_TEXT, segmentId, rev: segment.rev, text }),
      );
      publishPending();
      setSaveState('pending');

      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        queuePendingText();
        publishPending();
        drainRef.current();
      }, debounceMs);
    },
    [commitWorking, debounceMs, enabled, publishPending, queuePendingText],
  );

  const setSpeaker = useCallback(
    (segmentId: string, speakerId: string) =>
      runImmediate(() => {
        const segment = workingRef.current.segments.find((item) => item.id === segmentId);
        if (!segment || segment.speakerId === speakerId) return null;
        return [{ op: OP_TYPES.SET_SPEAKER, segmentId, rev: segment.rev, speakerId }];
      }),
    [runImmediate],
  );

  const splitSegment = useCallback(
    (segmentId: string, atCharOffset: number, newSpeakerId?: string | null) =>
      runImmediate(() => {
        const segment = workingRef.current.segments.find((item) => item.id === segmentId);
        if (!segment) return null;
        // A split at 0 or at the end produces an empty half and no useful
        // change; the API would take it, which is exactly why the client should
        // not send it.
        if (atCharOffset <= 0 || atCharOffset >= segment.text.length) return null;
        return [
          {
            op: OP_TYPES.SPLIT,
            segmentId,
            rev: segment.rev,
            atCharOffset,
            ...(newSpeakerId ? { newSpeakerId } : {}),
          },
        ];
      }),
    [runImmediate],
  );

  const joinWithNext = useCallback(
    (segmentId: string) =>
      runImmediate(() => {
        const list = workingRef.current.segments;
        const index = list.findIndex((item) => item.id === segmentId);
        if (index < 0 || index + 1 >= list.length) return null;
        const first = list[index];
        const second = list[index + 1];
        return [
          {
            op: OP_TYPES.JOIN,
            segmentIds: [first.id, second.id],
            revs: [first.rev, second.rev],
          },
        ];
      }),
    [runImmediate],
  );

  const deleteSegment = useCallback(
    (segmentId: string) =>
      runImmediate(() => {
        const segment = workingRef.current.segments.find((item) => item.id === segmentId);
        if (!segment) return null;
        return [{ op: OP_TYPES.DELETE, segmentId, rev: segment.rev }];
      }),
    [runImmediate],
  );

  const renameSpeaker = useCallback(
    (speakerId: string, displayName: string) =>
      runImmediate(() => {
        const speaker = workingRef.current.speakers.find((item) => item.id === speakerId);
        const trimmed = displayName.trim();
        if (!speaker || !trimmed || speaker.displayName === trimmed) return null;
        return [
          { op: OP_TYPES.RENAME_SPEAKER, speakerId, rev: speaker.rev, displayName: trimmed },
        ];
      }),
    [runImmediate],
  );

  /**
   * Create a speaker and hand back the one the SERVER made.
   *
   * Two-phase, and it has to be: the id and the `colorIndex` are the server's
   * to choose (it records them in the op so a replay paints the same colour),
   * so a `segment.set_speaker` naming a locally-invented id would be a 400. The
   * new speaker is identified by DIFFING the result against what was held
   * before rather than by matching the display name, because two speakers may
   * legitimately share a name.
   */
  const createSpeaker = useCallback(
    async (displayName: string): Promise<TranscriptSpeaker | null> => {
      const trimmed = displayName.trim();
      if (!enabled || !transcriptId || !trimmed) return null;
      const before = new Set(workingRef.current.speakers.map((speaker) => speaker.id));
      await runImmediate(() => [{ op: OP_TYPES.CREATE_SPEAKER, displayName: trimmed }]);
      if (!isMounted()) return null;
      return (
        workingRef.current.speakers.find((speaker) => !before.has(speaker.id)) ?? null
      );
    },
    [enabled, isMounted, runImmediate, transcriptId],
  );

  const mergeSpeakers = useCallback(
    (sourceIds: string[], targetId: string, keepName: boolean) =>
      runImmediate(() => {
        const sources = sourceIds.filter((id) => id !== targetId);
        if (sources.length === 0) return null;
        return [{ op: OP_TYPES.MERGE_SPEAKERS, sourceIds: sources, targetId, keepName }];
      }),
    [runImmediate],
  );

  const replaceAll = useCallback(
    (params: {
      find: string;
      replace: string;
      matchCase: boolean;
      wholeWord: boolean;
      speakerId?: string | null;
    }) =>
      runImmediate(() => {
        if (!params.find) return null;
        // ONE op, however many segments it rewrites — the server expands it
        // into concrete text ops before recording, so this is one version.
        return [
          {
            op: OP_TYPES.FIND_REPLACE,
            find: params.find,
            replace: params.replace,
            matchCase: params.matchCase,
            wholeWord: params.wholeWord,
            ...(params.speakerId ? { speakerId: params.speakerId } : {}),
          },
        ];
      }),
    [runImmediate],
  );

  const replaceOne = useCallback(
    (segmentId: string, start: number, end: number, replacement: string) => {
      const segment = workingRef.current.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const next =
        segment.text.slice(0, start) + replacement + segment.text.slice(end);
      updateText(segmentId, next);
    },
    [updateText],
  );

  const resolveConflict = useCallback(
    (id: string, choice: 'mine' | 'theirs') => {
      const card = conflicts.find((entry) => entry.id === id);
      setConflicts((current) => current.filter((entry) => entry.id !== id));
      if (!card) return;

      if (choice === 'theirs') {
        // Adopt the server's copy locally. Nothing is sent: the transcript
        // already says this.
        commitWorking((current) => ({
          ...current,
          segments: current.segments.map((segment) =>
            segment.id === id && card.entity === 'segment'
              ? { ...segment, text: card.theirs }
              : segment,
          ),
          speakers: current.speakers.map((speaker) =>
            speaker.id === id && card.entity === 'speaker'
              ? { ...speaker, displayName: card.theirs }
              : speaker,
          ),
        }));
        return;
      }

      // "Keep mine" re-sends against the rev that WON, which is the whole
      // reason the conflict path refetched. An entity the other editor deleted
      // has no rev to send against and no row to send to.
      if (card.currentRev === null) return;
      if (card.entity === 'segment') {
        void runImmediate(() => [
          {
            op: OP_TYPES.UPDATE_TEXT,
            segmentId: id,
            rev: card.currentRev as number,
            text: card.mine,
          },
        ]);
      } else {
        void runImmediate(() => [
          {
            op: OP_TYPES.RENAME_SPEAKER,
            speakerId: id,
            rev: card.currentRev as number,
            displayName: card.mine,
          },
        ]);
      }
    },
    [commitWorking, conflicts, runImmediate],
  );

  /**
   * Undo the merge in `undoableMerge`.
   *
   * TWO PATHS, and which one applies is decided by whether anything has been
   * saved since. Restoring `version − 1` is exact and cheap, but only while the
   * merge is still the newest version: restoring once something else has landed
   * would silently discard that something. So the fallback is the inverse ops —
   * re-create each source speaker and put its own segments back on it — which
   * only undoes the merge and leaves every later edit intact.
   */
  const undoMerge = useCallback(async () => {
    const pending = undoableMerge;
    if (!pending || !transcriptId || !enabled) return;
    setUndoableMerge(null);

    if (workingRef.current.version === pending.version) {
      try {
        const result = await restoreTranscriptVersion(
          transcriptId,
          pending.version - 1,
          pending.version,
        );
        if (isMounted()) adoptResult(result);
        return;
      } catch {
        // A restore refused (something landed between the snackbar and the
        // tap) falls through to the inverse ops below rather than reporting a
        // failure: the user asked to undo, and the other path can still do it.
      }
    }

    for (const merge of pending.merges) {
      for (const source of merge.sources) {
        const before = new Set(workingRef.current.speakers.map((speaker) => speaker.id));
        await runImmediate(() => [
          { op: OP_TYPES.CREATE_SPEAKER, displayName: source.displayName },
        ]);
        if (!isMounted()) return;
        const recreated = workingRef.current.speakers.find(
          (speaker) => !before.has(speaker.id),
        );
        if (!recreated) continue;

        await runImmediate(() => {
          const ops: TranscriptOp[] = [];
          for (const segmentId of source.segmentIds) {
            const segment = workingRef.current.segments.find(
              (item) => item.id === segmentId,
            );
            // A segment somebody deleted since is simply skipped: an undo has
            // no business resurrecting rows it did not remove.
            if (!segment) continue;
            ops.push({
              op: OP_TYPES.SET_SPEAKER,
              segmentId,
              rev: segment.rev,
              speakerId: recreated.id,
            });
          }
          return ops;
        });
      }
    }
  }, [adoptResult, enabled, isMounted, runImmediate, transcriptId, undoableMerge]);

  const dismissUndo = useCallback(() => setUndoableMerge(null), []);
  const dismissError = useCallback(() => setError(null), []);

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const effectiveSaveState: SaveState = useMemo(() => {
    if (isOffline && pendingCount > 0) return 'offline';
    return saveState;
  }, [isOffline, pendingCount, saveState]);

  return {
    speakers: working.speakers,
    segments: working.segments,
    version: working.version,
    saveState: effectiveSaveState,
    pendingCount,
    isOffline,
    error,
    dismissError,
    conflicts,
    resolveConflict,
    updateText,
    flush,
    setSpeaker,
    splitSegment,
    joinWithNext,
    deleteSegment,
    renameSpeaker,
    createSpeaker,
    mergeSpeakers,
    replaceAll,
    replaceOne,
    undoableMerge,
    undoMerge,
    dismissUndo,
  };
}

export default useTranscriptOperations;
