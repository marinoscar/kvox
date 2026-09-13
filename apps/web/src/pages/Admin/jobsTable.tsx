/**
 * Admin → Operations → Jobs: the DataTable column contract (issue #266, epic #254).
 *
 * A sibling module rather than columns inlined in `JobsPage.tsx`, for the
 * reason every table in this repo follows (`components/admin/userListColumns.tsx`
 * is the model): the column list is the table's PUBLIC shape — what a test, a
 * CSV export and both renderers read — while the page is the state that feeds
 * it. Keeping them apart lets a test assert the contract without mounting a
 * page and mocking its fetch layer.
 *
 * =============================================================================
 * WHAT `GET /api/admin/jobs` ACTUALLY HONOURS
 * =============================================================================
 *
 * `sortable` and `filterable` are declared ONLY where the endpoint can serve
 * them. Read off `apps/api/src/jobs/dto/job-list-query.dto.ts` and
 * `job-admin.service.ts`'s `buildListWhere`:
 *
 *   | query param       | accepts                            | column here        |
 *   | ----------------- | ---------------------------------- | ------------------ |
 *   | `status`          | pending/running/succeeded/failed    | `status`, `is`     |
 *   | `type`            | one machine type key                | `type`, `is`       |
 *   | `scheduled`       | `'true'` (overrides `status`)       | `scheduled`, `is`  |
 *   | `processedWithin` | 4h/24h/7d/30d/all                   | `processedWithin`  |
 *   | `subjectType`     | one string                          | — (see below)      |
 *   | `subjectId`       | one string                          | — (see below)      |
 *   | `page`/`pageSize` | 1-based, pageSize max 100           | pagination         |
 *
 * NO COLUMN IS `sortable`, AND THAT IS NOT AN OVERSIGHT. The endpoint orders
 * by `createdAt DESC` and offers no `sortBy` at all — `job-admin.service.ts`
 * says why: a sortable column set needs an index per column to stay usable at
 * the sizes a queue reaches. A sortable header the server cannot honour would
 * either silently do nothing or 400, and both are worse than a table that is
 * honestly newest-first. `createdAt` is therefore a plain column, and the page
 * says "newest first" where the user can read it.
 *
 * NO QUICK SEARCH EITHER: there is no free-text parameter. `subjectType` and
 * `subjectId` are exact-match, and an exact-match box that looks like a search
 * field is the same lie in a different control, so they are left off this
 * table entirely until something in the app can supply a subject to filter by.
 *
 * =============================================================================
 * `scheduled` AND `processedWithin` ARE `filterOnly`
 * =============================================================================
 *
 * Both are query parameters with no cell worth printing.
 *
 *   * `scheduled` is a predicate over TWO fields (`status = 'pending'` AND
 *     `scheduledFor > now`), not a stored boolean, and the fact it selects is
 *     already visible in the `scheduledFor` column of the rows it returns.
 *   * `processedWithin` is a window over `COALESCE(finishedAt, createdAt)` —
 *     a bound on the query, not a property of a row. Printing "24h" on every
 *     row would say nothing.
 *
 * This is exactly the case `DataTableColumn.filterOnly` documents: a real
 * endpoint's query parameters are not always a subset of its response's
 * columns, and the alternatives are a bespoke control beside the table (which
 * the shared filter bar exists to delete) or a decorative column whose cells
 * repeat one word.
 *
 * `scheduled` offers ONE enum value, not two. `scheduled=false` is defined by
 * the API to mean the same as omitting the parameter, so a "No" option would
 * be a control that changes nothing — and removing the filter already
 * expresses it.
 */

import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../../components/datatable';
import { JOB_STATUSES } from '../../services/jobs';
import type { Job, JobStatusName, ProcessedWithin } from '../../services/jobs';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'admin-jobs';

/** Column ids the page reads filters out of. Named so a typo cannot drift. */
export const STATUS_COLUMN_ID = 'status';
export const TYPE_COLUMN_ID = 'type';
export const SCHEDULED_COLUMN_ID = 'scheduled';
export const PROCESSED_WITHIN_COLUMN_ID = 'processedWithin';

/** The single value the `scheduled` filter offers — see the module header. */
export const SCHEDULED_FILTER_VALUE = 'true';

const STATUS_ENUM_VALUES = [
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
] satisfies { value: JobStatusName; label: string }[];

/**
 * `all` is deliberately absent: it is the API's default, and the page sends
 * nothing when the filter is absent. An "All time" option would be a chip
 * describing a constraint that is not applied.
 */
const PROCESSED_WITHIN_ENUM_VALUES = [
  { value: '4h', label: 'Last 4 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
] satisfies { value: ProcessedWithin; label: string }[];

/** MUI `Chip` colours per status. `default` for pending — it is not a state to alarm anyone. */
const STATUS_CHIP_COLOR: Record<JobStatusName, 'default' | 'info' | 'success' | 'error'> = {
  pending: 'default',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
};

// =============================================================================
// Formatting
// =============================================================================

/**
 * A duration, in the largest unit that still says something.
 *
 * Exported because `JobInsightsPage` renders the same milliseconds — averages,
 * percentiles and ETAs — and two formatters would drift into a page reading
 * "1500ms" beside one reading "1.5s" for the same number.
 *
 * `null` renders as an em dash rather than "0 ms": the API's nullable
 * durations mean "no succeeded jobs to measure", and printing a zero would
 * state a measurement that was never taken.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${String(remainingMinutes).padStart(2, '0')}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** A timestamp in the viewer's locale, or an em dash when the API sent `null`. */
export function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** The first 8 characters of a UUID — enough to tell two rows apart by eye. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// =============================================================================
// Reading the filter model
// =============================================================================

/**
 * Read a single-operand `is` filter out of the model as a plain STRING.
 *
 * Returning a scalar (not the filter object) is what lets a refetch effect
 * depend on it directly — an effect keyed on the filter array would refetch
 * forever, since the array is rebuilt on every change.
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
export function asJobStatus(value: string | undefined): JobStatusName | undefined {
  return JOB_STATUSES.find((candidate) => candidate === value);
}

/** Narrow a filter value to a `processedWithin` the endpoint accepts. */
export function asProcessedWithin(value: string | undefined): ProcessedWithin | undefined {
  return PROCESSED_WITHIN_ENUM_VALUES.map((entry) => entry.value).find(
    (candidate) => candidate === value,
  );
}

/**
 * Keep `scheduled` and `status` mutually exclusive, favouring whichever the
 * user just added.
 *
 * THE SERVER ALREADY RESOLVES THE CONTRADICTION — `scheduled=true` overrides
 * `status` outright (`buildListWhere`) — so this is not about preventing a bad
 * request. It is about not LYING in the filter bar: with both chips up, a user
 * filtering "failed" and "in backoff" would read a chip saying `Status is
 * Failed` above a table containing nothing but pending rows, and would
 * reasonably conclude the table is broken. Only one of the two constraints was
 * ever applied; only one of them may be displayed.
 *
 * The one that survives is the one just added, because that is the user's most
 * recent statement of intent — silently discarding the new filter and keeping
 * the old one is the version of this that feels like a broken control.
 *
 * A pure function over (next, previous) so the rule is asserted directly by a
 * test rather than through a rendered filter menu.
 */
export function enforceExclusiveJobFilters(
  next: DataTableFilterModel,
  previous: DataTableFilterModel,
): DataTableFilterModel {
  const has = (model: DataTableFilterModel, columnId: string) =>
    model.some((filter) => filter.columnId === columnId);

  const nextHasScheduled = has(next, SCHEDULED_COLUMN_ID);
  const nextHasStatus = has(next, STATUS_COLUMN_ID);
  if (!nextHasScheduled || !nextHasStatus) return next;

  // Both present: drop whichever was ALREADY there before this change.
  const scheduledIsNew = !has(previous, SCHEDULED_COLUMN_ID);
  const dropColumnId = scheduledIsNew ? STATUS_COLUMN_ID : SCHEDULED_COLUMN_ID;
  return next.filter((filter) => filter.columnId !== dropColumnId);
}

// =============================================================================
// The columns
// =============================================================================

/**
 * @param typeOptions the job types this deployment actually has rows for,
 * taken from `GET /stats`'s `byType` (machine `type` as the value, the API's
 * own `label` as the label). Derived from the data rather than hardcoded: the
 * handler registry is a server-side concern, and a hardcoded list here would
 * offer filters for types that have never run and omit the ones that have.
 */
export function buildJobColumns(
  typeOptions: { value: string; label: string }[],
): DataTableColumn<Job>[] {
  return [
    {
      /**
       * The row-unique `primary` column, and therefore the row's ACCESSIBLE
       * NAME: `rowAccessibleName()` takes the first visible `primary` column's
       * scalar and names every row-action button and every card after it.
       *
       * The scalar carries the short id alongside the label FOR THAT REASON. A
       * queue routinely holds dozens of rows of one type, so a scalar of
       * `"Thumbnail"` alone would name a whole screen of buttons "Retry
       * Thumbnail" with no way to tell which one. `hideable: false` for the
       * same reason: hiding this column would rename every control on the page
       * after whichever column happened to be `primary` next.
       */
      id: TYPE_COLUMN_ID,
      label: 'Job',
      priority: 'primary',
      hideable: false,
      filterable: ['is'], // ?type=<machine key>
      filterType: 'enum',
      enumValues: typeOptions,
      minWidth: 220,
      flex: 1.2,
      value: (job) => `${job.typeLabel} (${shortId(job.id)})`,
      render: (job) => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {job.typeLabel}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {shortId(job.id)}
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
      value: (job) => job.status,
      render: (job) => (
        <Chip label={job.status} size="small" color={STATUS_CHIP_COLOR[job.status]} />
      ),
    },
    {
      // See the module header: a query bound, not a row property.
      id: SCHEDULED_COLUMN_ID,
      label: 'Backoff',
      priority: 'detail',
      filterOnly: true,
      filterable: ['is'], // ?scheduled=true
      filterType: 'enum',
      enumValues: [{ value: SCHEDULED_FILTER_VALUE, label: 'Waiting out a backoff' }],
    },
    {
      id: PROCESSED_WITHIN_COLUMN_ID,
      label: 'Last activity',
      priority: 'detail',
      filterOnly: true,
      filterable: ['is'], // ?processedWithin=
      filterType: 'enum',
      enumValues: PROCESSED_WITHIN_ENUM_VALUES,
    },
    {
      /**
       * Attempts STARTED, charged at claim time — so a running job on its
       * first attempt already reads `1`, and a pending one reads `0`. Rendered
       * as the raw number the API sends rather than "0 of 3": the maximum is a
       * per-handler setting this response does not carry, and inventing a
       * denominator would be the UI stating a limit it cannot know.
       */
      id: 'attempts',
      label: 'Attempts',
      priority: 'secondary',
      align: 'right',
      width: 110,
      value: (job) => job.attempts,
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'secondary',
      minWidth: 180,
      value: (job) => formatDateTime(job.createdAt),
    },
    {
      /**
       * Only ever set on a `pending` row in backoff, which is precisely what
       * the `scheduled` filter selects — so this column is where that filter's
       * result becomes visible, and why the filter needs no cell of its own.
       */
      id: 'scheduledFor',
      label: 'Runs after',
      priority: 'secondary',
      minWidth: 180,
      value: (job) => formatDateTime(job.scheduledFor),
    },
    {
      id: 'startedAt',
      label: 'Started',
      priority: 'detail',
      minWidth: 180,
      value: (job) => formatDateTime(job.startedAt),
    },
    {
      id: 'finishedAt',
      label: 'Finished',
      priority: 'detail',
      minWidth: 180,
      value: (job) => formatDateTime(job.finishedAt),
    },
    {
      /**
       * `truncate`, because a stack trace tail runs to hundreds of characters
       * and wrapping it would make one failed row taller than the rest of the
       * page. The full text is in the tooltip and in the CSV.
       */
      id: 'lastError',
      label: 'Last error',
      priority: 'detail',
      truncate: true,
      minWidth: 240,
      value: (job) => job.lastError ?? '',
    },
    {
      /**
       * The two subject fields as ONE column. They are meaningless apart — an
       * id with no type does not say what it identifies — and the endpoint
       * treats them as a pair too.
       */
      id: 'subject',
      label: 'Subject',
      priority: 'detail',
      minWidth: 200,
      value: (job) =>
        job.subjectType && job.subjectId
          ? `${job.subjectType}:${job.subjectId}`
          : (job.subjectType ?? job.subjectId ?? ''),
    },
    {
      id: 'executor',
      label: 'Executor',
      priority: 'detail',
      minWidth: 160,
      value: (job) => job.executor ?? '',
      render: (job) =>
        job.executor ? (
          <Tooltip title={job.leaseExpiresAt ? `Lease until ${formatDateTime(job.leaseExpiresAt)}` : ''}>
            <Typography variant="body2" noWrap>
              {job.executor}
            </Typography>
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.secondary">
            —
          </Typography>
        ),
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (job) => job.id,
    },
  ];
}
