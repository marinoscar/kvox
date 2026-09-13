/**
 * Admin → Operations → Broadcasts (`/admin/settings/broadcasts`).
 *
 * Issue #325, epic #319. A REGISTRY CARD and nothing else, per CLAUDE.md's
 * MANDATORY Settings UI Pattern: one entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`), one route in `App.tsx` gated on the same
 * permission string the API enforces, and no tab anywhere. The hub, the Console
 * rail and the compact AppBar title all pick this page up from that single
 * declaration.
 *
 * EXPLICITLY NOT A TAB ON `/admin/settings/notifications`. Rule 2 forbids it,
 * and the two pages answer different questions: that one is the deployment-wide
 * KILL SWITCH — whether browser notifications may be raised at all — while this
 * one composes and sends one announcement to every user. A tab strip would
 * present a reachability decision as a content decision, which is the exact
 * mistake epic #90 fixed.
 *
 * =============================================================================
 * THE RESOURCE-PAGE CONVENTION, NOT `SystemSettingsSection`
 * =============================================================================
 *
 * `JobsPage` and `WorkersPage` are the models, and this page follows them
 * literally: module-level `PAGE_TITLE`/`PAGE_DESCRIPTION` mirroring the
 * registry card word for word; an `xl` container with an `h4`/`h1` heading and
 * a `text.secondary` description that appends " (read-only)" when the write
 * permission is absent; errors as an `Alert` and successes as a `Snackbar`; a
 * `DataTable` in a `Paper` with server-side pagination and row actions; column
 * definitions in the sibling `broadcastsTable.tsx`.
 *
 * `SystemSettingsSection` is deliberately NOT used: it is the wrapper for a
 * branch of the system-settings document, and a broadcast is not a setting. It
 * is work that is dispatched and watched.
 *
 * =============================================================================
 * WRITE CONTROLS ARE DISABLED WITH A REASON, NEVER ABSENT
 * =============================================================================
 *
 * Two different gates, and both resolve to "disabled with a tooltip":
 *
 *   * NO `broadcasts:write` — the New button and both row actions are present
 *     and inert, so the control set does not change shape between a read-only
 *     admin and a writing one. An operator comparing notes with a colleague can
 *     see that the action exists and that they lack the permission, rather than
 *     concluding the feature is missing.
 *   * THE ROW'S STATUS — a `sent` broadcast cannot be cancelled and a `sending`
 *     one cannot be deleted, mirroring the API's own 409s
 *     (`isBroadcastCancelable` / `isBroadcastDeletable` in
 *     `services/broadcasts.ts`). Disabled rather than hidden for the same
 *     reason: "Cancel is greyed out because this already went out" is an
 *     answer; a missing button is a mystery.
 *
 * There is deliberately NO selection column and no bulk bar. No endpoint takes
 * a set of ids, so a checkbox would gate nothing while adding a tab stop per
 * row for every keyboard user — the same ruling `WorkersPage` makes.
 *
 * =============================================================================
 * POLLING IS OFF UNLESS SOMETHING IS IN FLIGHT
 * =============================================================================
 *
 * Unlike the queue, this table is static most of the time: `sent`, `canceled`
 * and `failed` are terminal, and a list of terminal rows cannot change with
 * nobody touching it. So the interval passed to `useVisiblePolling` is `0`
 * (which that hook treats as "off") unless a row is `scheduled` or `sending`,
 * and `BROADCASTS_POLL_INTERVAL_MS` otherwise. During a send that is exactly
 * the behaviour the jobs page has, and outside one it is no requests at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CancelScheduleSendOutlinedIcon from '@mui/icons-material/CancelScheduleSendOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Navigate } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableFilterModel, DataTableRowAction } from '../../components/datatable';
import { BroadcastComposer } from '../../components/admin/BroadcastComposer';
import { BroadcastDetailDialog } from '../../components/admin/BroadcastDetailDialog';
import { usePermissions } from '../../hooks/usePermissions';
import {
  BROADCASTS_POLL_INTERVAL_MS,
  useBroadcastActions,
  useBroadcasts,
  useVisiblePolling,
} from '../../hooks/useBroadcasts';
import {
  BROADCAST_CHUNK_SIZE,
  getBroadcast,
  getBroadcastAudience,
  getBroadcasts,
  isBroadcastCancelable,
  isBroadcastDeletable,
} from '../../services/broadcasts';
import type {
  Broadcast,
  BroadcastDetail,
  BroadcastListParams,
} from '../../services/broadcasts';
import {
  STATUS_COLUMN_ID,
  TABLE_ID,
  asBroadcastStatus,
  buildBroadcastColumns,
  readIsFilter,
} from './broadcastsTable';

/** Mirrors the `Broadcasts` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Broadcasts';
const PAGE_DESCRIPTION =
  'Write an announcement and send it to every active user now or at a scheduled time, then watch it go out.';

export default function BroadcastsPage() {
  const { hasPermission } = usePermissions();

  const { broadcasts, total, isLoading, error, fetchBroadcasts, refresh } = useBroadcasts();

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);

  // The audience count. `null` until `GET /audience` resolves — see the
  // composer, which prints "all active users" rather than a zero for that case.
  const [audience, setAudience] = useState<number | null>(null);

  const [detail, setDetail] = useState<BroadcastDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Flattened to a SCALAR, never the `filters` array: a new array is handed
  // back on every change, so an effect keyed on one would refetch forever.
  const status = asBroadcastStatus(readIsFilter(filters, STATUS_COLUMN_ID));

  const query = useMemo<BroadcastListParams>(
    () => ({
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
      ...(status ? { status } : {}),
    }),
    [page, pageSize, status],
  );

  useEffect(() => {
    void fetchBroadcasts(query);
  }, [fetchBroadcasts, query]);

  const actions = useBroadcastActions(refresh);

  /**
   * Poll only while something can still change on its own.
   *
   * `0` disables the interval outright (`useVisiblePolling` treats `<= 0` as
   * off), which is the state this page is in almost all the time. See the file
   * header.
   */
  const anyInFlight = broadcasts.some(
    (broadcast) => broadcast.status === 'scheduled' || broadcast.status === 'sending',
  );
  useVisiblePolling(refresh, anyInFlight ? BROADCASTS_POLL_INTERVAL_MS : 0);

  /**
   * The audience count, re-read whenever the composer opens.
   *
   * Not once at mount: a page left open for an afternoon would confirm a send
   * against a number counted hours ago, and the count is the single fact the
   * confirmation dialog exists to state.
   */
  useEffect(() => {
    if (!composerOpen) return;
    let canceled = false;
    void getBroadcastAudience()
      .then((result) => {
        if (!canceled) setAudience(result.activeUsers);
      })
      .catch(() => {
        // Deliberately silent, and deliberately left as `null`. A failed count
        // must not block composing — the composer degrades to "all active
        // users", which is true — and an error banner about a number nobody
        // asked for would be noise over a form.
        if (!canceled) setAudience(null);
      });
    return () => {
      canceled = true;
    };
  }, [composerOpen]);

  const columns = useMemo(() => buildBroadcastColumns(), []);

  const canWrite = hasPermission('broadcasts:write');

  const openDetail = useCallback(async (broadcast: Broadcast) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getBroadcast(broadcast.id));
    } catch {
      setDetailError('Failed to load this broadcast.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const rowActions = useMemo(
    () =>
      [
        {
          id: 'view',
          label: 'View broadcast',
          icon: <VisibilityOutlinedIcon fontSize="small" />,
          // Never gated: reading is what `broadcasts:read` buys, and this page
          // is unreachable without it.
          onClick: (broadcast) => void openDetail(broadcast),
        },
        {
          id: 'cancel',
          label: 'Cancel broadcast',
          icon: <CancelScheduleSendOutlinedIcon fontSize="small" />,
          // Disabled, NOT omitted, in both directions — see the file header.
          disabled: (broadcast) =>
            !canWrite || !isBroadcastCancelable(broadcast) || actions.isWorking,
          confirm: {
            title: 'Cancel this broadcast?',
            /**
             * THE IN-FLIGHT SENTENCE IS THE WHOLE POINT OF THIS DIALOG.
             *
             * The fan-out re-checks the status BETWEEN batches, so up to one
             * chunk's worth of recipients can already have been dispatched — or
             * be mid-dispatch — when the cancel lands. An operator pulling an
             * announcement needs to be told that in a number, because the safe
             * assumption ("nothing went out") is the wrong one, and a vague
             * "some may still be sent" reads like the cancel failed.
             */
            description: (broadcast) =>
              broadcast.status === 'sending'
                ? `"${broadcast.title}" is already sending. Cancelling stops every batch after the ` +
                  `current one, but one in-flight batch of up to ${BROADCAST_CHUNK_SIZE} recipients ` +
                  'may still go out — what has already been sent cannot be recalled. The record is ' +
                  'kept so you can look up what was announced.'
                : `"${broadcast.title}" will not be sent. The record is kept so you can look up ` +
                  'what was scheduled.',
            confirmLabel: 'Cancel broadcast',
          },
          onClick: (broadcast) => {
            void actions.cancel(broadcast.id).then((ok) => {
              if (ok) setNotice('Broadcast canceled.');
            });
          },
        },
        {
          id: 'delete',
          label: 'Delete broadcast',
          icon: <DeleteIcon fontSize="small" />,
          destructive: true,
          disabled: (broadcast) =>
            !canWrite || !isBroadcastDeletable(broadcast) || actions.isWorking,
          confirm: {
            title: 'Delete this broadcast?',
            description: (broadcast) =>
              `"${broadcast.title}" will be removed from this list. Notifications already ` +
              'delivered are NOT withdrawn — recipients keep them. This cannot be undone.',
            confirmLabel: 'Delete',
          },
          onClick: (broadcast) => {
            void actions.remove(broadcast.id).then((ok) => {
              if (ok) setNotice('Broadcast deleted.');
            });
          },
        },
      ] satisfies DataTableRowAction<Broadcast>[],
    [canWrite, actions, openDetail],
  );

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {filters.length > 0
          ? 'No broadcasts match these filters'
          : 'Nothing has been announced yet'}
      </Typography>
    ),
    [filters.length],
  );

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string, exactly as every sibling admin page does. It sits
  // after every hook so the hook order never changes.
  if (!hasPermission('broadcasts:read')) {
    return <Navigate to="/" replace />;
  }

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

        {actions.error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={actions.clearError}>
            {actions.error}
          </Alert>
        )}

        {/* The API's non-fatal `warnings` from the last create. Rendered rather
            than swallowed: "browser notifications are off deployment-wide" is
            something the admin must know about a broadcast that has already been
            queued, and it is explicitly not an error — scheduling around the
            switch being flipped back is legitimate. */}
        {warnings.map((warning) => (
          <Alert key={warning} severity="warning" sx={{ mb: 2 }} onClose={() => setWarnings([])}>
            {warning}
          </Alert>
        ))}

        <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
          <Tooltip
            title={
              canWrite
                ? 'Compose an announcement for every active user'
                : 'You need the broadcasts:write permission to send a broadcast'
            }
          >
            {/* A disabled button fires no events, so the tooltip needs a live
                wrapper to hang off — the standard MUI arrangement. */}
            <span>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                disabled={!canWrite || actions.isWorking}
                onClick={() => setComposerOpen(true)}
              >
                New broadcast
              </Button>
            </span>
          </Tooltip>
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Paper sx={{ width: '100%', p: 2 }}>
          <Box sx={{ minWidth: 0 }}>
            <DataTable<Broadcast>
              tableId={TABLE_ID}
              data-testid="admin-broadcasts-table"
              ariaLabel="Broadcasts"
              columns={columns}
              rows={broadcasts}
              rowId={(broadcast) => broadcast.id}
              loading={isLoading}
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
              // No `selection` and no `bulkActions`: no endpoint takes a set of
              // ids — see the file header.
              csvExport={{
                filename: 'broadcasts',
                // Replays THIS page's own query, so an export can only ever
                // contain what the user's own list request already returns.
                fetchAllRows: async ({ page: exportPage, pageSize: exportPageSize }) => {
                  const response = await getBroadcasts({
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
            Newest first.{' '}
            {anyInFlight
              ? `Something is queued or sending, so the list is re-read every ${
                  BROADCASTS_POLL_INTERVAL_MS / 1000
                } seconds while this tab is in front.`
              : 'Nothing is queued or sending, so the list is not being polled.'}
          </Typography>
        </Paper>

        <BroadcastComposer
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          audience={audience}
          isWorking={actions.isWorking}
          onSubmit={async (body) => {
            const result = await actions.create(body);
            if (!result) return false;
            setWarnings(result.warnings);
            setNotice(
              result.broadcast.scheduledFor
                ? 'Broadcast scheduled. You can cancel it until it starts sending.'
                : 'Broadcast queued. It starts sending immediately.',
            );
            return true;
          }}
          onSendTest={async (body) => (await actions.sendTest(body)) !== null}
        />

        <BroadcastDetailDialog
          open={detailOpen}
          broadcast={detail}
          isLoading={detailLoading}
          error={detailError}
          onClose={() => setDetailOpen(false)}
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
