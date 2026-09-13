/**
 * The backup policy, the run history, and the writes (issue #287, epic #254).
 *
 * Three exports and one shared contract, for the reason `useJobs.ts` and
 * `useWorkerNodes.ts` both give for holding several: they are views of ONE
 * surface, and `DbBackupPage` mounts all of them together. What they share is
 * the contract — every function RESOLVES rather than throws, and a failure is a
 * STRING the page renders — because every caller is a click handler that needs
 * to branch, not a place to handle an exception that has already been captured
 * for display.
 *
 * =============================================================================
 * ⚠ "UNREACHABLE" IS A SEPARATE ANSWER FROM "FAILED", AND THAT IS THE POINT
 * =============================================================================
 *
 * This is the one page in the application that deliberately takes the API away.
 * At the end of a restore the swap renames two catalogs and THE API PROCESS
 * EXITS so its connection pool can be rebuilt; requests in that window do not
 * fail with a status code, they fail with no response at all, and only once
 * something is listening again do they become a maintenance `503`.
 *
 * `ApiService.request` throws an `ApiError` for every response it actually got.
 * Anything else — a `TypeError` from `fetch` — means there was no response, so
 * these hooks report `isUnreachable` alongside the message. The page uses that
 * to tell the operator they are watching the EXPECTED sequence rather than
 * showing them a generic failure at the exact moment they most need to trust
 * the screen. When the API answers again with the maintenance marker,
 * `services/api.ts` records a block centrally and `MaintenanceGate` takes the
 * subtree — nothing here has to know about that, which is precisely why the
 * recogniser lives on the shared error path.
 *
 * The distinction is NOT "did the request fail". A 500 from a live API is still
 * a failure to report normally; only the absence of any answer is the restart.
 *
 * =============================================================================
 * WHY THE RUN LIST POLLS AND THE CONFIG DOES NOT
 * =============================================================================
 *
 * A dump advances with nobody touching it — `bytesWritten` climbs for minutes
 * or hours, a restore walks `restoring` → `verifying` → `swapping` — so the
 * list is polled through the shared `useVisiblePolling` (one implementation, in
 * `hooks/useVisiblePolling.ts`, extracted by #271 rather than copied; this
 * module re-exports it so the page imports its polling from the hook module it
 * already depends on, and so a page test that mocks this module still
 * intercepts the poll). The policy changes only when a human saves it, and a
 * timer over a form nobody is editing would be load with no information in it.
 *
 * The CONFIG is nevertheless refreshed by the page alongside the list, because
 * `nextRunAt` and `activeRunId` are computed server-side and move on their own.
 * The page decides that; this module only makes it possible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  cancelBackupRun,
  deleteBackupRun,
  getBackupDownloadUrl,
  getBackupRuns,
  getDbBackupConfig,
  rollbackRestore,
  startBackupRun,
  startRestore,
  updateDbBackupConfig,
} from '../services/dbBackup';
import type {
  BackupDownloadUrl,
  CancelBackupResult,
  DbBackupConfig,
  DbBackupRun,
  DbBackupRunListParams,
  DeleteBackupResult,
  RollbackRestoreResult,
  StartRestoreResult,
  UpdateDbBackupConfigInput,
} from '../services/dbBackup';
import { useIsMounted } from './useIsMounted';
import { useVisiblePolling } from './useVisiblePolling';

// One implementation, in `hooks/useVisiblePolling.ts` — see the file header.
export { useVisiblePolling };

/**
 * How often the page re-asks, while its tab is in front.
 *
 * Ten seconds, matching `JOBS_POLL_INTERVAL_MS` and
 * `WORKER_NODES_POLL_INTERVAL_MS`, and chosen against what the data can do: a
 * running dump's `bytesWritten` moves continuously, so a progress bar that
 * advances every ten seconds reads as live, while a shorter poll would re-read
 * a paginated list for a bar that moves a pixel.
 */
export const DB_BACKUP_POLL_INTERVAL_MS = 10_000;

/**
 * Did this failure come back from the API, or from nothing at all?
 *
 * `ApiError` means a response was received and read; anything else means
 * `fetch` itself rejected. See the file header for why the difference is the
 * whole reason this page can be honest about a restart.
 */
function isUnreachable(err: unknown): boolean {
  return !(err instanceof ApiError);
}

/**
 * Turn any thrown value into the sentence the page will render.
 *
 * 403 is named explicitly because its remedy is a permission rather than a
 * retry — the treatment `useJobs`, `useWorkerNodes` and `useMaintenance` all
 * give it. The message says "database backups" and not "settings", because the
 * API reserves a dedicated `db_backup:*` triple for this surface and telling an
 * operator to ask for the wrong permission is worse than telling them nothing.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage database backups';
    // The API's own sentence wins; `fallback` covers a body with no message at
    // all, which is what a proxy-generated error looks like.
    return err.message || fallback;
  }
  // The transport never got an answer. Said plainly rather than as "Failed to
  // fetch", which is a browser string and not an explanation.
  return 'The application is not responding';
}

// =============================================================================
// The policy
// =============================================================================

export interface UseDbBackupConfigResult {
  config: DbBackupConfig | null;
  isLoading: boolean;
  /** Failure to LOAD. Distinct from `saveError`: "nothing to show" versus "your change did not stick". */
  loadError: string | null;
  /** True when the last load failed with no response at all — see the file header. */
  isUnreachable: boolean;
  isSaving: boolean;
  saveError: string | null;
  /** Resolves `true` when the write landed, `false` when it did not — never throws. */
  save: (input: UpdateDbBackupConfigInput) => Promise<boolean>;
  /** Re-read WITHOUT raising the loading flag. What the page's poll calls. */
  refresh: () => Promise<void>;
}

export function useDbBackupConfig(): UseDbBackupConfigResult {
  const [config, setConfig] = useState<DbBackupConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it.
  const isMounted = useIsMounted();

  const load = useCallback(
    async (showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      try {
        const data = await getDbBackupConfig();
        if (isMounted()) {
          setConfig(data);
          setLoadError(null);
          setUnreachable(false);
        }
      } catch (err) {
        if (isMounted()) {
          setLoadError(messageFor(err, 'Failed to load the backup policy'));
          setUnreachable(isUnreachable(err));
          // The POLICY is deliberately NOT cleared, unlike the run list. It is
          // the form the operator may be halfway through reading, it does not
          // claim anything about the current state of the system, and blanking
          // it during the restart this page causes would lose the schedule they
          // were checking for no benefit.
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(async () => {
    await load(false);
  }, [load]);

  /**
   * `PUT config`, then adopt what the API says the policy now IS.
   *
   * The response is stored rather than the submitted form, because the API
   * recomputes `nextRunAt` from the saved values: an operator must be shown
   * when the schedule will actually fire, not their own arithmetic on what they
   * typed. A 400 (an unknown timezone, a storage provider this deployment does
   * not have) becomes `saveError` verbatim — this app invents no client-side
   * validation for either, because the runtime's own zone data and the
   * deployment's own provider list are the authorities.
   */
  const save = useCallback(
    async (input: UpdateDbBackupConfigInput) => {
      setIsSaving(true);
      setSaveError(null);
      try {
        const data = await updateDbBackupConfig(input);
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (isMounted()) setSaveError(messageFor(err, 'Failed to save the backup policy'));
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return {
    config,
    isLoading,
    loadError,
    isUnreachable: unreachable,
    isSaving,
    saveError,
    save,
    refresh,
  };
}

// =============================================================================
// The run history
// =============================================================================

export interface UseDbBackupRunsResult {
  runs: DbBackupRun[];
  total: number;
  isLoading: boolean;
  error: string | null;
  /** True when the last read failed with no response at all — see the file header. */
  isUnreachable: boolean;
  /** Run a NEW query (raises the loading flag) and remember it for the poll. */
  fetchRuns: (params?: DbBackupRunListParams) => Promise<void>;
  /** Repeat the last query WITHOUT raising the loading flag. What the poll calls. */
  refresh: () => Promise<void>;
}

export function useDbBackupRuns(): UseDbBackupRunsResult {
  const [runs, setRuns] = useState<DbBackupRun[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const isMounted = useIsMounted();

  /**
   * The last query, so a poll repeats the CURRENT view rather than an
   * unfiltered one. A ref and not state, exactly as `useJobs` holds it: a
   * re-render on every query would change nothing on screen, and the value is
   * only ever read from inside a callback.
   */
  const lastParams = useRef<DbBackupRunListParams>({});

  const runQuery = useCallback(
    async (params: DbBackupRunListParams, showLoading: boolean) => {
      // A POLL DOES NOT RAISE THE LOADING FLAG. The rows stay on screen and the
      // table keeps its scroll offset, its expansion and its focus; a spinner
      // every ten seconds over a progress bar is the fastest way to make a live
      // table unusable.
      if (showLoading) setIsLoading(true);
      try {
        const response = await getBackupRuns(params);
        if (isMounted()) {
          setRuns(response.items);
          setTotal(response.total);
          setError(null);
          setUnreachable(false);
        }
      } catch (err) {
        if (isMounted()) {
          setError(messageFor(err, 'Failed to load backup runs'));
          setUnreachable(isUnreachable(err));
          // CLEARED, not left standing. These rows carry a live progress bar
          // and a restore status: leaving the last successful page on screen
          // under an error banner would show a dump "running" that nobody has
          // heard from since, which is the one wrong answer this page must
          // never give.
          setRuns([]);
          setTotal(0);
        }
      } finally {
        if (isMounted() && showLoading) setIsLoading(false);
      }
    },
    [isMounted],
  );

  const fetchRuns = useCallback(
    async (params: DbBackupRunListParams = {}) => {
      lastParams.current = params;
      await runQuery(params, true);
    },
    [runQuery],
  );

  const refresh = useCallback(async () => {
    await runQuery(lastParams.current, false);
  }, [runQuery]);

  return { runs, total, isLoading, error, isUnreachable: unreachable, fetchRuns, refresh };
}

// =============================================================================
// The writes
// =============================================================================

export interface UseDbBackupActionsResult {
  /** True while any write is in flight. */
  isWorking: boolean;
  /** The last failure, or `null`. Cleared when a write starts. */
  error: string | null;
  clearError: () => void;
  /** The claimed run, or `null` when the start failed (409 while one is already going). */
  startBackup: () => Promise<DbBackupRun | null>;
  /** ⚠ Read `outcome`: a run executing on another API instance answers `not_running_here`. */
  cancelRun: (id: string) => Promise<CancelBackupResult | null>;
  /** ⚠ Read `objectDeleted`: the row can go while the stored object stays. */
  deleteRun: (id: string) => Promise<DeleteBackupResult | null>;
  /** A signed, expiring URL, or `null`. */
  downloadUrlFor: (id: string) => Promise<BackupDownloadUrl | null>;
  /** ⚠ Read `mode`: all three outcomes are a 200 and only one of them started anything. */
  restore: (
    id: string,
    options?: { overrideSchemaCheck?: boolean },
  ) => Promise<StartRestoreResult | null>;
  /** ⚠ Read `mode`: the two routes back differ by hours. */
  rollback: (id: string) => Promise<RollbackRestoreResult | null>;
}

/**
 * Every write, sharing one in-flight flag and one error.
 *
 * ONE FLAG FOR ALL OF THEM, as `useJobActions` and `useNodeActions` have one:
 * they all mutate the same small set of runs and the page re-reads after any of
 * them, so a second write started while the first is landing would be issued
 * against state that is already wrong, and its result would be reported over
 * the top of the first one's. On this page that is not a cosmetic concern —
 * two of these writes replace the production database.
 *
 * `onChanged` fires AFTER a write resolves and never in parallel with it: a
 * refresh racing its own mutation is how a cancelled run flickers back to
 * "Running" for one frame.
 *
 * ⚠ `restore` and `rollback` RESOLVE THEIR RESULT rather than reporting
 * success, because for both of them the mode is the answer. A `guided` restore
 * is a 200 that started nothing and must not be reported as "restore under
 * way"; an `unavailable` rollback is a 200 that means the window closed. The
 * page renders the mode; this hook only reports the failure to get one.
 */
export function useDbBackupActions(onChanged?: () => void): UseDbBackupActionsResult {
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const run = useCallback(
    async <T,>(operation: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsWorking(true);
      setError(null);
      try {
        const result = await operation();
        onChanged?.();
        return result;
      } catch (err) {
        if (isMounted()) setError(messageFor(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsWorking(false);
      }
    },
    [isMounted, onChanged],
  );

  const startBackup = useCallback(
    () => run(() => startBackupRun(), 'Failed to start a backup'),
    [run],
  );

  const cancelRun = useCallback(
    (id: string) => run(() => cancelBackupRun(id), 'Failed to cancel the backup'),
    [run],
  );

  const deleteRun = useCallback(
    (id: string) => run(() => deleteBackupRun(id), 'Failed to delete the backup'),
    [run],
  );

  const downloadUrlFor = useCallback(
    (id: string) => run(() => getBackupDownloadUrl(id), 'Failed to get a download link'),
    [run],
  );

  const restore = useCallback(
    (id: string, options: { overrideSchemaCheck?: boolean } = {}) =>
      run(() => startRestore(id, options), 'Failed to start the restore'),
    [run],
  );

  const rollback = useCallback(
    (id: string) => run(() => rollbackRestore(id), 'Failed to roll back the restore'),
    [run],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    isWorking,
    error,
    clearError,
    startBackup,
    cancelRun,
    deleteRun,
    downloadUrlFor,
    restore,
    rollback,
  };
}
