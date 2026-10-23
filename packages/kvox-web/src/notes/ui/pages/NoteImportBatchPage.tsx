/**
 * `/notes/import-batches/:batchId`: the live progress of one import (issue #720,
 * epic #708). Hundreds of files flow in here: an overall bar (finished of total), the
 * pipeline funnel, status chips that filter the file list, the retries, the way to the
 * Review Queue, and a banner that says what happened once it is done. The page
 * re-reads the batch every two seconds while it works (and only while the tab is
 * visible), and the file list with it.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RateReviewIcon from '@mui/icons-material/RateReview';
import ReplayIcon from '@mui/icons-material/Replay';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router-dom';

import { formatRelativeTime, useKvoxHost, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { useImportBatch, useImportBatchItems } from '../../headless/index.js';
import type { NoteImportBatch, NoteImportItemStatus } from '../../headless/index.js';
import { ImportBatchItemList } from '../components/ImportBatchItemList.js';
import { ImportStageFunnel } from '../components/ImportStageFunnel.js';
import { pluralize } from '../library/format.js';
import { summarizeImportFailures } from '../library/useAdHocNoteImport.js';
import type { NoteImportNavigationState } from '../library/useAdHocNoteImport.js';

/**
 * Props of {@link NoteImportBatchPage}.
 *
 * @stability experimental
 */
export interface NoteImportBatchPageProps {
  /** The batch to show. Default: the `:batchId` route parameter. */
  batchId?: string;
  /** Poll interval while the batch works, in milliseconds (tests pass 0). */
  pollMs?: number;
  /**
   * Where "Open Review Queue" goes. Default `/graph/review-queue?batchId=…`.
   * `null` hides the link.
   */
  reviewQueuePath?: ((batchId: string) => string) | null;
}

/**
 * The default Review Queue link of a batch.
 *
 * @param batchId - The batch.
 * @returns `/graph/review-queue?batchId=…`.
 *
 * @stability experimental
 */
export function defaultReviewQueuePath(batchId: string): string {
  return `/graph/review-queue?batchId=${encodeURIComponent(batchId)}`;
}

/** Files that are done (whatever the outcome) and all files. */
function finishedOf(batch: NoteImportBatch): { finished: number; total: number } {
  const c = batch.counts;
  const total = Object.values(c ?? {}).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  const finished = (c?.imported ?? 0) + (c?.failed ?? 0) + (c?.missing ?? 0) + (c?.skipped ?? 0);
  return { finished, total };
}

/**
 * The completion sentence: `All 128 notes imported. 120 are in the graph; 8 wait for review.`
 *
 * @param batch - A finished batch.
 * @returns The sentence.
 *
 * @stability experimental
 */
export function importCompletionSentence(batch: NoteImportBatch): string {
  const c = batch.counts;
  const s = batch.stageCounts;
  const imported = c?.imported ?? 0;
  const failed = c?.failed ?? 0;
  const skipped = c?.skipped ?? 0;
  const missing = c?.missing ?? 0;
  const parts: string[] = [];
  if (failed === 0 && imported > 0) {
    parts.push(`All ${pluralize(imported, 'note')} imported.`);
  } else if (imported > 0) {
    parts.push(`${imported.toLocaleString()} of ${(imported + failed).toLocaleString()} notes imported; ${failed.toLocaleString()} failed.`);
  } else if (failed > 0) {
    parts.push(`None of the ${pluralize(failed, 'file')} could be imported.`);
  }
  const inGraph = s?.in_graph ?? 0;
  const waiting = s?.extracted ?? 0;
  if (inGraph > 0 || waiting > 0) {
    const graph: string[] = [];
    if (inGraph > 0) graph.push(`${inGraph.toLocaleString()} ${inGraph === 1 ? 'is' : 'are'} in the graph`);
    if (waiting > 0) graph.push(`${waiting.toLocaleString()} wait${waiting === 1 ? 's' : ''} for review`);
    parts.push(`${graph.join('; ')}.`);
  }
  if (skipped > 0) parts.push(`${pluralize(skipped, 'file')} unchanged, skipped.`);
  if (missing > 0) parts.push(`${pluralize(missing, 'file')} no longer in the folder.`);
  return parts.length > 0 ? parts.join(' ') : 'Nothing needed importing.';
}

const FILTERS: ReadonlyArray<{ status: NoteImportItemStatus | undefined; label: string }> = [
  { status: undefined, label: 'All' },
  { status: 'imported', label: 'Imported' },
  { status: 'failed', label: 'Failed' },
  { status: 'missing', label: 'Missing' },
  { status: 'skipped', label: 'Skipped' },
  { status: 'queued', label: 'Queued' },
];

/**
 * `/notes/import-batches/:batchId`: one import, live.
 *
 * @param props - See {@link NoteImportBatchPageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function NoteImportBatchPage({
  batchId: batchIdProp,
  pollMs,
  reviewQueuePath = defaultReviewQueuePath,
}: NoteImportBatchPageProps = {}) {
  const params = useParams<{ batchId: string }>();
  const batchId = batchIdProp ?? params.batchId;
  const host = useKvoxHost();
  const location = useLocation();
  const hasPermission = useKvoxPermissionCheck();
  const canWrite = hasPermission('notes:write');
  const navState = (location.state ?? null) as NoteImportNavigationState | null;
  const [uploadFailuresOpen, setUploadFailuresOpen] = useState(true);
  const [filter, setFilter] = useState<NoteImportItemStatus | undefined>(undefined);
  const [busy, setBusy] = useState<'retry' | 'extractions' | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null);

  const batchState = useImportBatch(batchId, pollMs === undefined ? {} : { pollMs });
  const { batch, isLoading, error, notFound, isActive, retryFailed, retryExtractions, retryExtractionsAvailable } =
    batchState;
  const items = useImportBatchItems(batchId, filter);
  const { refresh: refreshItems } = items;

  // Every fresh read of the batch re-reads the rows in view, so a polled page moves together.
  useEffect(() => {
    if (batch) void refreshItems();
  }, [batch]);

  if (notFound) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Alert severity="warning">This import does not exist, or it is not yours.</Alert>
        <Button component={RouterLink} to="/notes/libraries" startIcon={<ArrowBackIcon />} sx={{ mt: 2 }}>
          Note libraries
        </Button>
      </Box>
    );
  }

  const backTo = batch?.libraryId ? `/notes/libraries/${encodeURIComponent(batch.libraryId)}` : '/notes';
  const backLabel = batch?.libraryId ? 'Library' : 'Notes';
  const progress = batch ? finishedOf(batch) : { finished: 0, total: 0 };
  const percent = progress.total > 0 ? Math.round((progress.finished / progress.total) * 100) : isActive ? 0 : 100;
  const isFinished = batch !== null && !isActive;
  const failedCount = batch?.counts?.failed ?? 0;
  const waitingReview = batch?.stageCounts?.extracted ?? 0;
  const graphAvailable = host.features().graphEnabled !== false && hasPermission('graph:read');
  const showReviewLink = Boolean(batchId && reviewQueuePath && graphAvailable && waitingReview > 0);
  const showRetryExtractions =
    canWrite && retryExtractionsAvailable && batch !== null && !isActive && (batch.counts?.imported ?? 0) > 0;

  const onRetry = async () => {
    setBusy('retry');
    try {
      const requeued = await retryFailed();
      setNotice({
        severity: requeued > 0 ? 'success' : 'info',
        text: requeued > 0 ? `${pluralize(requeued, 'file')} queued again.` : 'There was nothing to retry.',
      });
    } catch (err) {
      setNotice({ severity: 'error', text: err instanceof Error ? err.message : 'The retry failed.' });
    } finally {
      setBusy(null);
    }
  };

  const onRetryExtractions = async () => {
    setBusy('extractions');
    try {
      const requeued = await retryExtractions();
      if (requeued === null) {
        setNotice({ severity: 'info', text: 'Retrying extractions is not available on this server yet.' });
      } else {
        setNotice({
          severity: requeued > 0 ? 'success' : 'info',
          text: requeued > 0 ? `${pluralize(requeued, 'extraction')} queued again.` : 'No extraction needed a retry.',
        });
      }
    } catch (err) {
      setNotice({ severity: 'error', text: err instanceof Error ? err.message : 'The retry failed.' });
    } finally {
      setBusy(null);
    }
  };

  const statusLine = !batch
    ? ''
    : isActive
      ? batch.status === 'running' || batch.status === 'scanning'
        ? `Importing ${progress.finished.toLocaleString()} of ${progress.total.toLocaleString()} files`
        : 'Extracting knowledge from the imported notes'
      : batch.status === 'cancelled'
        ? 'This import was cancelled.'
        : 'Import finished';

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Button component={RouterLink} to={backTo} startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 1 }}>
        {backLabel}
      </Button>
      <Typography variant="h5" component="h1">
        {isFinished ? 'Import finished' : 'Importing notes'}
      </Typography>
      {batch && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Started {formatRelativeTime(batch.createdAt)}
          {batch.finishedAt ? ` · finished ${formatRelativeTime(batch.finishedAt)}` : ''}
        </Typography>
      )}

      {navState?.uploadFailures && navState.uploadFailures.length > 0 && uploadFailuresOpen && (
        <Alert severity="warning" onClose={() => setUploadFailuresOpen(false)} sx={{ mb: 2 }}>
          {summarizeImportFailures(navState.uploadFailures)}
        </Alert>
      )}
      {error && !batch && <Alert severity="error">{error}</Alert>}
      {isLoading && !batch && <LinearProgress aria-label="Loading the import" />}

      {batch && (
        <>
          <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 1 }}>
              <Typography sx={{ fontWeight: 500 }}>{statusLine}</Typography>
              <Typography color="text.secondary">
                {progress.finished.toLocaleString()} / {progress.total.toLocaleString()}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={percent}
              aria-label="Files imported"
              aria-valuetext={`${progress.finished} of ${progress.total} files done`}
              sx={{ height: 10, borderRadius: 5, mb: 2 }}
            />
            <ImportStageFunnel stageCounts={batch.stageCounts} />
          </Paper>

          {isFinished && batch.status !== 'cancelled' && (
            <Alert
              severity={failedCount > 0 ? 'warning' : 'success'}
              sx={{ mb: 2 }}
              action={
                showReviewLink && batchId && reviewQueuePath ? (
                  <Button color="inherit" size="small" component={RouterLink} to={reviewQueuePath(batchId)}>
                    Review
                  </Button>
                ) : undefined
              }
            >
              <AlertTitle>{failedCount > 0 ? 'Finished with some failures' : 'Done'}</AlertTitle>
              {importCompletionSentence(batch)}
            </Alert>
          )}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
            {canWrite && failedCount > 0 && (
              <Button variant="contained" startIcon={<ReplayIcon />} onClick={() => void onRetry()} disabled={busy !== null}>
                {busy === 'retry' ? 'Retrying…' : `Retry failed (${failedCount.toLocaleString()})`}
              </Button>
            )}
            {showRetryExtractions && (
              <Button variant="outlined" onClick={() => void onRetryExtractions()} disabled={busy !== null}>
                {busy === 'extractions' ? 'Retrying…' : 'Retry failed extractions'}
              </Button>
            )}
            {showReviewLink && batchId && reviewQueuePath && (
              <Button variant="outlined" startIcon={<RateReviewIcon />} component={RouterLink} to={reviewQueuePath(batchId)}>
                Open Review Queue ({waitingReview.toLocaleString()})
              </Button>
            )}
          </Box>

          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Files
          </Typography>
          <Box role="group" aria-label="Filter files by status" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
            {FILTERS.map(({ status, label }) => {
              const count = status
                ? (batch.counts?.[status] ?? 0)
                : finishedOf(batch).total;
              if (status && count === 0 && filter !== status) return null;
              const selected = filter === status;
              return (
                <Chip
                  key={label}
                  label={`${label} ${count.toLocaleString()}`}
                  color={selected ? 'primary' : status === 'failed' ? 'error' : 'default'}
                  variant={selected ? 'filled' : 'outlined'}
                  onClick={() => setFilter(status)}
                  aria-pressed={selected}
                />
              );
            })}
          </Box>
          <ImportBatchItemList
            items={items.items}
            isLoading={items.isLoading}
            error={items.error}
            hasMore={items.hasMore}
            isLoadingMore={items.isLoadingMore}
            onLoadMore={() => void items.loadMore()}
            emptyText={filter ? 'No files with this status.' : 'No files in this import yet.'}
          />
        </>
      )}

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={(_, reason) => {
          if (reason !== 'clickaway') setNotice(null);
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Box>
          {notice ? (
            <Alert severity={notice.severity} onClose={() => setNotice(null)}>
              {notice.text}
            </Alert>
          ) : undefined}
        </Box>
      </Snackbar>
      {batch && !isFinished && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          You can leave this page; the import keeps going.{' '}
          <Link component={RouterLink} to="/notes">
            Go to your notes
          </Link>
        </Typography>
      )}
    </Box>
  );
}
