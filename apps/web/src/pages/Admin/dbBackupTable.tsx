/**
 * Admin → Operations → Database Backup: the DataTable column contract
 * (issue #287, epic #254).
 *
 * A sibling module rather than columns inlined in `DbBackupPage.tsx`, for the
 * reason every table in this repo follows (`jobsTable.tsx` and
 * `workersTable.tsx` are the models): the column list is the table's PUBLIC
 * shape — what a test, a CSV export and both renderers read — while the page is
 * the state that feeds it. Keeping them apart lets a test assert the contract
 * without mounting a page and mocking its fetch layer.
 *
 * =============================================================================
 * WHAT `GET /api/admin/db-backup/runs` ACTUALLY HONOURS
 * =============================================================================
 *
 * `page`, `pageSize` (max 100), `status` and `trigger`. That is the whole query
 * (`db-backup-list-query.dto.ts`), so `filterable` is declared on exactly those
 * two columns and on no others, and nothing here is `sortable`: the endpoint
 * orders newest-first and offers no `sortBy`, so a sortable header would either
 * silently do nothing or 400. Sorting and filtering in this DataTable are
 * ALWAYS server-side (`types.ts` says so twice), so a control the server cannot
 * honour could only be answered by filtering `rows` in the page — which the
 * contract forbids. There is no free-text parameter either, so no quick search.
 *
 * =============================================================================
 * ⚠ `stale` IS NOT `failed`, AND THE TABLE MUST NOT LET THEM LOOK ALIKE
 * =============================================================================
 *
 * A `failed` run is a known ending: the dump or the upload errored, the partial
 * archive was deleted, and `lastError` says what happened. A `stale` run is an
 * UNKNOWN ending — the run stopped heartbeating and the sweep released its slot
 * — so nobody can say whether its archive exists, whether it is complete, or
 * whether the process that was writing it is still alive somewhere. Those are
 * different problems with different next steps, and an operator scanning this
 * table during an incident has to be able to tell them apart at a glance.
 *
 * So `stale` gets its own treatment and it differs from every other status by
 * MORE THAN HUE — filled warning palette, a warning triangle, and the word
 * "Stale" — the same rule `workersTable.tsx` applies to a stale node, and for
 * the same accessibility reason: colour alone fails anyone who cannot
 * distinguish these hues, and a screenshotted backup table is a common enough
 * artefact that "it's fine, it's green" is not a safe assumption.
 *
 * =============================================================================
 * THE BYTE COLUMNS TAKE STRINGS AND NEVER WIDEN THEM
 * =============================================================================
 *
 * `sizeBytes` and `bytesWritten` arrive as decimal strings because they are
 * `BigInt` columns (see `services/dbBackup.ts`). `formatBytes` takes the string
 * and produces the label; nothing here stores a number back onto a run. A run
 * that is still writing shows its LIVE `bytesWritten` instead of a final size
 * of zero, which is the only honest thing to print while a dump is streaming —
 * `sizeBytes` is not set until the archive is closed.
 */

import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import SyncIcon from '@mui/icons-material/Sync';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Box, Chip, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';
import type { DataTableColumn, DataTableFilterModel } from '../../components/datatable';
import {
  DB_BACKUP_RUN_STATUSES,
  DB_BACKUP_TRIGGERS,
  isBackupRunActive,
  parseByteCount,
} from '../../services/dbBackup';
import type {
  DbBackupRun,
  DbBackupRunStatus,
  DbBackupTrigger,
  RestoreStatus,
} from '../../services/dbBackup';
// Imported from the sibling table modules rather than re-implemented. Both are
// three-line functions, which is exactly why copying them is tempting and
// wrong: two formatters drift into one page reading "1500ms" beside another
// reading "1.5s" for the same number, and an operator who has just come from
// the jobs page must not have to re-read the timestamp format.
import { formatDateTime, formatDuration, shortId } from './jobsTable';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'admin-db-backup-runs';

/** Column ids the page reads filters out of. Named so a typo cannot drift. */
export const STATUS_COLUMN_ID = 'status';
export const TRIGGER_COLUMN_ID = 'trigger';

const STATUS_ENUM_VALUES = [
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'stale', label: 'Stale' },
] satisfies { value: DbBackupRunStatus; label: string }[];

const TRIGGER_ENUM_VALUES = [
  { value: 'manual', label: 'Manual' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'pre_restore', label: 'Before a restore' },
] satisfies { value: DbBackupTrigger; label: string }[];

// =============================================================================
// Chip vocabulary
// =============================================================================

/** How one state is drawn: a word, a colour, a fill, and an icon. */
interface ChipSpec {
  label: string;
  color: ChipProps['color'];
  variant: ChipProps['variant'];
  Icon: typeof CheckCircleIcon;
}

/**
 * One chip per run status. Keys are `DatabaseBackupRunDto.status`'s enum,
 * exactly.
 *
 * `stale` is the only WARNING-palette chip and `failed` the only ERROR one, so
 * "nobody knows how this ended" and "this ended badly" never read as the same
 * row — see the module header for why that distinction is load-bearing rather
 * than decorative.
 */
export const RUN_STATUS_CHIPS: Record<DbBackupRunStatus, ChipSpec> = {
  pending: {
    label: 'Pending',
    color: 'default',
    variant: 'outlined',
    Icon: HourglassEmptyIcon,
  },
  running: {
    label: 'Running',
    color: 'info',
    variant: 'outlined',
    Icon: SyncIcon,
  },
  completed: {
    label: 'Completed',
    color: 'success',
    variant: 'filled',
    Icon: CheckCircleIcon,
  },
  failed: {
    label: 'Failed',
    color: 'error',
    variant: 'filled',
    Icon: ErrorOutlineIcon,
  },
  stale: {
    label: 'Stale',
    color: 'warning',
    variant: 'filled',
    Icon: WarningAmberIcon,
  },
};

/**
 * What caused the run.
 *
 * `pre_restore` is spelled "Before a restore" rather than left as the wire
 * value: it is the safety dump the restore path took on its own initiative, it
 * is the archive a rollback falls back to, and an operator deciding what to
 * delete must not read it as a backup somebody scheduled.
 */
export const TRIGGER_LABELS: Record<DbBackupTrigger, string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  pre_restore: 'Before a restore',
};

/** The restore audit's own vocabulary, for the runs that carry one. */
export const RESTORE_STATUS_LABELS: Record<RestoreStatus, string> = {
  restoring: 'Restoring',
  verifying: 'Verifying',
  swapping: 'Swapping',
  completed: 'Restored',
  failed: 'Restore failed',
  rolled_back: 'Rolled back',
};

/**
 * Draw one state chip.
 *
 * `testId` is passed through so a test can name the exact chip on a given row
 * rather than searching the page for a word that appears in more than one
 * vocabulary — "Failed" is both a run status and a restore status, by design.
 */
function stateChip(spec: ChipSpec, testId: string) {
  const { Icon } = spec;
  return (
    <Chip
      size="small"
      label={spec.label}
      color={spec.color}
      variant={spec.variant}
      // The icon carries the same information as the colour, for the same
      // reason every status chip in this app does.
      icon={<Icon fontSize="small" />}
      data-testid={testId}
    />
  );
}

// =============================================================================
// Formatting
// =============================================================================

// Up to exabytes, which is past anything a `pg_dump` will ever be — but
// `sizeBytes` is a signed 64-bit column, so a corrupt or synthetic value can be
// larger than petabytes, and a scale that ran out would print "9223 PB" instead
// of a number a reader can recognise as nonsense.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/**
 * A byte count, from the DECIMAL STRING the API sends, in the largest unit that
 * still says something.
 *
 * Powers of 1000 and the SI-style short names, matching what `pg_dump` output
 * sizes are quoted in everywhere else an operator will see them (a storage
 * console, an invoice). Consistency with the numbers next to it beats
 * pedantry about kibibytes.
 *
 * An unreadable or absent value renders as an em dash rather than "0 B",
 * because `freeDiskBytes` is genuinely `null` on many hosts and a confident
 * zero there would read as "the disk is full".
 */
export function formatBytes(value: string | null | undefined): string {
  const bytes = parseByteCount(value);
  if (bytes === null) return '—';
  if (bytes < 1000) return `${bytes} B`;

  let scaled = bytes;
  let unit = 0;
  while (scaled >= 1000 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  // One decimal below 10, none above: "1.4 GB" is useful, "847.3 MB" is noise.
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${BYTE_UNITS[unit]}`;
}

/**
 * How long a run took, or how long it has been going.
 *
 * @param now the instant an unfinished run is measured against, passed in for
 * the same one-render-one-moment reason `buildWorkerNodeColumns` takes it: a
 * page of rows each calling `new Date()` can print two runs that started in the
 * same second as different durations.
 *
 * A run that never started has no duration — an em dash, not a zero, because
 * zero would state a measurement that was never taken. `formatDuration` is the
 * jobs page's own formatter, reused rather than copied.
 */
export function formatRunDuration(
  run: Pick<DbBackupRun, 'startedAt' | 'finishedAt'>,
  now: Date,
): string {
  if (!run.startedAt) return '—';
  const started = new Date(run.startedAt).getTime();
  const ended = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return '—';
  return formatDuration(Math.max(0, ended - started));
}

/**
 * What to print in the size column.
 *
 * A run that is still writing has `sizeBytes` of `'0'` — the archive is not
 * closed — so its LIVE `bytesWritten` is what says something. Printing "0 B"
 * for a dump that is forty minutes in and has streamed eleven gigabytes is the
 * single most misleading thing this table could do.
 */
export function formatRunSize(
  run: Pick<DbBackupRun, 'status' | 'sizeBytes' | 'bytesWritten'>,
): string {
  if (isBackupRunActive(run)) return `${formatBytes(run.bytesWritten)} written`;
  return formatBytes(run.sizeBytes);
}

/** The first 12 characters of a sha256 — enough to compare against a storage console by eye. */
export function shortChecksum(checksum: string | null): string {
  return checksum ? `${checksum.slice(0, 12)}…` : '—';
}

// =============================================================================
// Reading the filter model
// =============================================================================

/**
 * Read a single-operand `is` filter out of the model as a plain STRING.
 *
 * Returning a scalar (not the filter object) is what lets a refetch effect
 * depend on it directly — an effect keyed on the filter array would refetch
 * forever, since the array is rebuilt on every change. Lifted from
 * `jobsTable.ts` in shape; kept local rather than imported so this table's
 * column ids and that one's cannot be crossed.
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
export function asRunStatus(value: string | undefined): DbBackupRunStatus | undefined {
  return DB_BACKUP_RUN_STATUSES.find((candidate) => candidate === value);
}

/** Narrow a filter value to a trigger the endpoint accepts. */
export function asRunTrigger(value: string | undefined): DbBackupTrigger | undefined {
  return DB_BACKUP_TRIGGERS.find((candidate) => candidate === value);
}

// =============================================================================
// The columns
// =============================================================================

/**
 * @param now the instant every relative measurement is taken against — see
 * `formatRunDuration`.
 */
export function buildBackupRunColumns(now: Date): DataTableColumn<DbBackupRun>[] {
  return [
    {
      /**
       * The row-unique `primary` column, and therefore the row's ACCESSIBLE
       * NAME: `rowAccessibleName()` takes the first visible `primary` column's
       * scalar and names every row-action button and every card after it.
       *
       * The scalar carries a short id FOR THAT REASON. Two scheduled backups
       * can start in the same displayed minute, and this page's row actions
       * include one that deletes an archive and one that replaces the
       * production database — two buttons announced identically, on those
       * actions, is not acceptable. `hideable: false` for the same reason:
       * hiding this column would rename every control on the page after
       * whichever column happened to be `primary` next.
       *
       * `createdAt` is the fallback because a `pending` run has no `startedAt`
       * yet and would otherwise sort into the table as a nameless row.
       */
      id: 'startedAt',
      label: 'Started',
      priority: 'primary',
      hideable: false,
      minWidth: 200,
      flex: 1,
      value: (run) => `${formatDateTime(run.startedAt ?? run.createdAt)} (${shortId(run.id)})`,
      render: (run) => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {formatDateTime(run.startedAt ?? run.createdAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {shortId(run.id)}
          </Typography>
        </Stack>
      ),
    },
    {
      // `filterable` because the endpoint takes `status`. `is` only: it accepts
      // one value, not a set.
      id: STATUS_COLUMN_ID,
      label: 'Status',
      priority: 'primary',
      width: 150,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: STATUS_ENUM_VALUES,
      value: (run) => RUN_STATUS_CHIPS[run.status].label,
      render: (run) => stateChip(RUN_STATUS_CHIPS[run.status], `run-status-${run.id}`),
    },
    {
      id: TRIGGER_COLUMN_ID,
      label: 'Trigger',
      priority: 'primary',
      width: 160,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: TRIGGER_ENUM_VALUES,
      value: (run) => TRIGGER_LABELS[run.trigger],
    },
    {
      /**
       * The live one. A running dump shows what it has streamed so far under an
       * indeterminate bar — indeterminate because the FINAL size is unknown
       * until the archive closes, and a determinate bar would need a total this
       * page would have to invent. A bar that claims 40% when nothing knows the
       * denominator is worse than one that only says "moving".
       *
       * The `value` scalar is the plain label, so the CSV export carries the
       * number and not a widget.
       */
      id: 'size',
      label: 'Size',
      priority: 'primary',
      minWidth: 170,
      value: (run) => formatRunSize(run),
      render: (run) =>
        isBackupRunActive(run) ? (
          <Box sx={{ minWidth: 0, width: '100%' }} data-testid={`run-progress-${run.id}`}>
            <Typography variant="body2" noWrap>
              {formatRunSize(run)}
            </Typography>
            <LinearProgress
              // Decorative: the byte count above it is the actual reading, and
              // a screen reader announcing a percentage nothing computed would
              // be worse than silence.
              aria-hidden
              sx={{ mt: 0.5, borderRadius: 1 }}
            />
          </Box>
        ) : (
          <Typography variant="body2" noWrap>
            {formatRunSize(run)}
          </Typography>
        ),
    },
    {
      id: 'duration',
      label: 'Duration',
      priority: 'secondary',
      align: 'right',
      width: 130,
      value: (run) => formatRunDuration(run, now),
    },
    {
      /**
       * VERIFIED means the archive was read back out of storage and its
       * checksum recomputed — not merely that the upload returned 200. It is
       * the difference between "we wrote something" and "we can read what we
       * wrote", which is the only property that makes a backup worth having.
       * `Not verified` is spelled out rather than left blank, because a blank
       * cell reads as missing data on exactly the row where it would matter
       * most.
       */
      id: 'verifiedAt',
      label: 'Verified',
      priority: 'secondary',
      minWidth: 180,
      value: (run) => (run.verifiedAt ? formatDateTime(run.verifiedAt) : 'Not verified'),
      render: (run) =>
        run.verifiedAt ? (
          <Tooltip title={formatDateTime(run.verifiedAt)}>
            <Typography variant="body2" noWrap data-testid={`run-verified-${run.id}`}>
              {formatDateTime(run.verifiedAt)}
            </Typography>
          </Tooltip>
        ) : (
          <Typography
            variant="body2"
            color="text.secondary"
            noWrap
            data-testid={`run-verified-${run.id}`}
          >
            Not verified
          </Typography>
        ),
    },
    {
      /**
       * Truncated on screen and FULL in the export: an operator comparing a
       * checksum against a storage console needs all of it, and that is exactly
       * the artefact a CSV is for. The tooltip carries the full value for
       * anyone doing it by eye.
       */
      id: 'checksumSha256',
      label: 'Checksum',
      priority: 'secondary',
      minWidth: 170,
      value: (run) => run.checksumSha256 ?? '',
      render: (run) => (
        <Tooltip title={run.checksumSha256 ?? 'Not checksummed'}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }} noWrap>
            {shortChecksum(run.checksumSha256)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      /**
       * The restore audit, on the archive it was performed from. Present only
       * for the runs that carry one, which is why the empty case is an em dash
       * rather than a word: "this archive has never been restored" is the
       * normal state of almost every row, and printing it on all of them would
       * bury the one row where it is not true.
       */
      id: 'restoreStatus',
      label: 'Restore',
      priority: 'secondary',
      minWidth: 150,
      value: (run) => (run.restoreStatus ? RESTORE_STATUS_LABELS[run.restoreStatus] : '—'),
      render: (run) =>
        run.restoreStatus ? (
          <Chip
            size="small"
            variant="outlined"
            color={
              run.restoreStatus === 'failed'
                ? 'error'
                : run.restoreStatus === 'completed'
                  ? 'success'
                  : 'info'
            }
            label={RESTORE_STATUS_LABELS[run.restoreStatus]}
            data-testid={`run-restore-${run.id}`}
          />
        ) : (
          <Typography variant="body2" color="text.secondary">
            —
          </Typography>
        ),
    },
    {
      id: 'finishedAt',
      label: 'Finished',
      priority: 'detail',
      minWidth: 180,
      value: (run) => formatDateTime(run.finishedAt),
    },
    {
      /**
       * The schema the archive was taken on. It is what the restore's
       * compatibility gate compares against the live database, so an operator
       * choosing which archive to restore can see the answer BEFORE opening the
       * dialog that would tell them.
       */
      id: 'migrationName',
      label: 'Schema',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (run) => run.migrationName ?? '—',
    },
    {
      id: 'storage',
      label: 'Storage',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (run) => `${run.storageProvider}: ${run.bucket}/${run.storageKey}`,
    },
    {
      /**
       * Why a run failed, in the row that failed. Truncated on screen — an
       * error can be a paragraph — and complete in the tooltip and the export.
       */
      id: 'lastError',
      label: 'Error',
      priority: 'detail',
      truncate: true,
      minWidth: 240,
      value: (run) => run.lastError ?? '',
    },
    {
      id: 'id',
      label: 'ID',
      priority: 'detail',
      truncate: true,
      minWidth: 200,
      value: (run) => run.id,
    },
  ];
}
