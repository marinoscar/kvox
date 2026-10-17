/**
 * "Import transcript (JSON)" — issue #571.
 *
 * Creates a transcript from a `kvox.transcript/v1` file (the JSON the export
 * dialog writes) and opens it. The button is a real `<button>` that opens a
 * `hidden` `<input type="file">` (out of the tab order and the accessibility
 * tree), so a click, Enter or Space opens the native picker and the keyboard
 * meets exactly one control.
 *
 * Offered only to a viewer holding `transcripts:write`, which is what
 * `POST /api/transcripts/imports` enforces, the same rule the library's
 * "New transcript" action follows. The API is still the authority.
 *
 * The file is checked in the browser first (empty, over the size limit), so an
 * oversized file is refused before any bytes are sent; every other refusal is
 * the API's, worded by `transcriptImportErrorMessage`.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useIsMounted, useKvoxHost, useKvoxPermissionCheck } from '../../../core/headless/index.js';
import {
  TRANSCRIPT_IMPORT_ACCEPT,
  checkTranscriptImportFile,
  importTranscript,
  transcriptImportErrorMessage,
} from '../../headless/clients/transcriptImports.js';
import { visuallyHidden } from '../visuallyHidden.js';

/**
 * Props of {@link ImportTranscriptButton}.
 *
 * @stability experimental
 */
export interface ImportTranscriptButtonProps {
  /**
   * Where a failure is shown. `inline` (default) puts the error under the button;
   * `snackbar` floats it, for a button sitting in a page header where an inline
   * alert would push the heading around.
   */
  errorPlacement?: 'inline' | 'snackbar';
  /** The button's variant. Default `outlined`, a secondary action. */
  variant?: 'text' | 'outlined' | 'contained';
}

/**
 * The visible label, and the button's accessible name.
 *
 * @stability experimental
 */
export const IMPORT_TRANSCRIPT_LABEL = 'Import transcript (JSON)';

/**
 * The import action: choose a transcript JSON export, upload it, open the new transcript.
 *
 * Renders nothing for a viewer without `transcripts:write`.
 *
 * @param props - Where errors go and the button's variant.
 * @returns The button, or nothing.
 *
 * @stability experimental
 */
export function ImportTranscriptButton({
  errorPlacement = 'inline',
  variant = 'outlined',
}: ImportTranscriptButtonProps = {}) {
  const host = useKvoxHost();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const hasPermission = useKvoxPermissionCheck();
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared so choosing the SAME file again after a refusal still fires
      // `change`: the input compares values, not intent.
      event.target.value = '';
      if (!file) return;

      setError(null);
      const refusal = checkTranscriptImportFile(file);
      if (refusal) {
        setError(refusal);
        return;
      }

      setIsImporting(true);
      try {
        const created = await importTranscript(host, file);
        if (!isMounted()) return;
        navigate(host.links.transcript(created.id));
      } catch (err) {
        if (!isMounted()) return;
        setError(transcriptImportErrorMessage(err));
      } finally {
        if (isMounted()) setIsImporting(false);
      }
    },
    [host, isMounted, navigate],
  );

  if (!hasPermission('transcripts:write')) return null;

  const alert = error ? (
    <Alert severity="error" onClose={() => setError(null)} sx={{ mt: errorPlacement === 'inline' ? 1.5 : 0 }}>
      {error}
    </Alert>
  ) : null;

  return (
    <Box>
      <Button
        variant={variant}
        onClick={() => inputRef.current?.click()}
        disabled={isImporting}
        startIcon={
          isImporting ? <CircularProgress size={16} color="inherit" aria-hidden /> : <FileUploadIcon />
        }
        sx={{ whiteSpace: 'nowrap' }}
      >
        {isImporting ? 'Importing…' : IMPORT_TRANSCRIPT_LABEL}
      </Button>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={TRANSCRIPT_IMPORT_ACCEPT}
        aria-label="Choose a transcript JSON file"
        onChange={(event) => void handleFile(event)}
        disabled={isImporting}
      />
      {/* Announced while the upload runs, since the button's own label change
          is not reliably read out once it is disabled. */}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {isImporting ? 'Importing the transcript…' : ''}
      </Box>
      {errorPlacement === 'inline' ? (
        alert
      ) : (
        <Snackbar
          open={Boolean(error)}
          onClose={(_, reason) => {
            // A stray click elsewhere must not dismiss a message the reader
            // may not have finished; the alert's own close button does.
            if (reason !== 'clickaway') setError(null);
          }}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
          <Box sx={{ maxWidth: 560 }}>{alert}</Box>
        </Snackbar>
      )}
    </Box>
  );
}
