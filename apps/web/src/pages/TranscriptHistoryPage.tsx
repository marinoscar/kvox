/**
 * `/transcripts/:id/history` — the version history. Issue #31, epic #19.
 *
 * This file replaces the placeholder #30 left here. It keeps that file's path
 * and default export on purpose: `App.tsx` lazy-imports
 * `./pages/TranscriptHistoryPage`, `destinations.ts` owns the route through its
 * `/transcripts` prefix, and `AppBar`'s drill-down table already titles it —
 * three facts that a replacement preserving those two things needs no change
 * anywhere else to keep true.
 *
 * =============================================================================
 * SESSIONS, NOT SAVES
 * =============================================================================
 *
 * The correction queue saves every 1.5 seconds of idle, so one sitting leaves
 * dozens of versions. `utils/versionSessions.ts` groups consecutive versions by
 * the same author on the same day into one session and explains at length why
 * that rule and not a time window; this page renders the result. Version 1 and
 * every restore stand alone, for the reasons given there.
 *
 * =============================================================================
 * THE PREVIEW IS THE SAME COMPONENT THE VIEWER USES, WITH NO EDITING PROPS
 * =============================================================================
 *
 * `SegmentList` with none of its `#31` props is exactly the reader #30 shipped:
 * no inline editor, no overflow buttons, nothing to tab through. That is why
 * the preview is not a second, simpler renderer — a history preview that drew
 * segments its own way would be a second answer to "what does this transcript
 * look like", and the whole point of reading a version is to see what it would
 * look like if restored.
 *
 * A version older than the first snapshot answers **409**, not an error: spec
 * §4.3 only guarantees a snapshot for version 1 and for restores, and
 * everything else is materialized by replay. That is "not available yet", and
 * saying anything stronger would blame the reader for the snapshot job's queue
 * depth.
 */

import HistoryIcon from '@mui/icons-material/History';
import RestoreIcon from '@mui/icons-material/Restore';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { SegmentList } from '../components/transcripts/SegmentList';
import { useTranscriptVersions } from '../hooks/useTranscriptVersions';
import { useTranscript } from '../hooks/useTranscripts';
import { ApiError } from '../services/api';
import {
  getTranscriptVersion,
  restoreTranscriptVersion,
} from '../services/transcriptEditing';
import type { TranscriptVersionDetail } from '../services/transcriptEditing';
import {
  authorLabel,
  groupVersionsIntoSessions,
  sessionSummary,
} from '../utils/versionSessions';
import { formatRelativeTime } from '../utils/relativeTime';

export function TranscriptHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { transcript } = useTranscript(id);
  const { versions, currentVersion, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh } =
    useTranscriptVersions(id);

  const [preview, setPreview] = useState<TranscriptVersionDetail | null>(null);
  const [previewFor, setPreviewFor] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const canRestore =
    transcript?.access === 'owner' || transcript?.access === 'editor';

  useEffect(() => {
    if (!id || previewFor === null) return;
    let cancelled = false;
    setIsPreviewLoading(true);
    setPreviewError(null);
    void (async () => {
      try {
        const detail = await getTranscriptVersion(id, previewFor);
        if (!cancelled) setPreview(detail);
      } catch (err) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(
          err instanceof ApiError && err.status === 409
            ? 'This version is still being prepared. Try again in a moment.'
            : 'That version could not be loaded.',
        );
      } finally {
        if (!cancelled) setIsPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, previewFor]);

  const handleRestore = useCallback(async () => {
    if (!id || confirmRestore === null || currentVersion === null) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await restoreTranscriptVersion(id, confirmRestore, currentVersion);
      setConfirmRestore(null);
      await refresh();
      // Back to the transcript, because that is what the user was restoring FOR.
      // Staying here would leave them looking at a list whose newest row is the
      // restore they just made, which answers a question they did not ask.
      navigate(`/transcripts/${id}`);
    } catch (err) {
      setRestoreError(
        err instanceof ApiError && err.status === 409
          ? 'Somebody saved a change while this page was open. Reload and try again.'
          : err instanceof ApiError
            ? err.message
            : 'The restore did not happen.',
      );
    } finally {
      setRestoreBusy(false);
    }
  }, [confirmRestore, currentVersion, id, navigate, refresh]);

  const sessions = groupVersionsIntoSessions(versions);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading version history" />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" component="h1" gutterBottom>
        Version history
      </Typography>
      {transcript && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {transcript.title}
        </Typography>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!error && sessions.length === 0 && (
        <Alert severity="info">This transcript has no recorded versions yet.</Alert>
      )}

      <Stack spacing={2}>
        {sessions.map((session) => (
          <Paper key={session.key} variant="outlined">
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="subtitle2" component="h2">
                  {session.authorName ?? 'The transcription service'}
                </Typography>
                {session.isAiOriginal && (
                  // The one row in this list that is not somebody's edit — and
                  // the version the rest of the history exists relative to.
                  <Chip size="small" color="primary" label="AI original" />
                )}
                {session.isRestore && (
                  <Chip size="small" icon={<HistoryIcon />} label="Restored" />
                )}
                <Typography variant="caption" color="text.secondary">
                  {formatRelativeTime(session.latestAt)}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {sessionSummary(session)}
              </Typography>
            </Box>
            <Divider />
            <List dense disablePadding aria-label={`Versions by ${session.authorName ?? 'the transcription service'}`}>
              {session.versions.map((version) => (
                <ListItem key={version.version} disablePadding>
                  <ListItemButton
                    selected={previewFor === version.version}
                    onClick={() => setPreviewFor(version.version)}
                  >
                    <ListItemText
                      primary={`Version ${version.version}`}
                      secondary={`${authorLabel(version)} · ${formatRelativeTime(version.createdAt)}`}
                      slotProps={{ secondary: { variant: 'caption' } }}
                    />
                    {version.version === currentVersion && (
                      <Chip size="small" label="Current" variant="outlined" />
                    )}
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Paper>
        ))}
      </Stack>

      {nextCursor && (
        <Button
          sx={{ mt: 2 }}
          disabled={isLoadingMore}
          onClick={() => void loadMore()}
        >
          {isLoadingMore ? 'Loading…' : 'Load older versions'}
        </Button>
      )}

      <Dialog
        open={previewFor !== null}
        onClose={() => {
          setPreviewFor(null);
          setPreview(null);
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Version {previewFor}</DialogTitle>
        <DialogContent>
          {isPreviewLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress aria-label="Loading this version" />
            </Box>
          )}
          {previewError && <Alert severity="info">{previewError}</Alert>}
          {preview && !isPreviewLoading && (
            <SegmentList
              segments={preview.segments}
              speakers={preview.speakers}
              // A preview has no player, so there is no current segment and no
              // playhead — and `onPlayFrom` is a no-op rather than a missing
              // prop, because the timestamps stay visible as reading anchors.
              currentSegmentIndex={-1}
              positionMs={0}
              wordsBySegment={new Map()}
              onPlayFrom={() => {}}
              selectedSpeakerIds={[]}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPreviewFor(null);
              setPreview(null);
            }}
          >
            Close
          </Button>
          {/* ⚠ "Export this version" mounts here, from #28:
              `<ExportDialog open onClose transcriptId currentVersion={previewFor} />`.
              That component does not exist in this branch yet — see the PR
              description — and a button that opens nothing is worse than none. */}
          {canRestore && previewFor !== null && previewFor !== currentVersion && (
            <Button
              variant="contained"
              startIcon={<RestoreIcon />}
              onClick={() => setConfirmRestore(previewFor)}
            >
              Restore this version
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRestore !== null} onClose={() => setConfirmRestore(null)}>
        <DialogTitle>Restore version {confirmRestore}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The transcript goes back to how it was at version {confirmRestore}.
            Nothing is deleted — the restore is recorded as a new version, and
            every version since stays in this list.
          </DialogContentText>
          {restoreError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {restoreError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRestore(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={restoreBusy}
            onClick={() => void handleRestore()}
          >
            Restore
          </Button>
        </DialogActions>
      </Dialog>

      <Button sx={{ mt: 3 }} onClick={() => navigate(`/transcripts/${id ?? ''}`)}>
        Back to the transcript
      </Button>
    </Box>
  );
}

export default TranscriptHistoryPage;
