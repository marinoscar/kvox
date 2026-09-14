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
  type ResumableUpload,
  type ResumableUploadOptions,
  type UploadProgress,
} from '../services/resumableUpload';
import {
  assertUploadSessionMatches,
  deleteUploadSession,
  listUploadSessions,
  saveUploadSession,
  type UploadSessionRecord,
} from '../services/uploadSessions';
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

  const refreshSessions = useCallback(async () => {
    const records = await listUploadSessions();
    if (!isMounted()) return;
    setSessions(records);
    setSessionsLoading(false);
  }, [isMounted]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

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
        }
      });
    },
    [patchProgress, refreshSessions],
  );

  const startUpload = useCallback(
    async ({ file, transcriptId = null, engineOptions }: StartUploadInput) => {
      const { upload, init } = await createTranscriptUpload(file, {
        ...engineOptions,
        transcriptId,
      });

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
      const status = await fetchUploadStatus(session.objectId);
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
    [register],
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
