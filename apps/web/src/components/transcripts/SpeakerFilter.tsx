/**
 * The speakers, and the "play only this speaker" control — issue #30, epic #19.
 *
 * TWO TREATMENTS OF ONE COMPONENT, chosen by the page rather than by a media
 * query in here:
 *
 *   `chips` — a horizontally scrolling row. What a phone gets, because a
 *             six-speaker panel is most of a small screen spent on something
 *             the reader consults occasionally.
 *   `panel` — a vertical list in the viewer's right column at `md` and up,
 *             where the space exists and scanning a column beats scrolling a
 *             row sideways.
 *
 * The variant is a PROP and not an internal `useMediaQuery` because the desktop
 * layout puts this inside a sticky right column that only exists at `md`+ — the
 * component cannot know that from its own width, and a second media query here
 * would be a second place for the two-column decision to be made.
 *
 * SELECTION IS A SET, NOT A SINGLE SPEAKER. The product requirement is "play
 * only this speaker", and one-of-N is what the UI offers by default — but the
 * engine's interval arithmetic is identical for two speakers, and modelling the
 * selection as a set now costs nothing and means "just these two people"
 * (#31's likely follow-up) is a UI change rather than an engine change. An
 * EMPTY set means no filter at all, never "play nothing".
 */

import MergeIcon from '@mui/icons-material/Merge';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';

import type { TranscriptSegment, TranscriptSpeaker } from '../../services/transcripts';
import { formatDuration } from '../../utils/playbackIntervals';
import { speakerColor } from '../../utils/transcriptDisplay';

export interface SpeakerStat {
  speaker: TranscriptSpeaker;
  segmentCount: number;
  /** Total time this speaker holds the floor, in milliseconds. */
  talkTimeMs: number;
}

/**
 * Segment counts and talk time per speaker.
 *
 * Exported because the page and its tests both want it without rendering
 * anything, and because computing it twice (once here, once in the page's
 * header summary) is how two numbers on one screen end up disagreeing.
 *
 * ONE PASS over the segments, keyed by speaker id, then projected back through
 * `speakers` so the ORDER is the API's — a speaker with no segments left after
 * an edit still appears, at zero, rather than silently vanishing from a filter
 * the user may have applied.
 */
export function computeSpeakerStats(
  speakers: readonly TranscriptSpeaker[],
  segments: readonly TranscriptSegment[],
): SpeakerStat[] {
  const totals = new Map<string, { segmentCount: number; talkTimeMs: number }>();
  for (const segment of segments) {
    const entry = totals.get(segment.speakerId) ?? { segmentCount: 0, talkTimeMs: 0 };
    entry.segmentCount += 1;
    // `Math.max(0, …)` so a segment whose end precedes its start (an edit that
    // has not been re-timed) cannot make a total go backwards.
    entry.talkTimeMs += Math.max(0, segment.endMs - segment.startMs);
    totals.set(segment.speakerId, entry);
  }

  return speakers.map((speaker) => ({
    speaker,
    segmentCount: totals.get(speaker.id)?.segmentCount ?? 0,
    talkTimeMs: totals.get(speaker.id)?.talkTimeMs ?? 0,
  }));
}

interface SpeakerFilterProps {
  speakers: readonly TranscriptSpeaker[];
  segments: readonly TranscriptSegment[];
  /** Speaker ids currently played. Empty means "everybody". */
  selectedSpeakerIds: readonly string[];
  onToggleSpeaker: (speakerId: string) => void;
  variant: 'chips' | 'panel';

  // --- Corrections (#31). All optional; absent means #30's read-only filter. --
  /**
   * Mount the correction affordances.
   *
   * On a PHONE this also changes what tapping a chip does: it opens the
   * speaker's action sheet (rename / merge into… / play only) rather than
   * toggling playback directly. That is the three-tap merge the vision asks
   * for, and it costs the playback filter exactly one extra tap — the right
   * trade, because merging is the correction this epic exists for and filtering
   * playback is not.
   */
  editable?: boolean;
  onOpenSpeakerActions?: (speakerId: string, anchor: HTMLElement) => void;
  /** Ticked for a desktop multi-speaker merge. */
  mergeSelection?: readonly string[];
  onToggleMergeSelection?: (speakerId: string) => void;
  /** Opens the merge dialog. Enabled only from two speakers up. */
  onMerge?: () => void;
}

export function SpeakerFilter({
  speakers,
  segments,
  selectedSpeakerIds,
  onToggleSpeaker,
  variant,
  editable = false,
  onOpenSpeakerActions,
  mergeSelection,
  onToggleMergeSelection,
  onMerge,
}: SpeakerFilterProps) {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const stats = useMemo(
    () => computeSpeakerStats(speakers, segments),
    [segments, speakers],
  );
  const selected = useMemo(() => new Set(selectedSpeakerIds), [selectedSpeakerIds]);
  const ticked = useMemo(() => new Set(mergeSelection ?? []), [mergeSelection]);

  if (speakers.length === 0) return null;

  /**
   * The accessible name says what the control DOES, not what it is.
   *
   * A chip reading "Ana · 42 · 12 min" is a fine visual label and a poor
   * accessible one — it does not say that activating it filters playback, and
   * `aria-pressed` alone cannot supply the verb.
   */
  const actionLabel = (stat: SpeakerStat) =>
    selected.has(stat.speaker.id)
      ? `Stop playing only ${stat.speaker.displayName}`
      : `Play only ${stat.speaker.displayName}`;

  if (variant === 'chips') {
    return (
      <Box
        role="group"
        aria-label="Speakers"
        sx={{
          display: 'flex',
          gap: 1,
          overflowX: 'auto',
          // The row is a scroll container, so it needs its own bottom padding
          // for the scrollbar on platforms that reserve space for one, and
          // `pb` on the parent would be inside the clipped area.
          pb: 1,
          // Never let the row's intrinsic width widen the page — the shell's
          // `minWidth: 0` chain ends at the page, and this is the first
          // descendant with a genuinely unbounded content width.
          minWidth: 0,
          '&::-webkit-scrollbar': { height: 6 },
        }}
      >
        {stats.map((stat) => {
          const color = speakerColor(stat.speaker.colorIndex, mode);
          const isSelected = selected.has(stat.speaker.id);
          return (
            <Chip
              key={stat.speaker.id}
              clickable
              onClick={(event) =>
                editable
                  ? onOpenSpeakerActions?.(stat.speaker.id, event.currentTarget)
                  : onToggleSpeaker(stat.speaker.id)
              }
              aria-pressed={editable ? undefined : isSelected}
              aria-haspopup={editable ? 'menu' : undefined}
              aria-label={
                editable ? `Actions for ${stat.speaker.displayName}` : actionLabel(stat)
              }
              variant={isSelected ? 'filled' : 'outlined'}
              label={
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {stat.speaker.displayName}
                  </Box>
                  <Box component="span" sx={{ opacity: 0.75, ml: 0.75 }}>
                    {stat.segmentCount} · {formatDuration(stat.talkTimeMs)}
                  </Box>
                </Box>
              }
              sx={{
                flexShrink: 0,
                borderColor: color,
                // The colour is the speaker's identity, so it has to survive
                // both states: a filled chip carries it as the ground, an
                // outlined one as the ink.
                color: isSelected ? theme.palette.getContrastText(color) : color,
                backgroundColor: isSelected ? color : 'transparent',
                '&:hover': { backgroundColor: isSelected ? color : undefined },
              }}
            />
          );
        })}
      </Box>
    );
  }

  const tickedCount = ticked.size;

  return (
    <Box>
      {/* `h2`, not `h3`: the page's only `h1` is the transcript's title, and a
          jump from 1 to 3 is a real axe failure (`heading-order`) as well as a
          screen-reader user's outline claiming a level that does not exist. */}
      <Typography variant="subtitle2" component="h2" sx={{ mb: 1 }}>
        Speakers
      </Typography>
      <List dense disablePadding aria-label="Speakers">
        {stats.map((stat) => {
          const color = speakerColor(stat.speaker.colorIndex, mode);
          const isSelected = selected.has(stat.speaker.id);
          return (
            /* `ListItem` (an `<li>`) WRAPPING `ListItemButton` (a `<button>`),
               rather than a `ListItemButton` rendered as the `<li>` itself.
               The two failures that shape this are both real: a `<ul>` whose
               direct children are not `<li>` is an axe `list` violation and a
               list screen readers do not announce a count for, and an `<li>`
               carrying `role="button"` is an `aria-allowed-role` violation —
               so making the button the list item fixes one by causing the
               other. The nesting satisfies both. */
            <ListItem
              key={stat.speaker.id}
              disablePadding
              secondaryAction={
                editable ? (
                  <IconButton
                    edge="end"
                    size="small"
                    aria-label={`Actions for ${stat.speaker.displayName}`}
                    onClick={(event) =>
                      onOpenSpeakerActions?.(stat.speaker.id, event.currentTarget)
                    }
                  >
                    <MoreVertIcon fontSize="small" />
                  </IconButton>
                ) : undefined
              }
            >
              {editable && (
                <Checkbox
                  size="small"
                  edge="start"
                  checked={ticked.has(stat.speaker.id)}
                  onChange={() => onToggleMergeSelection?.(stat.speaker.id)}
                  // Named for the OUTCOME, not the widget. "Checkbox, Ana" says
                  // nothing about what ticking it will let you do.
                  slotProps={{
                    input: {
                      'aria-label': `Select ${stat.speaker.displayName} to merge`,
                    },
                  }}
                />
              )}
              <ListItemButton
                selected={isSelected}
                onClick={() => onToggleSpeaker(stat.speaker.id)}
                aria-pressed={isSelected}
                aria-label={actionLabel(stat)}
                sx={{ borderRadius: 1 }}
              >
                <Box
                  aria-hidden
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: color,
                    mr: 1.5,
                    flexShrink: 0,
                  }}
                />
                <ListItemText
                  primary={stat.speaker.displayName}
                  secondary={`${stat.segmentCount} segments · ${formatDuration(stat.talkTimeMs)}`}
                  slotProps={{
                    primary: { sx: { color, fontWeight: 600 } },
                    secondary: { variant: 'caption' },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      {editable && (
        <Button
          fullWidth
          size="small"
          startIcon={<MergeIcon />}
          // Disabled below two, because a merge of one speaker is not a
          // narrower version of a merge — it is nothing at all, and an enabled
          // button that does nothing is worse than one that says why it cannot.
          disabled={tickedCount < 2}
          onClick={onMerge}
          sx={{ mt: 1 }}
        >
          {tickedCount >= 2 ? `Merge ${tickedCount} speakers` : 'Merge speakers'}
        </Button>
      )}
    </Box>
  );
}

export default SpeakerFilter;
