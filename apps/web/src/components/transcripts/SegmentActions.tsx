/**
 * The per-segment overflow menu — issue #31, epic #19.
 *
 * ONE COMPONENT, TWO PRESENTATIONS, and the choice is made here rather than by
 * the caller: a bottom sheet below `sm` and an anchored menu above it. Unlike
 * `SpeakerFilter`'s `variant` prop — which exists because the desktop layout
 * puts that component in a column the component cannot see — nothing about this
 * menu's placement depends on where it was opened from, so the media query is
 * genuinely local.
 *
 * The boundary is `sm` (600px), matching every other compact-window gate in
 * this application. It is not one of the five coupled gates `CLAUDE.md` names
 * and does not move them; it simply agrees with them.
 *
 * =============================================================================
 * WHY THE SPEAKER PICKER IS A SECOND VIEW AND NOT A SUBMENU
 * =============================================================================
 *
 * A nested menu is a hover affordance. On a phone there is no hover, and an
 * eight-speaker submenu opening off the side of a bottom sheet is somewhere
 * between awkward and unreachable. Replacing the sheet's contents with the
 * speaker list — with a back button — is one tap deeper on both surfaces and is
 * the same interaction on each. The rename view added by #220 is the same
 * mechanism a third time: one `view` state machine, three bodies, one surface.
 *
 * =============================================================================
 * NAMING A SPEAKER DEFAULTS TO ALL LINES (#220)
 * =============================================================================
 *
 * This menu used to open with a single item, "Change speaker", leading to a
 * picker whose last entry was "New speaker…". That reads like "give this voice
 * a name" and is not: it creates a NEW speaker and repoints ONE segment at it,
 * so a user correcting `Speaker A` to `Justin` from the line in front of them
 * ended up with `Justin` and `Speaker A` as two speakers for one voice, and no
 * indication anywhere that the other forty lines had been left behind.
 *
 * So the two operations are now two items, each stating its own scope, and the
 * ALL-LINES one is first:
 *
 *   • "Rename <name>" → `speaker.rename` → every line that speaker holds.
 *   • "Move this line to another speaker" → `segment.set_speaker` → this line.
 *
 * All-lines is the default because it is what the user almost always means:
 * diarization got the VOICES right and the LABELS anonymous, so the correction
 * being made is nearly always to the label. Per-line reassignment is the rarer,
 * genuinely different repair — diarization split one voice in two, or attributed
 * a line to the wrong person — and it stays one tap away rather than being the
 * thing you reach by accident.
 *
 * The scopes are carried by `ListItemText`'s `secondary` line ("Applies to all
 * N lines" / "This line only") and not by the item wording alone, because the
 * distinction has to survive being skimmed. For the same reason the picker's
 * own escape hatch is "New speaker for this line only…": inside a view already
 * labelled "this line only" it would still be the one item a user reads as
 * "name this voice".
 *
 * ⚠ The rename item is the SAME `SpeakerNameForm` the chip rail's
 * `SpeakerActions` opens, deliberately — see that file's header. Two forms
 * making the same promise in different words is how the promise stops being
 * true in one of them.
 */

import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import EditIcon from '@mui/icons-material/Edit';
import PersonOutlinedIcon from '@mui/icons-material/PersonOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import MenuItem from '@mui/material/MenuItem';
import MenuList from '@mui/material/MenuList';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import type { TranscriptSegment, TranscriptSpeaker } from '../../services/transcripts';
import { SpeakerNameForm } from './SpeakerNameForm';

export interface SegmentActionsProps {
  open: boolean;
  /** Where to hang the desktop menu. Ignored by the bottom sheet. */
  anchorEl: HTMLElement | null;
  segment: TranscriptSegment | null;
  speakers: readonly TranscriptSpeaker[];
  /** Names already used here, offered as rename suggestions. */
  nameSuggestions: readonly string[];
  /**
   * How many lines this segment's speaker holds, for the "all N lines" copy.
   *
   * A NUMBER, not the whole stats map: the only thing this menu can say
   * anything about is the speaker of the segment it was opened from, and taking
   * the map would invite it to grow opinions about the others.
   */
  speakerSegmentCount: number;
  /** False for the last segment — there is nothing after it to join with. */
  canJoin: boolean;
  onClose: () => void;
  /** All lines — `speaker.rename`. The default naming action. */
  onRenameSpeaker: (displayName: string) => void;
  /** This line only — `segment.set_speaker`. */
  onSetSpeaker: (speakerId: string) => void;
  /** This line only — creates a speaker and points this segment at it. */
  onCreateSpeaker: () => void;
  onSplit: () => void;
  onJoin: () => void;
  onDelete: () => void;
  onPlayFrom: () => void;
}

export function SegmentActions({
  open,
  anchorEl,
  segment,
  speakers,
  nameSuggestions,
  speakerSegmentCount,
  canJoin,
  onClose,
  onRenameSpeaker,
  onSetSpeaker,
  onCreateSpeaker,
  onSplit,
  onJoin,
  onDelete,
  onPlayFrom,
}: SegmentActionsProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const [view, setView] = useState<'root' | 'speaker' | 'rename'>('root');

  // Reopening must never land on the speaker list left over from last time:
  // the second view is a step INSIDE one interaction, not a remembered state.
  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  if (!segment) return null;

  const close = (action?: () => void) => () => {
    onClose();
    action?.();
  };

  const speaker = speakers.find((item) => item.id === segment.speakerId) ?? null;
  const speakerName = speaker?.displayName ?? 'this speaker';

  const rootItems = (
    <MenuList aria-label="Segment actions" autoFocusItem={open && !isCompactWindow}>
      {/* All-lines first, and with the speaker's real name in it: "Rename
          Speaker A" is a sentence about a voice, where "Change speaker" was a
          sentence about a row. See the file header. */}
      <MenuItem onClick={() => setView('rename')}>
        <ListItemIcon>
          <EditIcon fontSize="small" />
        </ListItemIcon>
        {/* The count is a reassurance, not a statistic: "all 12 lines" tells
            the user the edit is bigger than the row they opened it from. It
            falls back to the countless wording rather than printing "all 1
            lines" or, if the page could not resolve a count at all, "all 0
            lines" — a number that would understate the blast radius. */}
        <ListItemText
          secondary={
            speakerSegmentCount > 1
              ? `Applies to all ${speakerSegmentCount} lines they speak`
              : 'Applies to every line they speak'
          }
        >
          {`Rename ${speakerName}`}
        </ListItemText>
      </MenuItem>
      <MenuItem onClick={() => setView('speaker')}>
        <ListItemIcon>
          <PersonOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText secondary="This line only">
          Move this line to another speaker
        </ListItemText>
      </MenuItem>
      <MenuItem onClick={close(onSplit)}>
        <ListItemIcon>
          <CallSplitIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Split here</ListItemText>
      </MenuItem>
      <MenuItem onClick={close(onJoin)} disabled={!canJoin}>
        <ListItemIcon>
          <CallMergeIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Join with next</ListItemText>
      </MenuItem>
      <MenuItem onClick={close(onPlayFrom)}>
        <ListItemIcon>
          <PlayArrowIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Play from here</ListItemText>
      </MenuItem>
      <Divider />
      <MenuItem onClick={close(onDelete)}>
        <ListItemIcon>
          <DeleteOutlinedIcon fontSize="small" color="error" />
        </ListItemIcon>
        <ListItemText
          slotProps={{ primary: { color: 'error.main' } }}
        >
          Delete segment
        </ListItemText>
      </MenuItem>
    </MenuList>
  );

  const speakerItems = (
    <MenuList aria-label="Move this line to another speaker">
      <MenuItem onClick={() => setView('root')}>
        <ListItemIcon>
          <ArrowBackIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Back</ListItemText>
      </MenuItem>
      <Divider />
      {speakers.map((target) => (
        <MenuItem
          key={target.id}
          selected={target.id === segment.speakerId}
          onClick={close(() => onSetSpeaker(target.id))}
        >
          <ListItemText>{target.displayName}</ListItemText>
        </MenuItem>
      ))}
      <Divider />
      {/* Spelled out, because this is the item that caused #220: inside a view
          about one line it is still the one entry a user reads as "name this
          voice", and it is the only one here that creates a second speaker. */}
      <MenuItem onClick={close(onCreateSpeaker)}>
        <ListItemText secondary="Creates a new speaker holding only this line">
          New speaker for this line only…
        </ListItemText>
      </MenuItem>
    </MenuList>
  );

  // Back sits OUTSIDE the form rather than inside it, as a sibling `<ul>`: the
  // root menu this view replaces has five other actions on it, so "I opened the
  // wrong one" is a real case here in a way it is not on the chip rail's
  // rename. Cancel still closes the whole surface, matching `SpeakerActions`,
  // so the shared form keeps one meaning for its one Cancel button.
  const renameForm = (
    <>
      <MenuList aria-label={`Rename ${speakerName}`}>
        <MenuItem onClick={() => setView('root')}>
          <ListItemIcon>
            <ArrowBackIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Back</ListItemText>
        </MenuItem>
      </MenuList>
      <Divider />
      <SpeakerNameForm
        initialName={speaker?.displayName ?? ''}
        nameSuggestions={nameSuggestions}
        onCancel={onClose}
        onSave={(displayName) => {
          onClose();
          onRenameSpeaker(displayName);
        }}
      />
    </>
  );

  const body =
    view === 'root' ? rootItems : view === 'speaker' ? speakerItems : renameForm;

  if (isCompactWindow) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, pb: 1 },
            // Named, because a bottom sheet with no accessible name is
            // announced as an unlabelled dialog and the user has to guess what
            // it belongs to.
            'aria-label': 'Segment actions',
          },
        }}
      >
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle2" noWrap>
            {segment.text || 'This segment'}
          </Typography>
        </Box>
        {body}
      </Drawer>
    );
  }

  // ⚠ `Popover`, NOT `Menu`. `Menu` renders its own `MenuList` — an actual
  // `<ul>` — and puts `children` INSIDE it, so handing it the `<MenuList>` this
  // component shares with the bottom sheet would nest `<ul>` directly in
  // `<ul>`, which is invalid HTML and an axe `list` violation. The rename view
  // is worse still: a `<div>` as a direct child of that `<ul>`. `Popover` is
  // the same surface with no list of its own, so ONE body renders correctly in
  // both presentations.
  return (
    <Popover
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      {body}
    </Popover>
  );
}

export default SegmentActions;
