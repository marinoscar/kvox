/**
 * `/notes/libraries/:libraryId`: one note library (issue #720, epic #708).
 *
 * A summary (folder on this device, counts, last scan, Rescan), the settings (rename,
 * Auto-extract, Auto-commit behind a confirmation that states ADR-0007's safe policy,
 * Remove), the recent imports, and the files of the latest import filtered by status.
 * There is no per-file library list route, so the file table reads the latest batch.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import FolderIcon from '@mui/icons-material/Folder';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import SyncIcon from '@mui/icons-material/Sync';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import { formatRelativeTime, useIsMounted, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { useImportBatchItems, useImportBatches, useNoteLibrary } from '../../headless/index.js';
import type { NoteImportBatch, NoteImportItemStatus } from '../../headless/index.js';
import { ImportBatchItemList } from '../components/ImportBatchItemList.js';
import { describeSyncProgress, pluralize, syncProgressPercent } from '../library/format.js';
import { noteImportBatchPath } from '../library/useAdHocNoteImport.js';
import type { NoteImportNavigationState } from '../library/useAdHocNoteImport.js';
import { useLibraryFolders } from '../library/useLibraryFolders.js';
import { syncErrorMessage, useLibrarySyncRunner } from '../library/useLibrarySyncRunner.js';

/**
 * Props of {@link NoteLibraryPage}.
 *
 * @stability experimental
 */
export interface NoteLibraryPageProps {
  /** The library to show. Default: the `:libraryId` route parameter. */
  libraryId?: string;
  /** Upload one file at a time (KVox Desktop). */
  sequential?: boolean;
}

/**
 * The words of ADR-0007's safe policy, shown wherever Auto-commit is offered.
 *
 * @stability experimental
 */
export const AUTO_COMMIT_SAFE_POLICY_TEXT =
  'Rows about sensitive personal facts, closings, ambiguous matches and low-confidence rows always wait for you in the Review Queue.';

const BATCH_STATUS_LABEL: Readonly<Record<string, string>> = {
  scanning: 'Scanning',
  running: 'Importing',
  completed: 'Done',
  completed_with_errors: 'Done with failures',
  cancelled: 'Cancelled',
};

function batchSummary(batch: NoteImportBatch): string {
  const c = batch.counts;
  const parts: string[] = [];
  if ((c?.imported ?? 0) > 0) parts.push(`${c.imported.toLocaleString()} imported`);
  if ((c?.failed ?? 0) > 0) parts.push(`${c.failed.toLocaleString()} failed`);
  if ((c?.missing ?? 0) > 0) parts.push(`${c.missing.toLocaleString()} missing`);
  const pending = (c?.queued ?? 0) + (c?.importing ?? 0);
  if (pending > 0) parts.push(`${pending.toLocaleString()} in progress`);
  return parts.length > 0 ? parts.join(' · ') : 'No files';
}

const FILE_FILTERS: ReadonlyArray<{ status: NoteImportItemStatus | undefined; label: string }> = [
  { status: undefined, label: 'All' },
  { status: 'imported', label: 'Imported' },
  { status: 'failed', label: 'Failed' },
  { status: 'missing', label: 'Missing' },
];

/**
 * `/notes/libraries/:libraryId`.
 *
 * @param props - See {@link NoteLibraryPageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function NoteLibraryPage({ libraryId: libraryIdProp, sequential }: NoteLibraryPageProps = {}) {
  const params = useParams<{ libraryId: string }>();
  const libraryId = libraryIdProp ?? params.libraryId;
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const hasPermission = useKvoxPermissionCheck();
  const canWrite = hasPermission('notes:write');
  const { library, isLoading, error, notFound, refresh, update, remove } = useNoteLibrary(libraryId);
  const batches = useImportBatches(libraryId, 10);
  const latestBatchId = batches.batches[0]?.id;
  const [fileFilter, setFileFilter] = useState<NoteImportItemStatus | undefined>(undefined);
  const files = useImportBatchItems(latestBatchId, fileFilter);
  const { folders, port, folderForSync, connect } = useLibraryFolders(libraryId ? [libraryId] : []);
  const runner = useLibrarySyncRunner(sequential ? { sequential } : {});
  const folder = libraryId ? folders[libraryId] : undefined;
  const repickEachScan = !port.capabilities.persistentFolders;

  const [name, setName] = useState('');
  const [saving, setSaving] = useState<'name' | 'autoExtract' | 'autoCommit' | null>(null);
  const [confirmAutoCommit, setConfirmAutoCommit] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (library) setName(library.name);
  }, [library?.name]); // reset the field when the stored name changes

  if (notFound) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Alert severity="warning">This library does not exist, or it is not yours.</Alert>
        <Button component={RouterLink} to="/notes/libraries" startIcon={<ArrowBackIcon />} sx={{ mt: 2 }}>
          Note libraries
        </Button>
      </Box>
    );
  }

  const save = async (field: 'name' | 'autoExtract' | 'autoCommit', patch: Parameters<typeof update>[0], done: string) => {
    setSaving(field);
    try {
      await update(patch);
      if (isMounted()) setNotice({ severity: 'success', text: done });
    } catch (err) {
      if (isMounted()) setNotice({ severity: 'error', text: err instanceof Error ? err.message : 'The change was not saved.' });
    } finally {
      if (isMounted()) setSaving(null);
    }
  };

  const onRename = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!library || trimmed === '' || trimmed === library.name) return;
    void save('name', { name: trimmed }, 'Library renamed.');
  };

  const rescan = async () => {
    if (!library) return;
    let ref;
    try {
      ref = await folderForSync(library.id);
    } catch (err) {
      setNotice({ severity: 'error', text: syncErrorMessage(err) });
      return;
    }
    if (!ref) return;
    const result = await runner.start(library, ref);
    if (!isMounted()) return;
    void refresh();
    void batches.refresh();
    if (!result) return;
    if (result.batchId && !result.cancelled && result.plan.uploadPaths.length > 0) {
      const state: NoteImportNavigationState = result.failed.length > 0 ? { uploadFailures: result.failed } : {};
      navigate(noteImportBatchPath(result.batchId), { state });
    } else if (!result.cancelled) {
      setNotice({
        severity: 'info',
        text:
          result.plan.missingCount > 0
            ? `No new or changed notes; ${pluralize(result.plan.missingCount, 'file')} no longer in the folder.`
            : 'Everything is up to date.',
      });
    }
  };

  const onRemove = async () => {
    if (!libraryId) return;
    setRemoving(true);
    try {
      await remove();
      await port.setLibraryFolder(libraryId, null).catch(() => undefined);
      navigate('/notes/libraries');
    } catch (err) {
      if (isMounted()) {
        setNotice({ severity: 'error', text: err instanceof Error ? err.message : 'The library was not removed.' });
        setConfirmRemove(false);
      }
    } finally {
      if (isMounted()) setRemoving(false);
    }
  };

  const syncing = runner.runningLibraryId !== null;
  const percent = runner.progress ? syncProgressPercent(runner.progress) : undefined;

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Button component={RouterLink} to="/notes/libraries" startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 1 }}>
        Note libraries
      </Button>
      {error && !library && <Alert severity="error">{error}</Alert>}
      {isLoading && !library && <LinearProgress aria-label="Loading the library" />}

      {library && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="h5" component="h1" sx={{ wordBreak: 'break-word' }}>
                {library.name}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.secondary', mt: 0.5 }}>
                {folder ? <FolderIcon fontSize="small" aria-hidden /> : <LinkOffIcon fontSize="small" aria-hidden />}
                <Typography variant="body2">
                  {folder === undefined
                    ? 'Looking for the folder…'
                    : folder
                      ? folder.name
                      : 'Folder not connected on this device'}
                  {' · '}
                  {library.lastScanAt ? `last scanned ${formatRelativeTime(library.lastScanAt)}` : 'never scanned'}
                </Typography>
              </Box>
            </Box>
            {canWrite && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {folder === null && !repickEachScan && (
                  <Button
                    variant="outlined"
                    onClick={() => {
                      void connect(library.id).catch((err: unknown) =>
                        setNotice({ severity: 'error', text: syncErrorMessage(err) }),
                      );
                    }}
                    disabled={syncing}
                  >
                    Connect folder
                  </Button>
                )}
                {syncing ? (
                  <Button variant="outlined" onClick={runner.stop}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    startIcon={<SyncIcon />}
                    onClick={() => void rescan()}
                    disabled={folder === undefined || (folder === null && !repickEachScan)}
                  >
                    Rescan
                  </Button>
                )}
              </Box>
            )}
          </Box>

          {runner.progress && syncing && (
            <Box role="status" aria-live="polite" sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                {describeSyncProgress(runner.progress)}
              </Typography>
              <LinearProgress
                variant={percent === undefined ? 'indeterminate' : 'determinate'}
                {...(percent === undefined ? {} : { value: percent })}
                aria-label="Rescan progress"
              />
            </Box>
          )}
          {runner.error && (
            <Alert severity="error" onClose={runner.clearError} sx={{ mb: 2 }}>
              {runner.error}
            </Alert>
          )}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 3 }} aria-label="Files in this library">
            <Chip label={`${library.counts.total.toLocaleString()} files`} />
            <Chip color="success" variant="outlined" label={`${library.counts.imported.toLocaleString()} imported`} />
            {library.counts.failed > 0 && <Chip color="error" variant="outlined" label={`${library.counts.failed.toLocaleString()} failed`} />}
            {library.counts.missing > 0 && <Chip color="warning" variant="outlined" label={`${library.counts.missing.toLocaleString()} missing`} />}
            {library.counts.diverged > 0 && (
              <Chip color="warning" variant="outlined" label={`${library.counts.diverged.toLocaleString()} edited since import`} />
            )}
            {library.counts.unsupported > 0 && <Chip variant="outlined" label={`${library.counts.unsupported.toLocaleString()} unsupported`} />}
            {library.counts.pending > 0 && <Chip variant="outlined" label={`${library.counts.pending.toLocaleString()} pending`} />}
          </Box>

          <Paper variant="outlined" component="section" aria-labelledby="library-settings-title" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
            <Typography id="library-settings-title" variant="h6" component="h2" sx={{ mb: 2 }}>
              Settings
            </Typography>
            <Box component="form" onSubmit={onRename} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 2 }}>
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                size="small"
                disabled={!canWrite || saving !== null}
                slotProps={{ htmlInput: { maxLength: 120 } }}
                sx={{ flex: 1, minWidth: 200 }}
              />
              {canWrite && (
                <Button
                  type="submit"
                  variant="outlined"
                  disabled={saving !== null || name.trim() === '' || name.trim() === library.name}
                >
                  {saving === 'name' ? 'Saving…' : 'Rename'}
                </Button>
              )}
            </Box>
            <FormControlLabel
              control={
                <Switch
                  checked={library.autoExtract}
                  disabled={!canWrite || saving !== null}
                  onChange={(_, checked) =>
                    void save(
                      'autoExtract',
                      { autoExtract: checked },
                      checked ? 'New notes from this library will be read for the knowledge graph.' : 'Auto-extract is off.',
                    )
                  }
                />
              }
              label="Auto-extract"
            />
            <FormHelperText sx={{ mt: -0.5, mb: 1.5, ml: 0 }}>
              Read every imported note for people, projects and facts, using your AI key. Proposals wait for your review.
            </FormHelperText>
            <FormControlLabel
              control={
                <Switch
                  checked={library.autoCommit}
                  disabled={!canWrite || saving !== null || (!library.autoExtract && !library.autoCommit)}
                  onChange={(_, checked) => {
                    if (checked) setConfirmAutoCommit(true);
                    else void save('autoCommit', { autoCommit: false }, 'Auto-commit is off: every proposal waits for review.');
                  }}
                />
              }
              label="Auto-commit"
            />
            <FormHelperText sx={{ mt: -0.5, mb: 2, ml: 0 }}>
              {library.autoExtract
                ? `Add safe proposals to the graph without review. ${AUTO_COMMIT_SAFE_POLICY_TEXT}`
                : 'Turn on Auto-extract first.'}
            </FormHelperText>
            {canWrite && (
              <Button color="error" variant="outlined" startIcon={<DeleteIcon />} onClick={() => setConfirmRemove(true)}>
                Remove library
              </Button>
            )}
          </Paper>

          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            Recent imports
          </Typography>
          {batches.error && <Alert severity="error">{batches.error}</Alert>}
          {batches.isLoading && batches.batches.length === 0 ? (
            <LinearProgress aria-label="Loading imports" sx={{ mb: 3 }} />
          ) : batches.batches.length === 0 ? (
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              No imports yet. Rescan to import the folder.
            </Typography>
          ) : (
            <Paper variant="outlined" sx={{ mb: 3 }}>
              <List aria-label="Recent imports" disablePadding>
                {batches.batches.map((batch, index) => (
                  <ListItemButton
                    key={batch.id}
                    component={RouterLink}
                    to={noteImportBatchPath(batch.id)}
                    divider={index < batches.batches.length - 1}
                  >
                    <ListItemText
                      primary={`${BATCH_STATUS_LABEL[batch.status] ?? batch.status} · ${formatRelativeTime(batch.createdAt)}`}
                      secondary={batchSummary(batch)}
                    />
                  </ListItemButton>
                ))}
              </List>
            </Paper>
          )}

          {latestBatchId && (
            <>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                <Typography variant="h6" component="h2">
                  Files in the latest import
                </Typography>
                <Link component={RouterLink} to={noteImportBatchPath(latestBatchId)} variant="body2">
                  Open the import
                </Link>
              </Box>
              <Box role="group" aria-label="Filter files by status" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                {FILE_FILTERS.map(({ status, label }) => {
                  const selected = fileFilter === status;
                  return (
                    <Chip
                      key={label}
                      label={label}
                      color={selected ? 'primary' : 'default'}
                      variant={selected ? 'filled' : 'outlined'}
                      onClick={() => setFileFilter(status)}
                      aria-pressed={selected}
                    />
                  );
                })}
              </Box>
              <ImportBatchItemList
                items={files.items}
                isLoading={files.isLoading}
                error={files.error}
                hasMore={files.hasMore}
                isLoadingMore={files.isLoadingMore}
                onLoadMore={() => void files.loadMore()}
                emptyText={fileFilter ? 'No files with this status.' : 'No files in this import.'}
              />
            </>
          )}
        </>
      )}

      {runner.dialog}

      <Dialog open={confirmAutoCommit} onClose={() => setConfirmAutoCommit(false)} aria-labelledby="auto-commit-title">
        <DialogTitle id="auto-commit-title">Add proposals to the graph without review?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            With Auto-commit on, what KVox extracts from this library’s notes goes straight into your knowledge graph
            when it is safe to. {AUTO_COMMIT_SAFE_POLICY_TEXT} You can undo a commit from the graph.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAutoCommit(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmAutoCommit(false);
              void save('autoCommit', { autoCommit: true }, 'Auto-commit is on.');
            }}
          >
            Turn on Auto-commit
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRemove} onClose={() => !removing && setConfirmRemove(false)} aria-labelledby="remove-library-title">
        <DialogTitle id="remove-library-title">Remove “{library?.name}”?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            KVox stops keeping this folder in sync. The notes already imported from it are kept, and nothing in the
            folder is touched.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)} disabled={removing}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={() => void onRemove()} disabled={removing}>
            {removing ? 'Removing…' : 'Remove library'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={notice?.severity === 'error' ? null : 6000}
        onClose={(_, reason) => {
          if (reason !== 'clickaway') setNotice(null);
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Box sx={{ maxWidth: 560 }}>
          {notice ? (
            <Alert severity={notice.severity} onClose={() => setNotice(null)}>
              {notice.text}
            </Alert>
          ) : undefined}
        </Box>
      </Snackbar>
    </Box>
  );
}
