/**
 * Admin → Operations → Database Backup (`/admin/settings/db-backup`).
 *
 * Issue #287, epic #254 — the last page of the epic, and the one that flips the
 * `Database Backup` card in `config/adminSections.tsx` from inert to routed. A
 * REGISTRY CARD and nothing else, per CLAUDE.md's MANDATORY Settings UI
 * Pattern: one entry in `ADMIN_SECTIONS`, one route in `App.tsx` gated on the
 * same permission string the API enforces, and no tab anywhere. The hub, the
 * Console rail and the compact AppBar title all pick this page up from that
 * single declaration.
 *
 * The three questions an operator brings here, in the order they ask them:
 *
 *   1. "Is this deployment actually being backed up, and when next?" — the
 *      policy panel, with the SERVER'S OWN `nextRunAt` beside the save button.
 *   2. "What have we got, and can I trust it?" — the run history, with the
 *      verified column and the checksum.
 *   3. "Put this one back." — the restore dialog, which is the careful part and
 *      carries its own long argument in
 *      `components/admin/DbBackupRestoreDialog.tsx`.
 *
 * =============================================================================
 * THREE PERMISSIONS, NOT TWO — AND THE THIRD IS THE POINT OF THE SPLIT
 * =============================================================================
 *
 * `db_backup:read` reaches the page (the route gate, and the card's). Scheduling
 * a backup, cancelling one and deleting an archive need `db_backup:write`.
 * Restoring and rolling back need `db_backup:restore`, which the API keeps as a
 * SEPARATE permission precisely so it can be withheld from someone who may
 * schedule backups but must not be able to replace the database — so this page
 * gates its restore controls on that string alone and never on `write`.
 * Collapsing the two here would quietly undo the reason the API split them.
 *
 * Controls are DISABLED with a reason rather than absent, the rule `UserList`
 * states and `JobsPage`, `WorkersPage` and `BroadcastsPage` all follow: the
 * control set must not change shape between a read-only admin and a writing
 * one, or an operator comparing notes with a colleague concludes the feature is
 * missing rather than that they lack the permission.
 *
 * =============================================================================
 * THE API'S PRECONDITIONS ARE ON THE CONTROLS, NOT IN THE ERROR HANDLER
 * =============================================================================
 *
 * The endpoints refuse a download of a run that is not `completed`, a delete of
 * one that is still active, a cancel of one that has finished, a restore of
 * anything but a `completed` archive, and a rollback of a run that was never
 * restored. Every one of those is a predicate in `services/dbBackup.ts` and
 * every row action reads it, so the refusal is visible in the UI rather than
 * discovered by clicking. A `stale` run is deliberately not downloadable or
 * restorable: nobody knows how it ended, so its archive may be truncated — the
 * exact case where a UI that "helpfully" allowed it would hand an operator a
 * corrupt restore during an incident.
 *
 * =============================================================================
 * ⚠ THE API GOING AWAY IS AN EXPECTED PHASE HERE, AND IS PRESENTED AS ONE
 * =============================================================================
 *
 * This is the only page in the application that deliberately takes the API
 * down. At the end of a restore the swap renames two catalogs and THE API
 * PROCESS EXITS so its connection pool can be rebuilt against the new database.
 * The observable sequence, in order:
 *
 *   1. requests fail with no response at all (the process is gone),
 *   2. then answer `503` with the maintenance marker (something is listening
 *      again, and the window is still open),
 *   3. then succeed.
 *
 * Step 2 is handled centrally and needs nothing from this page:
 * `services/api.ts` recognises the marker on the one error path every request
 * shares, records a block, and `MaintenanceGate` swaps the whole subtree for
 * the maintenance screen — whose "Try again" clears the block, remounts this
 * page, and re-runs its effects. That is the recovery, and it is the same one
 * every other page in the app gets.
 *
 * Step 1 is what this page has to get right. A transport failure with no
 * response is `isUnreachable` on both read hooks (see `hooks/useDbBackup.ts`),
 * and while a restart is EXPECTED — because a restore was just started here, or
 * because a run in the list is mid-restore — it is rendered as the expected
 * sequence rather than as an error. Showing "Failed to load backup runs" at the
 * exact moment an operator is watching their own database being replaced is the
 * one thing that would make them doubt a screen that is working perfectly.
 *
 * The flag is STICKY across the outage on purpose: the run list is cleared when
 * a read fails (rows carrying a live progress bar must not outlive their
 * refresh), so "a run is mid-restore" is not observable while the API is gone.
 * It is cleared again by the first successful read that shows nothing in
 * flight.
 *
 * =============================================================================
 * POLLING, AND WHY IT STOPS WITH THE TAB
 * =============================================================================
 *
 * A dump advances with nobody touching it, and a restore walks four states over
 * hours, so this is one of the admin surfaces where a poll is the honest
 * design. The shared `useVisiblePolling` (one implementation, in
 * `hooks/useVisiblePolling.ts`) tears the interval down while the tab is hidden
 * and fetches immediately on return. A backup page left open on a second
 * monitor overnight should not poll all day; a page that resumes by waiting out
 * a full interval is worse than one that never paused, because an hour-old
 * "Running" that looks live is the wrong answer this page must not give.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
import CancelIcon from '@mui/icons-material/Cancel';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import RestoreIcon from '@mui/icons-material/Restore';
import UndoIcon from '@mui/icons-material/Undo';
import { Navigate } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableFilterModel, DataTableRowAction } from '../../components/datatable';
import { DbBackupConfigPanel } from '../../components/admin/DbBackupConfigPanel';
import { DbBackupRestoreDialog } from '../../components/admin/DbBackupRestoreDialog';
import type { RestoreDialogIntent } from '../../components/admin/DbBackupRestoreDialog';
import { usePermissions } from '../../hooks/usePermissions';
import {
  DB_BACKUP_POLL_INTERVAL_MS,
  useDbBackupActions,
  useDbBackupConfig,
  useDbBackupRuns,
  useVisiblePolling,
} from '../../hooks/useDbBackup';
import {
  getBackupRuns,
  isBackupCancelable,
  isBackupDeletable,
  isBackupDownloadable,
  isBackupRestorable,
  isBackupRunActive,
  isRestoreInFlight,
  isRollbackAvailable,
} from '../../services/dbBackup';
import type { DbBackupRun, DbBackupRunListParams } from '../../services/dbBackup';
import {
  STATUS_COLUMN_ID,
  TABLE_ID,
  TRIGGER_COLUMN_ID,
  asRunStatus,
  asRunTrigger,
  buildBackupRunColumns,
  formatBytes,
  formatRunDuration,
  readIsFilter,
} from './dbBackupTable';

/** Mirrors the `Database Backup` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Database Backup';
const PAGE_DESCRIPTION =
  'Schedule backups, review what has been taken, and restore the database from one.';

export default function DbBackupPage() {
  const { hasPermission } = usePermissions();

  const {
    config,
    isLoading: configLoading,
    loadError: configError,
    isUnreachable: configUnreachable,
    isSaving,
    saveError,
    save,
    refresh: refreshConfig,
  } = useDbBackupConfig();

  const {
    runs,
    total,
    isLoading: runsLoading,
    error: runsError,
    isUnreachable: runsUnreachable,
    fetchRuns,
    refresh: refreshRuns,
  } = useDbBackupRuns();

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogIntent, setDialogIntent] = useState<RestoreDialogIntent | null>(null);
  const [dialogRun, setDialogRun] = useState<DbBackupRun | null>(null);
  /** See the file header: sticky across the outage the swap causes. */
  const [restartExpected, setRestartExpected] = useState(false);

  /**
   * The instant every duration on this page is measured against.
   *
   * ONE CLOCK FOR THE WHOLE RENDER, advanced on each refresh rather than read
   * per cell — otherwise two runs that started in the same second can render
   * different elapsed times, which on a page whose whole job is to show
   * progress reads as a bug in the progress.
   */
  const [renderedAt, setRenderedAt] = useState(() => new Date());

  // --- Query params, flattened to SCALARS -------------------------------------
  // Never the `filters` array: a new array is handed back on every change, so an
  // effect keyed on one would refetch forever.
  const status = asRunStatus(readIsFilter(filters, STATUS_COLUMN_ID));
  const trigger = asRunTrigger(readIsFilter(filters, TRIGGER_COLUMN_ID));

  const query = useMemo<DbBackupRunListParams>(
    () => ({
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
      ...(status ? { status } : {}),
      ...(trigger ? { trigger } : {}),
    }),
    [page, pageSize, status, trigger],
  );

  useEffect(() => {
    void fetchRuns(query);
  }, [fetchRuns, query]);

  /**
   * Re-read BOTH the history and the policy, and re-date the page.
   *
   * One function, so the two halves are never a poll apart: `nextRunAt` and
   * `activeRunId` are computed server-side and move on their own, so a policy
   * panel that is not re-read alongside the table would show a next-run time
   * that has already passed.
   */
  const refreshAll = useCallback(() => {
    setRenderedAt(new Date());
    void refreshRuns();
    void refreshConfig();
  }, [refreshRuns, refreshConfig]);

  const actions = useDbBackupActions(refreshAll);
  useVisiblePolling(refreshAll, DB_BACKUP_POLL_INTERVAL_MS);

  const activeRun = useMemo(() => runs.find((run) => isBackupRunActive(run)) ?? null, [runs]);
  /**
   * Whether the single active slot is taken, whatever this page happens to be
   * SHOWING.
   *
   * `config.activeRunId` is why the API publishes it: the run holding the slot
   * may be on another page of the history, or filtered out entirely, and a
   * "Back up now" button enabled off the visible rows alone would send a
   * request the API answers with a 409. The visible run is still preferred for
   * the progress panel, because that is the one there are bytes to report for.
   */
  const slotTaken = activeRun !== null || (config?.activeRunId ?? null) !== null;
  const restoringRun = useMemo(() => runs.find((run) => isRestoreInFlight(run)) ?? null, [runs]);

  /**
   * A restart stops being expected once the API answers again AND nothing is
   * mid-restore. Not on the first successful read alone: the restore path
   * itself keeps serving normally for hours before the swap, so a read
   * succeeding says nothing about whether the restart has happened yet.
   */
  useEffect(() => {
    if (!runsUnreachable && !runsError && !restoringRun) setRestartExpected(false);
  }, [runsUnreachable, runsError, restoringRun]);

  useEffect(() => {
    if (restoringRun) setRestartExpected(true);
  }, [restoringRun]);

  const apiUnreachable = runsUnreachable || configUnreachable;
  /** The expected phase, not a failure — see the file header. */
  const showingRestartSequence = apiUnreachable && restartExpected;

  const canWrite = hasPermission('db_backup:write');
  const canRestore = hasPermission('db_backup:restore');

  const columns = useMemo(() => buildBackupRunColumns(renderedAt), [renderedAt]);

  const openDialog = useCallback((intent: RestoreDialogIntent, run: DbBackupRun) => {
    actions.clearError();
    setDialogRun(run);
    setDialogIntent(intent);
  }, [actions]);

  const handleDownload = useCallback(
    async (run: DbBackupRun) => {
      const link = await actions.downloadUrlFor(run.id);
      if (!link) return;
      // A signed, expiring URL to object storage — opened rather than fetched,
      // so the browser's own download machinery handles an archive that may be
      // gigabytes. `noopener` because the target is a third-party storage host.
      window.open(link.url, '_blank', 'noopener,noreferrer');
      setNotice(`Download link opened; it expires in ${link.expiresIn} seconds.`);
    },
    [actions],
  );

  const rowActions = useMemo(() => {
    const list: DataTableRowAction<DbBackupRun>[] = [];

    // Reading is enough to download an archive: the same `db_backup:read` the
    // page is gated on is what the API enforces on the download route.
    list.push({
      id: 'download',
      label: 'Download archive',
      icon: <DownloadIcon fontSize="small" />,
      // The API answers 400 for anything but a `completed` run — including a
      // `stale` one, whose archive may be truncated.
      disabled: (run) => !isBackupDownloadable(run) || actions.isWorking,
      onClick: (run) => void handleDownload(run),
    });

    if (canWrite) {
      list.push({
        id: 'cancel',
        label: 'Cancel backup',
        icon: <CancelIcon fontSize="small" />,
        disabled: (run) => !isBackupCancelable(run) || actions.isWorking,
        confirm: {
          title: 'Cancel this backup?',
          description: () =>
            'The dump is stopped and its partial archive is deleted, so the run ends as ' +
            'failed. Nothing already backed up is affected.',
          confirmLabel: 'Cancel backup',
        },
        onClick: (run) => {
          void actions.cancelRun(run.id).then((result) => {
            // ⚠ The outcome, not the status code: a run executing on another
            // API instance cannot be signalled from here, and saying "cancelled"
            // would be wrong in the one case where the operator has to do
            // something else.
            if (result) setNotice(result.detail);
          });
        },
      });

      list.push({
        id: 'delete',
        label: 'Delete backup',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // The API refuses to delete an active run: its archive is mid-upload.
        disabled: (run) => !isBackupDeletable(run) || actions.isWorking,
        confirm: {
          title: 'Delete this backup?',
          description: (run) =>
            `The archive taken on ${new Date(run.createdAt).toLocaleString()} and its record ` +
            'are removed. This cannot be undone, and it is one fewer point you can restore to.',
          confirmLabel: 'Delete',
        },
        onClick: (run) => {
          void actions.deleteRun(run.id).then((result) => {
            if (!result) return;
            setNotice(
              result.objectDeleted
                ? 'Backup deleted.'
                : 'Backup record deleted, but the stored archive could not be removed — ' +
                  'check the storage provider.',
            );
          });
        },
      });
    }

    if (canRestore) {
      list.push({
        id: 'restore',
        label: 'Restore from this backup',
        icon: <RestoreIcon fontSize="small" />,
        destructive: true,
        disabled: (run) => !isBackupRestorable(run) || actions.isWorking,
        // NO `confirm` here, deliberately. The shared confirmation dialog is a
        // title and a sentence; this action needs the pre-flight verdicts, the
        // typed literal, the phase timings and the restart notice, and those
        // live in `DbBackupRestoreDialog`.
        onClick: (run) => openDialog('restore', run),
      });

      list.push({
        id: 'rollback',
        label: 'Roll back this restore',
        icon: <UndoIcon fontSize="small" />,
        destructive: true,
        // The API answers 400 when this archive was never restored — there is
        // no swap to undo, and restoring it instead would be a different
        // request.
        disabled: (run) => !isRollbackAvailable(run) || actions.isWorking,
        onClick: (run) => openDialog('rollback', run),
      });
    }

    return list;
  }, [actions, canRestore, canWrite, handleDownload, openDialog]);

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {filters.length > 0
          ? 'No backups match these filters'
          : 'No backups have been taken yet'}
      </Typography>
    ),
    [filters.length],
  );

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string, exactly as every sibling admin page does. It sits
  // after every hook so the hook order never changes.
  if (!hasPermission('db_backup:read')) {
    return <Navigate to="/" replace />;
  }

  const startDisabled = !canWrite || actions.isWorking || slotTaken;

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the registry card so the hub card, the
            rail row, the compact AppBar title and this `h1` all name the page
            identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
          {/* Stated up front rather than left for the operator to discover by
              finding every control disabled. */}
          {!canWrite && ' (read-only)'}
        </Typography>

        {/* ------------------------------------------------------------------
            THE EXPECTED SEQUENCE. Replaces the error banners while a restart is
            expected and the API is not answering — see the file header.
            ------------------------------------------------------------- */}
        {showingRestartSequence && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="db-backup-restarting">
            <AlertTitle>The application is restarting</AlertTitle>
            The swap is finishing and the API has exited so it can reconnect to the restored
            database. This is the expected last step, not a failure. This page will show the
            maintenance screen while it comes back, and then carry on by itself.
            <LinearProgress sx={{ mt: 1.5, borderRadius: 1 }} aria-hidden />
          </Alert>
        )}

        {actions.error && !showingRestartSequence && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={actions.clearError}>
            {actions.error}
          </Alert>
        )}
        {configError && !showingRestartSequence && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {configError}
          </Alert>
        )}

        {/* ------------------------------------------------------------------
            WHAT IS HAPPENING RIGHT NOW. Above the policy, because during an
            incident it is the only thing on this page anybody is reading.
            ------------------------------------------------------------- */}
        {activeRun && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="db-backup-active-run">
            <AlertTitle>A backup is running</AlertTitle>
            {formatBytes(activeRun.bytesWritten)} written so far, over{' '}
            {formatRunDuration(activeRun, renderedAt)}. The archive size is not known until the
            dump finishes.
            <LinearProgress sx={{ mt: 1.5, borderRadius: 1 }} aria-hidden />
          </Alert>
        )}

        {restoringRun && (
          <Alert severity="warning" sx={{ mb: 3 }} data-testid="db-backup-restore-in-flight">
            <AlertTitle>A restore is in progress</AlertTitle>
            The archive from {new Date(restoringRun.createdAt).toLocaleString()} is being
            restored. The application keeps serving until the swap, which restarts it.
          </Alert>
        )}

        {config && (
          <DbBackupConfigPanel
            config={config}
            canWrite={canWrite}
            isSaving={isSaving}
            saveError={saveError}
            onSave={save}
            onSaved={setNotice}
          />
        )}

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mb: 2, alignItems: { sm: 'center' } }}
        >
          <Tooltip
            title={
              !canWrite
                ? 'You do not have permission to start a backup'
                : slotTaken
                  ? 'A backup is already running — only one runs at a time'
                  : 'Take a backup now, outside the schedule'
            }
          >
            {/* A disabled button fires no events, so the tooltip needs a live
                wrapper to hang off — the standard MUI arrangement. */}
            <span>
              <Button
                variant="outlined"
                startIcon={<BackupOutlinedIcon />}
                disabled={startDisabled}
                onClick={() => {
                  void actions.startBackup().then((run) => {
                    if (run) setNotice('Backup started.');
                  });
                }}
              >
                Back up now
              </Button>
            </span>
          </Tooltip>
        </Stack>

        {runsError && !showingRestartSequence && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {runsError}
          </Alert>
        )}

        <Paper sx={{ width: '100%', p: 2 }}>
          <Box sx={{ minWidth: 0 }}>
            <DataTable<DbBackupRun>
              tableId={TABLE_ID}
              data-testid="admin-db-backup-table"
              ariaLabel="Backup runs"
              columns={columns}
              rows={runs}
              rowId={(run) => run.id}
              loading={runsLoading || configLoading}
              emptyState={emptyState}
              pagination={{
                page,
                pageSize,
                total,
                // The API caps `pageSize` at 100, so no option here may exceed it.
                pageSizeOptions: [10, 20, 50, 100],
                onPaginationChange: (next) => {
                  setPage(next.page);
                  setPageSize(next.pageSize);
                },
              }}
              filters={filters}
              onFiltersChange={(next) => {
                setFilters(next);
                setPage(0);
              }}
              rowActions={rowActions}
              // No `selection` and no bulk bar: no endpoint takes a set of ids,
              // so a checkbox column would gate nothing while adding a tab stop
              // per row for every keyboard user — the ruling `WorkersPage` and
              // `BroadcastsPage` both make.
              csvExport={{
                filename: 'database-backups',
                // Replays THIS page's own query, so an export can only ever
                // contain what the user's own list request already returns.
                fetchAllRows: async ({ page: exportPage, pageSize: exportPageSize }) => {
                  const response = await getBackupRuns({
                    ...query,
                    page: exportPage + 1,
                    pageSize: exportPageSize,
                  });
                  return response.items;
                },
              }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Newest first. The history is re-read every {DB_BACKUP_POLL_INTERVAL_MS / 1000}{' '}
            seconds while this tab is in front.
          </Typography>
        </Paper>

        <DbBackupRestoreDialog
          open={dialogIntent !== null}
          intent={dialogIntent ?? 'restore'}
          run={dialogRun}
          config={config}
          isWorking={actions.isWorking}
          error={actions.error}
          onRestore={async (options) => {
            if (!dialogRun) return null;
            const result = await actions.restore(dialogRun.id, options);
            // ⚠ Only `running` started anything. A `guided` or `blocked` answer
            // is a 200 that changed nothing, and treating either as "a restart
            // is coming" would put this page into the outage state over a
            // deployment that is serving perfectly.
            if (result?.mode === 'running') setRestartExpected(true);
            return result;
          }}
          onRollback={async () => {
            if (!dialogRun) return null;
            const result = await actions.rollback(dialogRun.id);
            // `unavailable` changed nothing; the other two both end in a
            // restart.
            if (result && result.mode !== 'unavailable') setRestartExpected(true);
            return result;
          }}
          onClose={() => {
            setDialogIntent(null);
            setDialogRun(null);
            refreshAll();
          }}
        />

        <Snackbar
          open={notice !== null}
          autoHideDuration={6000}
          onClose={() => setNotice(null)}
          message={notice}
        />
      </Box>
    </Container>
  );
}
