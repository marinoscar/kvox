/**
 * One speaker's correction actions — issue #31, epic #19.
 *
 * =============================================================================
 * THE THREE-TAP MERGE, AND WHY IT HAS NO CONFIRMATION STEP
 * =============================================================================
 *
 * The requirement is exact: on a phone, merging two speakers is at most three
 * taps. Those three are the chip, "Merge into…", and the target — which means
 * the third tap MUST be the one that commits. A fourth "Are you sure?" would
 * break the budget, and it would buy nothing: the merge is immediately
 * reversible from the Undo snackbar that follows it, which is a better
 * confirmation than a dialog because it is shown AFTER the user can see what
 * happened rather than before.
 *
 * The desktop path (tick several in the panel → Merge → `SpeakerMergeDialog`)
 * does have a dialog, and that is not an inconsistency: it is answering a
 * question this sheet does not have to ask, since "merge A into B" already
 * says which name to keep and a multi-select does not.
 *
 * Rename SUGGESTS the names already used in this transcript. The realistic
 * correction is "Speaker 3 is also Ana" — the name is almost always one
 * already on screen, and typing it again by hand is how two spellings of one
 * person end up in the same transcript.
 *
 * =============================================================================
 * RENAME IS ALL-LINES, AND THE FORM SAYS SO OUT LOUD
 * =============================================================================
 *
 * "Rename" here has always meant `speaker.rename` — the whole voice, every line
 * they hold — because this surface is opened from a speaker, not from a line,
 * and there is no per-line reading of it available. That was never in doubt
 * from the chip rail; it became worth stating when issue #220 gave
 * `SegmentActions` a rename item too, where the SAME words could plausibly have
 * meant "just this line". So the form is shared rather than copied
 * (`SpeakerNameForm`), and it carries the scope sentence with it: both entry
 * points make the same promise, in the same words, because they are the same
 * component making it.
 */

import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import EditIcon from '@mui/icons-material/Edit';
import MergeIcon from '@mui/icons-material/Merge';
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

import type { TranscriptSpeaker } from '../../services/transcripts';
import { SpeakerNameForm } from './SpeakerNameForm';

export interface SpeakerActionsProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  speaker: TranscriptSpeaker | null;
  /** Every speaker, so "Merge into…" can list the others. */
  speakers: readonly TranscriptSpeaker[];
  /** Names already used here, offered as rename suggestions. */
  nameSuggestions: readonly string[];
  isPlayingOnly: boolean;
  onClose: () => void;
  onRename: (displayName: string) => void;
  /** `source` is this speaker; `target` is the one tapped. */
  onMergeInto: (targetId: string) => void;
  onTogglePlayOnly: () => void;
}

export function SpeakerActions({
  open,
  anchorEl,
  speaker,
  speakers,
  nameSuggestions,
  isPlayingOnly,
  onClose,
  onRename,
  onMergeInto,
  onTogglePlayOnly,
}: SpeakerActionsProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const [view, setView] = useState<'root' | 'merge' | 'rename'>('root');

  useEffect(() => {
    if (open) setView('root');
  }, [open, speaker]);

  if (!speaker) return null;

  const others = speakers.filter((item) => item.id !== speaker.id);

  const rootItems = (
    <MenuList aria-label={`Actions for ${speaker.displayName}`}>
      <MenuItem onClick={() => setView('rename')}>
        <ListItemIcon>
          <EditIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Rename</ListItemText>
      </MenuItem>
      <MenuItem onClick={() => setView('merge')} disabled={others.length === 0}>
        <ListItemIcon>
          <MergeIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Merge into…</ListItemText>
      </MenuItem>
      <Divider />
      <MenuItem
        onClick={() => {
          onClose();
          onTogglePlayOnly();
        }}
      >
        <ListItemIcon>
          <PlayArrowIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>
          {isPlayingOnly
            ? `Stop playing only ${speaker.displayName}`
            : `Play only ${speaker.displayName}`}
        </ListItemText>
      </MenuItem>
    </MenuList>
  );

  const mergeItems = (
    <MenuList aria-label="Merge into">
      <MenuItem onClick={() => setView('root')}>
        <ListItemIcon>
          <ArrowBackIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>Back</ListItemText>
      </MenuItem>
      <Divider />
      {others.map((target) => (
        <MenuItem
          key={target.id}
          onClick={() => {
            onClose();
            onMergeInto(target.id);
          }}
        >
          {/* The accessible name is the whole sentence, because "Ben" alone in
              a list gives a screen-reader user no way to know whether tapping
              it merges into Ben or renames to Ben. */}
          <ListItemText>{`Merge ${speaker.displayName} into ${target.displayName}`}</ListItemText>
        </MenuItem>
      ))}
    </MenuList>
  );

  const renameForm = (
    <SpeakerNameForm
      initialName={speaker.displayName}
      nameSuggestions={nameSuggestions}
      onCancel={onClose}
      onSave={(displayName) => {
        onClose();
        onRename(displayName);
      }}
    />
  );

  const body =
    view === 'root' ? rootItems : view === 'merge' ? mergeItems : renameForm;

  if (isCompactWindow) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, pb: 1 },
            'aria-label': `Actions for ${speaker.displayName}`,
          },
        }}
      >
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle2">{speaker.displayName}</Typography>
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

export default SpeakerActions;
