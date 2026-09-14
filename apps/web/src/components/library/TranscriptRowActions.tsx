/**
 * The trailing action cluster on a library transcript row — issue #98, epic #19.
 *
 * Two controls: Play/Pause for the recording, and a `⋮` overflow menu for
 * everything the row can do without being opened. They are extracted from
 * `TranscriptsLibraryView` because between them they carry two menus' worth of
 * gating, three dialogs and a confirmation flow, and a row component that also
 * held all of that would be a hundred lines of card layout with four hundred
 * lines of behaviour inside it.
 *
 * =============================================================================
 * THIS COMPONENT IS A SIBLING OF THE CARD'S ACTION AREA, NEVER A CHILD OF IT
 * =============================================================================
 *
 * The row used to be one `CardActionArea` wrapping the whole card body. Putting
 * these controls inside it would be nesting buttons inside a button: invalid
 * HTML, an axe failure, a keyboard order that makes no sense, and a screen
 * reader that cannot offer both targets because as far as it is concerned there
 * is only one. `event.stopPropagation()` makes the MOUSE behave and fixes none
 * of that — it is the trick that hides the bug rather than the fix for it.
 *
 * So the row is restructured instead: the action area is the transcript, this
 * cluster sits beside it, and neither is inside the other. It is the same split
 * `NotesLibraryView`'s `SourceLine` already makes, and for the same reasons.
 * With the nesting gone there is nothing to stop propagating: a click here
 * never reaches the action area because it is not in it.
 *
 * =============================================================================
 * EVERY ITEM IS GATED ON WHAT THE API WILL ACTUALLY ALLOW
 * =============================================================================
 *
 * The wording and the gates are `TranscriptPage`'s page menu, deliberately —
 * one action should not be called two things depending on where the user found
 * it. Share and Delete are owner-only because the share routes and the delete
 * route answer a non-owner a 404; a non-owner is offered Leave instead, which
 * is the same `DELETE /shares/:userId` route called with your own id and is the
 * one share route any holder may reach.
 *
 * Export is the one gate that is not copied verbatim. The page renders it
 * unconditionally — it can afford to, because the dialog it opens explains
 * itself on a page the user has already committed to. A row menu should not
 * offer to export a transcript that has no version to export, so it asks the
 * question the page's own comment is really about: is there a version at all.
 * `currentVersion` is 0 until the AI ingest writes version 1, which also keeps
 * the page's case — a transcript whose newest attempt failed but whose earlier
 * version is still perfectly exportable.
 */

import { useCallback, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

import { ExportDialog } from '../transcripts/ExportDialog';
import { ShareDialog } from '../transcripts/ShareDialog';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../services/api';
import { deleteTranscript } from '../../services/transcripts';
import type { TranscriptListItem } from '../../services/transcripts';
import { removeShare } from '../../services/transcriptShares';
import { hasPlayableAudio } from '../../utils/transcriptDisplay';
import type { AudioPreviewState } from '../../hooks/useLibraryAudioPreview';

/**
 * ≥44px in both axes on a phone — WCAG 2.5.8, and the same number
 * `datatable/desktop/RowActionsCell.tsx` enforces for its card renderer.
 *
 * Applied only in the comfortable (phone) layout. The dense layout is the
 * pointer-driven one, where MUI's own 40px small button already clears the
 * 24px minimum that applies there and a 44px target would cost a row of
 * vertical space on every row in the list.
 */
const TOUCH_TARGET_SX = { minWidth: 44, minHeight: 44 } as const;

/** Which confirmation the row is asking for, if any. */
type Confirmation = 'delete' | 'leave';

export interface TranscriptRowActionsProps {
  transcript: TranscriptListItem;
  /** The row's layout: `true` is the `sm`-and-up dense row, `false` the phone card. */
  dense: boolean;
  /** What the shared preview element is doing for THIS row. */
  previewState: AudioPreviewState;
  onTogglePreview: () => void;
  onOpen: () => void;
  /** The list has to re-read itself: a row was deleted or left. */
  onChanged: () => void;
}

export function TranscriptRowActions({
  transcript,
  dense,
  previewState,
  onTogglePreview,
  onOpen,
  onChanged,
}: TranscriptRowActionsProps) {
  const { user } = useAuth();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const isOwner = transcript.access === 'owner';
  const canExport = transcript.currentVersion >= 1;
  const playable = hasPlayableAudio(transcript);

  const isPlaying = previewState === 'playing';
  const isLoadingAudio = previewState === 'loading';

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  const handleConfirm = useCallback(async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm === 'delete') await deleteTranscript(transcript.id);
      else if (user?.id) await removeShare(transcript.id, user.id);
      setConfirm(null);
      // The list re-reads itself rather than this component removing the row:
      // a deleted transcript goes to `deleting` and is purged asynchronously,
      // so what the row should show next is the server's answer, not a guess.
      onChanged();
    } catch (cause) {
      setConfirmError(
        cause instanceof ApiError ? cause.message : 'That could not be completed.',
      );
    } finally {
      setConfirmBusy(false);
    }
  }, [confirm, onChanged, transcript.id, user?.id]);

  const buttonSx = dense ? undefined : TOUCH_TARGET_SX;
  const buttonSize = dense ? 'small' : 'medium';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: dense ? 0.25 : 0.5,
        // Never shrinks and never wraps: at 360px the title truncates instead,
        // which is the thing on this row that can lose characters and still be
        // useful. A control that has wrapped under the card is a control the
        // user has to hunt for.
        flexShrink: 0,
        pr: dense ? 0.5 : 1,
      }}
    >
      {playable && (
        <IconButton
          size={buttonSize}
          sx={buttonSx}
          /**
           * Named for its ROW, not for its icon. A screen-reader user moving
           * through a list of forty rows otherwise hears "Play, Play, Play" and
           * has no way to tell which recording any of them belongs to.
           */
          aria-label={`${isPlaying ? 'Pause' : 'Play'} "${transcript.title}"`}
          /**
           * The name deliberately does NOT change while the URL is being
           * signed — a control that renames itself mid-press is a control a
           * screen reader describes differently each time it is touched. The
           * busy state is announced as busy, which is what it is.
           */
          aria-busy={isLoadingAudio || undefined}
          onClick={onTogglePreview}
        >
          {isLoadingAudio ? (
            // `aria-hidden`, because the button's own name and `aria-busy`
            // already say this — an unlabelled progressbar inside a labelled
            // button is a second, meaningless element to announce.
            <CircularProgress size={dense ? 16 : 20} aria-hidden />
          ) : isPlaying ? (
            <PauseIcon fontSize={dense ? 'small' : 'medium'} />
          ) : (
            <PlayArrowIcon fontSize={dense ? 'small' : 'medium'} />
          )}
        </IconButton>
      )}

      <IconButton
        size={buttonSize}
        sx={buttonSx}
        aria-label={`More options for "${transcript.title}"`}
        aria-haspopup="menu"
        aria-expanded={menuAnchor ? true : undefined}
        onClick={(event) => setMenuAnchor(event.currentTarget)}
      >
        <MoreVertIcon fontSize={dense ? 'small' : 'medium'} />
      </IconButton>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem
          onClick={() => {
            closeMenu();
            onOpen();
          }}
        >
          <ListItemText>Open</ListItemText>
        </MenuItem>
        {canExport && (
          <MenuItem
            onClick={() => {
              closeMenu();
              setExportOpen(true);
            }}
          >
            <ListItemText>Export…</ListItemText>
          </MenuItem>
        )}
        {isOwner && (
          <MenuItem
            onClick={() => {
              closeMenu();
              setShareOpen(true);
            }}
          >
            <ListItemText>Share…</ListItemText>
          </MenuItem>
        )}
        {isOwner ? (
          <MenuItem
            onClick={() => {
              closeMenu();
              setConfirm('delete');
            }}
          >
            <ListItemText slotProps={{ primary: { color: 'error.main' } }}>
              Delete transcript
            </ListItemText>
          </MenuItem>
        ) : (
          <MenuItem
            onClick={() => {
              closeMenu();
              setConfirm('leave');
            }}
          >
            <ListItemText>Leave this transcript</ListItemText>
          </MenuItem>
        )}
      </Menu>

      {/*
        All three dialogs are siblings of the menu rather than children of it,
        and that placement is load-bearing: a dialog rendered inside `<Menu>` is
        unmounted the instant the menu closes, which is the instant the item
        that opened it was clicked. They portal to the body, so they cost this
        flex row no layout at all, and each renders nothing while closed.
      */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        transcriptId={transcript.id}
        currentVersion={transcript.currentVersion}
      />
      {isOwner && (
        <ShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          transcriptId={transcript.id}
          transcriptTitle={transcript.title}
        />
      )}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        {/* The same two sentences the transcript page uses. A destructive
            action must not be described one way from the list and another way
            from the page — the user is deciding about the same thing. */}
        <DialogTitle>
          {confirm === 'delete' ? 'Delete this transcript?' : 'Leave this transcript?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm === 'delete'
              ? 'The recording, the transcript and every version of it are removed. This cannot be undone.'
              : 'You will lose access to it immediately. Only the owner can share it with you again.'}
          </DialogContentText>
          {confirmError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {confirmError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button color="error" disabled={confirmBusy} onClick={() => void handleConfirm()}>
            {confirm === 'delete' ? 'Delete' : 'Leave'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default TranscriptRowActions;
