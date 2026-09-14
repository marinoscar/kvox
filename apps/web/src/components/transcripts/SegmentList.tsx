/**
 * The transcript itself — virtualized, with dynamic row heights.
 *
 * Issue #30, epic #19. A ten-hour conversation is tens of thousands of
 * segments; rendering them all is tens of thousands of DOM nodes, and on a
 * phone that is not slow, it is a blank screen.
 *
 * =============================================================================
 * WHY `@tanstack/react-virtual` AND NOT `react-window`
 * =============================================================================
 *
 * Segment text is variable length — one word to a paragraph — so row height is
 * not knowable before layout. `react-window` is built around a fixed (or
 * caller-supplied) row size; supplying one here means either clipping long
 * segments or reserving a paragraph's height for every one-word interjection.
 * `useVirtualizer` measures each rendered row through `measureElement` and
 * corrects its offsets as it goes, which is exactly the dynamic case.
 *
 * =============================================================================
 * AUTO-FOLLOW, AND WHY IT HAS TO BE INTERRUPTIBLE
 * =============================================================================
 *
 * While playing, the list scrolls to keep the current segment visible. That is
 * right until the reader scrolls somewhere else — to re-read something, to look
 * ahead — at which point continuing to yank the viewport back is the single
 * most hostile thing a transcript reader can do. So any user scroll DISENGAGES
 * following, and a "Jump to current" button appears to put it back. Engaging is
 * always explicit; disengaging is always implicit. The reverse (a button to
 * stop following) would mean the reader has to fight the page first and find
 * the control second.
 *
 * The user-scroll signal is `wheel`/`touchstart`/`keydown`, NOT the `scroll`
 * event: `scrollToIndex` fires `scroll` too, so following would switch itself
 * off on its own first move.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptWord,
} from '../../services/transcripts';
import { findWordIndexAt, formatTimestamp } from '../../utils/playbackIntervals';
import { speakerColor } from '../../utils/transcriptDisplay';

/**
 * The height a row is ASSUMED to be before it has been measured.
 *
 * Only affects the scrollbar's initial proportions and how many rows are
 * rendered on the first frame — every visible row is measured immediately
 * after. Sized for a two-line segment, which is the common case.
 */
const ESTIMATED_ROW_HEIGHT = 96;

/**
 * Rows rendered beyond the viewport, on each side.
 *
 * Six is a compromise between a scroll that outruns the renderer (too few) and
 * the DOM count the whole component exists to bound (too many). It is also what
 * the "row count stays bounded" test asserts against: a fixture of 6,000
 * segments must render tens of rows, not thousands.
 */
const OVERSCAN = 6;

interface SegmentListProps {
  segments: TranscriptSegment[];
  speakers: readonly TranscriptSpeaker[];
  /** -1 when the playhead is between segments. */
  currentSegmentIndex: number;
  /** Current position, for word-level highlighting inside the current segment. */
  positionMs: number;
  /** Segment id → word timings, for whatever windows have been fetched. */
  wordsBySegment: Map<string, TranscriptWord[]>;
  /** Tapping a timestamp plays from there. */
  onPlayFrom: (ms: number) => void;
  /** Speaker ids playback is restricted to. Empty means "everybody". */
  selectedSpeakerIds: readonly string[];
}

export function SegmentList({
  segments,
  speakers,
  currentSegmentIndex,
  positionMs,
  wordsBySegment,
  onPlayFrom,
  selectedSpeakerIds,
}: SegmentListProps) {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  const speakerById = useMemo(() => {
    const map = new Map<string, TranscriptSpeaker>();
    for (const speaker of speakers) map.set(speaker.id, speaker);
    return map;
  }, [speakers]);

  const selected = useMemo(() => new Set(selectedSpeakerIds), [selectedSpeakerIds]);

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    // Keyed by segment ID rather than by index, so a measurement cache survives
    // an edit that inserts or removes a row above (#31) instead of shifting
    // every remembered height down by one.
    getItemKey: (index) => segments[index]?.id ?? index,
  });

  // Any INPUT gesture disengages following. See the file header for why this
  // cannot be the `scroll` event.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const disengage = () => setFollowing(false);
    element.addEventListener('wheel', disengage, { passive: true });
    element.addEventListener('touchstart', disengage, { passive: true });
    element.addEventListener('keydown', disengage);
    return () => {
      element.removeEventListener('wheel', disengage);
      element.removeEventListener('touchstart', disengage);
      element.removeEventListener('keydown', disengage);
    };
  }, []);

  useEffect(() => {
    if (!following || currentSegmentIndex < 0) return;
    // `center`, not `start`: a reader following a conversation wants the
    // preceding line visible too, and `start` puts the current segment at the
    // very top with everything said a moment ago already scrolled away.
    virtualizer.scrollToIndex(currentSegmentIndex, { align: 'center' });
  }, [currentSegmentIndex, following, virtualizer]);

  const jumpToCurrent = useCallback(() => {
    setFollowing(true);
    if (currentSegmentIndex >= 0) {
      virtualizer.scrollToIndex(currentSegmentIndex, { align: 'center' });
    }
  }, [currentSegmentIndex, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  if (segments.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4 }}>
        This transcript has no segments.
      </Typography>
    );
  }

  return (
    <Box sx={{ position: 'relative' }}>
      {/* Offered only when it would DO something — following is off and there
          is a current segment to jump to. A permanently visible button that is
          sometimes a no-op trains the reader to ignore it. */}
      {!following && currentSegmentIndex >= 0 && (
        <Button
          size="small"
          variant="contained"
          onClick={jumpToCurrent}
          sx={{
            position: 'absolute',
            // Top-centre rather than bottom: the bottom of this list is where
            // the phone's mini player docks, and two floating controls stacked
            // on each other is how the important one gets covered.
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
          }}
        >
          Jump to current
        </Button>
      )}

      <Box
        ref={scrollRef}
        // `region` + a name, because this is the page's primary content and a
        // screen-reader user needs to be able to jump straight to it rather
        // than tabbing through the player first.
        role="region"
        aria-label="Transcript"
        tabIndex={0}
        sx={{
          height: { xs: '60vh', md: '70vh' },
          overflowY: 'auto',
          // Momentum scrolling on iOS, and the one property that keeps a long
          // list from feeling broken on a phone.
          WebkitOverflowScrolling: 'touch',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
        }}
      >
        <Box sx={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((virtualRow) => {
            const segment = segments[virtualRow.index];
            if (!segment) return null;
            const speaker = speakerById.get(segment.speakerId);
            const color = speakerColor(speaker?.colorIndex ?? 0, mode);
            const isCurrent = virtualRow.index === currentSegmentIndex;
            const dimmed = selected.size > 0 && !selected.has(segment.speakerId);
            const words = isCurrent ? wordsBySegment.get(segment.id) : undefined;
            const wordIndex = words ? findWordIndexAt(words, positionMs) : -1;

            return (
              <Box
                key={segment.id}
                data-testid="segment-row"
                data-index={virtualRow.index}
                // `measureElement` is what makes the heights DYNAMIC: the
                // virtualizer reads each row's real box as it mounts and
                // corrects the offsets below it.
                ref={virtualizer.measureElement}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  px: 2,
                  py: 1.25,
                  backgroundColor: isCurrent ? 'action.selected' : 'transparent',
                  // Dimming rather than hiding: a filtered-out speaker's words
                  // are still part of the conversation being read, and removing
                  // them would make the transcript lie about what was said.
                  opacity: dimmed ? 0.45 : 1,
                }}
              >
                <Box
                  sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}
                >
                  <Typography
                    component="span"
                    variant="subtitle2"
                    sx={{ color, fontWeight: 700 }}
                  >
                    {speaker?.displayName ?? 'Speaker'}
                  </Typography>
                  <ButtonBase
                    onClick={() => onPlayFrom(segment.startMs)}
                    aria-label={`Play from ${formatTimestamp(segment.startMs)}`}
                    sx={{
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: '0.75rem',
                      color: 'text.secondary',
                      borderRadius: 0.5,
                      px: 0.5,
                      // 24px is below the 44px touch-target guidance on
                      // purpose: the whole ROW is not a button (it must stay
                      // selectable text for copying and, in #31, editing), so
                      // this control is deliberately small and precise, with
                      // the player's own transport as the coarse alternative.
                      minHeight: 24,
                    }}
                  >
                    {formatTimestamp(segment.startMs)}
                  </ButtonBase>
                </Box>

                <Typography variant="body2" component="p" sx={{ mt: 0.25 }}>
                  {words && words.length > 0 ? (
                    words.map((word, index) => (
                      <Box
                        component="span"
                        key={`${segment.id}-${index}`}
                        sx={{
                          backgroundColor:
                            index === wordIndex ? 'action.selected' : 'transparent',
                          // Weight rather than colour for the current word:
                          // colour is already spoken for by speaker identity,
                          // and a second colour meaning would make both weaker.
                          fontWeight: index === wordIndex ? 700 : 400,
                          borderRadius: 0.5,
                        }}
                      >
                        {word.t}{' '}
                      </Box>
                    ))
                  ) : (
                    segment.text
                  )}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default SegmentList;
