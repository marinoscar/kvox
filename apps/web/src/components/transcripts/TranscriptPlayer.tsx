/**
 * The transport — issue #30, epic #19.
 *
 * ONE COMPONENT, TWO DOCKINGS, chosen by the page:
 *
 *   `mini` — fixed to the bottom of the viewport, above the phone's bottom
 *            navigation bar. What a reader gets below `md`, where the segment
 *            list needs the whole screen and the player has to stay reachable
 *            without scrolling back to it.
 *   `card` — an ordinary card, which the viewer's right column makes sticky at
 *            `md` and up.
 *
 * ⚠ THE `mini` DOCK'S BOTTOM OFFSET IS DERIVED FROM `BottomNav`'s OWN GATE, and
 * has to keep tracking it. `common/Layout.tsx` documents five coupled
 * breakpoint gates; this is not a sixth — it decides nothing about which
 * navigation chrome exists — but it is a CONSUMER of gate (2) in exactly the
 * way `<main>`'s `pb` (gate 3) is: the fixed bottom bar exists only below `sm`,
 * so only below `sm` does anything have to clear it. At `sm` and up the rail is
 * the navigation and the bottom of the viewport is free, so the player sits on
 * the safe-area inset alone. Getting this wrong is visible immediately (a
 * 56-pixel dead band on a tablet, or a player hidden behind the bar on a
 * phone), which is why it is written as one responsive value rather than two
 * components.
 *
 * `env(safe-area-inset-bottom)` is what keeps it clear of the iPhone home
 * indicator; it evaluates to `0px` everywhere else, so it costs nothing.
 */

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import CancelIcon from '@mui/icons-material/Cancel';
import Forward15Icon from '@mui/icons-material/Forward10';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Replay15Icon from '@mui/icons-material/Replay10';
import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';

import type { TranscriptSegment, TranscriptSpeaker } from '../../services/transcripts';
import type { PlaybackEngine, PlaybackRate } from '../../hooks/usePlaybackEngine';
import { PLAYBACK_RATES, SKIP_MS } from '../../hooks/usePlaybackEngine';
import { formatTimestamp } from '../../utils/playbackIntervals';
import { buildScrubberRegions, speakerColor } from '../../utils/transcriptDisplay';

/**
 * The height the `mini` dock occupies, for the spacer the page renders under
 * the segment list.
 *
 * A FIXED element is out of flow, so without a matching spacer the last segment
 * of the transcript sits permanently underneath the player and cannot be
 * scrolled into view — the one part of a transcript a reader is most likely to
 * want at the end of a listen.
 */
export const MINI_PLAYER_HEIGHT = 112;

interface TranscriptPlayerProps {
  engine: PlaybackEngine;
  segments: readonly TranscriptSegment[];
  speakers: readonly TranscriptSpeaker[];
  /** Speaker ids playback is restricted to. Empty means "everybody". */
  selectedSpeakerIds: readonly string[];
  /** Clears the whole filter — the "Only: Ana" chip's delete handler. */
  onClearSpeakerFilter: () => void;
  variant: 'mini' | 'card';
}

export function TranscriptPlayer({
  engine,
  segments,
  speakers,
  selectedSpeakerIds,
  onClearSpeakerFilter,
  variant,
}: TranscriptPlayerProps) {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';

  const colorIndexOf = useMemo(() => {
    const map = new Map(speakers.map((speaker) => [speaker.id, speaker.colorIndex]));
    return (speakerId: string) => map.get(speakerId) ?? 0;
  }, [speakers]);

  const regions = useMemo(
    () => buildScrubberRegions(segments, engine.durationMs, colorIndexOf),
    [colorIndexOf, engine.durationMs, segments],
  );

  const selectedNames = speakers
    .filter((speaker) => selectedSpeakerIds.includes(speaker.id))
    .map((speaker) => speaker.displayName);

  const scrubberDisabled = engine.durationMs <= 0;

  const body = (
    <Box sx={{ px: variant === 'mini' ? 2 : 0, py: variant === 'mini' ? 1 : 0 }}>
      {selectedNames.length > 0 && (
        <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Chip size="small" color="primary" label={`Only: ${selectedNames.join(', ')}`} />
          {/* A REAL `IconButton`, not `Chip`'s own `onDelete` affordance. MUI
              renders that as a bare `<svg>` with a click handler: it is not
              focusable, has no role, and cannot be activated from the keyboard
              — so the only way to clear a speaker filter would be a mouse or a
              tap. The chip keeps its job (saying what is filtered) and the
              button keeps its own (undoing it). */}
          <IconButton
            size="small"
            aria-label="Clear speaker filter"
            onClick={onClearSpeakerFilter}
          >
            <CancelIcon fontSize="small" />
          </IconButton>
        </Box>
      )}

      {/* The scrubber, with the speaker bands painted BEHIND the rail. The
          bands are decorative (`aria-hidden`): the slider already reports the
          position numerically, and a screen reader has no use for "who is
          speaking at 43% of the way through". */}
      <Box sx={{ position: 'relative' }}>
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: 6,
            transform: 'translateY(-50%)',
            borderRadius: 3,
            overflow: 'hidden',
            backgroundColor: 'action.hover',
            pointerEvents: 'none',
          }}
        >
          {regions.map((region) => (
            <Box
              key={`${region.startPct}-${region.colorIndex}`}
              sx={{
                position: 'absolute',
                left: `${region.startPct}%`,
                width: `${region.widthPct}%`,
                top: 0,
                bottom: 0,
                backgroundColor: speakerColor(region.colorIndex, mode),
                opacity: 0.55,
              }}
            />
          ))}
        </Box>

        <Slider
          size="small"
          aria-label="Playback position"
          // `getAriaValueText`, not just the raw number: "2 754 000" is what a
          // screen reader would otherwise read out for 45:54.
          getAriaValueText={(value) => formatTimestamp(value)}
          value={Math.min(engine.positionMs, engine.durationMs || engine.positionMs)}
          min={0}
          max={engine.durationMs || 1}
          disabled={scrubberDisabled}
          onChange={(_, value) => engine.seekToMs(Array.isArray(value) ? value[0] : value)}
          sx={{
            // The rail and track are transparent so the speaker bands read
            // through; the thumb is the only painted part.
            '& .MuiSlider-rail': { opacity: 0 },
            '& .MuiSlider-track': { opacity: 0.35 },
            py: 1,
          }}
        />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <IconButton
            aria-label="Skip back 15 seconds"
            onClick={() => engine.skip(-SKIP_MS)}
            size="small"
          >
            <Replay15Icon />
          </IconButton>
          <IconButton
            aria-label={engine.isPlaying ? 'Pause' : 'Play'}
            onClick={engine.togglePlay}
            color="primary"
          >
            {engine.isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
          </IconButton>
          <IconButton
            aria-label="Skip forward 15 seconds"
            onClick={() => engine.skip(SKIP_MS)}
            size="small"
          >
            <Forward15Icon />
          </IconButton>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums', ml: 0.5 }}
          >
            {formatTimestamp(engine.positionMs)}
            {engine.durationMs > 0 ? ` / ${formatTimestamp(engine.durationMs)}` : ''}
          </Typography>
        </Box>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={engine.rate}
          aria-label="Playback speed"
          // `?? engine.rate` — MUI hands back `null` when the pressed button is
          // the active one, and a null rate would make the element silent.
          onChange={(_, value: PlaybackRate | null) => engine.setRate(value ?? engine.rate)}
        >
          {PLAYBACK_RATES.map((rate) => (
            <ToggleButton key={rate} value={rate} aria-label={`${rate} times speed`}>
              {rate}×
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
    </Box>
  );

  if (variant === 'card') {
    return (
      <Paper variant="outlined" component="section" aria-label="Audio player" sx={{ p: 2 }}>
        {body}
      </Paper>
    );
  }

  return (
    <Paper
      elevation={8}
      component="section"
      aria-label="Audio player"
      sx={{
        position: 'fixed',
        left: 0,
        right: 0,
        // See the file header: derived from `BottomNav`'s `down('sm')` gate.
        bottom: {
          xs: 'calc(56px + env(safe-area-inset-bottom))',
          sm: 'env(safe-area-inset-bottom)',
        },
        // Below the AppBar's own layer so a scrolled page never paints the
        // player over the header, and above ordinary page content.
        zIndex: theme.zIndex.appBar - 1,
        borderRadius: 0,
      }}
    >
      {body}
    </Paper>
  );
}

export default TranscriptPlayer;
