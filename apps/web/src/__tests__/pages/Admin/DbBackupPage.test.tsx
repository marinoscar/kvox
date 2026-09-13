/**
 * Admin → Operations → Database Backup (`/admin/settings/db-backup`), issue
 * #287, epic #254.
 *
 * The table's MECHANICS are asserted once for every table in
 * `runDataTableConformanceSuite`, and the column contract and its formatters in
 * `dbBackupTable.test.ts`. What is page-specific — and what this file covers —
 * is everything that could be wrong while both of those are perfectly fine:
 *
 *   * the policy form round-trips every field and shows the SERVER'S
 *     `nextRunAt`, so a wrong schedule is caught now rather than by a backup
 *     that did not happen;
 *   * an invalid timezone surfaces the API's own 400 rather than a message this
 *     app invented;
 *   * the API's preconditions are visible on the controls — no delete for a
 *     running run, no download for one that is not completed — instead of being
 *     discovered as an error;
 *   * a `stale` run is visibly different from a failed one;
 *   * the restore dialog shows every pre-flight verdict, states the restart
 *     consequence, and cannot fire without the typed literal;
 *   * `guided` is rendered as the supported path it is, with the commands
 *     copyable, and NOT as a failure;
 *   * `blocked` needs a second, explicit override that names the schema gate;
 *   * the swap's own outage is presented as the expected sequence, falls
 *     through to the maintenance gate, and recovers — with no generic error at
 *     the moment the operator most needs to trust the screen.
 *
 * The hooks are mocked, as `JobsPage.test.tsx` mocks `useJobs` and
 * `WorkersPage.test.tsx` mocks `useWorkerNodes`: the fetch layer has its own
 * suite, and driving it through msw here would test the transport twice while
 * making every assertion about the page wait on it. `useVisiblePolling` is NOT
 * mocked — the poll's wiring to this page is one of the things under test.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  act,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, type MockUser } from '../../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../../components/datatable/__tests__/testUtils/layoutStubs';
import { api } from '../../../services/api';
import { MaintenanceGate } from '../../../components/common/MaintenanceGate';
import {
  clearMaintenanceBlock,
  reportMaintenanceBlock,
} from '../../../services/maintenance';
import type {
  DbBackupConfig,
  DbBackupRun,
  RestorePreflight,
  StartRestoreResult,
} from '../../../services/dbBackup';

vi.mock('../../../hooks/useDbBackup', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDbBackup')>(
    '../../../hooks/useDbBackup',
  );
  return {
    ...actual,
    useDbBackupConfig: vi.fn(),
    useDbBackupRuns: vi.fn(),
    useDbBackupActions: vi.fn(),
  };
});

import {
  DB_BACKUP_POLL_INTERVAL_MS,
  useDbBackupActions,
  useDbBackupConfig,
  useDbBackupRuns,
} from '../../../hooks/useDbBackup';
import DbBackupPage from '../../../pages/Admin/DbBackupPage';
import { shortId } from '../../../pages/Admin/jobsTable';

const mockUseConfig = vi.mocked(useDbBackupConfig);
const mockUseRuns = vi.mocked(useDbBackupRuns);
const mockUseActions = vi.mocked(useDbBackupActions);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: DbBackupConfig = {
  enabled: true,
  frequency: 'weekly',
  dayOfWeek: 2,
  dayOfMonth: 1,
  timeOfDay: '02:30',
  timezone: 'Europe/London',
  retentionCount: 7,
  storageProvider: '',
  runStaleMinutes: 180,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nextRunAt: '2026-01-06T02:30:00.000Z',
  activeRunId: null,
};

function run(overrides: Partial<DbBackupRun> = {}): DbBackupRun {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    trigger: 'scheduled',
    bytesWritten: '1288490188',
    sizeBytes: '1288490188',
    storageProvider: 's3',
    storageKey: 'backups/2026-01-01.dump',
    bucket: 'app-backups',
    format: 'custom',
    checksumSha256: 'a1b2c3d4e5f6a7b8c9d0',
    verifiedAt: '2026-01-01T00:45:00.000Z',
    dbVersion: '17.2',
    appVersion: '1.0.0',
    migrationName: '20260101120000_init',
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
    ...overrides,
  };
}

const completedRun = run();
const runningRun = run({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'running',
  trigger: 'manual',
  sizeBytes: '0',
  bytesWritten: '4000000000',
  finishedAt: null,
  checksumSha256: null,
  verifiedAt: null,
});
const staleRun = run({
  id: '33333333-3333-4333-8333-333333333333',
  status: 'stale',
  finishedAt: null,
  checksumSha256: null,
  verifiedAt: null,
});
const failedRun = run({
  id: '44444444-4444-4444-8444-444444444444',
  status: 'failed',
  lastError: 'pg_dump exited 1',
  checksumSha256: null,
  verifiedAt: null,
});

/** A pre-flight carrying one of each verdict, so "every verdict is shown" is testable. */
function preflight(overrides: Partial<RestorePreflight> = {}): RestorePreflight {
  return {
    outcome: 'ok',
    runId: completedRun.id,
    targetDatabase: 'appdb',
    scratchDatabase: 'appdb_restore_1',
    oldDatabase: 'appdb_old_1',
    gates: [
      {
        id: 'pg_client_version',
        kind: 'capability',
        verdict: 'pass',
        title: 'Client and server versions match',
        detail: 'pg_restore 17.2 against server 17.2.',
        action: null,
      },
      {
        id: 'disk_space',
        kind: 'disk',
        verdict: 'warning',
        title: 'Free disk space could not be measured',
        detail: 'This host does not report free space.',
        action: 'Check there is room for a second copy of the database.',
      },
      {
        id: 'replicas',
        kind: 'replicas',
        verdict: 'block',
        title: 'A streaming replica is attached',
        detail: 'One replica is following this server.',
        action: 'Detach the replica before restoring.',
      },
    ],
    rollback: {
      configured: 'retain_database',
      effective: 'retain_database',
      downgraded: false,
      reason: null,
    },
    archiveMigration: '20260101120000_init',
    liveMigration: '20260202120000_add_widgets',
    databaseSizeBytes: '4000000000',
    freeDiskBytes: null,
    ...overrides,
  };
}

const RUNNING_RESULT: StartRestoreResult = {
  mode: 'running',
  runId: completedRun.id,
  scratchDatabase: 'appdb_restore_1',
  oldDatabase: 'appdb_old_1',
  preflight: preflight(),
};

const GUIDED_RESULT: StartRestoreResult = {
  mode: 'guided',
  runId: completedRun.id,
  guidance: {
    reason: 'The database role cannot create databases.',
    commands: 'createdb appdb_restore_1\npg_restore --dbname=appdb_restore_1 archive.dump',
    runbook: 'docs/runbooks/database-restore.md',
  },
  preflight: preflight({ outcome: 'guided' }),
};

const BLOCKED_RESULT: StartRestoreResult = {
  mode: 'blocked',
  runId: completedRun.id,
  block: {
    gateId: 'schema_compatibility',
    message: 'The archive was taken on an older schema than the live database.',
    overridable: true,
    overrideParameter: 'overrideSchemaCheck',
  },
  preflight: preflight({ outcome: 'blocked' }),
};

// ---------------------------------------------------------------------------
// Hook state
// ---------------------------------------------------------------------------

const mockRefreshRuns = vi.fn();
const mockRefreshConfig = vi.fn();
const mockSave = vi.fn();
const mockStartBackup = vi.fn();
const mockCancelRun = vi.fn();
const mockDeleteRun = vi.fn();
const mockDownloadUrlFor = vi.fn();
const mockRestore = vi.fn();
const mockRollback = vi.fn();
const mockClearError = vi.fn();

function setConfigState(overrides: Partial<ReturnType<typeof useDbBackupConfig>> = {}) {
  mockUseConfig.mockReturnValue({
    config: CONFIG,
    isLoading: false,
    loadError: null,
    isUnreachable: false,
    isSaving: false,
    saveError: null,
    save: mockSave,
    refresh: mockRefreshConfig,
    ...overrides,
  });
}

function setRunsState(
  rows: DbBackupRun[] = [completedRun],
  overrides: Partial<ReturnType<typeof useDbBackupRuns>> = {},
) {
  mockUseRuns.mockReturnValue({
    runs: rows,
    total: rows.length,
    isLoading: false,
    error: null,
    isUnreachable: false,
    fetchRuns: vi.fn().mockResolvedValue(undefined),
    refresh: mockRefreshRuns,
    ...overrides,
  });
}

function setActionsState(overrides: { isWorking?: boolean; error?: string | null } = {}) {
  mockUseActions.mockReturnValue({
    isWorking: overrides.isWorking ?? false,
    error: overrides.error ?? null,
    clearError: mockClearError,
    startBackup: mockStartBackup,
    cancelRun: mockCancelRun,
    deleteRun: mockDeleteRun,
    downloadUrlFor: mockDownloadUrlFor,
    restore: mockRestore,
    rollback: mockRollback,
  });
}

/** An admin holding exactly the permissions named. */
function userWith(permissions: string[]): MockUser {
  return { ...mockAdminUser, permissions };
}

const READ_ONLY = ['db_backup:read'];
const READ_WRITE = ['db_backup:read', 'db_backup:write'];
const FULL = ['db_backup:read', 'db_backup:write', 'db_backup:restore'];

function renderPage(permissions: string[] = FULL, width = 1400) {
  setInitialContainerWidth(width);
  return render(<DbBackupPage />, { wrapperOptions: { user: userWith(permissions) } });
}

/**
 * Open one row's action menu.
 *
 * The shared `RowActionsCell` collapses two or more actions into an overflow
 * menu, and its button is named after the row's own scalar — which is why that
 * scalar carries a short id: two rows announced identically, on a menu holding
 * delete and restore, is not acceptable.
 */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, row: DbBackupRun) {
  await user.click(
    await screen.findByRole('button', {
      name: new RegExp(`^Row actions for .*\\(${shortId(row.id)}\\)$`),
    }),
  );
  return screen.findByRole('menu');
}

/** One item in that menu, by its exact label. */
async function rowAction(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  row: DbBackupRun,
) {
  const menu = await openRowMenu(user, row);
  return within(menu).getByRole('menuitem', { name: label });
}

/** Leave the menu without running anything. */
async function closeRowMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await waitForElementToBeRemoved(() => screen.queryByRole('menu')).catch(() => undefined);
}

// ---------------------------------------------------------------------------

describe('DbBackupPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    clearMaintenanceBlock();
    // The table persists its layout under `user_settings.dataTables`.
    vi.spyOn(api, 'get').mockResolvedValue({ dataTables: {} } as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
    mockSave.mockResolvedValue(true);
    mockDeleteRun.mockResolvedValue({ id: completedRun.id, objectDeleted: true });
    mockCancelRun.mockResolvedValue({
      runId: runningRun.id,
      outcome: 'signalled',
      detail: 'The dump was signalled to stop.',
    });
    mockDownloadUrlFor.mockResolvedValue({ url: 'https://example.test/a', expiresIn: 300 });
    setConfigState();
    setRunsState();
    setActionsState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearMaintenanceBlock();
  });

  // =========================================================================
  // Reachability, and the three-permission split
  // =========================================================================

  it('redirects a user without db_backup:read away, rather than rendering an empty page', () => {
    renderPage(['jobs:read']);

    expect(
      screen.queryByRole('heading', { level: 1, name: 'Database Backup' }),
    ).not.toBeInTheDocument();
  });

  it('renders for a db_backup:read holder, and says so when they cannot write', () => {
    renderPage(READ_ONLY);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Database Backup' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
  });

  it('withholds restore from a write holder who lacks db_backup:restore', async () => {
    // The whole reason the API keeps a third permission: someone may schedule
    // backups and still must not be able to replace the database.
    const user = userEvent.setup();
    renderPage(READ_WRITE);

    const menu = await openRowMenu(user, completedRun);
    expect(within(menu).getByRole('menuitem', { name: 'Delete backup' })).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Restore from this backup' }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Roll back this restore' }),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // The policy form
  // =========================================================================

  describe('the policy form', () => {
    it('round-trips every field, sending the whole policy back', async () => {
      const user = userEvent.setup();
      renderPage();

      // Every stored value is on screen…
      expect(screen.getByLabelText('Scheduled backups')).toBeChecked();
      expect(screen.getByRole('combobox', { name: 'Frequency' })).toHaveTextContent(
        'Every week',
      );
      expect(screen.getByRole('combobox', { name: 'Day of the week' })).toHaveTextContent(
        'Tuesday',
      );
      expect(screen.getByLabelText('Time of day')).toHaveValue('02:30');
      expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/London');
      expect(screen.getByLabelText('Backups to keep')).toHaveValue(7);
      expect(screen.getByLabelText('Compression level')).toHaveValue(6);
      expect(screen.getByRole('combobox', { name: 'Rollback mode' })).toHaveTextContent(
        /Keep the replaced database/,
      );
      expect(
        screen.getByLabelText('Keep the replaced database for (hours)'),
      ).toHaveValue(48);

      // …and an edit to any of them comes back on the wire, together with the
      // ones that did not change.
      await user.clear(screen.getByLabelText('Time of day'));
      await user.type(screen.getByLabelText('Time of day'), '04:15');
      await user.clear(screen.getByLabelText('Backups to keep'));
      await user.type(screen.getByLabelText('Backups to keep'), '30');
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));

      await waitFor(() =>
        expect(mockSave).toHaveBeenCalledWith({
          enabled: true,
          frequency: 'weekly',
          dayOfWeek: 2,
          dayOfMonth: 1,
          timeOfDay: '04:15',
          timezone: 'Europe/London',
          retentionCount: 30,
          compressionLevel: 6,
          restoreRollbackMode: 'retain_database',
          oldDatabaseRetentionHours: 48,
        }),
      );
    });

    it('shows the SERVER’S next run time, so a wrong schedule is caught now', () => {
      renderPage();

      // Never a client-side projection: the timezone is resolved by the
      // runtime the scheduler actually fires on.
      expect(screen.getByTestId('db-backup-next-run')).toHaveTextContent(
        /Next scheduled backup:/,
      );
      expect(screen.getByTestId('db-backup-next-run')).toHaveTextContent(
        new Date(CONFIG.nextRunAt!).toLocaleString(),
      );
    });

    it('says plainly when nothing is scheduled, rather than leaving the line blank', () => {
      setConfigState({ config: { ...CONFIG, enabled: false, nextRunAt: null } });
      renderPage();

      expect(screen.getByTestId('db-backup-next-run')).toHaveTextContent(
        'No backup is scheduled.',
      );
    });

    it('surfaces the API’s own 400 for an unknown timezone, inventing no validation of its own', async () => {
      const user = userEvent.setup();
      // The API validates by PERFORMING the projection; a list in the browser
      // would rot and would disagree with the runtime's ICU data.
      setConfigState({ saveError: 'Unknown timezone: Mars/Olympus' });
      renderPage();

      await user.clear(screen.getByLabelText('Timezone'));
      await user.type(screen.getByLabelText('Timezone'), 'Mars/Olympus');

      expect(screen.getByTestId('db-backup-config-error')).toHaveTextContent(
        'Unknown timezone: Mars/Olympus',
      );
      // The field itself is not marked invalid by this app — the save is the
      // only thing that can decide.
      expect(screen.getByLabelText('Timezone')).toHaveValue('Mars/Olympus');
    });

    it('shows the day-of-week picker only for a weekly schedule', async () => {
      setConfigState({ config: { ...CONFIG, frequency: 'daily' } });
      renderPage();

      // A weekday picker over a daily schedule is a control that changes
      // nothing, and an operator who sets it will believe it applied.
      expect(
        screen.queryByRole('combobox', { name: 'Day of the week' }),
      ).not.toBeInTheDocument();
    });

    it('disables every control for a read-only admin rather than hiding the form', () => {
      renderPage(READ_ONLY);

      expect(screen.getByLabelText('Scheduled backups')).toBeDisabled();
      expect(screen.getByLabelText('Timezone')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    });
  });

  // =========================================================================
  // The run history
  // =========================================================================

  describe('the run history', () => {
    it('renders the BigInt byte fields, which arrive as strings, as sizes', async () => {
      setRunsState([completedRun]);
      renderPage();

      expect(await screen.findByText('1.3 GB')).toBeInTheDocument();
    });

    it('shows a running dump’s live bytes written rather than a final size of zero', async () => {
      setRunsState([runningRun]);
      renderPage();

      // In the table…
      expect(await screen.findByTestId(`run-progress-${runningRun.id}`)).toHaveTextContent(
        '4.0 GB written',
      );
      // …and in the banner an operator watches during a backup.
      expect(screen.getByTestId('db-backup-active-run')).toHaveTextContent('4.0 GB written');
    });

    it('makes a STALE run visually distinct from a failed one', async () => {
      setRunsState([staleRun, failedRun]);
      renderPage();

      const stale = await screen.findByTestId(`run-status-${staleRun.id}`);
      const failed = await screen.findByTestId(`run-status-${failedRun.id}`);

      expect(stale).toHaveTextContent('Stale');
      expect(failed).toHaveTextContent('Failed');
      // Different palette AND different word AND a different icon — "nobody
      // knows how this ended" is not "this ended badly", and colour alone is
      // not an accessible distinction.
      expect(stale).toHaveClass('MuiChip-colorWarning');
      expect(failed).toHaveClass('MuiChip-colorError');
      expect(stale).not.toHaveClass('MuiChip-colorError');
    });

    it('says "Not verified" rather than leaving the cell blank', async () => {
      setRunsState([staleRun]);
      renderPage();

      expect(await screen.findByTestId(`run-verified-${staleRun.id}`)).toHaveTextContent(
        'Not verified',
      );
    });
  });

  // =========================================================================
  // The API's preconditions, on the controls
  // =========================================================================

  describe('the API’s preconditions', () => {
    it('does not offer delete for a running run', async () => {
      const user = userEvent.setup();
      setRunsState([runningRun]);
      renderPage();

      // The API answers 400: the archive is mid-upload. Disabled rather than
      // absent, so the control set does not change shape row to row — a missing
      // button is a mystery, a greyed-out one with a reason is an answer.
      expect(await rowAction(user, 'Delete backup', runningRun)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await closeRowMenu(user);
      expect(mockDeleteRun).not.toHaveBeenCalled();
    });

    it('offers delete for a run that has finished', async () => {
      const user = userEvent.setup();
      setRunsState([completedRun]);
      renderPage();

      expect(await rowAction(user, 'Delete backup', completedRun)).not.toHaveAttribute(
        'aria-disabled',
      );
    });

    it('does not offer download for a run that is not completed', async () => {
      const user = userEvent.setup();
      setRunsState([runningRun, failedRun, staleRun]);
      renderPage();

      for (const row of [runningRun, failedRun, staleRun]) {
        // A `stale` archive is the important one: nobody knows how the run
        // ended, so the file may be truncated, and handing it over during an
        // incident would be the worst possible help.
        expect(await rowAction(user, 'Download archive', row)).toHaveAttribute(
          'aria-disabled',
          'true',
        );
        await closeRowMenu(user);
      }
    });

    it('offers cancel only while a run is still active', async () => {
      const user = userEvent.setup();
      setRunsState([runningRun, completedRun]);
      renderPage();

      expect(await rowAction(user, 'Cancel backup', runningRun)).not.toHaveAttribute(
        'aria-disabled',
      );
      await closeRowMenu(user);
      expect(await rowAction(user, 'Cancel backup', completedRun)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('offers restore only for a completed archive', async () => {
      const user = userEvent.setup();
      setRunsState([completedRun, staleRun]);
      renderPage();

      expect(await rowAction(user, 'Restore from this backup', completedRun)).not.toHaveAttribute(
        'aria-disabled',
      );
      await closeRowMenu(user);
      expect(await rowAction(user, 'Restore from this backup', staleRun)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('offers rollback only for an archive that was actually restored', async () => {
      const user = userEvent.setup();
      const restored = run({
        id: '55555555-5555-4555-8555-555555555555',
        restoreStatus: 'completed',
        restoredAt: '2026-02-01T00:00:00.000Z',
      });
      setRunsState([completedRun, restored]);
      renderPage();

      // Rolling back undoes a swap that happened; restoring this archive would
      // be a new restore, which is a different request — and a 400.
      expect(await rowAction(user, 'Roll back this restore', completedRun)).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await closeRowMenu(user);
      expect(await rowAction(user, 'Roll back this restore', restored)).not.toHaveAttribute(
        'aria-disabled',
      );
    });

    it('refuses to start a second backup while one is running', async () => {
      setRunsState([runningRun]);
      renderPage();

      await screen.findByTestId('db-backup-active-run');
      expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    });

    it('reports what a cancel actually MANAGED, not merely that it returned 200', async () => {
      const user = userEvent.setup();
      mockCancelRun.mockResolvedValue({
        runId: runningRun.id,
        outcome: 'not_running_here',
        detail: 'That run is executing on another API instance and cannot be stopped here.',
      });
      setRunsState([runningRun]);
      renderPage();

      await user.click(await rowAction(user, 'Cancel backup', runningRun));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel backup' }));

      // The outcome, not the status code: saying "cancelled" would be wrong in
      // the one case where the operator has to do something else.
      expect(
        await screen.findByText(/executing on another API instance/),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Progress polling
  // =========================================================================

  describe('progress polling', () => {
    let documentHidden = false;

    beforeEach(() => {
      documentHidden = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => documentHidden,
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      documentHidden = false;
    });

    it('advances the progress on each poll, and STOPS polling while the tab is hidden', async () => {
      setRunsState([runningRun]);
      const { rerender } = renderPage();

      await screen.findByTestId('db-backup-active-run');
      expect(screen.getByTestId('db-backup-active-run')).toHaveTextContent('4.0 GB written');

      // One interval: the page re-reads, and the new byte count is on screen.
      setRunsState([{ ...runningRun, bytesWritten: '7000000000' }]);
      await act(async () => {
        vi.advanceTimersByTime(DB_BACKUP_POLL_INTERVAL_MS);
      });
      expect(mockRefreshRuns).toHaveBeenCalled();
      rerender(<DbBackupPage />);
      expect(screen.getByTestId('db-backup-active-run')).toHaveTextContent('7.0 GB written');

      // Hidden: the interval is torn down, not throttled.
      const before = mockRefreshRuns.mock.calls.length;
      documentHidden = true;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(DB_BACKUP_POLL_INTERVAL_MS * 6);
      });
      expect(mockRefreshRuns.mock.calls.length).toBe(before);

      // Back in front: an immediate catch-up, so the page never shows a stale
      // byte count that looks live.
      documentHidden = false;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(mockRefreshRuns.mock.calls.length).toBeGreaterThan(before);
    });
  });

  // =========================================================================
  // The restore dialog
  // =========================================================================

  describe('the restore dialog', () => {
    async function openRestore(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await rowAction(user, 'Restore from this backup', completedRun));
      return screen.findByRole('dialog');
    }

    it('states the restart consequence and the phase timings BEFORE anything can be confirmed', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openRestore(user);

      expect(within(dialog).getByTestId('restore-restart-notice')).toHaveTextContent(
        /The application will restart/,
      );
      // Hours for the restore, seconds for the swap — the two facts that decide
      // whether this is done now or in a window.
      const phases = within(dialog).getByTestId('restore-phases');
      expect(phases).toHaveTextContent(/Restoring — hours/);
      expect(phases).toHaveTextContent(/Swapping — seconds/);
      // And the confirm is inert until both the acknowledgement and the literal.
      expect(
        within(dialog).getByRole('button', { name: 'Restore this backup' }),
      ).toBeDisabled();
    });

    it('states what rolling back will cost, taken from the saved policy', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openRestore(user);
      expect(within(dialog).getByText(/rolling back is a rename — seconds/)).toBeInTheDocument();
    });

    it('cannot fire without the typed literal, whatever else is ticked', async () => {
      const user = userEvent.setup();
      renderPage();

      const dialog = await openRestore(user);
      const confirm = within(dialog).getByRole('button', { name: 'Restore this backup' });

      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      expect(confirm).toBeDisabled();

      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'restore');
      // Case matters: the API's Zod literal refuses anything else, and a
      // lower-case match here would let the UI fire a request that is refused.
      expect(confirm).toBeDisabled();

      await user.clear(within(dialog).getByLabelText('Type RESTORE to confirm'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      expect(confirm).toBeEnabled();

      expect(mockRestore).not.toHaveBeenCalled();
    });

    it('shows EVERY pre-flight verdict once the API has run them, passes included', async () => {
      const user = userEvent.setup();
      mockRestore.mockResolvedValue(RUNNING_RESULT);
      renderPage();

      const dialog = await openRestore(user);
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      await user.click(within(dialog).getByRole('button', { name: 'Restore this backup' }));

      const gates = await screen.findByTestId('restore-preflight-gates');
      // A pass, a warning and a block: an operator replacing a production
      // database should see what was CHECKED, not only what objected.
      expect(within(gates).getByTestId('restore-gate-pg_client_version')).toHaveTextContent(
        'Passed',
      );
      expect(within(gates).getByTestId('restore-gate-disk_space')).toHaveTextContent('Warning');
      expect(within(gates).getByTestId('restore-gate-replicas')).toHaveTextContent('Blocked');
      // Each with its own action item.
      expect(within(gates).getByTestId('restore-gate-replicas')).toHaveTextContent(
        'Detach the replica before restoring.',
      );
      expect(mockRestore).toHaveBeenCalledWith(completedRun.id, {});
    });

    it('warns when short disk downgraded the rollback from seconds to hours', async () => {
      const user = userEvent.setup();
      mockRestore.mockResolvedValue({
        ...RUNNING_RESULT,
        preflight: preflight({
          rollback: {
            configured: 'retain_database',
            effective: 'pre_restore_dump',
            downgraded: true,
            reason: 'there is not enough free disk for a second copy',
          },
        }),
      });
      renderPage();

      const dialog = await openRestore(user);
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      await user.click(within(dialog).getByRole('button', { name: 'Restore this backup' }));

      // It changes the recovery guarantee, which is the fact most likely to
      // change the decision.
      const notice = await screen.findByTestId('restore-rollback-downgraded');
      expect(notice).toHaveTextContent(/hours, not seconds/);
      expect(notice).toHaveTextContent(/not enough free disk/);
    });

    it('renders `guided` as the supported path it is, not as a failure', async () => {
      const user = userEvent.setup();
      mockRestore.mockResolvedValue(GUIDED_RESULT);
      renderPage();

      const dialog = await openRestore(user);
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      await user.click(within(dialog).getByRole('button', { name: 'Restore this backup' }));

      const guided = await screen.findByTestId('restore-guided');
      // `info`, never `error`: nothing failed, and telling an operator their
      // deployment is broken while handing them the fix invites a retry.
      expect(guided).toHaveClass('MuiAlert-colorInfo');
      expect(guided).not.toHaveClass('MuiAlert-colorError');
      expect(guided).toHaveTextContent(/Nothing has been started/);

      // The whole deliverable: a paste-ready block, and a way to copy it.
      expect(screen.getByTestId('restore-guided-commands')).toHaveTextContent(
        'pg_restore --dbname=appdb_restore_1 archive.dump',
      );
      const writeText = vi.fn().mockResolvedValue(undefined);
      // `navigator.clipboard` is a getter-only property in jsdom, so it is
      // redefined rather than assigned.
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      await user.click(screen.getByRole('button', { name: 'Copy Commands' }));
      expect(writeText).toHaveBeenCalledWith(GUIDED_RESULT.guidance!.commands);

      expect(screen.getByTestId('restore-guided-runbook')).toHaveTextContent(
        'docs/runbooks/database-restore.md',
      );
    });

    it('requires a SECOND, explicit override for a blocked schema check, and a re-typed literal', async () => {
      const user = userEvent.setup();
      mockRestore.mockResolvedValue(BLOCKED_RESULT);
      renderPage();

      const dialog = await openRestore(user);
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      await user.click(within(dialog).getByRole('button', { name: 'Restore this backup' }));

      expect(await screen.findByTestId('restore-blocked')).toHaveTextContent(
        'The archive was taken on an older schema',
      );
      // The two values the operator has to compare.
      expect(screen.getByTestId('restore-schema-mismatch')).toHaveTextContent(
        '20260101120000_init',
      );
      expect(screen.getByTestId('restore-schema-mismatch')).toHaveTextContent(
        '20260202120000_add_widgets',
      );

      const again = screen.getByRole('button', { name: 'Restore anyway' });
      expect(again).toBeDisabled();

      // The literal was cleared: this is a different, more dangerous request
      // and must not inherit the consent given to the one that was refused.
      expect(screen.getByLabelText('Type RESTORE to confirm')).toHaveValue('');
      await user.click(screen.getByLabelText('Accept the schema mismatch'));
      expect(again).toBeDisabled();

      await user.type(screen.getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      expect(again).toBeEnabled();

      mockRestore.mockResolvedValue(RUNNING_RESULT);
      await user.click(again);

      // The override names the schema parameter and nothing else.
      await waitFor(() =>
        expect(mockRestore).toHaveBeenLastCalledWith(completedRun.id, {
          overrideSchemaCheck: true,
        }),
      );
    });

    it('offers no override at all when nothing unblocks the gate', async () => {
      const user = userEvent.setup();
      mockRestore.mockResolvedValue({
        ...BLOCKED_RESULT,
        block: {
          gateId: 'createdb_privilege',
          message: 'The role cannot create databases.',
          overridable: false,
          overrideParameter: null,
        },
      });
      renderPage();

      const dialog = await openRestore(user);
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type RESTORE to confirm'), 'RESTORE');
      await user.click(within(dialog).getByRole('button', { name: 'Restore this backup' }));

      await screen.findByTestId('restore-blocked');
      // Not a disabled control — no control. A greyed-out switch would imply a
      // way through that has simply not been unlocked, and no amount of
      // accepting makes a role without CREATEDB able to create a database.
      expect(screen.queryByTestId('restore-override')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Restore anyway' })).not.toBeInTheDocument();
      expect(screen.getByText(/There is no override for this check/)).toBeInTheDocument();
    });

    it('uses a DIFFERENT literal for a rollback, so a copied confirmation is refused', async () => {
      const user = userEvent.setup();
      const restored = run({
        id: '66666666-6666-4666-8666-666666666666',
        restoreStatus: 'completed',
        restoredAt: '2026-02-01T00:00:00.000Z',
      });
      setRunsState([restored]);
      mockRollback.mockResolvedValue({
        mode: 'renamed',
        runId: restored.id,
        promoted: 'appdb_old_1',
        parked: 'appdb_restored_1',
        detail: 'The previous database was renamed back into place.',
      });
      renderPage();

      await user.click(await rowAction(user, 'Roll back this restore', restored));
      const dialog = await screen.findByRole('dialog');

      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type ROLLBACK to confirm'), 'RESTORE');
      expect(within(dialog).getByRole('button', { name: 'Roll back' })).toBeDisabled();

      await user.clear(within(dialog).getByLabelText('Type ROLLBACK to confirm'));
      await user.type(within(dialog).getByLabelText('Type ROLLBACK to confirm'), 'ROLLBACK');
      await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));

      // The mode is the answer, and its `detail` is the API's own sentence.
      expect(await screen.findByTestId('rollback-renamed')).toHaveTextContent(
        'The previous database was renamed back into place.',
      );
    });

    it('reports an `unavailable` rollback as information, not as a failure', async () => {
      const user = userEvent.setup();
      const restored = run({
        id: '77777777-7777-4777-8777-777777777777',
        restoreStatus: 'completed',
      });
      setRunsState([restored]);
      mockRollback.mockResolvedValue({
        mode: 'unavailable',
        runId: restored.id,
        detail: 'The retained database has passed its retention window.',
      });
      renderPage();

      await user.click(await rowAction(user, 'Roll back this restore', restored));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByLabelText('Acknowledge the consequences'));
      await user.type(within(dialog).getByLabelText('Type ROLLBACK to confirm'), 'ROLLBACK');
      await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));

      // Nothing went wrong just now — the rollback window simply closed, and
      // retrying will not change it.
      const alert = await screen.findByTestId('rollback-unavailable');
      expect(alert).toHaveClass('MuiAlert-colorInfo');
      expect(alert).toHaveTextContent('passed its retention window');
    });
  });

  // =========================================================================
  // The swap's own outage
  // =========================================================================

  describe('when the API goes away mid-swap', () => {
    function renderGated(permissions: string[] = FULL) {
      setInitialContainerWidth(1400);
      return render(
        <MaintenanceGate>
          <DbBackupPage />
        </MaintenanceGate>,
        { wrapperOptions: { user: userWith(permissions) } },
      );
    }

    it('presents the outage as the expected sequence, reaches the maintenance screen, and recovers', async () => {
      const user = userEvent.setup();
      const swapping = run({ restoreStatus: 'swapping' });
      setRunsState([swapping]);
      const { rerender } = renderGated();

      await screen.findByTestId('db-backup-restore-in-flight');

      // 1. The process is gone: `fetch` rejects with no response at all.
      setRunsState([], {
        error: 'The application is not responding',
        isUnreachable: true,
      });
      rerender(
        <MaintenanceGate>
          <DbBackupPage />
        </MaintenanceGate>,
      );

      expect(screen.getByTestId('db-backup-restarting')).toHaveTextContent(
        /The application is restarting/,
      );
      // NO generic error at the exact moment the operator most needs to trust
      // the screen.
      expect(
        screen.queryByText('The application is not responding'),
      ).not.toBeInTheDocument();

      // 2. Something is listening again, and it is the maintenance window.
      //    Recognised centrally by `services/api.ts`; this page needs no
      //    special case for it.
      act(() => {
        reportMaintenanceBlock({
          message: 'Restoring the database.',
          retryAfterSeconds: 30,
          allowAdmins: false,
        });
      });

      expect(
        await screen.findByRole('heading', { name: /under maintenance/i }),
      ).toBeInTheDocument();
      expect(screen.getByText('Restoring the database.')).toBeInTheDocument();
      expect(screen.queryByTestId('db-backup-restarting')).not.toBeInTheDocument();

      // 3. It is back. "Try again" clears the block, the page remounts and
      //    re-runs its effects — no reload, so the in-memory access token
      //    survives.
      setRunsState([run({ restoreStatus: 'completed', restoredAt: '2026-02-01T00:00:00Z' })]);
      await user.click(screen.getByRole('button', { name: /Try again/i }));

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Database Backup' }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('db-backup-restarting')).not.toBeInTheDocument();
      expect(
        screen.queryByText('The application is not responding'),
      ).not.toBeInTheDocument();
    });

    it('still shows an ordinary failure as an error when no restart is expected', async () => {
      // The distinction the whole treatment rests on: a live API failing is not
      // a restart, and hiding it would be worse than showing it.
      setRunsState([], { error: 'Failed to load backup runs' });
      renderPage();

      expect(await screen.findByText('Failed to load backup runs')).toBeInTheDocument();
      expect(screen.queryByTestId('db-backup-restarting')).not.toBeInTheDocument();
    });
  });
});

