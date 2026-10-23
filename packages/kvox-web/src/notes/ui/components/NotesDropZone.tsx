/**
 * Drop documents anywhere on a notes page to import them (issue #720).
 *
 * Wraps the page's content; while files are dragged over it an overlay reads "Drop
 * notes to import", and a drop goes through the same path as `ImportNotesButton`
 * (an ad-hoc batch, then its progress page). A folder dragged in contributes nothing:
 * folders are libraries ("Add folder"), which keep in sync.
 *
 * Only for a viewer holding `notes:write`; for anyone else the children render
 * unwrapped. The drop target is also announced in words (`aria-live`), since a drag
 * is a pointer gesture and the button beside the title is the keyboard route.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';

import { useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { NOTE_IMPORT_DEFAULT_MAX_BYTES } from '../../headless/index.js';
import { useAdHocNoteImport } from '../library/useAdHocNoteImport.js';
import { visuallyHidden } from '../visuallyHidden.js';

/**
 * Props of {@link NotesDropZone}.
 *
 * @stability experimental
 */
export interface NotesDropZoneProps {
  /** The page content the zone covers. */
  children: ReactNode;
  /** The largest file accepted before upload, in bytes. Default 25 MiB. */
  maxBytes?: number;
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * A drop target for documents to import as notes.
 *
 * @param props - See {@link NotesDropZoneProps}.
 * @returns The wrapped children.
 *
 * @stability experimental
 */
export function NotesDropZone({ children, maxBytes = NOTE_IMPORT_DEFAULT_MAX_BYTES }: NotesDropZoneProps) {
  const hasPermission = useKvoxPermissionCheck();
  const { importFiles, isImporting, progress, error, clearError } = useAdHocNoteImport(maxBytes);
  const [isOver, setIsOver] = useState(false);
  // dragenter/dragleave fire for every child crossed; count them so the overlay does not flicker.
  const depth = useRef(0);

  if (!hasPermission('notes:write')) return <>{children}</>;

  const onDragEnter = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setIsOver(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsOver(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setIsOver(false);
    // A dropped folder shows up as a zero-byte entry with no type: leave it out.
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.size > 0 || file.type !== '');
    if (files.length > 0) void importFiles(files);
  };

  return (
    <Box
      data-testid="notes-drop-zone"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      sx={{ position: 'relative', minHeight: '100%' }}
    >
      {children}
      {(isOver || isImporting) && (
        <Box
          aria-hidden
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: (theme) => theme.zIndex.modal - 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(0, 0, 0, 0.35)',
            pointerEvents: isImporting ? 'auto' : 'none',
            p: 2,
          }}
        >
          <Paper
            elevation={6}
            sx={{
              px: { xs: 3, sm: 6 },
              py: { xs: 3, sm: 5 },
              textAlign: 'center',
              border: 2,
              borderStyle: 'dashed',
              borderColor: 'primary.main',
              maxWidth: 420,
            }}
          >
            <CloudUploadIcon color="primary" sx={{ fontSize: 48 }} />
            <Typography variant="h6" component="p">
              {isImporting ? 'Uploading notes…' : 'Drop notes to import'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {isImporting && progress && progress.total > 0
                ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
                : 'Markdown, text, PDF, Word or PowerPoint'}
            </Typography>
          </Paper>
        </Box>
      )}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {isOver ? 'Drop notes to import' : isImporting ? 'Uploading notes…' : ''}
      </Box>
      <Snackbar
        open={Boolean(error)}
        onClose={(_, reason) => {
          if (reason !== 'clickaway') clearError();
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Box sx={{ maxWidth: 560 }}>
          {error ? (
            <Alert severity="error" onClose={clearError}>
              {error}
            </Alert>
          ) : undefined}
        </Box>
      </Snackbar>
    </Box>
  );
}
