/**
 * `/transcripts/:id` — read mode. Issue #30, epic #19.
 *
 * Three states, in this order, because they are what the user can actually be
 * looking at:
 *
 *   1. **Not ready.** The pipeline stepper, or the failed state with a reason
 *      and (for the owner) a Retry. There are no segments to show and there is
 *      no audio worth playing, so the page IS the stepper.
 *   2. **Ready, one column.** Below `md`: speaker chips, the virtualized
 *      segment list, and the mini player fixed above the bottom bar.
 *   3. **Ready, two columns.** At `md` and up: segments on the left, a sticky
 *      right column carrying the player and the speakers panel.
 *
 * The correction actions (rename a speaker, edit a segment, split, merge) are
 * issue #31 and are deliberately absent — this page is READ mode, and the
 * exports it shares with `SegmentList`/`usePlaybackEngine` are shaped so #31
 * adds actions rather than rewriting the reader.
 *
 * =============================================================================
 * KEYBOARD SHORTCUTS ARE DESKTOP-ONLY, AND GUARDED
 * =============================================================================
 *
 * Space, J and L are bound at the document level, which is the only way a
 * transport shortcut can work while the reader's focus is in the segment list.
 * That makes it essential to IGNORE the key when the user is typing: a Space in
 * the rename field must insert a space, not pause the audio. The guard is on
 * the event target's tag and `isContentEditable`, checked before anything else.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { SegmentList } from '../components/transcripts/SegmentList';
import { SpeakerFilter } from '../components/transcripts/SpeakerFilter';
import { TranscriptPipeline } from '../components/transcripts/TranscriptPipeline';
import {
  MINI_PLAYER_HEIGHT,
  TranscriptPlayer,
} from '../components/transcripts/TranscriptPlayer';
import { TranscriptStatusChip } from '../components/transcripts/TranscriptStatusChip';
import { usePlaybackEngine, SKIP_MS } from '../hooks/usePlaybackEngine';
import { useTranscript, useTranscriptSegments } from '../hooks/useTranscripts';
import { useTranscriptWords } from '../hooks/useTranscriptWords';
import { ApiError } from '../services/api';
import { retryTranscript } from '../services/transcripts';
import { formatDuration } from '../utils/playbackIntervals';
import { hasPlaybackRendition } from '../utils/transcriptDisplay';

/**
 * Should a document-level transport shortcut be ignored for this event?
 *
 * Exported for its own test: the failure it prevents (Space pausing the audio
 * instead of typing a space) is trivially reproducible by hand and completely
 * invisible in a snapshot.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function TranscriptPage() {
  const { id } = useParams<{ id: string }>();
  const theme = useTheme();
  const navigate = useNavigate();
  const isWide = useMediaQuery(theme.breakpoints.up('md'));

  const { transcript, isLoading, error, setTranscript } = useTranscript(id);
  const isReady = transcript?.status === 'ready';
  const { segments } = useTranscriptSegments(id, isReady);

  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<string[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const speakers = useMemo(() => transcript?.speakers ?? [], [transcript?.speakers]);

  const speakerName = useCallback(
    (speakerId: string) =>
      speakers.find((speaker) => speaker.id === speakerId)?.displayName ?? '',
    [speakers],
  );

  const engine = usePlaybackEngine({
    // The engine is only given an id once the transcript is READY. Before that
    // `GET /:id/audio` has nothing to sign, and mounting an element that 404s
    // would put the player into its error state for the whole processing wait.
    transcriptId: isReady ? id : undefined,
    segments,
    selectedSpeakerIds,
    title: transcript?.title ?? 'Transcript',
    speakerName,
    playbackReady: transcript ? hasPlaybackRendition(transcript.playbackStatus) : false,
  });

  const { wordsBySegment } = useTranscriptWords(id, engine.positionMs, isReady);

  const toggleSpeaker = useCallback((speakerId: string) => {
    setSelectedSpeakerIds((current) =>
      current.includes(speakerId)
        ? current.filter((value) => value !== speakerId)
        : [...current, speakerId],
    );
  }, []);

  const clearSpeakerFilter = useCallback(() => setSelectedSpeakerIds([]), []);

  const handleRetry = useCallback(async () => {
    if (!id) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      setTranscript(await retryTranscript(id));
    } catch (err) {
      setRetryError(
        err instanceof ApiError ? err.message : 'The retry could not be started.',
      );
    } finally {
      setIsRetrying(false);
    }
  }, [id, setTranscript]);

  // Desktop transport shortcuts. Bound whenever the engine is usable, and not
  // gated on width: a keyboard attached to a tablet is still a keyboard, and a
  // device with no keys never fires these.
  useEffect(() => {
    if (!isReady) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.code === 'Space') {
        // Prevented BEFORE toggling: Space also scrolls the page, and a
        // transcript that jumps a screenful every time playback starts is
        // worse than no shortcut.
        event.preventDefault();
        engine.togglePlay();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'j') {
        event.preventDefault();
        engine.skip(-SKIP_MS);
      } else if (key === 'l') {
        event.preventDefault();
        engine.skip(SKIP_MS);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [engine, isReady]);

  if (isLoading && !transcript) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading transcript" />
      </Box>
    );
  }

  if (error && !transcript) {
    return (
      <Box sx={{ maxWidth: 700, mx: 'auto' }}>
        <Alert severity="error">{error}</Alert>
        <Button sx={{ mt: 2 }} onClick={() => navigate('/transcripts')}>
          Back to transcripts
        </Button>
      </Box>
    );
  }

  if (!transcript) return null;

  const header = (
    <Box sx={{ mb: 2 }}>
      <Typography variant="h5" component="h1" sx={{ mb: 0.5 }}>
        {transcript.title}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <TranscriptStatusChip transcript={transcript} showStage />
        <Typography variant="caption" color="text.secondary">
          {formatDuration(transcript.durationMs)} · {transcript.speakerCount}{' '}
          {transcript.speakerCount === 1 ? 'speaker' : 'speakers'}
        </Typography>
      </Box>
    </Box>
  );

  if (!isReady) {
    return (
      <Box sx={{ maxWidth: 800, mx: 'auto' }}>
        {header}
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <TranscriptPipeline
            transcript={transcript}
            // Owner only: the API answers a retry from anyone else with a 404,
            // so offering the button to an editor would be offering a control
            // that cannot work.
            canRetry={transcript.access === 'owner'}
            onRetry={() => void handleRetry()}
            isRetrying={isRetrying}
            retryError={retryError}
          />
        </Paper>
      </Box>
    );
  }

  const playerBlocked = engine.status === 'preparing' || engine.status === 'error';
  const playerNotice = playerBlocked ? (
    <Alert severity={engine.status === 'error' ? 'error' : 'info'}>
      {engine.status === 'error'
        ? (engine.error ?? 'The audio could not be loaded.')
        : 'Preparing audio… the transcript below is ready to read now.'}
    </Alert>
  ) : null;

  const segmentList = (
    <SegmentList
      segments={segments}
      speakers={speakers}
      currentSegmentIndex={engine.currentSegmentIndex}
      positionMs={engine.positionMs}
      wordsBySegment={wordsBySegment}
      onPlayFrom={engine.playFromMs}
      selectedSpeakerIds={selectedSpeakerIds}
    />
  );

  if (isWide) {
    return (
      <Box>
        {header}
        <Grid container spacing={3}>
          <Grid size={{ md: 8 }} sx={{ minWidth: 0 }}>
            {segmentList}
          </Grid>
          <Grid size={{ md: 4 }}>
            {/* Sticky, not fixed: it scrolls with the page until it reaches the
                top and then stays, which keeps it inside the grid column
                instead of having to be positioned against the viewport. The
                offset clears the sticky AppBar above it. */}
            <Box
              sx={{
                position: 'sticky',
                top: theme.spacing(10),
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {playerNotice}
              {!playerBlocked && (
                <TranscriptPlayer
                  engine={engine}
                  segments={segments}
                  speakers={speakers}
                  selectedSpeakerIds={selectedSpeakerIds}
                  onClearSpeakerFilter={clearSpeakerFilter}
                  variant="card"
                />
              )}
              <Paper variant="outlined" sx={{ p: 2 }}>
                <SpeakerFilter
                  speakers={speakers}
                  segments={segments}
                  selectedSpeakerIds={selectedSpeakerIds}
                  onToggleSpeaker={toggleSpeaker}
                  variant="panel"
                />
              </Paper>
            </Box>
          </Grid>
        </Grid>
      </Box>
    );
  }

  return (
    <Box>
      {header}
      <Box sx={{ mb: 1.5 }}>
        <SpeakerFilter
          speakers={speakers}
          segments={segments}
          selectedSpeakerIds={selectedSpeakerIds}
          onToggleSpeaker={toggleSpeaker}
          variant="chips"
        />
      </Box>
      {playerNotice && <Box sx={{ mb: 2 }}>{playerNotice}</Box>}
      {segmentList}

      {!playerBlocked && (
        <>
          <TranscriptPlayer
            engine={engine}
            segments={segments}
            speakers={speakers}
            selectedSpeakerIds={selectedSpeakerIds}
            onClearSpeakerFilter={clearSpeakerFilter}
            variant="mini"
          />
          {/* The spacer for the FIXED player above. Without it the last segment
              is permanently underneath the transport and cannot be scrolled
              into view — see `MINI_PLAYER_HEIGHT`. */}
          <Box aria-hidden sx={{ height: MINI_PLAYER_HEIGHT }} />
        </>
      )}
    </Box>
  );
}

export default TranscriptPage;
