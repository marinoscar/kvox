/**
 * Admin -> Users & Allowlist -> Reminders (issue #301, re-homed by #465).
 *
 * The packaged `UsersPage` (`@marinoscar/platform-web/identity/ui`) owns the
 * Users and Allowlist tabs, but the platform has no "remind an invitee" feature:
 * `POST /api/allowlist/:id/reminder` and its bookkeeping are this app's (a side
 * table, `apps/api/src/allowlist-reminders/`). This panel is how that feature
 * stays reachable. It is appended to the page through `slots.Tabs`, with
 * `permission: 'allowlist:read'`, in `identity/usersPageSlots.ts`.
 *
 * WHY A TAB AND NOT A SETTINGS CARD (Settings UI Pattern, rule 2). Users,
 * Allowlist and Reminders are three views of one question, "who may use this
 * application"; that is parallel content, which is what a tab is for. A new
 * destination would be a card in the registry, and this is not one.
 *
 * WHAT IT SHOWS. The PENDING allowlist entries (invited, not yet signed in),
 * each with how often it has been chased and when, and a "Send reminder"
 * button. The entries come from the platform's `GET /api/allowlist?status=pending`
 * (the packaged `useAllowlist` hook); the counts come from this app's
 * `GET /api/allowlist/reminders?ids=` for just the ids on screen and are joined
 * here by id. A failed counts request degrades to "no history shown" with a
 * warning, never to an empty list.
 *
 * THE API AUTHORISES, THE UI PRESENTS. The button is rendered only with
 * `allowlist:write`, the string `POST /:id/reminder` enforces; hiding it is not
 * security.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { useAllowlist, usePermissions } from '@marinoscar/platform-web/identity/headless';
import type { AllowedEmailEntry } from '@marinoscar/platform-web/identity/headless';
import { DataTable } from '../datatable';
import type { DataTableColumn, DataTableSortState } from '../datatable';
import {
  getAllowlistReminders,
  reminderErrorMessage,
  sendAllowlistReminder,
} from '../../services/allowlistReminders';
import type { AllowlistReminderState } from '../../services/allowlistReminders';

/** Persistence key for `user_settings.dataTables`. */
export const REMINDERS_TABLE_ID = 'admin-allowlist-reminders';

/** Column ids that are also valid `sortBy` values of `GET /api/allowlist`. */
const SORTABLE_FIELDS = ['email', 'addedAt'] as const;
type ReminderSortField = (typeof SORTABLE_FIELDS)[number];

function asSortField(field: string | undefined): ReminderSortField | undefined {
  return SORTABLE_FIELDS.find((candidate) => candidate === field);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * The `Reminders` cell's scalar: empty at zero.
 *
 * HIDDEN AT ZERO, DELIBERATELY. The count exists as a restraint: an
 * administrator who can see they already chased somebody twice thinks before a
 * third. A column reading "0" on every row is noise that trains the eye to skip
 * it, so the count appears only once there is something to be restrained by.
 */
export function formatReminderSummary(state: AllowlistReminderState | undefined): string {
  if (!state || state.reminderCount < 1) return '';
  if (!state.lastReminderAt) return `${state.reminderCount} sent`;
  return `${state.reminderCount} sent · ${formatDateTime(state.lastReminderAt)}`;
}

interface ReminderCellProps {
  entry: AllowedEmailEntry;
  state: AllowlistReminderState | undefined;
  canSend: boolean;
  /** Never rejects: the panel owns the failure copy. */
  onSend: (entry: AllowedEmailEntry) => Promise<void>;
}

/**
 * What has been sent, and the control that sends another. The in-flight state is
 * LOCAL to the cell: each button is independently pressable, and a page-level
 * flag would freeze every row for one request.
 */
function ReminderCell({ entry, state, canSend, onSend }: ReminderCellProps) {
  const [sending, setSending] = useState(false);
  const summary = formatReminderSummary(state);

  const handleClick = useCallback(async () => {
    setSending(true);
    try {
      await onSend(entry);
    } finally {
      setSending(false);
    }
  }, [entry, onSend]);

  return (
    <Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: 'center' }}>
      {summary !== '' && (
        <Typography variant="body2" color="text.secondary" noWrap>
          {summary}
        </Typography>
      )}
      {canSend && (
        <Button
          size="small"
          variant="outlined"
          // Named after the row's own email: a screen reader moving through
          // twenty rows must be able to tell one "Send reminder" from another.
          aria-label={`Send reminder to ${entry.email}`}
          disabled={sending}
          startIcon={
            sending ? <CircularProgress size={14} aria-hidden /> : <SendIcon fontSize="small" />
          }
          onClick={() => void handleClick()}
        >
          Send reminder
        </Button>
      )}
    </Stack>
  );
}

export function AllowlistRemindersPanel() {
  const { entries, total, isLoading, error, fetchAllowlist } = useAllowlist();
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('allowlist:write');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<DataTableSortState | null>(null);
  const [reminders, setReminders] = useState<Record<string, AllowlistReminderState>>({});
  // Separate from the hook's `error` (LOADING the entries): a failed reminder is
  // about one named person, a failed counts read is about the whole page.
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);

  const sortField = asSortField(sort?.field);
  const sortDirection = sort?.direction;

  useEffect(() => {
    void fetchAllowlist({
      page: page + 1, // the table is zero-based, the API is one-based
      pageSize,
      search: search || undefined,
      status: 'pending',
      ...(sortField ? { sortBy: sortField, sortOrder: sortDirection } : {}),
    });
  }, [page, pageSize, search, sortField, sortDirection, fetchAllowlist]);

  // The counts of the rows on screen, joined by id. Re-read whenever the page of
  // entries changes; a sent reminder patches its own row instead (below).
  const entryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  useEffect(() => {
    let cancelled = false;
    setCountsError(null);
    getAllowlistReminders(entryIds)
      .then((rows) => {
        if (cancelled) return;
        setReminders(Object.fromEntries(rows.map((row) => [row.allowedEmailId, row])));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReminders({});
        setCountsError(
          err instanceof Error && err.message
            ? err.message
            : 'Failed to load reminder history',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [entryIds]);

  /**
   * NEVER REJECTS. `ReminderCell` awaits this to clear its own spinner, and an
   * unhandled rejection from a cell would leave that spinner turning forever.
   * The outcome is reported in the alerts above the table.
   */
  const handleSend = useCallback(async (entry: AllowedEmailEntry) => {
    setReminderError(null);
    setReminderNotice(null);
    try {
      const sent = await sendAllowlistReminder(entry.id);
      setReminders((current) => ({
        ...current,
        [entry.id]: {
          allowedEmailId: entry.id,
          reminderCount: sent.reminderCount,
          lastReminderAt: sent.lastReminderAt,
        },
      }));
      setReminderNotice(`Reminder sent to ${entry.email}.`);
    } catch (err) {
      setReminderError(reminderErrorMessage(err, entry.email));
    }
  }, []);

  const columns = useMemo<DataTableColumn<AllowedEmailEntry>[]>(
    () => [
      {
        // Row-unique, and therefore the row's accessible name.
        id: 'email',
        label: 'Email',
        priority: 'primary',
        sortable: true, // sortBy=email
        searchable: true, // ?search= is an `email contains` predicate
        hideable: false,
        minWidth: 240,
        flex: 1.4,
        value: (entry) => entry.email,
      },
      {
        id: 'addedAt',
        label: 'Added Date',
        priority: 'secondary',
        sortable: true, // sortBy=addedAt (the endpoint's default order)
        minWidth: 180,
        value: (entry) => formatDateTime(entry.addedAt),
      },
      {
        // Neither sortable nor filterable: the allowlist endpoint knows nothing
        // of reminders, so either control would be a live-looking affordance it
        // cannot answer.
        id: 'reminders',
        label: 'Reminders',
        priority: 'primary',
        minWidth: 300,
        flex: 1.2,
        value: (entry) => formatReminderSummary(reminders[entry.id]),
        render: (entry) => (
          <ReminderCell
            entry={entry}
            state={reminders[entry.id]}
            canSend={canWrite}
            onSend={handleSend}
          />
        ),
      },
    ],
    [reminders, canWrite, handleSend],
  );

  const emptyState = useMemo(
    () => (
      <Typography color="text.secondary">
        {search ? 'No pending invitations match your search' : 'No pending invitations'}
      </Typography>
    ),
    [search],
  );

  return (
    <Paper sx={{ width: '100%', p: 2 }}>
      <Typography variant="h6" component="h2">
        Invitation reminders
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Addresses that were allowed to sign in but have not done so yet. A reminder emails the
        invitation again.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {countsError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Reminder history is unavailable: {countsError}
        </Alert>
      )}
      {reminderError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setReminderError(null)}>
          {reminderError}
        </Alert>
      )}
      {reminderNotice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setReminderNotice(null)}>
          {reminderNotice}
        </Alert>
      )}

      <Box sx={{ minWidth: 0 }}>
        <DataTable<AllowedEmailEntry>
          tableId={REMINDERS_TABLE_ID}
          data-testid="admin-allowlist-reminders-table"
          ariaLabel="Pending invitations"
          columns={columns}
          rows={entries}
          rowId={(entry) => entry.id}
          loading={isLoading}
          emptyState={emptyState}
          disableExport
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
          quickSearch={{
            value: search,
            ariaLabel: 'Search by email',
            placeholder: 'Search by email',
            onChange: (next) => {
              setSearch(next);
              setPage(0);
            },
          }}
        />
      </Box>
    </Paper>
  );
}
