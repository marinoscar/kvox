/**
 * Take a note out of this application — issue #58, epic #45, spec §8.
 *
 * =============================================================================
 * ⚠ THE FORM IS BUILT FROM `GET /api/notes/exporters`, NOT FROM A LIST IN HERE
 * =============================================================================
 *
 * The registry publishes every format WITH its option list — key, label,
 * description, type, default — and this dialog renders whatever comes back.
 * There is no `if (format === 'markdown')` below and there must never be one:
 * the API's promise that adding a format costs one class only holds if the
 * client has stopped needing to know the formats. A deployment that registers a
 * fourth exporter offers it here immediately, with its own checkboxes, and
 * nothing in `apps/web` changes.
 *
 * The `option.type === 'boolean'` check on each field is the same discipline in
 * the other direction: a future non-boolean option renders NOTHING rather than
 * a checkbox that would send the wrong shape and be refused with a 400.
 *
 * =============================================================================
 * THE CURRENT VERSION IS WHAT GETS EXPORTED, AND THE DIALOG SAYS SO
 * =============================================================================
 *
 * The API will export any version in the history. This dialog deliberately
 * offers only the CURRENT one and states that in words. A version picker here
 * would be a second, weaker copy of the history page — which already shows what
 * each version contains, which is the only way to choose between them
 * meaningfully — and a user exporting the wrong version has no way to tell from
 * the file until they open it. Someone who wants an older version restores it
 * there (a restore APPENDS, losing nothing) and exports the result.
 *
 * =============================================================================
 * A REUSED EXPORT MUST NOT LOOK LIKE A STALL
 * =============================================================================
 *
 * `POST` answers 202 with a `pending` row, or 200 with one that already exists
 * — `reused` says which. A reused export is already `ready`, so the loop below
 * settles on the FIRST answer and the download is offered immediately. That is
 * the whole point of #54's content addressing, and a dialog that spun for two
 * seconds anyway would hide the one path that is genuinely free.
 *
 * ⚠ EVERY ASYNC RESOLUTION IS GUARDED BY A GENERATION COUNTER. A user who
 * switches format mid-poll, or closes the dialog, has a request in flight whose
 * response would otherwise land on top of the new state.
 *
 * ⚠ THE TIMEOUT IS NOT A CANCELLATION. Nothing client-side can stop a queued
 * render, and this dialog does not pretend otherwise: it says the export is
 * still being made and that asking again will pick it up — which is true,
 * because the identical request reuses the row.
 *
 * THE DOWNLOAD IS A SIGNED URL AND IT IS OPENED, NOT FETCHED. The
 * `Content-Disposition` with the server-chosen filename is signed INTO the URL;
 * fetching the bytes into a blob would pull a possibly-large file through the
 * tab's memory and throw that filename away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';

import {
  NOTE_EXPORT_POLL_INTERVAL_MS,
  NOTE_EXPORT_POLL_TIMEOUT_MS,
  createNoteExport,
  defaultNoteExportOptions,
  formatNoteExportSize,
  getNoteExport,
  getNoteExporters,
  isSettled,
} from '../../services/noteExports';
import type { NoteExport, NoteExporter } from '../../services/noteExports';

export interface NoteExportDialogProps {
  open: boolean;
  onClose: () => void;
  noteId: string;
  /** For the "this is what gets exported" line. The filename is server-chosen. */
  currentVersion: number;
}

/** What the dialog is doing right now. */
type Phase = 'form' | 'working' | 'ready' | 'error' | 'timeout';

export function NoteExportDialog({
  open,
  onClose,
  noteId,
  currentVersion,
}: NoteExportDialogProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const [exporters, setExporters] = useState<NoteExporter[] | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<NoteExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Bumped on every open, every format change and every unmount. See the header. */
  const runId = useRef(0);

  const selected = useMemo(
    () => exporters?.find((exporter) => exporter.format === format) ?? null,
    [exporters, format],
  );

  useEffect(() => {
    if (!open) return;

    runId.current += 1;

    const run = runId.current;

    setPhase('form');
    setResult(null);
    setError(null);

    void (async () => {
      try {
        const available = await getNoteExporters();

        if (runId.current !== run) return;

        setExporters(available);

        const first = available[0] ?? null;

        setFormat(first?.format ?? null);
        setOptions(first ? defaultNoteExportOptions(first) : {});
      } catch (cause) {
        if (runId.current !== run) return;

        setExporters([]);
        setPhase('error');
        setError(messageOf(cause, 'The available export formats could not be loaded.'));
      }
    })();
  }, [noteId, open]);

  useEffect(
    () => () => {
      runId.current += 1;
    },
    [],
  );

  const start = useCallback(async () => {
    if (!selected) return;

    runId.current += 1;

    const run = runId.current;

    setPhase('working');
    setError(null);
    setResult(null);

    try {
      let row: NoteExport | null = await createNoteExport(noteId, {
        format: selected.format,
        options,
      });

      const deadline = Date.now() + NOTE_EXPORT_POLL_TIMEOUT_MS;

      // ⚠ A REUSED EXPORT NEVER ENTERS THIS LOOP: it comes back `ready`, so the
      // condition is false on the first evaluation and the download is offered
      // on the same tick the dialog was asked.
      while (row !== null && !isSettled(row)) {
        if (Date.now() > deadline) {
          if (runId.current === run) setPhase('timeout');

          return;
        }

        await delay(NOTE_EXPORT_POLL_INTERVAL_MS);

        if (runId.current !== run) return;

        row = await getNoteExport(noteId, row.id);
      }

      if (runId.current !== run) return;

      if (row === null) {
        // The list stopped carrying it — an expiry mid-poll. Not a failure of
        // the render, and asking again is genuinely the right answer here.
        setPhase('error');
        setError('That export is no longer available. Export again to make a fresh one.');

        return;
      }

      setResult(row);

      if (row.status === 'failed') {
        setPhase('error');
        setError(row.error ?? 'The export could not be rendered.');

        return;
      }

      setPhase('ready');
    } catch (cause) {
      if (runId.current !== run) return;

      setPhase('error');
      setError(messageOf(cause, 'The export could not be started.'));
    }
  }, [noteId, options, selected]);

  const download = useCallback(() => {
    if (!result?.downloadUrl) return;

    // See the header: hand the browser the signed URL rather than fetching the
    // bytes — the filename is signed into the URL's own disposition.
    window.open(result.downloadUrl, '_blank', 'noopener,noreferrer');
  }, [result]);

  const chooseFormat = useCallback(
    (next: string) => {
      const exporter = exporters?.find((candidate) => candidate.format === next) ?? null;

      setFormat(next);
      setOptions(exporter ? defaultNoteExportOptions(exporter) : {});
      // A format change invalidates any finished export shown below it: the
      // Download button must not keep offering the previous format's file.
      setResult(null);
      setError(null);
      setPhase('form');
      runId.current += 1;
    },
    [exporters],
  );

  const busy = phase === 'working';

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={isCompactWindow}
      aria-labelledby="note-export-title"
    >
      <DialogTitle id="note-export-title">Export note</DialogTitle>

      <DialogContent dividers>
        {exporters === null ? (
          <Stack sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress aria-label="Loading export formats" />
          </Stack>
        ) : (
          <Stack spacing={3}>
            {/* WHAT GETS EXPORTED, said before anything is chosen. See the
                header for why there is no version picker. */}
            <Typography variant="body2" color="text.secondary">
              Exporting <strong>version {currentVersion}</strong> — the note as it is right now.
              To export an older version, restore it from the history first; restoring loses
              nothing.
            </Typography>

            <FormControl>
              <FormLabel id="note-export-format-label">Format</FormLabel>
              <RadioGroup
                aria-labelledby="note-export-format-label"
                value={format ?? ''}
                onChange={(event) => chooseFormat(event.target.value)}
              >
                {exporters.map((exporter) => (
                  <FormControlLabel
                    key={exporter.format}
                    value={exporter.format}
                    control={<Radio disabled={busy} />}
                    label={exporter.label}
                  />
                ))}
              </RadioGroup>
            </FormControl>

            {selected && selected.options.length > 0 && (
              <FormControl component="fieldset" variant="standard">
                <FormLabel component="legend">{selected.label} options</FormLabel>
                <FormGroup>
                  {selected.options.map((option) =>
                    // A future non-boolean option renders nothing rather than a
                    // checkbox that would send the wrong shape. See the header.
                    option.type === 'boolean' ? (
                      <Box key={option.key} sx={{ mb: 1 }}>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={options[option.key] ?? option.default}
                              disabled={busy}
                              onChange={(event) => {
                                setOptions((current) => ({
                                  ...current,
                                  [option.key]: event.target.checked,
                                }));
                                setResult(null);
                                setPhase('form');
                              }}
                            />
                          }
                          label={option.label}
                        />
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', ml: 4, mt: -0.5 }}
                        >
                          {option.description}
                        </Typography>
                      </Box>
                    ) : null,
                  )}
                </FormGroup>
              </FormControl>
            )}

            {busy && (
              <Box>
                <LinearProgress aria-label="Rendering the export" />
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Rendering your export. This keeps running even if you put your phone down.
                </Typography>
              </Box>
            )}

            {phase === 'timeout' && (
              <Alert severity="info">
                This export is taking longer than expected. It is still being rendered — export
                again with the same options in a moment and it will be waiting for you.
              </Alert>
            )}

            {phase === 'error' && error !== null && <Alert severity="error">{error}</Alert>}

            {phase === 'ready' && result !== null && (
              <Alert severity="success" data-testid="note-export-ready">
                <Typography variant="body2">
                  <strong>{result.filename}</strong>
                  {formatNoteExportSize(result.sizeBytes) !== null &&
                    ` · ${formatNoteExportSize(result.sizeBytes)}`}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {result.reused
                    ? 'You already exported this — here it is again, no waiting.'
                    : 'Exports are kept for seven days. Asking for the same one again is free.'}
                </Typography>
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        {phase === 'ready' && result?.downloadUrl ? (
          <Button
            variant="contained"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={download}
          >
            Download
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={() => void start()}
            disabled={busy || selected === null}
          >
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** An error's message, or a sentence that says what failed. */
function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default NoteExportDialog;
