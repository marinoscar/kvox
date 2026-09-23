/**
 * The recording a note was made from, playable from the note — issue #309.
 *
 * `NoteProvenance` says in words what a note was generated from; this card is
 * the evidence itself, one press away. It is only mounted when the note
 * detail carries an `originTranscript`, which the API resolves all-or-nothing:
 * a chain of notes the caller cannot fully read never reaches this component.
 *
 * ⚠ The audio is LAZY. Rendering this card signs nothing — the first Play
 * press does, through `useSourceAudio`. A note page is read far more often than
 * its recording is heard, and a signed URL per view would be a signature per
 * page load for audio nobody asked for.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Link as RouterLink } from 'react-router-dom';

import { useSourceAudio } from '../../hooks/useSourceAudio';
import type { NoteOriginTranscript } from '../../services/notes';
import { formatDuration, formatTimestamp } from '../../utils/playbackIntervals';

export interface NoteSourceMediaProps {
  origin: NoteOriginTranscript;
}

/** Minimum touch target, per the app's mobile guidance. */
const TAP_TARGET = 44;

/** "Source recording", or "Original recording (via 2 notes)" for a chain. */
export function sourceMediaCaption(origin: NoteOriginTranscript): string {
  if (origin.via !== 'note_chain') return 'Source recording';
  const hops = Math.max(1, origin.hops);
  return `Original recording (via ${hops} ${hops === 1 ? 'note' : 'notes'})`;
}

function unit(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

/** "1 minute 23 seconds" — a position a screen reader can speak. */
export function spokenDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes) parts.push(unit(minutes, 'minute'));
  if (seconds || parts.length === 0) parts.push(unit(seconds, 'second'));
  return parts.join(' ');
}

export function NoteSourceMedia({ origin }: NoteSourceMediaProps) {
  const player = useSourceAudio(origin.id);

  const processing = origin.status !== 'ready';
  const totalMs = player.durationMs ?? origin.durationMs ?? 0;
  const positionMs = Math.min(player.positionMs, totalMs || player.positionMs);
  const playing = player.status === 'playing';
  const loading = player.status === 'loading';
  const failed = player.status === 'error';
  const transcriptPath = `/transcripts/${encodeURIComponent(origin.id)}`;

  const playButton = (
    <IconButton
      onClick={player.toggle}
      disabled={processing}
      aria-label={playing ? 'Pause source recording' : 'Play source recording'}
      aria-busy={loading || undefined}
      sx={{ width: TAP_TARGET, height: TAP_TARGET, flexShrink: 0 }}
    >
      {loading ? (
        <CircularProgress size={20} aria-hidden />
      ) : playing ? (
        <PauseIcon />
      ) : (
        <PlayArrowIcon />
      )}
    </IconButton>
  );

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-label="Source recording"
      data-testid="note-source-media"
      sx={{ p: { xs: 1.5, sm: 2 }, mb: 2, overflow: 'hidden' }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={{ xs: 1, sm: 2 }}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        {/* What the recording is, and the way to it. */}
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0, flex: 1 }}>
          <GraphicEqIcon color="primary" aria-hidden sx={{ flexShrink: 0 }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" component="p">
              {sourceMediaCaption(origin)}
            </Typography>
            <Link
              component={RouterLink}
              to={transcriptPath}
              variant="body2"
              sx={{
                display: 'block',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {origin.title}
            </Link>
            {origin.durationMs !== null ? (
              <Typography variant="caption" color="text.secondary" component="p">
                {formatDuration(origin.durationMs)}
              </Typography>
            ) : null}
          </Box>
        </Stack>

        {/* The compact player. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', minWidth: 0, flex: { xs: '1 1 auto', sm: '1 1 280px' } }}
        >
          {processing ? (
            <Tooltip title="Audio is still processing">
              {/* A disabled button fires no pointer events; the span carries
                  the tooltip for it. */}
              <span>{playButton}</span>
            </Tooltip>
          ) : (
            playButton
          )}
          {failed ? (
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', minWidth: 0, flex: 1 }}
              role="status"
            >
              <Typography variant="body2" color="error">
                {player.error ?? 'Audio unavailable'}
              </Typography>
              <Button size="small" onClick={player.retry} sx={{ minHeight: TAP_TARGET }}>
                Retry
              </Button>
            </Stack>
          ) : (
            <>
              <Slider
                size="small"
                aria-label="Seek source recording"
                value={positionMs}
                min={0}
                max={totalMs || 1}
                step={1000}
                disabled={processing || totalMs <= 0}
                onChange={(_event, value) => player.seek(value as number)}
                getAriaValueText={(value) => `${spokenDuration(value)} of ${spokenDuration(totalMs)}`}
                sx={{ flex: 1, minWidth: 0, mx: 1 }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
              >
                {formatTimestamp(positionMs)} / {formatTimestamp(totalMs)}
              </Typography>
            </>
          )}
        </Stack>

        <Button
          component={RouterLink}
          to={transcriptPath}
          variant="outlined"
          size="small"
          sx={{ minHeight: TAP_TARGET, flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
        >
          Open transcript
        </Button>
      </Stack>
    </Paper>
  );
}

export default NoteSourceMedia;
