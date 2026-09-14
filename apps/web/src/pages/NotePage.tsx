/**
 * `/notes/:id` — watch a note being written, and read it once it is. Issue #57,
 * epic #45.
 *
 * ⚠ SCOPE. This is the GENERATION view #57 specifies: the live stream, the
 * markdown, the stop affordance, the failure and its Regenerate. Issue #58
 * builds the rest of this page — inline editing, the version history beside it,
 * export — on top of this file rather than instead of it. What is here is real;
 * nothing is stubbed.
 *
 * =============================================================================
 * THE STREAM IS ADDITIVE. CLOSING THIS PAGE CANCELS NOTHING.
 * =============================================================================
 *
 * `note.generate` completes the note — body, version, status, notification —
 * with no knowledge of whether anyone is connected. The API says so in as many
 * words: deleting the whole stream controller would cost a user the live view
 * and not one character of a note. So this page NEVER claims to be cancelling
 * anything, and the stop affordance is called "Stop watching" rather than
 * "Stop": it closes one SSE connection and says, in the same breath, that the
 * note is still being written and a notification will arrive. Labelling it
 * "Stop" or "Cancel" would be the interface lying about what the button does —
 * there is no cancel endpoint for a note generation, by design (the provider
 * has already been paid for the tokens either way).
 *
 * =============================================================================
 * THE BODY IS NEVER TRUSTED AS MARKUP
 * =============================================================================
 *
 * Everything rendered here is model output, generated from a transcript this
 * application did not write, so it goes through `MarkdownView` — `react-markdown`
 * with `remark-gfm` and NO `rehype-raw`. A `<script>` in the model's output is
 * inert text, not an element, because the renderer builds a React tree and
 * never sets HTML from a string. There is no `dangerouslySetInnerHTML` anywhere
 * in `apps/web` and this page must not be what introduces one.
 *
 * =============================================================================
 * A FAILURE IS A RECORDED REASON, NEVER "SOMETHING WENT WRONG"
 * =============================================================================
 *
 * Two sources, in order: the note's own `failureReason` (what the job recorded,
 * and what survives a reload) and the `error` frame's reason (what the stream
 * saw, available seconds earlier and sometimes the more specific of the two).
 * A generic sentence is shown only when neither exists — which for this API
 * means only a frame class that carries no reason at all.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import HistoryIcon from '@mui/icons-material/History';
import RefreshIcon from '@mui/icons-material/Refresh';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';

import { MarkdownView } from '../components/notes/MarkdownView';
import { NoteStatusChip } from '../components/notes/NoteStatusChip';
import { isNoteInFlight, useNote } from '../hooks/useNotes';
import { ApiError } from '../services/api';
import { connectNoteStream, describeStreamError } from '../services/noteGenerationStream';
import type { SseConnection } from '../services/noteGenerationStream';
import { regenerateNote } from '../services/notes';
import { noteSourceFallbackLabel, noteSourcePath, noteSourceRef } from '../utils/noteSource';
import { formatRelativeTime } from '../utils/relativeTime';

export function NotePage() {
  const { id } = useParams<{ id: string }>();
  const { note, isLoading, error, refresh, setNote } = useNote(id);

  /** The buffer the stream has produced, offset-reconciled by the service. */
  const [streamed, setStreamed] = useState('');
  /**
   * Whether this page holds a live connection.
   *
   * Distinct from "is the note in flight": the user can stop watching a note
   * that is very much still being written, which is the whole point of the stop
   * affordance.
   */
  const [watching, setWatching] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const inFlight = note ? isNoteInFlight(note.status) : false;

  // Reset EVERYTHING stream-shaped when the note changes. `/notes/a` →
  // `/notes/b` must not render a's half-streamed buffer under b's heading, and
  // must not inherit a's "you stopped watching" state either.
  useEffect(() => {
    setStreamed('');
    setStreamError(null);
    setWatching(true);
  }, [id]);

  useEffect(() => {
    if (!id || !inFlight || !watching) return;

    const connection: SseConnection = connectNoteStream(id, {
      onContent: setStreamed,
      // Re-read rather than trust the buffer: the committed body is what the
      // job wrote, `currentVersion` moved, and the status is no longer
      // `generating`. The buffer and the row agree in the normal case; the row
      // is the one that is true.
      onDone: () => {
        void refresh();
      },
      onError: (failure) => {
        setStreamError(describeStreamError(failure));
        // The note's own `failureReason` is the durable record of this, and it
        // is what a reload will show — so read it rather than leaving the page
        // rendering only a frame that no longer exists anywhere.
        void refresh();
      },
    });

    // ⚠ THE TEARDOWN IS LOAD-BEARING, not hygiene. Navigating away mid-stream
    // must close the socket; without this, every note opened during one
    // session leaves a connection held open against a page that is gone.
    return () => connection.close();
  }, [id, inFlight, refresh, watching]);

  const handleRegenerate = useCallback(async () => {
    if (!id) return;
    setIsRegenerating(true);
    setRegenerateError(null);
    setStreamError(null);
    setStreamed('');
    try {
      const result = await regenerateNote(id);
      // Adopt the returned row immediately — it is already `generating` — so
      // the stream effect below re-opens on this render rather than after a
      // poll. `regenerate` answers with the same shape `create` does precisely
      // so a client does not have to re-read to find that out.
      setNote(result.note);
      setWatching(true);
    } catch (err) {
      setRegenerateError(
        err instanceof ApiError ? err.message : 'The note could not be regenerated',
      );
    } finally {
      setIsRegenerating(false);
    }
  }, [id, setNote]);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading this note" />
      </Box>
    );
  }

  if (error || !note) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Alert severity="error">{error ?? 'This note could not be loaded'}</Alert>
      </Box>
    );
  }

  const sourceRef = noteSourceRef(note);
  const sourcePath = noteSourcePath(note);
  const sourceLabel = sourceRef ? noteSourceFallbackLabel(sourceRef.type) : null;

  // The streamed buffer while it is being written; the committed body after.
  // Never both, and never the buffer once the row has the real thing.
  const body = inFlight && streamed ? streamed : note.body;

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 1 }}
      >
        <Typography variant="h5" component="h1" sx={{ minWidth: 0 }}>
          {note.title}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
          <NoteStatusChip status={note.status} />
          <Button
            size="small"
            startIcon={<HistoryIcon />}
            component={RouterLink}
            to={`/notes/${note.id}/history`}
          >
            History
          </Button>
        </Stack>
      </Stack>

      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
        {formatRelativeTime(note.createdAt)}
        {sourceLabel ? ' · from ' : ''}
        {sourceLabel &&
          (sourcePath ? (
            <Link component={RouterLink} to={sourcePath}>
              {sourceLabel}
            </Link>
          ) : (
            sourceLabel
          ))}
        {note.templateName ? ` · ${note.templateName}` : ''}
        {note.model ? ` · ${note.model}` : ''}
      </Typography>

      {inFlight && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" component="h2">
                {watching ? 'Writing your note…' : 'Still writing in the background'}
              </Typography>
              {/* THE HONEST SENTENCE. Said whether or not the user is
                  watching, because the thing it promises is true either way and
                  it is what makes leaving this page a reasonable thing to do. */}
              <Typography variant="caption" color="text.secondary">
                You can close this page — the note keeps being written and a
                notification will arrive when it is ready.
              </Typography>
            </Box>
            {watching && (
              <Button
                size="small"
                startIcon={<StopCircleIcon />}
                onClick={() => setWatching(false)}
                sx={{ flexShrink: 0 }}
              >
                Stop watching
              </Button>
            )}
          </Stack>
          {watching && <LinearProgress aria-hidden sx={{ mt: 1.5 }} />}
        </Paper>
      )}

      {note.status === 'failed' && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => void handleRegenerate()}
              disabled={isRegenerating}
            >
              {isRegenerating ? 'Starting…' : 'Regenerate'}
            </Button>
          }
        >
          <AlertTitle>This note could not be generated</AlertTitle>
          {/* The RECORDED reason, in this order: the row (durable, survives a
              reload), then the frame (seen seconds earlier), then — only if
              neither exists — a sentence that at least says where to look. */}
          {note.failureReason ??
            streamError ??
            'Your AI provider did not return a note, and recorded no reason. Try again.'}
        </Alert>
      )}

      {/* A stream error that has NOT (yet) become a failed row: the reader gave
          up, or the row vanished. Distinct from the alert above, which is about
          the generation. */}
      {streamError && note.status !== 'failed' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {streamError}
        </Alert>
      )}

      {regenerateError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {regenerateError}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{ p: { xs: 2, sm: 3 } }}
        // ⚠ THE LIVE REGION. `polite`, so a screen-reader user hears the note
        // arriving without it interrupting whatever they are reading, and
        // `aria-busy` while it is still being written so assistive technology
        // knows the region is not finished. Named, because an unnamed `region`
        // is a landmark a user cannot identify — and because axe is right to
        // say so.
        component="section"
        role="region"
        aria-label="Note"
        aria-live="polite"
        aria-busy={inFlight}
      >
        {body ? (
          <MarkdownView>{body}</MarkdownView>
        ) : inFlight ? (
          <Typography color="text.secondary">
            Waiting for the first words from your AI provider…
          </Typography>
        ) : (
          <Typography color="text.secondary">This note is empty.</Typography>
        )}
      </Paper>

      {note.currentVersion > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary">
            Version {note.currentVersion}
            {note.provider ? ` · generated by ${note.provider}` : ''}
          </Typography>
        </>
      )}
    </Box>
  );
}

export default NotePage;
