/**
 * Admin → Allowlist (issue #67, epic #51).
 *
 * The hand-rolled `TableContainer` block is deleted wholesale. Three specific
 * conversions, each of them a shape the card renderer could not otherwise have:
 *
 *  1. **`window.confirm` → the row action's own `confirm` option.** The native
 *     dialog blocked the event loop, could not be styled or translated, and
 *     needed a global stub to test. `DataTableRowAction.confirm` gives ONE
 *     dialog per table, owned by the renderer, with copy derived from the row.
 *  2. **"Cannot remove a claimed entry" → `disabled: (e) => Boolean(e.claimedBy)`.**
 *     The old code branched between a disabled `IconButton` wrapped in a
 *     Tooltip and a live one; the contract expresses that as one action with a
 *     per-row predicate, and `RowActionsCell` keeps the tooltip working over
 *     the disabled control.
 *  3. **"Add Email" moved OUT of the table into this page's header.** It is a
 *     TABLE-level action — it belongs to neither a row nor a selection — so it
 *     has no home inside a renderer that only knows about rows. It sits above
 *     the table, next to the heading, where it is the same control at every
 *     width.
 *
 * The search box is gone from this file entirely: quick search is now the
 * table's own control, debounced on emission, and it renders as a bar on
 * desktop and a full-screen sheet on a phone.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { DataTable } from '../datatable';
import type {
  DataTableFilterModel,
  DataTableRowAction,
  DataTableSortState,
} from '../datatable';
import { useAllowlist } from '../../hooks/useAllowlist';
import { usePermissions } from '../../hooks/usePermissions';
import { ApiError, getAllowlist } from '../../services/api';
import { AddEmailDialog } from './AddEmailDialog';
import type { AllowedEmailEntry } from '../../types';
import { TABLE_ID, asAllowlistSortField, buildAllowlistColumns } from './allowlistColumns';

type AllowlistStatus = 'all' | 'pending' | 'claimed';

/** The `status` query param, read out of the filter model as a SCALAR. */
function readStatusFilter(filters: DataTableFilterModel): AllowlistStatus {
  const found = filters.find(
    (filter) => filter.columnId === 'status' && filter.operator === 'is',
  );
  return found?.value === 'pending' || found?.value === 'claimed' ? found.value : 'all';
}

/**
 * What to say when `POST /api/allowlist/{id}/reminder` refuses (issue #301).
 *
 * ⚠ THE TWO NAMED STATUSES ARE NOT FAILURES OF THE SAME KIND, AND NEITHER IS A
 * GENERIC ONE. `AllowlistService.sendReminder` raises:
 *
 *   - **409** when the entry is already claimed. The invitee signed in, which
 *     is the outcome the invitation was for — so this reads as news rather than
 *     an apology, and it tells the administrator what to do about the stale row
 *     in front of them (reload; it will say `Claimed`). The button is not
 *     rendered for a claimed row at all, so reaching this means the list is
 *     older than the database, not that the gate leaked.
 *   - **404** for an id that is gone — somebody removed the entry in another
 *     tab or another session. Retrying cannot help; re-reading can.
 *
 * Everything else keeps the server's own sentence, which is what
 * `useAllowlist`'s other handlers do (`err.message`), falling back to a plain
 * statement only when there is no message to show. Maintenance windows are
 * already intercepted centrally in `services/api.ts` and never reach here.
 *
 * Exported for its own test: the mapping is the whole of this feature's error
 * behaviour and deserves to be assertable without driving a click.
 */
export function reminderErrorMessage(error: unknown, email: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return `${email} has already signed in, so there is nobody left to remind. Reload the list to see the current status.`;
    }
    if (error.status === 404) {
      return `That allowlist entry no longer exists — it was removed somewhere else. Reload the list.`;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Failed to send reminder';
}

export function AllowlistTable() {
  const {
    entries,
    total,
    isLoading,
    error,
    fetchAllowlist,
    addEmail,
    removeEmail,
    sendReminder,
  } = useAllowlist();
  const { hasPermission } = usePermissions();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<DataTableSortState | null>(null);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Separate from the hook's `error`, which is about LOADING and about the two
  // writes that change which rows exist. A reminder failure is about one named
  // person, so its sentence names them; folding the two into one state would
  // mean a failed reminder silently clearing a failed load, and vice versa.
  const [reminderError, setReminderError] = useState<string | null>(null);

  // --- Row actions ------------------------------------------------------------
  const canWrite = hasPermission('allowlist:write');

  /**
   * ⚠ NEVER REJECTS. `ReminderCell` awaits this to clear its own spinner, and
   * an unhandled rejection from a cell would leave that spinner turning
   * forever. The outcome is reported in the alert above the table instead — the
   * same place the hook already reports a failed add or remove.
   */
  const handleSendReminder = useCallback(
    async (entry: AllowedEmailEntry) => {
      setReminderError(null);
      try {
        await sendReminder(entry.id);
      } catch (err) {
        setReminderError(reminderErrorMessage(err, entry.email));
      }
    },
    [sendReminder],
  );

  const columns = useMemo(
    () =>
      buildAllowlistColumns({
        canSendReminder: canWrite,
        onSendReminder: handleSendReminder,
      }),
    // Both are stable (`canWrite` is a boolean off the session, `handleSendReminder`
    // a `useCallback` over the hook's own `useCallback`), so the column array
    // keeps its identity across renders — which is what the DataGrid's cell
    // repaint guidance in `DesktopGridRenderer` asks pages to preserve.
    [canWrite, handleSendReminder],
  );

  // --- Query params, flattened to scalars ------------------------------------
  const status = useMemo(() => readStatusFilter(filters), [filters]);
  const sortField = asAllowlistSortField(sort?.field);
  const sortDirection = sort?.direction;

  useEffect(() => {
    fetchAllowlist({
      page: page + 1,
      pageSize,
      search: search || undefined,
      status,
      ...(sortField ? { sortBy: sortField, sortOrder: sortDirection } : {}),
    });
    // Scalars only — `entries` is replaced on every fetch, so nothing here may
    // depend on a row object.
  }, [page, pageSize, search, status, sortField, sortDirection, fetchAllowlist]);

  const rowActions = useMemo(() => {
    // DELETE /api/allowlist/{id} enforces allowlist:write. Gating the ARRAY (as
    // opposed to a rendered `<TableCell>`) removes the control from the grid,
    // the tablet row expander and the card header in one move.
    if (!canWrite) return [] as DataTableRowAction<AllowedEmailEntry>[];

    return [
      {
        id: 'remove',
        label: 'Remove',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // The server refuses this too (`allowlist.service.ts` raises 400 on a
        // claimed entry); disabling keeps the control and its tooltip
        // discoverable rather than making the row silently actionless.
        disabled: (entry) => Boolean(entry.claimedBy),
        confirm: {
          title: 'Remove from allowlist?',
          description: (entry) =>
            `${entry.email} will no longer be able to sign in. This cannot be undone.`,
          confirmLabel: 'Remove',
        },
        onClick: (entry) => {
          void removeEmail(entry.id).catch(() => {
            /* surfaced through the hook's `error` */
          });
        },
      },
    ] satisfies DataTableRowAction<AllowedEmailEntry>[];
  }, [canWrite, removeEmail]);

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {search ? 'No emails found matching your search' : 'No emails in allowlist'}
      </Typography>
    ),
    [search],
  );

  return (
    <Paper sx={{ width: '100%', p: 2 }}>
      {/* Table-level action: not a row action, not a bulk action. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mb: 2, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
      >
        <Typography variant="h6" component="h2">
          Email allowlist
        </Typography>
        {canWrite && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setDialogOpen(true)}
          >
            Add Email
          </Button>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {reminderError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setReminderError(null)}>
          {reminderError}
        </Alert>
      )}

      <Box sx={{ minWidth: 0 }}>
        <DataTable<AllowedEmailEntry>
          tableId={TABLE_ID}
          data-testid="admin-allowlist-table"
          ariaLabel="Email allowlist"
          columns={columns}
          rows={entries}
          rowId={(entry) => entry.id}
          loading={isLoading}
          emptyState={emptyState}
          pagination={{
            page,
            pageSize,
            total,
            pageSizeOptions: [5, 10, 25, 50],
            onPaginationChange: (next) => {
              setPage(next.page);
              setPageSize(next.pageSize);
            },
          }}
          sort={{ sort, onSortChange: setSort }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            setPage(0);
          }}
          quickSearch={{
            value: search,
            ariaLabel: 'Search by email',
            placeholder: 'Search by email',
            onChange: (next) => {
              setSearch(next);
              setPage(0);
            },
          }}
          rowActions={rowActions}
          csvExport={{
            filename: 'allowlist',
            fetchAllRows: async ({ page: exportPage, pageSize: exportPageSize }) => {
              const response = await getAllowlist({
                page: exportPage + 1,
                pageSize: exportPageSize,
                search: search || undefined,
                status,
              });
              return response.items;
            },
          }}
        />
      </Box>

      <AddEmailDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={addEmail}
      />
    </Paper>
  );
}
