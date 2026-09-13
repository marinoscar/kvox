/**
 * Admin → Operations → Broadcasts: the DataTable column contract (issue #325,
 * epic #319).
 *
 * A sibling module rather than columns inlined in `BroadcastsPage.tsx`, for the
 * reason every table in this repo follows (`jobsTable.tsx` and
 * `components/admin/userListColumns.tsx` are the models): the column list is
 * the table's PUBLIC shape — what a test, a CSV export and both renderers read
 * — while the page is the state that feeds it. Keeping them apart lets a test
 * assert the contract without mounting a page and mocking its fetch layer.
 *
 * =============================================================================
 * WHAT `GET /api/admin/broadcasts` ACTUALLY HONOURS
 * =============================================================================
 *
 * Read off `apps/api/src/notifications/broadcasts/dto/broadcast-list-query.dto.ts`
 * and `broadcasts.service.ts`'s `list`:
 *
 *   | query param       | accepts                                  | column here    |
 *   | ----------------- | ---------------------------------------- | -------------- |
 *   | `status`          | draft/scheduled/sending/sent/canceled/failed | `status`, `is` |
 *   | `page`/`pageSize` | 1-based, pageSize max 100                | pagination     |
 *
 * That is the whole query surface. NO COLUMN IS `sortable`: the service orders
 * by `createdAt DESC` and offers no `sortBy`, so a sortable header would either
 * silently do nothing or 400 — the same reasoning `jobsTable.tsx` gives at
 * length. There is no quick search either, for the same reason: no free-text
 * parameter exists, and a search box that filters only the current page is a
 * control that lies about its scope.
 *
 * =============================================================================
 * `draft` IS OFFERED AS A FILTER EVEN THOUGH THE API NEVER WRITES ONE
 * =============================================================================
 *
 * `create` stamps `scheduled` unconditionally; nothing in this epic produces a
 * `draft` row. It is still in the enum because the STATUS COLUMN can render one
 * — the database column allows it, and a future compose-and-save-for-later
 * would populate it — and a filter that omits a status the table can display is
 * a filter that silently cannot reach some of its own rows.
 *
 * =============================================================================
 * IMPORTANCE IS DERIVED FROM `eventKey`, BECAUSE THERE IS NO `critical` COLUMN
 * =============================================================================
 *
 * The API takes `critical: boolean` on create and DERIVES the event key from
 * it (`admin.broadcast` vs `admin.broadcast_critical`), then stores only the
 * key. So "can recipients mute this?" is answered by reading the key back, and
 * `isCriticalBroadcast` below is the single place that reading happens — the
 * page, the detail dialog and this table all call it rather than each writing
 * their own `=== 'admin.broadcast_critical'`.
 */

import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../../components/datatable';
import { BROADCAST_STATUSES } from '../../services/broadcasts';
import type { Broadcast, BroadcastStatusName } from '../../services/broadcasts';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'broadcasts';

/** Column ids the page reads filters out of. Named so a typo cannot drift. */
export const TITLE_COLUMN_ID = 'title';
export const STATUS_COLUMN_ID = 'status';

/**
 * The event key the API derives for a broadcast recipients may not mute.
 * `admin.broadcast_critical` in `notifications/broadcasts/broadcasts.service.ts`.
 */
export const CRITICAL_EVENT_KEY = 'admin.broadcast_critical';

/** Whether recipients can mute this broadcast. See the module header. */
export function isCriticalBroadcast(broadcast: Pick<Broadcast, 'eventKey'>): boolean {
  return broadcast.eventKey === CRITICAL_EVENT_KEY;
}

const STATUS_ENUM_VALUES = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'failed', label: 'Failed' },
] satisfies { value: BroadcastStatusName; label: string }[];

/**
 * MUI `Chip` colours per status.
 *
 * `default` for `draft` and `canceled` — neither is a state to alarm anyone,
 * and a canceled announcement is a decision that was taken deliberately rather
 * than a fault. `warning` for `sending` because it is the one status during
 * which an operator's options are shrinking by the second.
 */
export const STATUS_CHIP_COLOR: Record<
  BroadcastStatusName,
  'default' | 'info' | 'warning' | 'success' | 'error'
> = {
  draft: 'default',
  scheduled: 'info',
  sending: 'warning',
  sent: 'success',
  canceled: 'default',
  failed: 'error',
};

/** Channel keys as the API stores them → what an administrator calls them. */
const CHANNEL_LABELS: Record<string, string> = {
  browser: 'In-app',
  email: 'Email',
  push: 'Push',
};

/**
 * `browser` is labelled "In-app", everywhere.
 *
 * The API's channel is named for the mechanism; the administrator's question is
 * about the destination. In this application the `browser` channel is what
 * writes the durable `notifications` row the bell renders — the OS toast is a
 * secondary effect of the same channel, and can be off deployment-wide while
 * the row is still written. Calling it "Browser" in the composer would suggest
 * that turning the kill switch off removes this channel, which is exactly
 * wrong.
 */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** A timestamp in the viewer's locale, or an em dash when the API sent `null`. */
export function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** The first 8 characters of a UUID — enough to tell two rows apart by eye. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * `dispatched / targeted`, as a scalar.
 *
 * The denominator is `—` until the fan-out freezes the audience and counts it,
 * because until then there genuinely is no target: `recipientsTargeted` is
 * `null` on every `scheduled` row. Printing `0 / 0` would state a measurement
 * that was never taken, and — worse here than on the jobs page — would read as
 * "this broadcast reaches nobody".
 */
export function formatProgress(broadcast: Pick<Broadcast, 'recipientsDispatched' | 'recipientsTargeted'>): string {
  const targeted = broadcast.recipientsTargeted;
  return `${broadcast.recipientsDispatched} / ${targeted === null ? '—' : targeted}`;
}

/**
 * Read a single-operand `is` filter out of the model as a plain STRING.
 *
 * Returning a scalar (not the filter object) is what lets a refetch effect
 * depend on it directly — an effect keyed on the filter array would refetch
 * forever, since the array is rebuilt on every change. Lifted from
 * `jobsTable.tsx`, which explains the same trap.
 */
export function readIsFilter(
  filters: DataTableFilterModel,
  columnId: string,
): string | undefined {
  const found = filters.find(
    (filter) => filter.columnId === columnId && filter.operator === 'is',
  );
  return typeof found?.value === 'string' && found.value ? found.value : undefined;
}

/** Narrow a stored/URL-supplied filter value to a status the endpoint accepts. */
export function asBroadcastStatus(value: string | undefined): BroadcastStatusName | undefined {
  return BROADCAST_STATUSES.find((candidate) => candidate === value);
}

// =============================================================================
// The columns
// =============================================================================

export function buildBroadcastColumns(): DataTableColumn<Broadcast>[] {
  return [
    {
      /**
       * The row-unique `primary` column, and therefore the row's ACCESSIBLE
       * NAME: `rowAccessibleName()` takes the first visible `primary` column's
       * scalar and names every row-action button and every card after it.
       *
       * THE SHORT ID IS IN THE SCALAR FOR THAT REASON, exactly as
       * `jobsTable.tsx` does it. A title alone is NOT row-unique — "Planned
       * maintenance tonight" is precisely the announcement an operator sends
       * three weeks running — so a scalar of the title alone would name several
       * "Cancel Planned maintenance tonight" buttons on one screen with no way
       * to tell which is which. `hideable: false` for the same reason: hiding
       * this column would rename every control on the page after whichever
       * column happened to be `primary` next.
       */
      id: TITLE_COLUMN_ID,
      label: 'Title',
      priority: 'primary',
      hideable: false,
      minWidth: 240,
      flex: 1.4,
      value: (broadcast) => `${broadcast.title} (${shortId(broadcast.id)})`,
      render: (broadcast) => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {broadcast.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {shortId(broadcast.id)}
          </Typography>
        </Stack>
      ),
    },
    {
      id: STATUS_COLUMN_ID,
      label: 'Status',
      priority: 'primary',
      filterable: ['is'], // ?status=
      filterType: 'enum',
      enumValues: STATUS_ENUM_VALUES,
      width: 130,
      value: (broadcast) => broadcast.status,
      render: (broadcast) => (
        <Chip
          label={broadcast.status}
          size="small"
          color={STATUS_CHIP_COLOR[broadcast.status]}
        />
      ),
    },
    {
      /**
       * Two words, not a boolean. "Cannot be muted" is the fact an operator
       * actually needs — a `true` under a header reading "Critical" makes them
       * work out what critical means to this system, and the answer ("the
       * recipient's own preference is bypassed") is the whole difference
       * between the two event keys.
       */
      id: 'importance',
      label: 'Importance',
      priority: 'secondary',
      width: 150,
      value: (broadcast) => (isCriticalBroadcast(broadcast) ? 'Cannot be muted' : 'Normal'),
      render: (broadcast) =>
        isCriticalBroadcast(broadcast) ? (
          <Tooltip title="Sent as admin.broadcast_critical — recipients' notification preferences are bypassed.">
            <Chip label="Cannot be muted" size="small" color="warning" variant="outlined" />
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Normal
          </Typography>
        ),
    },
    {
      /**
       * The channels this send was NARROWED to, which is not the same as the
       * channels each recipient got: the API intersects this set with the admin
       * policy and then with each user's preferences. So this column says what
       * was asked for, and the detail dialog's approximate breakdown says what
       * was attempted.
       */
      id: 'channels',
      label: 'Channels',
      priority: 'secondary',
      minWidth: 180,
      value: (broadcast) => broadcast.channels.map(channelLabel).join(', '),
      render: (broadcast) => (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {broadcast.channels.map((channel) => (
            <Chip key={channel} label={channelLabel(channel)} size="small" variant="outlined" />
          ))}
        </Stack>
      ),
    },
    {
      id: 'scheduledFor',
      label: 'Scheduled for',
      priority: 'secondary',
      minWidth: 180,
      // `null` means "immediately" rather than "unknown", and an em dash would
      // be read as the latter. The two are genuinely different intentions and
      // the column is the only place either is visible.
      value: (broadcast) =>
        broadcast.scheduledFor ? formatDateTime(broadcast.scheduledFor) : 'Immediately',
    },
    {
      id: 'progress',
      label: 'Progress',
      priority: 'secondary',
      align: 'right',
      width: 140,
      value: (broadcast) => formatProgress(broadcast),
    },
    {
      id: 'finishedAt',
      label: 'Sent at',
      priority: 'secondary',
      minWidth: 180,
      value: (broadcast) => formatDateTime(broadcast.finishedAt),
    },
    {
      /**
       * The API returns `createdById` and nothing else — there is no join to a
       * user on this response — so this column prints the id it was given
       * rather than inventing a name. `System` for `null`, which is what a row
       * created by something other than a signed-in administrator would carry.
       */
      id: 'createdById',
      label: 'Created by',
      priority: 'detail',
      minWidth: 160,
      value: (broadcast) =>
        broadcast.createdById ? shortId(broadcast.createdById) : 'System',
      render: (broadcast) =>
        broadcast.createdById ? (
          <Tooltip title={broadcast.createdById}>
            <Typography variant="body2" noWrap>
              {shortId(broadcast.createdById)}
            </Typography>
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.secondary">
            System
          </Typography>
        ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      minWidth: 180,
      value: (broadcast) => formatDateTime(broadcast.createdAt),
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'detail',
      minWidth: 180,
      value: (broadcast) => formatDateTime(broadcast.startedAt),
    },
    {
      id: 'canceledAt',
      label: 'Canceled',
      priority: 'detail',
      minWidth: 180,
      value: (broadcast) => formatDateTime(broadcast.canceledAt),
    },
    {
      /**
       * `truncate`, because a fan-out failure carries a handler's message and
       * would otherwise make one failed row taller than the rest of the page.
       * The full text is in the detail dialog and in the CSV.
       */
      id: 'lastError',
      label: 'Last error',
      priority: 'detail',
      truncate: true,
      minWidth: 240,
      value: (broadcast) => broadcast.lastError ?? '',
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (broadcast) => broadcast.id,
    },
  ];
}
