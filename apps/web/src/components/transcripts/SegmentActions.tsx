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
 * the same interaction on each.
 */

import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
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

export interface SegmentActionsProps {
  open: boolean;
  /** Where to hang the desktop menu. Ignored by the bottom sheet. */
  anchorEl: HTMLElement | null;
  segment: TranscriptSegment | null;
  speakers: readonly TranscriptSpeaker[];
  /** False for the last segment — there is nothing after it to join with. */
  canJoin: boolean;
  onClose: () => void;
  onSetSpeaker: (speakerId: string) => void;
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
  canJoin,
  onClose,
  onSetSpeaker,
  onCreateSpeaker,
  onSplit,
  onJoin,
  onDelete,
  onPlayFrom,
}: SegmentActionsProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const [view, setView] = useState<'root' | 'speaker'>('root');

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

  const rootItems = (
    <MenuList aria-label="Segment actions" autoFocusItem={open && !isCompactWindow}>
      <MenuItem onClick={() => setView('speaker')}>
        <ListItemIcon>
          <PersonOutlinedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Change speaker</ListItemText>
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
    <MenuList aria-label="Choose a speaker">
      <MenuItem onClick={() => setView('root')}>
        <ListItemIcon>
          <ArrowBackIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Back</ListItemText>
      </MenuItem>
      <Divider />
      {speakers.map((speaker) => (
        <MenuItem
          key={speaker.id}
          selected={speaker.id === segment.speakerId}
          onClick={close(() => onSetSpeaker(speaker.id))}
        >
          <ListItemText>{speaker.displayName}</ListItemText>
        </MenuItem>
      ))}
      <Divider />
      <MenuItem onClick={close(onCreateSpeaker)}>
        <ListItemText>New speaker…</ListItemText>
      </MenuItem>
    </MenuList>
  );

  const body = view === 'root' ? rootItems : speakerItems;

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
