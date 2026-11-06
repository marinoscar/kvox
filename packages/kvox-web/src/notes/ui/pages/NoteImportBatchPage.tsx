/**
 * `/notes/import-batches/:batchId`: the live progress of one import (issues #720, #814;
 * epics #708, #811). Hundreds of files flow in here: an overall bar (finished of total,
 * with the upload phase as its buffer), throughput and time left, the pipeline funnel,
 * status chips, a file-name search and a sort over a virtualized file list, the retries,
 * a CSV of the failures, the upload controls (pause, resume, cancel, retry) while this
 * tab is still uploading, the way to the Review Queue, and a banner that says what
 * happened once it is done.
 *
 * The page re-reads the batch every two seconds while it works (and only while the tab
 * is visible); every read pulls just the items changed since the newest one it holds
 * (`useAllImportBatchItems().poll`). Files this tab is still uploading come from
 * `useBatchUpload(batchId)` and are merged with the server's items by path, so every
 * file shows from the first second.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RateReviewIcon from '@mui/icons-material/RateReview';
import ReplayIcon from '@mui/icons-material/Replay';
import SearchIcon from '@mui/icons-material/Search';
import StopIcon from '@mui/icons-material/Stop';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router-dom';

import { formatRelativeTime, useKvoxHost, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { useAllImportBatchItems, useBatchUpload, useImportBatch } from '../../headless/index.js';
import type { BatchUpload, NoteImportBatch } from '../../headless/index.js';
import { ImportBatchItemTable } from '../components/ImportBatchItemTable.js';
import { ImportStageFunnel } from '../components/ImportStageFunnel.js';
import { pluralize } from '../library/format.js';
import {
  buildImportBatchRows,
  filterImportBatchRows,
  formatEta,
  importBatchFailuresCsv,
  importThroughput,
  sortImportBatchRows,
} from '../library/importBatchRows.js';
import type { ImportBatchRowFilter, ImportBatchRowSort, ImportThroughputSample } from '../library/importBatchRows.js';
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

const FILTERS: ReadonlyArray<{ status: ImportBatchRowFilter | undefined; label: string }> = [
  { status: undefined, label: 'All' },
  { status: 'uploading', label: 'Uploading' },
  { status: 'upload_failed', label: 'Upload failed' },
  { status: 'imported', label: 'Imported' },
  { status: 'failed', label: 'Failed' },
  { status: 'missing', label: 'Missing' },
  { status: 'skipped', label: 'Skipped' },
  { status: 'queued', label: 'Queued' },
];

const SORTS: ReadonlyArray<{ value: ImportBatchRowSort; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'stage', label: 'Stage' },
  { value: 'updated', label: 'Last change' },
];

/** Whether this tab still has files of the upload to send. */
function uploadPending(upload: BatchUpload | null | undefined): boolean {
  if (!upload) return false;
  return upload.status === 'uploading' || (upload.status === 'paused' && upload.counts.queued + upload.counts.uploading > 0);
}

/** Hands a text file to the browser to save. */
function downloadText(text: string, filename: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
  const [filter, setFilter] = useState<ImportBatchRowFilter | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ImportBatchRowSort>('name');
  const [busy, setBusy] = useState<'retry' | 'extractions' | 'uploads' | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null);

  const batchState = useImportBatch(batchId, pollMs === undefined ? {} : { pollMs });
  const { batch, isLoading, error, notFound, isActive, retryFailed, retryExtractions, retryExtractionsAvailable } =
    batchState;
  const items = useAllImportBatchItems(batchId, { q: search });
  const { poll: pollItems } = items;
  const uploadState = useBatchUpload(batchId);
  const upload = uploadState?.upload ?? null;
  const uploading = uploadPending(upload);

  // Every fresh read of the batch reads the items changed since, so a polled page moves together.
  const firstBatch = useRef(true);
  useEffect(() => {
    if (!batch) return;
    if (firstBatch.current) {
      firstBatch.current = false;
      return;
    }
    void pollItems();
  }, [batch]);

  const allRows = useMemo(
    () => buildImportBatchRows(items.searchResults ?? items.items, upload),
    [items.items, items.searchResults, upload],
  );
  const rows = useMemo(
    () => sortImportBatchRows(filterImportBatchRows(allRows, filter, search), sort),
    [allRows, filter, search, sort],
  );
  const rowCounts = useMemo(() => {
    const counts: Partial<Record<ImportBatchRowFilter, number>> = {};
    for (const row of allRows) counts[row.filter] = (counts[row.filter] ?? 0) + 1;
    return counts;
  }, [allRows]);

  // Throughput: readings of the finished count over time, kept in a ref (not state).
  const samples = useRef<ImportThroughputSample[]>([]);

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
  const serverProgress = batch ? finishedOf(batch) : { finished: 0, total: 0 };
  // Files this tab sends that are not items yet still count toward the whole.
  const total = Math.max(serverProgress.total, upload ? upload.files.length - upload.counts.cancelled : 0);
  const progress = { finished: serverProgress.finished, total };
  const percent = progress.total > 0 ? Math.round((progress.finished / progress.total) * 100) : isActive ? 0 : 100;
  const sent = upload ? upload.counts.uploaded + upload.counts.skipped : 0;
  const uploadPercent = upload && upload.files.length > 0 ? Math.round((sent / upload.files.length) * 100) : 100;
  const isFinished = batch !== null && !isActive && !uploading;
  if (batch) {
    const now = Date.now();
    const last = samples.current[samples.current.length - 1];
    if (!last || last.finished !== progress.finished) {
      samples.current = [...samples.current.filter((sample) => now - sample.at < 600_000), { at: now, finished: progress.finished }];
    }
  }
  const throughput = importThroughput(samples.current, progress.total - progress.finished);
  const failureCsv = importBatchFailuresCsv(allRows);
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

  const onUploads = async (action: 'retry' | 'cancel') => {
    if (!uploadState) return;
    setBusy('uploads');
    try {
      if (action === 'retry') {
        const failed = upload?.counts.failed ?? 0;
        const run = uploadState.retry();
        setNotice({ severity: 'info', text: `${pluralize(failed, 'upload')} started again.` });
        await run;
      } else {
        await uploadState.cancel();
        setNotice({ severity: 'info', text: 'Upload stopped. Files already sent are still imported.' });
      }
    } catch (err) {
      setNotice({ severity: 'error', text: err instanceof Error ? err.message : 'That did not work.' });
    } finally {
      setBusy(null);
    }
  };

  const statusLine = !batch
    ? ''
    : uploading
      ? upload?.status === 'paused'
        ? `Upload paused at ${sent.toLocaleString()} of ${upload.files.length.toLocaleString()} files`
        : `Uploading ${sent.toLocaleString()} of ${(upload?.files.length ?? 0).toLocaleString()} files`
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
              variant={upload && uploadPercent < 100 ? 'buffer' : 'determinate'}
              value={percent}
              {...(upload && uploadPercent < 100 ? { valueBuffer: uploadPercent } : {})}
              aria-label="Files imported"
              aria-valuetext={`${progress.finished} of ${progress.total} files done`}
              sx={{ height: 10, borderRadius: 5, mb: 1 }}
            />
            {(uploading || (throughput.perMinute !== null && !isFinished)) && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} aria-live="polite">
                {[
                  upload ? `${sent.toLocaleString()} of ${upload.files.length.toLocaleString()} uploaded` : null,
                  throughput.perMinute !== null ? `${Math.max(1, Math.round(throughput.perMinute)).toLocaleString()} files/min` : null,
                  throughput.etaMs !== null && throughput.etaMs > 0 ? `${formatEta(throughput.etaMs)} left` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Typography>
            )}
            <Box sx={{ mb: 1 }} />
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

          {upload && (uploading || upload.counts.failed > 0) && upload.status !== 'cancelled' && (
            <Box
              role="group"
              aria-label="Upload controls"
              sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}
            >
              {upload.status === 'uploading' && (
                <Button variant="outlined" startIcon={<PauseIcon />} onClick={() => uploadState?.pause()}>
                  Pause upload
                </Button>
              )}
              {upload.status === 'paused' && (
                <Button variant="outlined" startIcon={<PlayArrowIcon />} onClick={() => uploadState?.resume()}>
                  Resume upload
                </Button>
              )}
              {uploading && (
                <Button color="error" startIcon={<StopIcon />} onClick={() => void onUploads('cancel')} disabled={busy !== null}>
                  Cancel upload
                </Button>
              )}
              {upload.counts.failed > 0 && (
                <Button startIcon={<ReplayIcon />} onClick={() => void onUploads('retry')} disabled={busy !== null}>
                  {`Retry uploads (${upload.counts.failed.toLocaleString()})`}
                </Button>
              )}
              {uploading && (
                <Typography variant="body2" color="text.secondary">
                  Keep this tab open until the upload finishes.
                </Typography>
              )}
            </Box>
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
              const count =
                status === undefined
                  ? Math.max(progress.total, allRows.length)
                  : status === 'uploading' || status === 'upload_failed'
                    ? (rowCounts[status] ?? 0)
                    : (batch.counts?.[status] ?? rowCounts[status] ?? 0);
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
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
            <TextField
              size="small"
              type="search"
              placeholder="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                htmlInput: { 'aria-label': 'Search files' },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <TextField
              select
              size="small"
              label="Sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as ImportBatchRowSort)}
              sx={{ minWidth: 140 }}
            >
              {SORTS.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
            {failureCsv && (
              <Button
                startIcon={<DownloadIcon />}
                onClick={() => downloadText(failureCsv, `import-${batchId ?? 'batch'}-failures.csv`)}
              >
                Export failures (CSV)
              </Button>
            )}
          </Box>
          <ImportBatchItemTable
            rows={rows}
            isLoading={items.isLoading}
            error={items.error}
            canReview={graphAvailable}
            {...(uploadState && canWrite ? { onRetryUpload: (path: string) => void uploadState.retry([path]) } : {})}
            emptyText={
              search.trim()
                ? 'No files match your search.'
                : filter
                  ? 'No files with this status.'
                  : 'No files in this import yet.'
            }
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
          {uploading
            ? 'You can open other pages while the files upload; do not close this tab.'
            : 'You can leave this page; the import keeps going.'}{' '}
          <Link component={RouterLink} to="/notes">
            Go to your notes
          </Link>
        </Typography>
      )}
    </Box>
  );
}
