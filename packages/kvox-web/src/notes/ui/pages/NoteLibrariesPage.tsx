/**
 * `/notes/libraries`: the folders of existing notes KVox keeps in sync (issue #720,
 * epic #708).
 *
 * "Add folder" asks for a folder on this device, makes a library named after it,
 * binds the two (on this device only), scans, shows what the import will cost, and
 * on Start uploads and opens the import's progress page. Each library is a card with
 * Rescan (progress inline) and Open. With no library yet the page explains the
 * feature around one big button. Loose files can be dropped anywhere on the page.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { useIsMounted, useKvoxHost, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { LibraryPageFrame } from '../../../core/ui/index.js';
import { createNoteLibrary, useNoteLibraries } from '../../headless/index.js';
import type { LibrarySyncResult } from '../../headless/index.js';
import { ImportNotesButton } from '../components/ImportNotesButton.js';
import { NoteLibraryCard } from '../components/NoteLibraryCard.js';
import { NotesDropZone } from '../components/NotesDropZone.js';
import { pluralize } from '../library/format.js';
import { noteImportBatchPath } from '../library/useAdHocNoteImport.js';
import type { NoteImportNavigationState } from '../library/useAdHocNoteImport.js';
import { useLibraryFolders } from '../library/useLibraryFolders.js';
import { syncErrorMessage, useLibrarySyncRunner } from '../library/useLibrarySyncRunner.js';

/**
 * Props of {@link NoteLibrariesPage}.
 *
 * @stability experimental
 */
export interface NoteLibrariesPageProps {
  /** Upload one file at a time (KVox Desktop). */
  sequential?: boolean;
}

/** What a library page tells the person after a sync that did not open a page. */
function syncOutcome(result: LibrarySyncResult): string {
  if (result.cancelled) return 'Nothing was uploaded.';
  if (result.plan.uploadPaths.length === 0) {
    return result.plan.missingCount > 0
      ? `No new or changed notes; ${pluralize(result.plan.missingCount, 'file')} no longer in the folder.`
      : 'Everything is up to date.';
  }
  const parts = [`${pluralize(result.uploaded, 'file')} uploaded`];
  if (result.skipped > 0) parts.push(`${result.skipped.toLocaleString()} already imported`);
  if (result.failed.length > 0) parts.push(`${result.failed.length.toLocaleString()} failed`);
  return `${parts.join(', ')}.`;
}

/**
 * The supported formats, as a sentence.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_FORMATS_TEXT = 'Markdown (.md), text (.txt), PDF, Word (.docx) and PowerPoint (.pptx)';

/**
 * `/notes/libraries`.
 *
 * @param props - See {@link NoteLibrariesPageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function NoteLibrariesPage({ sequential }: NoteLibrariesPageProps = {}) {
  const host = useKvoxHost();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const hasPermission = useKvoxPermissionCheck();
  const canWrite = hasPermission('notes:write');
  const { libraries, isLoading, error, refresh } = useNoteLibraries();
  const { folders, port, folderForSync, connect, remember } = useLibraryFolders(libraries.map((l) => l.id));
  const runner = useLibrarySyncRunner(sequential ? { sequential } : {});
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null);
  const [lastBatch, setLastBatch] = useState<Record<string, string>>({});
  const repickEachScan = !port.capabilities.persistentFolders;
  const busy = adding || runner.runningLibraryId !== null;

  const sync = async (library: (typeof libraries)[number], openBatch: boolean) => {
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
    if (!result) return;
    if (result.batchId) setLastBatch((previous) => ({ ...previous, [library.id]: result.batchId! }));
    if (openBatch && result.batchId && !result.cancelled && result.plan.uploadPaths.length > 0) {
      const state: NoteImportNavigationState = result.failed.length > 0 ? { uploadFailures: result.failed } : {};
      navigate(noteImportBatchPath(result.batchId), { state });
      return;
    }
    setNotice({ severity: result.failed.length > 0 ? 'error' : 'info', text: syncOutcome(result) });
  };

  const addFolder = async () => {
    setAdding(true);
    try {
      const ref = await port.pickFolder();
      if (!ref) return;
      const library = await createNoteLibrary(host, ref.name.slice(0, 120) || 'My notes');
      await port.setLibraryFolder(library.id, ref);
      if (!isMounted()) return;
      remember(library.id, ref);
      void refresh();
      setAdding(false);
      const result = await runner.start(library, ref);
      if (!isMounted() || !result) return;
      void refresh();
      if (result.batchId) setLastBatch((previous) => ({ ...previous, [library.id]: result.batchId! }));
      if (result.batchId && !result.cancelled && result.plan.uploadPaths.length > 0) {
        const state: NoteImportNavigationState = result.failed.length > 0 ? { uploadFailures: result.failed } : {};
        navigate(noteImportBatchPath(result.batchId), { state });
      } else if (result.plan.uploadPaths.length === 0 && !result.cancelled) {
        setNotice({
          severity: 'info',
          text: `No notes found in “${ref.name}”. KVox imports ${NOTE_IMPORT_FORMATS_TEXT}.`,
        });
      } else {
        setNotice({ severity: 'info', text: `Library “${library.name}” added. Rescan it when you are ready.` });
      }
    } catch (err) {
      if (isMounted()) setNotice({ severity: 'error', text: syncErrorMessage(err) });
    } finally {
      if (isMounted()) setAdding(false);
    }
  };

  const addButton = canWrite ? (
    <Button
      variant="contained"
      startIcon={<CreateNewFolderIcon />}
      onClick={() => void addFolder()}
      disabled={busy}
      sx={{ whiteSpace: 'nowrap' }}
    >
      {adding ? 'Adding…' : 'Add folder'}
    </Button>
  ) : null;

  const showEmpty = !isLoading && !error && libraries.length === 0;

  return (
    <NotesDropZone>
      <LibraryPageFrame
        title="Note libraries"
        action={null}
        secondaryAction={
          libraries.length > 0 ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <ImportNotesButton />
              {addButton}
            </Box>
          ) : undefined
        }
      >
        <Button component={RouterLink} to="/notes" startIcon={<ArrowBackIcon />} size="small" sx={{ mb: 1, mt: -1 }}>
          Notes
        </Button>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {isLoading && libraries.length === 0 && (
          <Box aria-busy="true" aria-label="Loading libraries">
            {[0, 1].map((row) => (
              <Skeleton key={row} variant="rectangular" height={140} sx={{ mb: 2, borderRadius: 1 }} />
            ))}
          </Box>
        )}

        {showEmpty && (
          <Paper variant="outlined" sx={{ p: { xs: 3, sm: 5 }, textAlign: 'center' }}>
            <FolderOpenIcon color="primary" sx={{ fontSize: 56 }} aria-hidden />
            <Typography variant="h6" component="h2" sx={{ mt: 1 }}>
              Bring in the notes you already have
            </Typography>
            <Typography color="text.secondary" sx={{ maxWidth: 520, mx: 'auto', mt: 1 }}>
              Point KVox at a folder of your notes and documents. Every file becomes a note you can search and ask
              about, and KVox can pull the people, projects and decisions in them into your knowledge graph. Rescan
              the folder any time to pick up new and changed files.
            </Typography>
            {canWrite ? (
              <Button
                variant="contained"
                size="large"
                startIcon={<CreateNewFolderIcon />}
                onClick={() => void addFolder()}
                disabled={busy}
                sx={{ mt: 3, px: 4, py: 1.5 }}
              >
                {adding ? 'Adding…' : 'Add your notes folder'}
              </Button>
            ) : (
              <Typography sx={{ mt: 2 }}>You can read notes here, but not import them.</Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Supported: {NOTE_IMPORT_FORMATS_TEXT}.
            </Typography>
            {canWrite && (
              <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Just a few files? Drop them on this page, or
                </Typography>
                <ImportNotesButton variant="text" label="Choose files" />
              </Box>
            )}
            {runner.progress && runner.runningLibraryId && (
              <Typography role="status" sx={{ mt: 2 }}>
                Scanning the folder…
              </Typography>
            )}
          </Paper>
        )}

        {libraries.length > 0 && (
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
            }}
          >
            {libraries.map((library) => (
              <NoteLibraryCard
                key={library.id}
                library={library}
                folder={folders[library.id]}
                repickEachScan={repickEachScan}
                canWrite={canWrite}
                progress={runner.runningLibraryId === library.id ? (runner.progress ?? { phase: 'enumerating', done: 0, total: 0, bytes: 0, totalBytes: 0, failed: [] }) : null}
                busyElsewhere={busy && runner.runningLibraryId !== library.id}
                error={runner.errorLibraryId === library.id ? runner.error : null}
                lastBatchId={lastBatch[library.id] ?? null}
                onRescan={() => void sync(library, false)}
                onConnect={() => {
                  void connect(library.id)
                    .then((ref) => {
                      if (ref) void sync(library, false);
                    })
                    .catch((err: unknown) => setNotice({ severity: 'error', text: syncErrorMessage(err) }));
                }}
                onStop={runner.stop}
              />
            ))}
          </Box>
        )}
        {runner.dialog}
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
      </LibraryPageFrame>
    </NotesDropZone>
  );
}
