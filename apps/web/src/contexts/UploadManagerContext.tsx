/**
 * The app-wide upload manager — issue #22, epic #19.
 *
 * =============================================================================
 * WHY THIS IS A PROVIDER AND NOT A HOOK ON THE UPLOAD SCREEN
 * =============================================================================
 *
 * An upload of a two-hour recording takes minutes to hours. In that time the
 * user will open the transcript list, look at settings, follow a notification —
 * and every one of those is a route change that unmounts whatever component
 * started the upload. State owned by that component dies with it: the transfer
 * stops mid-part, and the only evidence is a file that never appears.
 *
 * Mounting ONCE, around the authenticated shell in `App.tsx` (exactly where
 * `NotificationProvider` mounts, and for the same reason), makes the engine
 * outlive every page. The engines themselves live in a `useRef` map — not in
 * state — so a re-render never recreates one, and a route change never touches
 * them.
 *
 * =============================================================================
 * THE PUBLIC SHAPE IS DESIGNED FOR TWO CONSUMERS THAT DO NOT EXIST YET
 * =============================================================================
 *
 * Issue #30 (the New-transcript screen) needs to START an upload and watch one.
 * Issue #32 (the home "In progress" section) needs to LIST every upload
 * including ones it did not start, and to offer pause/resume/cancel on each.
 * Hence `uploads` is a plain array of self-describing records rather than a
 * map keyed by something only the starter knows, `activeUploads` is derived
 * here rather than re-derived (differently) in two places, and every action
 * takes an `id` rather than an engine handle — a list rendered from context
 * has ids, not closures.
 *
 * `ManagedUpload` deliberately carries `fileName` and `size` as its own
 * fields rather than a `File`: the home screen renders rows for uploads
 * restored from an interrupted session, where no `File` exists until the user
 * re-picks one.
 */

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createTranscriptUpload,
  fetchUploadStatus,
  resumeUpload as resumeUploadEngine,
  startUpload as startUploadEngine,
  type ResumableUpload,
  type ResumableUploadOptions,
  type UploadInitResponse,
  type UploadProgress,
} from '../services/resumableUpload';
import {
  assertUploadSessionMatches,
  deleteUploadSession,
  listUploadSessions,
  saveUploadSession,
  UploadSessionGoneError,
  type UploadSessionRecord,
} from '../services/uploadSessions';
import { ApiError } from '../services/api';
import { getTranscript } from '../services/transcripts';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import { useIsMounted } from '../hooks/useIsMounted';

/** One upload the manager knows about. `id` is the storage object id. */
export interface ManagedUpload {
  id: string;
  objectId: string;
  transcriptId: string | null;
  fileName: string;
  size: number;
  /** Epoch milliseconds, for stable ordering and "started 3 minutes ago". */
  startedAt: number;
  /** Whether this upload was picked up from an interrupted session. */
  resumed: boolean;
  progress: UploadProgress;
}

export interface StartUploadInput {
  file: File;
  transcriptId?: string | null;
  /**
   * An upload the server has ALREADY initialised — adopt it instead of calling
   * `POST /storage/objects/upload/init`.
   *
   * Added by issue #30 for the New-transcript screen, and it is not an
   * optional convenience there: `POST /api/transcripts` creates the transcript
   * row AND initialises its multipart upload in ONE response, deliberately, so
   * that a client cannot end up with a transcript in `uploading` that has no
   * upload behind it. The object it creates is `managed_by: 'transcripts'`,
   * which a client is not permitted to ask for — so the generic init endpoint
   * cannot produce an equivalent one, and calling it as well would leave an
   * orphaned object behind for housekeeping to fail later.
   *
   * Everything AFTER this point is unchanged: the same engine, the same
   * progress records, the same session persistence, the same pause/resume/cancel.
   * This only replaces where the first part URLs came from.
   */
  init?: UploadInitResponse;
  /** Escape hatch for tests; production never passes this. */
  engineOptions?: ResumableUploadOptions;
}

export interface UploadManagerContextValue {
  /** Every upload this session knows about, oldest first. */
  uploads: ManagedUpload[];
  /** The subset still doing work — what a "2 uploads in progress" badge counts. */
  activeUploads: ManagedUpload[];
  /** Interrupted uploads from a previous visit, newest first. */
  sessions: UploadSessionRecord[];
  /** The first session read is still in flight. */
  sessionsLoading: boolean;

  /** The "Keep screen on while uploading" preference. Persisted per browser. */
  keepScreenAwake: boolean;
  setKeepScreenAwake: (next: boolean) => void;
  /** Whether this browser implements the Screen Wake Lock API at all. */
  wakeLockSupported: boolean;
  /** Whether a wake lock is held right now. */
  wakeLockHeld: boolean;

  startUpload: (input: StartUploadInput) => Promise<ManagedUpload>;
  pauseUpload: (id: string) => void;
  resumeUpload: (id: string) => void;
  cancelUpload: (id: string) => Promise<void>;
  /** Remove a SETTLED upload from the list. Active uploads are left alone. */
  dismissUpload: (id: string) => void;
  /**
   * Continue an interrupted upload with a re-picked file.
   *
   * Throws `UploadSessionMismatchError` when the file is not the one the
   * session was started for — the caller shows that message rather than
   * uploading part 7 of a different file into the same object.
   */
  resumeFromSession: (
    session: UploadSessionRecord,
    file: File,
    engineOptions?: ResumableUploadOptions,
  ) => Promise<ManagedUpload>;
  refreshSessions: () => Promise<void>;
  getUpload: (id: string) => ManagedUpload | undefined;
}

export const UploadManagerContext = createContext<UploadManagerContextValue | null>(null);

/** Phases that mean "this upload still needs the network (and the screen)". */
const ACTIVE_PHASES = new Set(['uploading', 'completing']);

/**
 * Phases in which an engine in THIS tab still owns its upload — the user can
 * pause, resume or cancel it right here. Reconciliation (#339) never touches
 * one of these: this tab is the authority on it, not a persisted record.
 */
const LIVE_HERE_PHASES = new Set(['idle', 'uploading', 'paused', 'completing']);

/**
 * Is the transcript behind a persisted session gone, or past needing its
 * upload? Issue #339.
 *
 * `true` ONLY on a definite answer from the server:
 *
 *   * **404** — `transcript.purge` hard-deleted the row (#322 purges abandoned
 *     uploads), or it was never this user's to see. Either way there is
 *     nothing to resume into.
 *   * **any status but `uploading`** — `deleting` is the purge on its way;
 *     `processing`/`ready`/`failed` mean the server already has (or gave up
 *     on) the bytes. Resuming would re-send parts into an upload nobody wants.
 *
 * Everything else — offline, a 5xx, a 401 the refresh could not fix — answers
 * `false`, and the session stays for the next reconcile. Discarding on a
 * transient failure would throw away a genuinely resumable multi-gigabyte
 * upload because the Wi-Fi blinked on page load.
 */
async function isTranscriptUploadGone(transcriptId: string): Promise<boolean> {
  try {
    const result = await getTranscript(transcriptId);
    // No etag was sent, so `not-modified` cannot happen; treated as "unknown".
    return result.status === 'ok' && result.data.status !== 'uploading';
  } catch (err) {
    return err instanceof ApiError && err.status === 404;
  }
}

export const KEEP_SCREEN_AWAKE_STORAGE_KEY = 'upload.keepScreenAwake';

/**
 * Default ON.
 *
 * The toggle exists for the user who does not want it, not as an opt-in: the
 * failure it prevents (screen locks, phone throttles or suspends the tab, a
 * 40-minute upload silently stalls) is invisible and expensive, while the cost
 * of the lock is a screen that stays lit only while an upload is actually
 * running AND the page is in front. Reading a stored `'false'` is the only way
 * it is off.
 */
function readKeepScreenAwake(): boolean {
  try {
    return localStorage.getItem(KEEP_SCREEN_AWAKE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function UploadManagerProvider({ children }: { children: ReactNode }) {
  const isMounted = useIsMounted();
  const [uploads, setUploads] = useState<ManagedUpload[]>([]);
  const [sessions, setSessions] = useState<UploadSessionRecord[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [keepScreenAwake, setKeepScreenAwakeState] = useState(readKeepScreenAwake);

  /**
   * The live engines, by object id.
   *
   * A REF, not state, and that is load-bearing: an engine is a long-lived
   * object with in-flight `XMLHttpRequest`s attached to it. Putting it in
   * state would make every progress event a reason to build a new map, and a
   * stale closure over an old map would abort the wrong transfer.
   */
  const enginesRef = useRef(new Map<string, ResumableUpload>());
  const unsubscribersRef = useRef(new Map<string, () => void>());

  const loadSessions = useCallback(async (): Promise<UploadSessionRecord[]> => {
    const records = await listUploadSessions();
    if (!isMounted()) return records;
    setSessions(records);
    setSessionsLoading(false);
    return records;
  }, [isMounted]);

  const refreshSessions = useCallback(async () => {
    await loadSessions();
  }, [loadSessions]);

  /** Session object ids with a reconcile request in flight — see `reconcileSessions`. */
  const reconcilingRef = useRef(new Set<string>());

  const isLiveHere = useCallback((objectId: string) => {
    const engine = enginesRef.current.get(objectId);
    return Boolean(engine && LIVE_HERE_PHASES.has(engine.getProgress().phase));
  }, []);

  /**
   * Forget a session whose upload can never be resumed — issue #339.
   *
   * The same removal cancel and dismiss already perform, in one place: drop
   * any settled engine and its row, delete the persisted record, and take the
   * card off screen. Re-checks liveness first, because the answer it acts on
   * was fetched a round trip ago and the user may have resumed in between.
   */
  const discardSession = useCallback(
    async (objectId: string) => {
      if (isLiveHere(objectId)) return;

      unsubscribersRef.current.get(objectId)?.();
      unsubscribersRef.current.delete(objectId);
      enginesRef.current.delete(objectId);
      setUploads((current) => current.filter((upload) => upload.id !== objectId));

      await deleteUploadSession(objectId);
      if (!isMounted()) return;
      setSessions((current) => current.filter((session) => session.objectId !== objectId));
    },
    [isLiveHere, isMounted],
  );

  /**
   * Discard persisted sessions whose transcript is gone — issue #339.
   *
   * Since #322 the server purges an abandoned upload's transcript, so an
   * IndexedDB record can outlive it indefinitely and offer a "Resume upload"
   * that can only fail. The SERVER is the authority here exactly as it is for
   * which parts landed: this asks it once per session, per reconcile.
   *
   * BOUNDED BY CONSTRUCTION. Only sessions carrying a `transcriptId` are asked
   * about, never one whose upload is live in this tab, and never one already
   * being asked about (a visibility flip mid-request would otherwise double
   * it). There is no timer: it runs on load, when the tab comes back into
   * view, and when an upload fails — each a moment the answer may have changed.
   */
  const reconcileSessions = useCallback(
    async (records: Pick<UploadSessionRecord, 'objectId' | 'transcriptId'>[]) => {
      const inFlight = reconcilingRef.current;
      const stale = records.filter(
        (record) =>
          record.transcriptId !== null &&
          !isLiveHere(record.objectId) &&
          !inFlight.has(record.objectId),
      );

      await Promise.all(
        stale.map(async (record) => {
          inFlight.add(record.objectId);
          try {
            if (await isTranscriptUploadGone(record.transcriptId as string)) {
              await discardSession(record.objectId);
            }
          } finally {
            inFlight.delete(record.objectId);
          }
        }),
      );
    },
    [discardSession, isLiveHere],
  );

  useEffect(() => {
    void loadSessions().then(reconcileSessions);
  }, [loadSessions, reconcileSessions]);

  // Back in view after hours in a background tab (or a phone's app switcher)
  // is precisely when the purge may have run. Re-read the store too: another
  // tab may have finished or cancelled one of these in the meantime.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void loadSessions().then(reconcileSessions);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadSessions, reconcileSessions]);

  // Unsubscribe on teardown. Deliberately does NOT cancel the uploads: this
  // provider unmounts when the app shell does (sign-out, tab close), and
  // aborting a nearly-finished transfer on the way out is worse than letting
  // the browser tear it down with the page.
  useEffect(() => {
    const unsubscribers = unsubscribersRef.current;
    return () => {
      for (const unsubscribe of unsubscribers.values()) unsubscribe();
      unsubscribers.clear();
    };
  }, []);

  const patchProgress = useCallback((id: string, progress: UploadProgress) => {
    setUploads((current) =>
      current.map((upload) => (upload.id === id ? { ...upload, progress } : upload)),
    );
  }, []);

  /**
   * Wire an engine into React state and into the session store.
   *
   * One place, used by both `startUpload` and `resumeFromSession`, so the two
   * paths cannot drift on what happens when an upload settles — which is where
   * the session record is cleaned up, and a missed cleanup means the user is
   * offered a resume for something that already finished.
   */
  const register = useCallback(
    (engine: ResumableUpload, record: ManagedUpload) => {
      enginesRef.current.set(record.id, engine);
      setUploads((current) => [...current.filter((item) => item.id !== record.id), record]);

      const unsubscribe = engine.subscribe((progress) => {
        patchProgress(record.id, progress);
      });
      unsubscribersRef.current.set(record.id, unsubscribe);

      void engine.whenSettled().then(async (outcome) => {
        if (outcome.status === 'completed' || outcome.status === 'cancelled') {
          // A failed upload KEEPS its session on purpose — that is precisely
          // the case the resume affordance exists for. Only a finished or
          // abandoned one is forgotten.
          await deleteUploadSession(record.id);
          await refreshSessions();
          return;
        }
        // …unless the failure was the upload ceasing to exist (#339): a
        // presign or complete call answering 404 because the purge got there
        // first. Then there is nothing to resume into, and a failed row with
        // a Resume prompt would be offering a dead end. Ask the server once.
        if (record.transcriptId) {
          await reconcileSessions([record]);
        }
      });
    },
    [patchProgress, reconcileSessions, refreshSessions],
  );

  const startUpload = useCallback(
    async ({
      file,
      transcriptId = null,
      init: providedInit,
      engineOptions,
    }: StartUploadInput) => {
      // Two paths to the same engine: adopt an init the caller already has
      // (#30's `POST /api/transcripts`), or ask the generic endpoint for one.
      const { upload, init } = providedInit
        ? { upload: startUploadEngine(file, providedInit, engineOptions), init: providedInit }
        : await createTranscriptUpload(file, { ...engineOptions, transcriptId });

      const record: ManagedUpload = {
        id: init.objectId,
        objectId: init.objectId,
        transcriptId,
        fileName: file.name,
        size: file.size,
        startedAt: Date.now(),
        resumed: false,
        progress: upload.getProgress(),
      };

      // Persisted BEFORE the first part lands, not after: the window this
      // record protects against (the tab dying early) is widest at the start.
      await saveUploadSession({
        objectId: init.objectId,
        transcriptId,
        fileName: file.name,
        size: file.size,
        lastModified: file.lastModified,
        partSize: init.partSize,
        createdAt: record.startedAt,
      });
      await refreshSessions();

      register(upload, record);
      return record;
    },
    [refreshSessions, register],
  );

  const resumeFromSession = useCallback(
    async (
      session: UploadSessionRecord,
      file: File,
      engineOptions?: ResumableUploadOptions,
    ) => {
      // Throws `UploadSessionMismatchError` before anything is uploaded. See
      // `uploadSessions.ts` for why a mismatch is a hard stop rather than a
      // warning: the resulting object assembles cleanly and is corrupt.
      assertUploadSessionMatches(session, file);

      // THE SERVER IS THE AUTHORITY on what has landed — never the local
      // record, which describes what this browser believed it sent before it
      // stopped being able to observe anything.
      let status;
      try {
        status = await fetchUploadStatus(session.objectId);
      } catch (err) {
        // The object is gone (#339): the purge removed the transcript and its
        // upload together. Forget the session so its card disappears, and
        // tell the caller there is nothing to report rather than an error.
        if (err instanceof ApiError && err.status === 404) {
          await discardSession(session.objectId);
          throw new UploadSessionGoneError(session);
        }
        throw err;
      }
      const upload = resumeUploadEngine(file, session.objectId, status, engineOptions);

      const record: ManagedUpload = {
        id: session.objectId,
        objectId: session.objectId,
        transcriptId: session.transcriptId,
        fileName: session.fileName,
        size: file.size,
        startedAt: session.createdAt,
        resumed: true,
        progress: upload.getProgress(),
      };

      register(upload, record);
      return record;
    },
    [discardSession, register],
  );

  const pauseUpload = useCallback((id: string) => {
    enginesRef.current.get(id)?.pause();
  }, []);

  const resumeUpload = useCallback((id: string) => {
    enginesRef.current.get(id)?.resume();
  }, []);

  const cancelUpload = useCallback(
    async (id: string) => {
      const engine = enginesRef.current.get(id);
      if (!engine) return;
      await engine.cancel();
      await deleteUploadSession(id);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const dismissUpload = useCallback((id: string) => {
    const engine = enginesRef.current.get(id);
    // Dismissing a RUNNING upload would hide a transfer that keeps consuming
    // the user's data with nothing on screen to stop it. Cancel it instead.
    if (engine && ACTIVE_PHASES.has(engine.getProgress().phase)) return;

    unsubscribersRef.current.get(id)?.();
    unsubscribersRef.current.delete(id);
    enginesRef.current.delete(id);
    setUploads((current) => current.filter((upload) => upload.id !== id));
  }, []);

  const activeUploads = useMemo(
    () => uploads.filter((upload) => ACTIVE_PHASES.has(upload.progress.phase)),
    [uploads],
  );

  const setKeepScreenAwake = useCallback((next: boolean) => {
    setKeepScreenAwakeState(next);
    try {
      localStorage.setItem(KEEP_SCREEN_AWAKE_STORAGE_KEY, next ? 'true' : 'false');
    } catch {
      // Storage blocked: the preference is then per-session. Not worth failing.
    }
  }, []);

  const { supported: wakeLockSupported, held: wakeLockHeld } = useScreenWakeLock({
    enabled: keepScreenAwake,
    active: activeUploads.length > 0,
  });

  const getUpload = useCallback(
    (id: string) => uploads.find((upload) => upload.id === id),
    [uploads],
  );

  const value = useMemo<UploadManagerContextValue>(
    () => ({
      uploads,
      activeUploads,
      sessions,
      sessionsLoading,
      keepScreenAwake,
      setKeepScreenAwake,
      wakeLockSupported,
      wakeLockHeld,
      startUpload,
      pauseUpload,
      resumeUpload,
      cancelUpload,
      dismissUpload,
      resumeFromSession,
      refreshSessions,
      getUpload,
    }),
    [
      uploads,
      activeUploads,
      sessions,
      sessionsLoading,
      keepScreenAwake,
      setKeepScreenAwake,
      wakeLockSupported,
      wakeLockHeld,
      startUpload,
      pauseUpload,
      resumeUpload,
      cancelUpload,
      dismissUpload,
      resumeFromSession,
      refreshSessions,
      getUpload,
    ],
  );

  return (
    <UploadManagerContext.Provider value={value}>{children}</UploadManagerContext.Provider>
  );
}
