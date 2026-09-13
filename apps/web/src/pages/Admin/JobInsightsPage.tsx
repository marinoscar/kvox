/**
 * Admin → Operations → Job Insights (`/admin/settings/jobs/insights`).
 *
 * Issue #266, epic #254. The second of the two Jobs pages, and a REGISTRY CARD
 * of its own rather than a tab on the first — `CLAUDE.md`'s Settings UI Pattern
 * rule 2, applied to a case that genuinely tempts the other way. Jobs and Job
 * Insights are not two views of one question: one is the queue's ROWS, which an
 * operator acts on row by row, and the other is its BEHAVIOUR over a window,
 * which nobody acts on at all. They are also two endpoints with two costs (a
 * cached paginated read versus percentiles over a window), and a tab strip would
 * make the expensive one load every time somebody opened the cheap one.
 *
 * Its route NESTS under the Jobs card's (`/admin/settings/jobs/insights`), which
 * is the case `settingsPageTitle`'s longest-prefix rule exists for: a bare
 * `startsWith` would let the `Jobs` card claim this path and the AppBar would
 * title this page "Jobs".
 *
 * =============================================================================
 * AN ESTIMATE MUST SAY HOW MUCH OF IT IS REAL
 * =============================================================================
 *
 * Every ETA the API returns is `remaining x avgMs / concurrency`, but that
 * `avgMs` comes from one of three places, and the response says which in
 * `basis`:
 *
 *   `live`    — this type's own completed jobs. The estimate is MEASUREMENT.
 *   `partial` — the average across every other type, because this one has no
 *               history yet. The estimate is an ANALOGY, and a bad one whenever
 *               job types differ in cost (they always do).
 *   `none`    — nothing has succeeded in the window at all, so the number is a
 *               shipped constant. The estimate is a PLACEHOLDER.
 *
 * So this page never renders those three the same way, and a `none` basis
 * RENDERS NO DURATION AT ALL — not the number greyed out, not the number with
 * an asterisk. A duration on screen is read as a measurement by everyone who
 * has ever seen a progress bar, and "4 minutes" derived from a constant is a
 * number that will be quoted to somebody else within the hour. The honest
 * output for `none` is "No estimate yet", and the count of outstanding jobs
 * beside it is the real information that case has.
 *
 * `partial` keeps its duration, hedged in words ("based on other job types"),
 * because an analogy is still evidence — it is right about the order of
 * magnitude in a way a constant is not.
 *
 * =============================================================================
 * WHY IT DOES NOT POLL
 * =============================================================================
 *
 * The sibling Jobs page polls every ten seconds; this one does not, and the
 * asymmetry is deliberate. Nothing here moves at that timescale — a p95 over
 * seven days does not change in ten seconds — so an interval would buy an
 * expensive query per tick and no new information. `generatedAt` is on screen
 * instead, so the operator can see how old the numbers are rather than assume
 * they are live, and refreshing is an explicit act.
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import { Navigate } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableColumn } from '../../components/datatable';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { usePermissions } from '../../hooks/usePermissions';
import {
  DEFAULT_INSIGHTS_WINDOW_DAYS,
  INSIGHTS_WINDOW_OPTIONS,
  useJobInsights,
} from '../../hooks/useJobInsights';
import type { JobEta, JobEtaBasis, JobInsights } from '../../services/jobs';
import { formatDateTime, formatDuration } from './jobsTable';

/** Mirrors the `Job Insights` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Job Insights';
const PAGE_DESCRIPTION =
  'See how long the queue takes, how fast it is moving, and when the outstanding work will be done.';

/** Persistence key for `user_settings.dataTables`. Never derived from the route. */
export const TYPES_TABLE_ID = 'admin-job-insights-types';

/**
 * How each `basis` is presented. The three differ in WORDS, in COLOUR and — for
 * `none` — in whether a duration is shown at all. See the file header.
 */
const BASIS_PRESENTATION: Record<
  JobEtaBasis,
  { chip: string; color: 'success' | 'warning' | 'default'; explanation: string }
> = {
  live: {
    chip: 'Measured',
    color: 'success',
    explanation: "Based on this job type's own completed runs in the window.",
  },
  partial: {
    chip: 'Estimated',
    color: 'warning',
    explanation:
      'This job type has no completed runs in the window, so the average across other job ' +
      'types was used. Treat it as an order of magnitude, not a measurement.',
  },
  none: {
    chip: 'No history',
    color: 'default',
    explanation:
      'Nothing has completed in this window, so there is no basis for an estimate at all.',
  },
};

/** One per-type row: the window's distribution merged with the all-time totals. */
interface JobTypeInsightRow {
  type: string;
  label: string;
  samples: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  throughputPerMin: number;
  lifetimeSucceeded: number;
  lifetimeFailed: number;
  lifetimeTotal: number;
  lifetimeAvgMs: number | null;
  lifetimeSamples: number;
}

/**
 * Merge `history.byType` (a distribution over the window) with `lifetime` (all-
 * time totals) into ONE row per type.
 *
 * They are two blocks in the response because they answer different questions
 * and the API refuses to pretend otherwise — `lifetime` has no percentiles,
 * because percentiles cannot be reconstructed from purged rows. They are one
 * TABLE here because the operator's question is per type ("what does this job
 * type cost"), and reading it off two tables side by side means matching type
 * names by eye. The lifetime columns are `detail` priority, so the window's
 * numbers are what a narrow screen shows first.
 *
 * A type present in only one block still gets a row: a type that has run
 * historically but not in the window has no percentiles (nulls, which render
 * as an em dash), and a type new in this window has no lifetime rollup yet.
 * Dropping either would silently hide a job type from a page whose whole
 * purpose is per-type comparison.
 */
export function buildTypeInsightRows(insights: JobInsights): JobTypeInsightRow[] {
  const rows = new Map<string, JobTypeInsightRow>();

  for (const entry of insights.history.byType) {
    rows.set(entry.type, {
      type: entry.type,
      label: entry.label,
      samples: entry.samples,
      avgMs: entry.avgMs,
      p50Ms: entry.p50Ms,
      p95Ms: entry.p95Ms,
      throughputPerMin: entry.throughputPerMin,
      lifetimeSucceeded: 0,
      lifetimeFailed: 0,
      lifetimeTotal: 0,
      lifetimeAvgMs: null,
      lifetimeSamples: 0,
    });
  }

  for (const entry of insights.lifetime) {
    const existing = rows.get(entry.type);
    const base: JobTypeInsightRow = existing ?? {
      type: entry.type,
      label: entry.label,
      samples: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      throughputPerMin: 0,
      lifetimeSucceeded: 0,
      lifetimeFailed: 0,
      lifetimeTotal: 0,
      lifetimeAvgMs: null,
      lifetimeSamples: 0,
    };

    rows.set(entry.type, {
      ...base,
      lifetimeSucceeded: entry.succeeded,
      lifetimeFailed: entry.failed,
      lifetimeTotal: entry.total,
      lifetimeAvgMs: entry.avgMs,
      lifetimeSamples: entry.durationSamples,
    });
  }

  return [...rows.values()].sort((a, b) => b.lifetimeTotal - a.lifetimeTotal);
}

/**
 * The per-type columns.
 *
 * Nothing is `sortable`: these rows are the whole result set, not a page of a
 * server-side query, and the shared table's sort is a request-shaped control.
 * The rows arrive ordered by all-time volume, which is the ordering the
 * question ("which job type dominates this deployment") actually wants.
 */
function buildTypeColumns(): DataTableColumn<JobTypeInsightRow>[] {
  return [
    {
      id: 'label',
      label: 'Job type',
      priority: 'primary',
      hideable: false,
      minWidth: 200,
      flex: 1,
      value: (row) => row.label,
    },
    {
      id: 'samples',
      label: 'Completed in window',
      priority: 'primary',
      align: 'right',
      width: 160,
      // The denominator for everything to its right — a p95 over two samples
      // is a number, not a distribution — so it is `primary` and sits first.
      value: (row) => row.samples,
    },
    {
      id: 'avgMs',
      label: 'Average',
      priority: 'secondary',
      align: 'right',
      width: 130,
      value: (row) => formatDuration(row.avgMs),
    },
    {
      id: 'p50Ms',
      label: 'Median (p50)',
      priority: 'secondary',
      align: 'right',
      width: 140,
      value: (row) => formatDuration(row.p50Ms),
    },
    {
      id: 'p95Ms',
      label: 'p95',
      priority: 'secondary',
      align: 'right',
      width: 130,
      value: (row) => formatDuration(row.p95Ms),
    },
    {
      id: 'throughputPerMin',
      label: 'Per minute (last hour)',
      priority: 'secondary',
      align: 'right',
      width: 180,
      // Two decimals: a queue doing three jobs an hour is 0.05/min, and one
      // decimal would render that as "0.1" or "0.0" depending on rounding.
      value: (row) => row.throughputPerMin.toFixed(2),
    },
    {
      id: 'lifetimeTotal',
      label: 'All-time runs',
      priority: 'detail',
      align: 'right',
      width: 140,
      value: (row) => row.lifetimeTotal,
    },
    {
      id: 'lifetimeSucceeded',
      label: 'All-time succeeded',
      priority: 'detail',
      align: 'right',
      width: 170,
      value: (row) => row.lifetimeSucceeded,
    },
    {
      id: 'lifetimeFailed',
      label: 'All-time failed',
      priority: 'detail',
      align: 'right',
      width: 150,
      value: (row) => row.lifetimeFailed,
    },
    {
      id: 'lifetimeAvgMs',
      label: 'All-time average',
      priority: 'detail',
      align: 'right',
      width: 170,
      value: (row) => formatDuration(row.lifetimeAvgMs),
    },
  ];
}

interface KpiProps {
  label: string;
  value: string | number;
  hint?: string;
}

function Kpi({ label, value, hint }: KpiProps) {
  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.5, minWidth: 150, flexGrow: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

/**
 * One type's ETA.
 *
 * The three `basis` values are rendered as three different statements, not one
 * statement with a badge — see the file header for why a `none` estimate shows
 * no duration whatsoever.
 */
function EtaRow({ eta }: { eta: JobEta }) {
  const presentation = BASIS_PRESENTATION[eta.basis];
  const measured = eta.basis !== 'none';

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'baseline' }, justifyContent: 'space-between' }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {eta.label}
          </Typography>
          <Chip size="small" label={presentation.chip} color={presentation.color} />
        </Stack>
        <Typography variant="h6" component="p">
          {measured ? formatDuration(eta.estimatedMs) : 'No estimate yet'}
        </Typography>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {eta.remaining} outstanding ({eta.pending} pending, {eta.running} running).
        {measured && ` About ${formatDuration(eta.avgMs)} per job.`}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {presentation.explanation}
      </Typography>
    </Paper>
  );
}

export default function JobInsightsPage() {
  const { hasPermission } = usePermissions();
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_INSIGHTS_WINDOW_DAYS);
  const { insights, isLoading, error, refresh, isResetting, resetHistory } =
    useJobInsights(windowDays);

  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const typeRows = useMemo(
    () => (insights ? buildTypeInsightRows(insights) : []),
    [insights],
  );
  const typeColumns = useMemo(() => buildTypeColumns(), []);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook, so the hook order never changes.
  if (!hasPermission('jobs:read')) {
    return <Navigate to="/" replace />;
  }

  // `jobs:write` — `POST /insights/reset-history` sits on the WRITE side even
  // though it deletes no job, because what it destroys is unrecoverable by any
  // other means.
  const canWrite = hasPermission('jobs:write');

  if (isLoading && !insights) {
    return <LoadingSpinner />;
  }

  const outstanding = insights
    ? insights.live.byStatus.pending + insights.live.byStatus.running
    : 0;

  const handleReset = async () => {
    setConfirmReset(false);
    const removed = await resetHistory();
    if (removed !== null) {
      setNotice(`Cleared ${removed} lifetime rollup row(s). No job was changed.`);
    }
  };

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
          {!canWrite && ' (read-only)'}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {insights && (
          <>
            {/* --------------------------------------------------------------
                THE WINDOW, AND WHEN THIS WAS TAKEN. Both sit above the numbers
                because both change what every number below means.
                ----------------------------------------------------------- */}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ mb: 3, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
            >
              <ToggleButtonGroup
                size="small"
                exclusive
                value={windowDays}
                aria-label="History window"
                onChange={(_, next) => {
                  // `null` is MUI's "clicked the active button"; keeping the
                  // current window is right — there is no unselected state.
                  if (next !== null) setWindowDays(next as number);
                }}
              >
                {INSIGHTS_WINDOW_OPTIONS.map((option) => (
                  <ToggleButton key={option} value={option}>
                    {option === 1 ? '24 hours' : `${option} days`}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>

              <Button startIcon={<RefreshIcon />} onClick={() => void refresh()}>
                Refresh
              </Button>

              <Box sx={{ flexGrow: 1 }} />

              {/* The API's OWN `windowDays`, not the button that was pressed:
                  it clamps, and a label reading back the request rather than
                  the response would describe a window that was not used. */}
              <Typography variant="caption" color="text.secondary">
                Covering {insights.windowDays} day(s) from{' '}
                {formatDateTime(insights.history.windowStart)} · taken{' '}
                {formatDateTime(insights.generatedAt)}
              </Typography>
            </Stack>

            <Stack
              direction="row"
              spacing={2}
              useFlexGap
              sx={{ flexWrap: 'wrap', mb: 4 }}
              aria-label="Queue insights summary"
            >
              <Kpi label="Outstanding" value={outstanding} hint="Pending plus running" />
              <Kpi
                label="Scheduled"
                value={insights.live.scheduled}
                hint="Waiting out a backoff"
              />
              <Kpi
                label="Rate limited"
                value={insights.live.rateLimited}
                hint="Deferred by a provider at least once"
              />
              <Kpi
                label="Retried"
                value={insights.live.retried}
                hint="Needed more than one attempt"
              />
              <Kpi
                label="Median duration"
                value={formatDuration(insights.history.overall.p50Ms)}
                hint={`${insights.history.overall.samples} completed in window`}
              />
              <Kpi
                label="p95 duration"
                value={formatDuration(insights.history.overall.p95Ms)}
              />
              <Kpi
                label="Throughput"
                value={`${insights.history.overall.throughputPerMin.toFixed(2)}/min`}
                hint={`Since ${formatDateTime(insights.history.throughputSince)}`}
              />
              <Kpi
                label="Worker concurrency"
                value={insights.concurrency}
                hint="The divisor in every estimate"
              />
            </Stack>

            {/* --------------------------------------------------------------
                THE ESTIMATES. One per type with work outstanding, slowest
                first, each carrying its own basis.
                ----------------------------------------------------------- */}
            <Typography variant="h6" component="h2" gutterBottom>
              Estimated time to finish
            </Typography>
            {insights.eta.length === 0 ? (
              <Alert severity="success" sx={{ mb: 4 }}>
                Nothing is outstanding — every job in the queue has finished.
              </Alert>
            ) : (
              <Stack spacing={1.5} sx={{ mb: 4 }}>
                {insights.eta.map((eta) => (
                  <EtaRow key={eta.type} eta={eta} />
                ))}
              </Stack>
            )}

            {/* --------------------------------------------------------------
                PER TYPE: the window's distribution and the all-time totals, one
                row each. See `buildTypeInsightRows` for why they are merged.
                ----------------------------------------------------------- */}
            <Typography variant="h6" component="h2" gutterBottom>
              By job type
            </Typography>
            <Paper sx={{ width: '100%', p: 2, mb: 4 }}>
              <Box sx={{ minWidth: 0 }}>
                <DataTable<JobTypeInsightRow>
                  tableId={TYPES_TABLE_ID}
                  data-testid="admin-job-insights-types-table"
                  ariaLabel="Job types"
                  columns={typeColumns}
                  rows={typeRows}
                  rowId={(row) => row.type}
                  emptyState={
                    <Typography color="text.secondary">
                      No job type has completed a run in this window.
                    </Typography>
                  }
                  csvExport={{ filename: 'job-insights-by-type' }}
                />
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1, display: 'block' }}
              >
                Percentiles cover the selected window only. All-time figures merge the lifetime
                rollup with the rows still in the table, and carry no percentiles — a percentile
                cannot be reconstructed from history that has been purged.
              </Typography>
            </Paper>

            {canWrite && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Lifetime statistics
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Clearing the rollup deletes the all-time counters for jobs whose rows have
                  already been purged. No job is deleted and no job changes state — but the
                  numbers cannot be rebuilt, because the rows that would prove them are gone.
                </Typography>
                <Button
                  color="error"
                  variant="outlined"
                  startIcon={<DeleteSweepIcon />}
                  disabled={isResetting}
                  onClick={() => setConfirmReset(true)}
                >
                  Clear lifetime statistics
                </Button>
              </Paper>
            )}
          </>
        )}

        <Dialog open={confirmReset} onClose={() => setConfirmReset(false)}>
          <DialogTitle>Clear the lifetime statistics?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              Every all-time counter is deleted and restarts from the jobs still in the table.
              No job is deleted and nothing else on this page changes. This cannot be undone.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button color="error" variant="contained" onClick={() => void handleReset()}>
              Clear
            </Button>
          </DialogActions>
        </Dialog>

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
