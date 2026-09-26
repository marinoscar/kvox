/**
 * The transcript itself — virtualized, with dynamic row heights, and (since
 * issue #31) editable in place.
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
 * corrects its offsets as it goes, which is exactly the dynamic case — and it
 * is what lets a row GROW as it is typed into without the rows below it
 * drifting out of place.
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
 *
 * EDITING DISENGAGES FOLLOWING TOO, for the same reason and more urgently: a
 * list that scrolls itself while somebody is typing into one of its rows takes
 * the caret off screen mid-sentence.
 *
 * THE PER-LINE PLAY BUTTON (#108) DOES NOT DISENGAGE FOLLOWING, and that falls
 * out of the signal above rather than being a special case: a click is not a
 * `wheel`, a `touchstart` or a `keydown`, so pressing it leaves following on
 * and the list keeps tracking the line that is now playing — which is what a
 * reader who just asked to hear that line wants. Reaching the same button with
 * the KEYBOARD does disengage, because Enter on it is a `keydown` on the scroll
 * region. That is accepted rather than fixed: the alternative is teaching the
 * disengage handler to recognise which descendants' key events do not count,
 * which is a list that goes stale silently, and a keyboard user who has just
 * been given a "Jump to current" button is not stranded.
 *
 * =============================================================================
 * EVERY EDITING PROP IS OPTIONAL, AND THE READ PATH IS UNCHANGED WITHOUT THEM
 * =============================================================================
 *
 * A viewer (and the history page's read-only preview, and the visual harness's
 * reader baselines) renders this component with none of them, and gets exactly
 * the component #30 shipped: no buttons, no `role="button"` on the text, no
 * edit affordance to tab through. `editable` is not a styling flag — it decides
 * whether the interactive elements EXIST, because a disabled control a screen
 * reader still announces is a control a viewer has to be told about.
 *
 * THE SPEAKER NAME IN A ROW HEADER FOLLOWS THAT RULE TOO (#220). With
 * `editable` and `onOpenSpeakerActions` it is a `ButtonBase` opening that
 * speaker's actions — the same surface the chip rail opens, so "Speaker A is
 * really Justin" is fixed from the line the user is reading and is fixed on
 * EVERY line, which is what naming a voice means. Without either prop it is the
 * plain `Typography` #30 shipped: no `role="button"`, no tab stop, nothing for
 * a viewer's screen reader to announce. Two renders of the same text, chosen by
 * mounting rather than by a `disabled` flag, for the reason above.
 *
 * Its accessible name states the scope ("applies to every line they speak")
 * because the visible label cannot: on screen the name is a name, and a user
 * who cannot see the menu it opens has no other way to learn that activating it
 * is about a voice rather than about this row. The ROW itself stays plain text
 * — see the timestamp's own note below for why that is not negotiable.
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
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

/** One highlighted range inside a segment's text, in UTF-16 code units. */
export interface TextRange {
  start: number;
  end: number;
}

/**
 * Split `text` into plain and highlighted runs.
 *
 * Exported and pure because the failure it prevents is invisible in a
 * screenshot: overlapping or out-of-order ranges (which a server can legitimately
 * return for an overlapping search) would otherwise drop or duplicate
 * characters, and a find & replace preview that silently loses a letter is
 * worse than one that highlights nothing.
 */
export function splitByRanges(
  text: string,
  ranges: readonly TextRange[],
): { text: string; highlighted: boolean; start: number }[] {
  if (ranges.length === 0) return [{ text, highlighted: false, start: 0 }];

  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const runs: { text: string; highlighted: boolean; start: number }[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) {
      runs.push({ text: text.slice(cursor, start), highlighted: false, start: cursor });
    }
    if (end > start) {
      runs.push({ text: text.slice(start, end), highlighted: true, start });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return runs;
}

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

  // --- Per-line playback (#108). All optional, the same posture as editing
  // below: absent means the read-only preview renders no button at all, rather
  // than a disabled one a screen reader still has to announce. -------------
  /** The line being played in ISOLATION, or null. Not the current segment. */
  activeSegmentId?: string | null;
  /** Whether the element is actually playing, so only one row shows Pause. */
  isPlaying?: boolean;
  /** Play this line and stop at its end. Its presence mounts the button. */
  onPlaySegment?: (segment: TranscriptSegment) => void;
  /** Pause, when the row's own button is already showing Pause. */
  onPause?: () => void;

  // --- Editing (#31). All optional; absent means the read-only reader. -------
  /** Mount the editing affordances at all. False for a viewer. */
  editable?: boolean;
  /** The segment whose text is currently an input, or null. */
  editingSegmentId?: string | null;
  onStartEdit?: (segmentId: string) => void;
  /** Esc — the text is put back the way it was and the field closes. */
  onCancelEdit?: () => void;
  /** Every keystroke. The queue behind it is what debounces. */
  onChangeText?: (segmentId: string, text: string) => void;
  /** Blur, or Cmd/Ctrl+Enter. */
  onCommitEdit?: () => void;
  /** Where the caret is, so "Split here" can open there. */
  onCaretChange?: (offset: number) => void;
  onOpenActions?: (segmentId: string, anchor: HTMLElement) => void;
  /**
   * Open the speaker actions for THIS segment's speaker (#220).
   *
   * Same signature as `SpeakerFilter`'s prop of the same name, and wired to the
   * same `speakerMenu` state on the page, so the rail and the transcript body
   * open one surface rather than two that have to agree.
   */
  onOpenSpeakerActions?: (speakerId: string, anchor: HTMLElement) => void;

  // --- Find & replace (#31) -------------------------------------------------
  matchesBySegment?: ReadonlyMap<string, TextRange[]>;
  activeMatch?: { segmentId: string; start: number; end: number } | null;
  /** Scroll this segment into view. Changing it is what "Next" does. */
  scrollToSegmentId?: string | null;
  /**
   * A deep link's target (`/transcripts/:id?segment=`, #367): scrolled to,
   * focused, and highlighted for {@link DEEP_LINK_HIGHLIGHT_MS}. Handled once
   * per id, as soon as the segments containing it have loaded.
   */
  highlightSegmentId?: string | null;
}

/** How long a deep-linked segment stays highlighted. */
export const DEEP_LINK_HIGHLIGHT_MS = 2_000;

export function SegmentList({
  segments,
  speakers,
  currentSegmentIndex,
  positionMs,
  wordsBySegment,
  onPlayFrom,
  selectedSpeakerIds,
  activeSegmentId = null,
  isPlaying = false,
  onPlaySegment,
  onPause,
  editable = false,
  editingSegmentId = null,
  onStartEdit,
  onCancelEdit,
  onChangeText,
  onCommitEdit,
  onCaretChange,
  onOpenActions,
  onOpenSpeakerActions,
  matchesBySegment,
  activeMatch = null,
  scrollToSegmentId = null,
  highlightSegmentId = null,
}: SegmentListProps) {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  /**
   * The text as it stood when this edit began, for Esc.
   *
   * A REF, not state: it is written exactly once per edit and read exactly once,
   * and re-rendering the list because a cancel buffer changed would be a
   * re-render of a virtualized list per keystroke.
   */
  const editBaseline = useRef<{ id: string; text: string } | null>(null);

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

  // Editing takes the viewport: nothing may scroll the row being typed into off
  // screen, and that includes the player's own auto-follow.
  useEffect(() => {
    if (editingSegmentId) setFollowing(false);
  }, [editingSegmentId]);

  useEffect(() => {
    // ⚠ `editingSegmentId` IS CHECKED HERE AND NOT ONLY IN THE EFFECT ABOVE.
    // That effect turns following off, but effects run in order and this one
    // has already fired once by then — one scroll, on the exact frame the
    // editor mounts, which moves focus out of the field the user just opened
    // and closes it again on blur. Guarding here as well makes the ordering
    // irrelevant.
    if (!following || editingSegmentId || currentSegmentIndex < 0) return;
    // `center`, not `start`: a reader following a conversation wants the
    // preceding line visible too, and `start` puts the current segment at the
    // very top with everything said a moment ago already scrolled away.
    virtualizer.scrollToIndex(currentSegmentIndex, { align: 'center' });
  }, [currentSegmentIndex, editingSegmentId, following, virtualizer]);

  // Find & replace navigation. Scrolling a VIRTUALIZED list to a match is the
  // reason this has to go through the virtualizer at all: the row the user is
  // being sent to usually does not exist in the DOM yet, so there is nothing to
  // call `scrollIntoView` on.
  useEffect(() => {
    if (!scrollToSegmentId) return;
    const index = segments.findIndex((segment) => segment.id === scrollToSegmentId);
    if (index < 0) return;
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [scrollToSegmentId, segments, virtualizer]);

  // #367: a deep-linked segment — scroll, focus once it is rendered (the list
  // is virtualized, so it may take a frame or two), and highlight briefly.
  const [flashSegmentId, setFlashSegmentId] = useState<string | null>(null);
  const handledHighlight = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightSegmentId || handledHighlight.current === highlightSegmentId) return;
    const index = segments.findIndex((segment) => segment.id === highlightSegmentId);
    if (index < 0) return;
    handledHighlight.current = highlightSegmentId;
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: 'center' });
    setFlashSegmentId(highlightSegmentId);

    let attempts = 0;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => {
      const target = Array.from(
        scrollRef.current?.querySelectorAll<HTMLElement>('[data-segment-id]') ?? [],
      ).find((element) => element.dataset.segmentId === highlightSegmentId);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 10) focusTimer = setTimeout(focus, 50);
    };
    focusTimer = setTimeout(focus, 0);
    const clear = setTimeout(() => setFlashSegmentId(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => {
      if (focusTimer) clearTimeout(focusTimer);
      clearTimeout(clear);
    };
  }, [highlightSegmentId, segments, virtualizer]);

  const jumpToCurrent = useCallback(() => {
    setFollowing(true);
    if (currentSegmentIndex >= 0) {
      virtualizer.scrollToIndex(currentSegmentIndex, { align: 'center' });
    }
  }, [currentSegmentIndex, virtualizer]);

  const startEdit = useCallback(
    (segment: TranscriptSegment) => {
      editBaseline.current = { id: segment.id, text: segment.text };
      onStartEdit?.(segment.id);
    },
    [onStartEdit],
  );

  const cancelEdit = useCallback(() => {
    const baseline = editBaseline.current;
    editBaseline.current = null;
    // Esc puts the text back. The change has already been applied optimistically
    // (and may already have been sent), so "cancel" is a revert, not a discard —
    // pretending otherwise would leave the screen and the transcript disagreeing.
    if (baseline) onChangeText?.(baseline.id, baseline.text);
    onCancelEdit?.();
  }, [onCancelEdit, onChangeText]);

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
            const speakerName = speaker?.displayName ?? 'Speaker';
            const color = speakerColor(speaker?.colorIndex ?? 0, mode);
            // The row's own play button shows Pause only when THIS line is the
            // one in isolated playback AND the element is actually running —
            // `activeSegmentId` alone survives a browser-level pause for a
            // moment, and a Pause icon over silent audio is worse than a
            // slightly late one.
            const playingThis = activeSegmentId === segment.id && isPlaying === true;
            const isCurrent = virtualRow.index === currentSegmentIndex;
            const dimmed = selected.size > 0 && !selected.has(segment.speakerId);
            const isEditing = editable && editingSegmentId === segment.id;
            const words = isCurrent && !isEditing ? wordsBySegment.get(segment.id) : undefined;
            const wordIndex = words ? findWordIndexAt(words, positionMs) : -1;
            const ranges = matchesBySegment?.get(segment.id) ?? [];
            const flashing = flashSegmentId === segment.id;

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
                  backgroundColor: flashing
                    ? 'action.focus'
                    : isCurrent
                      ? 'action.selected'
                      : 'transparent',
                  transition: 'background-color 400ms',
                  // Dimming rather than hiding: a filtered-out speaker's words
                  // are still part of the conversation being read, and removing
                  // them would make the transcript lie about what was said.
                  opacity: dimmed ? 0.45 : 1,
                }}
              >
                {/* `center` on the OUTER row so the 40px button sits on the
                    line's optical middle, with the three text pieces keeping
                    their own baseline alignment in the group below — a button
                    on a shared baseline would hang below the speaker's name. */}
                <Box
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
                >
                  {/* The coarse "hear this line" target the row never had
                      (#108). It is deliberately the FIRST thing in the row, and
                      deliberately 40px against the 24px timestamp beside it:
                      the timestamp is the precise "play from here and keep
                      going" control and stays small, while this one is a thumb
                      target. The negative margins let it claim that hit area
                      out of the row's own padding, so the row height does not
                      change and the transcript stays selectable text rather
                      than becoming a list of buttons.

                      Mounted only when a handler exists, the same rule
                      `editable` follows: the read-only preview gets no control
                      to announce. */}
                  {onPlaySegment && (
                    <IconButton
                      size="small"
                      aria-label={
                        playingThis
                          ? 'Pause this line'
                          : `Play this line, ${speakerName} at ${formatTimestamp(segment.startMs)}`
                      }
                      aria-pressed={playingThis}
                      onClick={() => (playingThis ? onPause?.() : onPlaySegment(segment))}
                      sx={{ width: 40, height: 40, my: -1, ml: -1 }}
                    >
                      {playingThis ? (
                        <PauseIcon fontSize="small" />
                      ) : (
                        <PlayArrowIcon fontSize="small" />
                      )}
                    </IconButton>
                  )}

                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 1,
                      flexWrap: 'wrap',
                    }}
                  >
                    {/* Mounted only when the page can act on it, the same rule
                        every other editing affordance in this file follows — a
                        viewer gets the plain `Typography` below and nothing
                        extra in their tab order. The padding is the timestamp's
                        (`px: 0.5`, `borderRadius: 0.5`) so the hit area is
                        claimed sideways and the name keeps its place on the
                        group's shared baseline; the row does not grow. */}
                    {editable && onOpenSpeakerActions ? (
                      <ButtonBase
                        onClick={(event) =>
                          onOpenSpeakerActions(segment.speakerId, event.currentTarget)
                        }
                        aria-label={`Rename ${speakerName} or merge, applies to every line they speak`}
                        sx={{
                          color,
                          fontWeight: 700,
                          fontSize: theme.typography.subtitle2.fontSize,
                          lineHeight: theme.typography.subtitle2.lineHeight,
                          borderRadius: 0.5,
                          px: 0.5,
                        }}
                      >
                        {speakerName}
                      </ButtonBase>
                    ) : (
                      <Typography
                        component="span"
                        variant="subtitle2"
                        sx={{ color, fontWeight: 700 }}
                      >
                        {speakerName}
                      </Typography>
                    )}
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
                        // purpose, and stays that way now that #108 has added a
                        // 40px button beside it: the whole ROW is not a button
                        // (it must stay selectable text for copying and, in
                        // #31, editing), so this control is deliberately small
                        // and precise — "play from here and keep going" — with
                        // the play button and the player's own transport as the
                        // coarse alternatives.
                        minHeight: 24,
                      }}
                    >
                      {formatTimestamp(segment.startMs)}
                    </ButtonBase>

                    {/* Provenance, and deliberately quiet: "edited" is useful
                        context and must never compete with the words
                        themselves. */}
                    {segment.origin === 'user' && (
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontStyle: 'italic' }}
                      >
                        edited
                      </Typography>
                    )}
                  </Box>

                  <Box sx={{ flexGrow: 1 }} />

                  {editable && (
                    <IconButton
                      size="small"
                      aria-label={`Actions for the line at ${formatTimestamp(segment.startMs)}`}
                      onClick={(event) => onOpenActions?.(segment.id, event.currentTarget)}
                    >
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>

                {isEditing ? (
                  <TextField
                    autoFocus
                    fullWidth
                    multiline
                    size="small"
                    variant="outlined"
                    value={segment.text}
                    // ⚠ THE LABEL GOES ON THE INPUT, NOT ON `TextField`. An
                    // `aria-label` prop passed to `TextField` is forwarded to
                    // its ROOT `FormControl` div — which leaves the textarea
                    // itself unlabelled while the page looks correct, and makes
                    // the field unfindable by its own name.
                    //
                    // Named by what it is, not by "Text field": a screen-reader
                    // user arriving here mid-transcript needs to know which line
                    // they are in.
                    slotProps={{
                      htmlInput: {
                        'aria-label': `Edit the line at ${formatTimestamp(segment.startMs)}`,
                      },
                    }}
                    sx={{ mt: 0.5 }}
                    onChange={(event) => onChangeText?.(segment.id, event.target.value)}
                    onSelect={(event) =>
                      onCaretChange?.(
                        (event.target as HTMLTextAreaElement).selectionStart ?? 0,
                      )
                    }
                    onBlur={() => {
                      editBaseline.current = null;
                      onCommitEdit?.();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        // Stopped, or the page's own Esc handling (a dialog, a
                        // drawer) would also fire and close something the user
                        // was not cancelling.
                        event.stopPropagation();
                        cancelEdit();
                        return;
                      }
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        editBaseline.current = null;
                        onCommitEdit?.();
                      }
                    }}
                  />
                ) : (
                  <Typography
                    variant="body2"
                    component="p"
                    sx={{ mt: 0.25 }}
                    data-segment-id={segment.id}
                    data-segment-rev={segment.rev}
                    tabIndex={-1}
                    {...(editable
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          'aria-label': `Edit the line at ${formatTimestamp(segment.startMs)}`,
                          onClick: () => startEdit(segment),
                          onKeyDown: (event: React.KeyboardEvent) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              startEdit(segment);
                            }
                          },
                          sx: {
                            mt: 0.25,
                            cursor: 'text',
                            borderRadius: 0.5,
                            // The affordance is a hover tint, not a border: a
                            // box around every line turns a transcript into a
                            // form.
                            '&:hover': { backgroundColor: 'action.hover' },
                          },
                        }
                      : {})}
                  >
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
                    ) : ranges.length > 0 ? (
                      splitByRanges(segment.text, ranges).map((run, index) =>
                        run.highlighted ? (
                          <Box
                            component="mark"
                            key={`${segment.id}-run-${index}`}
                            data-testid="search-match"
                            sx={{
                              // The ACTIVE match is the one "Next" just moved
                              // to; the others are context. Two tints, so the
                              // user can see both where they are and how many
                              // more there are.
                              backgroundColor:
                                activeMatch &&
                                activeMatch.segmentId === segment.id &&
                                activeMatch.start === run.start
                                  ? 'warning.main'
                                  : 'action.selected',
                              color: 'inherit',
                              borderRadius: 0.5,
                            }}
                          >
                            {run.text}
                          </Box>
                        ) : (
                          <Box component="span" key={`${segment.id}-run-${index}`}>
                            {run.text}
                          </Box>
                        ),
                      )
                    ) : (
                      segment.text
                    )}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default SegmentList;
