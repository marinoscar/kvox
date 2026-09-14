/**
 * Take a transcript out of this application (issue #28, epic #19, spec §8).
 *
 * "The user should never need KVox in order to access information they created
 * with KVox." This dialog is where that promise is kept: pick a format, pick a
 * version, set the format's own options, and get a file.
 *
 * =============================================================================
 * THE FORM IS BUILT FROM THE SERVER'S ANSWER, NOT FROM A LIST COMPILED IN HERE
 * =============================================================================
 *
 * `GET /api/transcripts/exporters` returns each format WITH its options — key,
 * label, description, type, default — and this component renders whatever comes
 * back. There is no `if (format === 'markdown')` anywhere below and there must
 * never be one: the API's promise that "a future `docx` exporter is one new
 * class" only holds if the client stops needing to know the formats. A
 * deployment that registers a new exporter offers it here immediately, with its
 * own checkboxes, and nothing in `apps/web` changes.
 *
 * The `option.type === 'boolean'` check on each field is the same discipline in
 * the other direction: a future non-boolean option renders NOTHING rather than
 * a checkbox that would send the wrong shape and be refused.
 *
 * =============================================================================
 * POLLING, AND WHY IT STOPS BOTH WAYS
 * =============================================================================
 *
 * `POST` answers 202 with a `pending` export, or 200 with one that already
 * exists — `reused` says which, so an export that is already `ready` skips the
 * poll entirely and offers its download immediately. Otherwise the dialog asks
 * again every `EXPORT_POLL_INTERVAL_MS` until the export settles or
 * `EXPORT_POLL_TIMEOUT_MS` passes.
 *
 * ⚠ THE TIMEOUT IS NOT A CANCELLATION. Nothing client-side can stop a render
 * that is already queued, and this dialog deliberately does not pretend
 * otherwise: it says the export is taking longer than expected and that asking
 * again will pick it up — which is true, because the identical request reuses
 * the row rather than rendering a second time. Saying "failed" there would be a
 * lie about work that is still running.
 *
 * ⚠ EVERY ASYNC RESOLUTION IS GUARDED BY A GENERATION COUNTER. A user who
 * switches format mid-poll, or closes the dialog, has a request in flight whose
 * response would otherwise land on top of the new state — the classic
 * stale-response bug, and the reason `runId` is compared before every
 * `setState` below rather than only on unmount.
 *
 * =============================================================================
 * THE DOWNLOAD IS A SIGNED URL, AND IT OPENS RATHER THAN FETCHING
 * =============================================================================
 *
 * `downloadUrl` is a short-lived signed URL at the storage provider carrying a
 * `Content-Disposition: attachment` the API signed INTO it. So the browser is
 * handed the URL directly instead of the app fetching the bytes and making a
 * blob: fetching would pull a possibly-large file through the tab's memory,
 * require CORS at the bucket, and throw away the server-chosen filename that is
 * the entire reason the disposition was signed.
 *
 * =============================================================================
 * FULL SCREEN ON PHONES
 * =============================================================================
 *
 * `down('sm')`, following `BroadcastComposer` — one of the five coupled
 * breakpoint gates CLAUDE.md's Settings UI rule 5 names. The boundary is `sm`
 * (600px) and never `md`, which would hand the phone treatment to tablets and
 * landscape phones.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  LinearProgress,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import {
  EXPORT_POLL_INTERVAL_MS,
  EXPORT_POLL_TIMEOUT_MS,
  createExport,
  defaultOptionsFor,
  formatExportSize,
  getExport,
  getExporters,
  getExportableVersions,
  isSettled,
} from '../../services/transcriptExports';
import type {
  TranscriptExport,
  TranscriptExporter,
  TranscriptVersionOption,
} from '../../services/transcriptExports';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  transcriptId: string;
  /** For the "which version" labels; the filename itself is server-chosen. */
  currentVersion: number;
}

/** What the dialog is doing right now. */
type Phase = 'form' | 'working' | 'ready' | 'error' | 'timeout';

export function ExportDialog({
  open,
  onClose,
  transcriptId,
  currentVersion,
}: ExportDialogProps) {
  const theme = useTheme();
  // The `down('sm')` compact-window convention, shared with `SettingsHub.tsx`,
  // `AppBar.tsx` and `BroadcastComposer.tsx` — CLAUDE.md's rule 5 gates.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const [exporters, setExporters] = useState<TranscriptExporter[] | null>(null);
  const [versions, setVersions] = useState<TranscriptVersionOption[]>([]);
  const [format, setFormat] = useState<string | null>(null);
  const [version, setVersion] = useState<number>(currentVersion);
  const [options, setOptions] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<TranscriptExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Bumped on every open, every format change and every unmount.
   *
   * See the file header: a response that resolves after the user has moved on
   * must not write to state. Comparing this before each `setState` is what
   * makes that true for the poll loop as well as for the one-shot reads.
   */
  const runId = useRef(0);

  const selected = useMemo(
    () => exporters?.find((exporter) => exporter.format === format) ?? null,
    [exporters, format],
  );

  // ---------------------------------------------------------------------------
  // Loading the form's own contents
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!open) return;

    runId.current += 1;

    const run = runId.current;

    setPhase('form');
    setResult(null);
    setError(null);
    setVersion(currentVersion);

    void (async () => {
      try {
        const available = await getExporters();

        if (runId.current !== run) return;

        setExporters(available);

        const first = available[0] ?? null;

        setFormat(first?.format ?? null);
        setOptions(first ? defaultOptionsFor(first) : {});
      } catch (cause) {
        if (runId.current !== run) return;

        setExporters([]);
        setPhase('error');
        setError(messageOf(cause, 'The available export formats could not be loaded.'));
      }

      try {
        const history = await getExportableVersions(transcriptId);

        if (runId.current !== run) return;

        setVersions(history);
      } catch {
        // A version list that will not load is NOT an error worth blocking the
        // export for: the current version — the default, and the one almost
        // every export wants — needs no history to be selectable. The picker
        // quietly falls back to offering only that.
        if (runId.current === run) setVersions([]);
      }
    })();
  }, [open, transcriptId, currentVersion]);

  useEffect(() => () => {
    runId.current += 1;
  }, []);

  // ---------------------------------------------------------------------------
  // Submitting, and polling until it settles
  // ---------------------------------------------------------------------------

  const start = useCallback(async () => {
    if (!selected) return;

    runId.current += 1;

    const run = runId.current;

    setPhase('working');
    setError(null);
    setResult(null);

    try {
      let row = await createExport(transcriptId, {
        format: selected.format,
        version,
        options,
      });

      const deadline = Date.now() + EXPORT_POLL_TIMEOUT_MS;

      while (!isSettled(row)) {
        if (Date.now() > deadline) {
          if (runId.current === run) setPhase('timeout');

          return;
        }

        await delay(EXPORT_POLL_INTERVAL_MS);

        if (runId.current !== run) return;

        row = await getExport(transcriptId, row.id);
      }

      if (runId.current !== run) return;

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
  }, [options, selected, transcriptId, version]);

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
      setOptions(exporter ? defaultOptionsFor(exporter) : {});
      // A format change invalidates any finished export shown below it: the
      // "Download" button must not keep offering the previous format's file.
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
      aria-labelledby="transcript-export-title"
    >
      <DialogTitle id="transcript-export-title">Export transcript</DialogTitle>

      <DialogContent dividers>
        {exporters === null ? (
          <Stack sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress aria-label="Loading export formats" />
          </Stack>
        ) : (
          <Stack spacing={3}>
            <FormControl>
              <FormLabel id="transcript-export-format-label">Format</FormLabel>
              <RadioGroup
                aria-labelledby="transcript-export-format-label"
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

            <TextField
              select
              fullWidth
              label="Version"
              value={version}
              disabled={busy}
              onChange={(event) => {
                setVersion(Number(event.target.value));
                setResult(null);
                setPhase('form');
              }}
              helperText="Any version in the history can be exported, exactly as it was saved."
              slotProps={{ htmlInput: { 'aria-label': 'Version' } }}
            >
              {versionChoices(versions, currentVersion).map((choice) => (
                <MenuItem key={choice.version} value={choice.version}>
                  {choice.label}
                </MenuItem>
              ))}
            </TextField>

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
                  Rendering your export. This stays running even if you put your phone down.
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
              <>
                <Divider />
                <Alert severity="success" data-testid="export-ready">
                  <Typography variant="body2">
                    <strong>{result.filename}</strong>
                    {formatExportSize(result.sizeBytes) !== null &&
                      ` · ${formatExportSize(result.sizeBytes)}`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Exports are kept for seven days. Asking for the same one again is free.
                  </Typography>
                </Alert>
              </>
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

/** One entry in the version dropdown. */
interface VersionChoice {
  version: number;
  label: string;
}

/**
 * The version picker's contents: the history when it loaded, the current
 * version alone when it did not.
 *
 * Exported for its own test, and because the "current" labelling is the one
 * piece of copy here that would be easy to get subtly wrong — a user who does
 * not know a transcript has versions still has to be able to tell which entry
 * is the one they are looking at.
 */
export function versionChoices(
  versions: TranscriptVersionOption[],
  currentVersion: number,
): VersionChoice[] {
  if (versions.length === 0) {
    return [{ version: currentVersion, label: `Current (v${currentVersion})` }];
  }

  return versions
    .slice()
    .sort((a, b) => b.version - a.version)
    .map((entry) => ({
      version: entry.version,
      label: versionLabel(entry, currentVersion),
    }));
}

function versionLabel(entry: TranscriptVersionOption, currentVersion: number): string {
  const prefix = entry.version === currentVersion ? `Current (v${entry.version})` : `v${entry.version}`;
  // `author: null` MEANS the AI — the schema's own convention, not a gap.
  const who = entry.author === null ? 'AI original' : (entry.author.name ?? entry.author.email ?? 'Edited');
  const what = entry.summary ?? who;

  return `${prefix} — ${what}`;
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
