/**
 * Admin → Allowlist: the DataTable column contract (issue #67, epic #51).
 *
 * ## What `GET /api/allowlist` actually honours
 *
 * Read off `apps/api/src/allowlist/dto/allowlist-query.dto.ts` and
 * `allowlist.service.ts`:
 *
 *   | query param | accepts                               | column here |
 *   | ----------- | ------------------------------------- | ----------- |
 *   | `sortBy`    | `email` \| `addedAt` \| `claimedAt`   | `email`, `addedAt` |
 *   | `sortOrder` | `asc` \| `desc`                       | — |
 *   | `search`    | `email contains`, case-insensitive    | `email` (`searchable`) |
 *   | `status`    | `all` \| `pending` \| `claimed`       | `status` (`is` only) |
 *
 * `addedBy` and `notes` are display-only: the service builds its `where` from
 * `email` and `claimedById` and nothing else, so declaring either sortable or
 * filterable would put a live-looking control on the page that the endpoint
 * cannot answer.
 *
 * ## Why `status` is a real column and not `filterOnly`
 *
 * `DataTableColumn.filterOnly` exists for query parameters with no cell, and
 * `datatable/types.ts` cites this very endpoint's `status` as the motivating
 * example — because in the origin project the allowlist had no status CELL, and
 * a decorative column reading `pending` on all 25 rows is worse than none.
 *
 * Here the status IS drawn: it is a `primary` chip, one of the two facts that
 * identify an entry at a glance on a phone. Since the cell exists anyway, the
 * filter rides on the same declaration rather than shadowing it with a second,
 * invisible "Status" entry in the filter menu. `value` returns the chip's own
 * text; the page maps `enumValues` (`pending` / `claimed`) onto `?status=`.
 *
 * Only `is` is offered: the predicate behind `status` is a nullness test on
 * `claimedById` with exactly three settings (all / pending / claimed), so
 * `isNot` and `isAnyOf` would be operators with nothing extra behind them.
 */

import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Chip, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import type { DataTableColumn } from '../datatable';
import type { AllowlistSortField } from '../../services/api';
import type { AllowedEmailEntry } from '../../types';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'admin-allowlist';

/** Column ids that are also valid `sortBy` values. */
const SORTABLE_FIELDS: readonly AllowlistSortField[] = ['email', 'addedAt'];

export function asAllowlistSortField(
  field: string | undefined,
): AllowlistSortField | undefined {
  return SORTABLE_FIELDS.find((candidate) => candidate === field);
}

/** `true` once the invited address has completed a first sign-in. */
export function isClaimed(entry: AllowedEmailEntry): boolean {
  return Boolean(entry.claimedBy);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * The `Reminders` cell's scalar (issue #301) — empty string at zero.
 *
 * ⚠ HIDDEN AT ZERO, DELIBERATELY. This column exists as a restraint: an
 * administrator who can see they have already chased somebody twice thinks
 * before a third. A column reading "0" on every row is noise that trains the
 * eye to skip it, which is the opposite of what a restraint needs — so the
 * count appears only once there is something to be restrained by.
 *
 * `lastReminderAt` is non-null whenever the count is, but it is read
 * defensively anyway: a date is appended only if there is one, never the string
 * "Invalid Date".
 */
export function formatReminderSummary(entry: AllowedEmailEntry): string {
  if (entry.reminderCount < 1) return '';
  if (!entry.lastReminderAt) return `${entry.reminderCount} sent`;
  return `${entry.reminderCount} sent \u00b7 ${formatDateTime(entry.lastReminderAt)}`;
}

/**
 * Can this entry be reminded at all?
 *
 * A claimed entry cannot: the invitee signed in, which is precisely what
 * `claimedAt` records, and there is nobody left to remind.
 * `AllowlistService.sendReminder` answers that case **409**, so the button is
 * not merely unhelpful there — it is a control whose only possible outcome is
 * an error.
 */
export function canRemind(entry: AllowedEmailEntry): boolean {
  return !isClaimed(entry);
}

export interface ReminderCellProps {
  entry: AllowedEmailEntry;
  /**
   * Whether to offer the button — `allowlist:write`, the exact string
   * `allowlist.controller.ts` puts on `POST /:id/reminder`.
   */
  canSend: boolean;
  /** Never rejects: `AllowlistTable` owns the failure copy. */
  onSend: (entry: AllowedEmailEntry) => Promise<void> | void;
}

/**
 * The `Reminders` cell: what has already been sent, and the control that sends
 * another.
 *
 * ⚠ A CLAIMED ROW RENDERS NO BUTTON — NOT A DISABLED ONE. That is the opposite
 * of the `Remove` row action beside it, and the difference is real rather than
 * cosmetic. `Remove` is disabled on a claimed row because removing a claimed
 * entry is a thing an administrator might reasonably reach for and needs told
 * about, so the control stays discoverable and keeps its tooltip. A reminder to
 * somebody who has already signed in is not a refused action, it is an action
 * with no subject — there is nobody on the other end of it — so there is nothing
 * to explain and nothing to leave on screen.
 *
 * ⚠ THE OUTBOUND-EMAIL WARNING IS NOT REPEATED HERE, AND DOES NOT BLOCK THIS.
 * `AllowlistEmailWarning` already states, once and above the table, that a
 * deployment with no mail transport delivers no invitations — which covers
 * reminders for the same reason and in the same words. Repeating it per row
 * would be the same sentence twenty times, and disabling the button on it would
 * make a legitimate configuration look broken; see that component's own
 * "it warns, it never blocks" header.
 *
 * The in-flight state is LOCAL to this cell, not lifted into the page. Two
 * administrators' worth of rows are on screen and each button is independently
 * pressable; a single page-level "sending" flag would freeze all of them for
 * one request.
 */
export function ReminderCell({ entry, canSend, onSend }: ReminderCellProps) {
  const [sending, setSending] = useState(false);
  const summary = formatReminderSummary(entry);
  const showButton = canSend && canRemind(entry);

  const handleClick = useCallback(
    async (event: MouseEvent<HTMLElement>) => {
      // The grid row is itself clickable; without this the press would also
      // register as a row activation. `RowActionsCell` stops propagation for
      // the same reason.
      event.stopPropagation();
      setSending(true);
      try {
        await onSend(entry);
      } finally {
        setSending(false);
      }
    },
    [entry, onSend],
  );

  if (!summary && !showButton) {
    // Nothing sent and nothing offerable: an empty cell, not a placeholder
    // dash. A dash would read as "no data", and the truthful statement is that
    // this row has no reminder history at all.
    return null;
  }

  return (
    <Stack direction="row" spacing={1} sx={{ minWidth: 0, alignItems: 'center' }}>
      {summary !== '' && (
        <Typography variant="body2" color="text.secondary" noWrap>
          {summary}
        </Typography>
      )}
      {showButton && (
        <Tooltip title="Send reminder">
          <span>
            <IconButton
              size="small"
              // Named after the row's own email, the same disambiguation
              // `RowActionsCell` applies ("Remove for ada@example.com") — a
              // screen reader moving through twenty rows must be able to tell
              // one "Send reminder" from another.
              aria-label={`Send reminder to ${entry.email}`}
              disabled={sending}
              onClick={handleClick}
            >
              {sending ? (
                <CircularProgress size={16} aria-hidden />
              ) : (
                <SendIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Stack>
  );
}

/** What the page hands the column builder so the cell can act (issue #301). */
export interface AllowlistColumnOptions {
  /** `allowlist:write`. Without it the count still renders; the button does not. */
  canSendReminder: boolean;
  onSendReminder: (entry: AllowedEmailEntry) => Promise<void> | void;
}

export function buildAllowlistColumns({
  canSendReminder,
  onSendReminder,
}: AllowlistColumnOptions): DataTableColumn<AllowedEmailEntry>[] {
  return [
    {
      // Row-unique and therefore the row's accessible name — every checkbox,
      // row-action button and card is named after it. Pinned visible for the
      // same reason `admin-users` pins its email column.
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
      id: 'status',
      label: 'Status',
      priority: 'primary',
      filterable: ['is'], // ?status=pending|claimed
      filterType: 'enum',
      enumValues: [
        { value: 'pending', label: 'Pending' },
        { value: 'claimed', label: 'Claimed' },
      ],
      width: 120,
      value: (entry) => (isClaimed(entry) ? 'Claimed' : 'Pending'),
      render: (entry) =>
        isClaimed(entry) ? (
          <Chip label="Claimed" color="success" size="small" />
        ) : (
          <Chip label="Pending" color="warning" size="small" />
        ),
    },
    {
      id: 'addedBy',
      label: 'Added By',
      priority: 'secondary',
      minWidth: 200,
      // A null `addedById` is a seeded entry, not a missing one — the word
      // "System" is the correct scalar, so it goes in `value` and reaches the
      // CSV too, rather than being a render-only flourish.
      value: (entry) => (entry.addedBy ? entry.addedBy.email : 'System'),
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
      /**
       * Reminders (issue #301): how often this invitation has been chased, when
       * it was last chased, and the control that chases it again.
       *
       * ## Why this is a COLUMN and not a second row action
       *
       * `DataTableRowAction` was the obvious home — `Remove` already lives
       * there — and it is the wrong one twice over.
       *
       * It cannot carry the count. The restraint this feature exists to provide
       * is the NUMBER being visible next to the address, at rest, without
       * opening anything; an action is a control, it has no cell to write in.
       *
       * And a second action changes the `Remove` control for every row.
       * `RowActionsCell` renders one action as a bare icon button and collapses
       * two or more into an overflow menu, so adding this would bury `Remove`
       * behind a `MoreVert` press on a table where it is currently one click —
       * a regression in an unrelated control, paid for by a feature that did
       * not ask for it.
       *
       * `priority: 'secondary'` puts it in the card body on a phone rather than
       * in the headline, beside `Added By`/`Added Date`: it is history about the
       * invitation, not one of the two facts (`email`, `status`) that identify
       * it at a glance.
       *
       * Neither sortable nor filterable: `allowlistQuerySchema` accepts
       * `email`/`addedAt`/`claimedAt` for `sortBy` and builds its `where` from
       * `email` and `claimedById` only, so either control would be a live-looking
       * affordance the endpoint cannot answer — the same rule `addedBy` and
       * `notes` already follow above.
       */
      id: 'reminders',
      label: 'Reminders',
      priority: 'secondary',
      minWidth: 240,
      flex: 1,
      // The scalar the CSV export and the accessible row name read. Empty at
      // zero, exactly like the cell.
      value: (entry) => formatReminderSummary(entry),
      render: (entry) => (
        <ReminderCell
          entry={entry}
          canSend={canSendReminder}
          onSend={onSendReminder}
        />
      ),
    },
    {
      /**
       * `truncate` rather than a `maxWidth` on a `<Typography>`: notes run to
       * 500 characters (`addEmailSchema`), and a wrapping cell would set the
       * height of every row in the grid to suit one entry. The full text stays
       * reachable through the truncation tooltip, and the card renderer folds
       * this column into its expandable region where wrapping is free.
       */
      id: 'notes',
      label: 'Notes',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      flex: 1,
      value: (entry) => entry.notes,
      render: (entry) =>
        entry.notes ? (
          <Typography variant="body2" noWrap>
            {entry.notes}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            -
          </Typography>
        ),
    },
  ];
}
