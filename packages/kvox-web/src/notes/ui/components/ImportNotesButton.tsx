/**
 * "Import notes": choose one or more documents (Markdown, text, PDF, Word,
 * PowerPoint), upload them as an ad-hoc import batch, and open the batch's progress
 * page (issue #720, epic #708).
 *
 * A real `<button>` opens a `hidden` `<input type="file" multiple>` (out of the tab
 * order and the accessibility tree), the same pattern as `ImportTranscriptButton`.
 * Offered only to a viewer holding `notes:write`, which is what the import routes
 * enforce; the API is still the authority.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import { useRef } from 'react';
import type { ChangeEvent } from 'react';

import { NOTE_IMPORT_ACCEPT } from '@marinoscar/kvox-contract/notes';

import { useKvoxPermissionCheck } from '../../../core/headless/index.js';
import { NOTE_IMPORT_DEFAULT_MAX_BYTES } from '../../headless/index.js';
import { useAdHocNoteImport } from '../library/useAdHocNoteImport.js';
import { visuallyHidden } from '../visuallyHidden.js';

/**
 * Props of {@link ImportNotesButton}.
 *
 * @stability experimental
 */
export interface ImportNotesButtonProps {
  /** The largest file accepted before upload, in bytes. Default 25 MiB (the server's default). */
  maxBytes?: number;
  /** The button's variant. Default `outlined`, a secondary action. */
  variant?: 'text' | 'outlined' | 'contained';
  /** The visible label. Default "Import notes". */
  label?: string;
}

/**
 * The import action: pick documents, upload them, open the import's progress page.
 * Renders nothing for a viewer without `notes:write`.
 *
 * @param props - See {@link ImportNotesButtonProps}.
 * @returns The button, or nothing.
 *
 * @stability experimental
 */
export function ImportNotesButton({
  maxBytes = NOTE_IMPORT_DEFAULT_MAX_BYTES,
  variant = 'outlined',
  label = 'Import notes',
}: ImportNotesButtonProps = {}) {
  const hasPermission = useKvoxPermissionCheck();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { importFiles, isImporting, progress, error, clearError } = useAdHocNoteImport(maxBytes);

  if (!hasPermission('notes:write')) return null;

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Cleared so choosing the SAME files again after a refusal still fires `change`.
    event.target.value = '';
    if (files.length > 0) void importFiles(files);
  };

  const busyLabel =
    progress && progress.total > 0
      ? `Uploading ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}…`
      : 'Importing…';

  return (
    <Box>
      <Button
        variant={variant}
        onClick={() => inputRef.current?.click()}
        disabled={isImporting}
        startIcon={isImporting ? <CircularProgress size={16} color="inherit" aria-hidden /> : <FileUploadIcon />}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {isImporting ? busyLabel : label}
      </Button>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={NOTE_IMPORT_ACCEPT}
        aria-label="Choose notes to import"
        onChange={handleFiles}
        disabled={isImporting}
      />
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {isImporting ? busyLabel : ''}
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
