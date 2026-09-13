/**
 * `hooks/useDbBackup.ts` — issue #287, epic #254.
 *
 * Three things are worth asserting here that no page test can:
 *
 *   * THE POLL IS THE ONE `useVisiblePolling`. The epic's instruction was to
 *     reuse the hook #266 wrote and #271 extracted, not to write a third, and
 *     the test for that is an IDENTITY comparison across the modules rather
 *     than a promise in a comment — two implementations that behave identically
 *     today are two places the `visibilitychange` teardown can be got wrong
 *     tomorrow, and the second one is discovered months later in a load graph.
 *     Its BEHAVIOUR (pause while hidden, catch up on return) is asserted here
 *     too, because this is the page where a poll that keeps firing during an
 *     outage would be hammering an API that has deliberately exited.
 *
 *   * "UNREACHABLE" IS A SEPARATE ANSWER FROM "FAILED". A `fetch` that rejects
 *     with no response is the API restarting after a restore swap; a 500 is a
 *     live API failing. The page renders those completely differently, so the
 *     hooks have to tell them apart, and getting this wrong would show a
 *     generic error at the exact moment an operator is watching their own
 *     database being replaced.
 *
 *   * A FAILED WRITE RESOLVES. Every caller is a click handler that needs to
 *     branch, not a place to handle an exception that has already been captured
 *     for display — and the two most dangerous writes in the application resolve
 *     their MODE rather than a boolean, because for both of them the mode is the
 *     answer and only one of the three started anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/dbBackup', async () => {
  const actual = await vi.importActual<typeof import('../../services/dbBackup')>(
    '../../services/dbBackup',
  );
  return {
    ...actual,
    getDbBackupConfig: vi.fn(),
    updateDbBackupConfig: vi.fn(),
    getBackupRuns: vi.fn(),
    startBackupRun: vi.fn(),
    cancelBackupRun: vi.fn(),
    deleteBackupRun: vi.fn(),
    getBackupDownloadUrl: vi.fn(),
    startRestore: vi.fn(),
    rollbackRestore: vi.fn(),
  };
});

import {
  getBackupRuns,
  getDbBackupConfig,
  startRestore,
  updateDbBackupConfig,
} from '../../services/dbBackup';
import type { DbBackupConfig, DbBackupRun } from '../../services/dbBackup';
import { ApiError } from '../../services/api';
import { useVisiblePolling as sharedUseVisiblePolling } from '../../hooks/useVisiblePolling';
import { useVisiblePolling as jobsUseVisiblePolling } from '../../hooks/useJobs';
import { useVisiblePolling as nodesUseVisiblePolling } from '../../hooks/useWorkerNodes';
import {
  useDbBackupActions,
  useDbBackupConfig,
  useDbBackupRuns,
  useVisiblePolling,
} from '../../hooks/useDbBackup';

const mockGetConfig = vi.mocked(getDbBackupConfig);
const mockUpdateConfig = vi.mocked(updateDbBackupConfig);
const mockGetRuns = vi.mocked(getBackupRuns);
const mockStartRestore = vi.mocked(startRestore);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: DbBackupConfig = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:30',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: '',
  runStaleMinutes: 180,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nextRunAt: '2026-01-02T02:30:00.000Z',
  activeRunId: null,
};

const run: DbBackupRun = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  trigger: 'manual',
  bytesWritten: '1200000000',
  sizeBytes: '1200000000',
  storageProvider: 's3',
  storageKey: 'backups/one.dump',
  bucket: 'backups',
  format: 'custom',
  checksumSha256: 'abc123',
  verifiedAt: '2026-01-01T01:00:00.000Z',
  dbVersion: '17.2',
  appVersion: '1.0.0',
  migrationName: '20260101_init',
  lastError: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:40:00.000Z',
  lastHeartbeatAt: null,
  createdById: null,
  restoreStatus: null,
  restoreError: null,
  restoredAt: null,
  restoredById: null,
  restoreScratchDb: null,
  restoreOldDb: null,
  swappedAt: null,
  preRestoreBackupId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:40:00.000Z',
};

function page(items: DbBackupRun[] = [run]) {
  return { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 };
}

// ---------------------------------------------------------------------------
// `document.hidden` is a getter in jsdom, so it is redefined rather than
// assigned. The event is dispatched separately because the browser fires it
// AFTER the property flips, and a hook that read the property off the event
// object rather than the document would otherwise pass here and fail in a
// browser.
// ---------------------------------------------------------------------------
let documentHidden = false;

function setTabHidden(hidden: boolean) {
  documentHidden = hidden;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('the backup poll', () => {
  it('is the ONE `useVisiblePolling`, shared with the jobs and workers pages', () => {
    // Identity, not behaviour — see the file header.
    expect(useVisiblePolling).toBe(sharedUseVisiblePolling);
    expect(useVisiblePolling).toBe(jobsUseVisiblePolling);
    expect(useVisiblePolling).toBe(nodesUseVisiblePolling);
  });

  describe('pausing', () => {
    beforeEach(() => {
      documentHidden = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => documentHidden,
      });
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      documentHidden = false;
    });

    it('polls while the tab is in front and STOPS once it is hidden', () => {
      const tick = vi.fn();
      renderHook(() => useVisiblePolling(tick, 1000));

      act(() => vi.advanceTimersByTime(2000));
      expect(tick).toHaveBeenCalledTimes(2);

      setTabHidden(true);
      act(() => vi.advanceTimersByTime(60_000));

      // Not "fewer calls" — NONE.
      expect(tick).toHaveBeenCalledTimes(2);
    });

    it('re-reads IMMEDIATELY when the tab comes back, then resumes', () => {
      const tick = vi.fn();
      renderHook(() => useVisiblePolling(tick, 1000));

      setTabHidden(true);
      act(() => vi.advanceTimersByTime(10_000));
      expect(tick).not.toHaveBeenCalled();

      // Without the catch-up, a tab restored after an hour would show an
      // hour-old "Running" for up to a full interval — stale progress that
      // looks live.
      setTabHidden(false);
      expect(tick).toHaveBeenCalledTimes(1);

      act(() => vi.advanceTimersByTime(1000));
      expect(tick).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useDbBackupConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue(config);
  });

  it('loads the policy on mount', async () => {
    const { result } = renderHook(() => useDbBackupConfig());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(config);
    expect(result.current.loadError).toBeNull();
    expect(result.current.isUnreachable).toBe(false);
  });

  it('adopts the policy the API hands back, so `nextRunAt` is never the client’s arithmetic', async () => {
    const { result } = renderHook(() => useDbBackupConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const saved = { ...config, timeOfDay: '05:00', nextRunAt: '2026-01-02T05:00:00.000Z' };
    mockUpdateConfig.mockResolvedValue(saved);

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ timeOfDay: '05:00' });
    });

    expect(ok).toBe(true);
    expect(result.current.config?.nextRunAt).toBe('2026-01-02T05:00:00.000Z');
  });

  it('surfaces the API’s own 400 message rather than inventing client-side validation', async () => {
    const { result } = renderHook(() => useDbBackupConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockUpdateConfig.mockRejectedValue(
      new ApiError('Unknown timezone "Mars/Olympus"', 400),
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.save({ timezone: 'Mars/Olympus' });
    });

    // Resolved `false` rather than thrown: the caller is a submit handler.
    expect(ok).toBe(false);
    expect(result.current.saveError).toBe('Unknown timezone "Mars/Olympus"');
    // The runtime's own zone data is the authority, so nothing was refused here.
    expect(mockUpdateConfig).toHaveBeenCalledWith({ timezone: 'Mars/Olympus' });
  });

  it('keeps the loaded policy on screen when a refresh fails', async () => {
    const { result } = renderHook(() => useDbBackupConfig());
    await waitFor(() => expect(result.current.config).toEqual(config));

    mockGetConfig.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await result.current.refresh();
    });

    // Unlike the run list, the policy is not cleared: it claims nothing about
    // the current state of the system, and blanking the schedule an operator is
    // reading during the restart this page causes buys nothing.
    expect(result.current.config).toEqual(config);
    expect(result.current.isUnreachable).toBe(true);
  });
});

describe('useDbBackupRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRuns.mockResolvedValue(page());
  });

  it('loads a page of runs and remembers the query for the poll', async () => {
    // NO FETCH ON MOUNT, exactly as `useJobs` has none: the PAGE owns the query
    // (its filters and its pagination), so a hook that fetched on mount would
    // issue an unfiltered request that the page's own effect immediately
    // replaces — two requests for one view, the first of them wrong.
    const { result } = renderHook(() => useDbBackupRuns());

    await act(async () => {
      await result.current.fetchRuns({ page: 2, pageSize: 50, status: 'failed' });
    });
    expect(mockGetRuns).toHaveBeenLastCalledWith({ page: 2, pageSize: 50, status: 'failed' });

    await act(async () => {
      await result.current.refresh();
    });
    // The poll repeats the CURRENT view, not an unfiltered one.
    expect(mockGetRuns).toHaveBeenLastCalledWith({ page: 2, pageSize: 50, status: 'failed' });
  });

  it('reports an API failure as a message and NOT as unreachable', async () => {
    mockGetRuns.mockRejectedValue(new ApiError('Something broke', 500));
    const { result } = renderHook(() => useDbBackupRuns());
    await act(async () => {
      await result.current.fetchRuns();
    });

    await waitFor(() => expect(result.current.error).toBe('Something broke'));
    // A live API failing is an ordinary error. Only the absence of any answer
    // is the restart this page causes.
    expect(result.current.isUnreachable).toBe(false);
    // Cleared, not left standing: these rows carry a live progress bar.
    expect(result.current.runs).toEqual([]);
  });

  it('reports a transport failure with no response as UNREACHABLE', async () => {
    // What the browser produces while the API process is gone mid-swap.
    mockGetRuns.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useDbBackupRuns());
    await act(async () => {
      await result.current.fetchRuns();
    });

    await waitFor(() => expect(result.current.isUnreachable).toBe(true));
    // Not the browser's own string, which explains nothing to an operator.
    expect(result.current.error).toBe('The application is not responding');
  });

  it('names a 403 by its remedy, which is a permission and not a retry', async () => {
    mockGetRuns.mockRejectedValue(new ApiError('Forbidden', 403));
    const { result } = renderHook(() => useDbBackupRuns());
    await act(async () => {
      await result.current.fetchRuns();
    });

    await waitFor(() =>
      expect(result.current.error).toBe(
        'You do not have permission to manage database backups',
      ),
    );
  });
});

describe('useDbBackupActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the restore MODE rather than a boolean, because the mode is the answer', async () => {
    // A `guided` outcome is a 200 that started NOTHING. Collapsing it to
    // "succeeded" would tell an operator a restore was under way when their
    // deployment is serving perfectly and the screen is holding the commands
    // they actually need.
    const guided = {
      mode: 'guided' as const,
      runId: run.id,
      guidance: { reason: 'No CREATEDB', commands: 'pg_restore …', runbook: 'docs/x.md' },
      preflight: {
        outcome: 'guided' as const,
        runId: run.id,
        targetDatabase: 'appdb',
        scratchDatabase: 'appdb_restore',
        oldDatabase: 'appdb_old',
        gates: [],
        rollback: {
          configured: 'retain_database' as const,
          effective: 'retain_database' as const,
          downgraded: false,
          reason: null,
        },
        archiveMigration: null,
        liveMigration: null,
        databaseSizeBytes: null,
        freeDiskBytes: null,
      },
    };
    mockStartRestore.mockResolvedValue(guided);

    const onChanged = vi.fn();
    const { result } = renderHook(() => useDbBackupActions(onChanged));

    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.restore(run.id);
    });

    expect(outcome).toEqual(guided);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('omits `overrideSchemaCheck` unless it is actually being set', async () => {
    mockStartRestore.mockResolvedValue({} as never);
    const { result } = renderHook(() => useDbBackupActions());

    await act(async () => {
      await result.current.restore(run.id);
    });
    expect(mockStartRestore).toHaveBeenLastCalledWith(run.id, {});

    await act(async () => {
      await result.current.restore(run.id, { overrideSchemaCheck: true });
    });
    expect(mockStartRestore).toHaveBeenLastCalledWith(run.id, { overrideSchemaCheck: true });
  });

  it('reports a 409 as a message and never throws at the click handler', async () => {
    mockStartRestore.mockRejectedValue(
      new ApiError('A database restore is already in flight', 409, undefined, {
        activeRunId: 'other',
      }),
    );
    const { result } = renderHook(() => useDbBackupActions());

    let outcome: unknown = 'unset';
    await act(async () => {
      outcome = await result.current.restore(run.id);
    });

    expect(outcome).toBeNull();
    expect(result.current.error).toBe('A database restore is already in flight');
  });
});
