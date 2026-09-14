/**
 * "This note changed somewhere else" — the 409, issue #58, epic #45.
 *
 * =============================================================================
 * ⚠ A 409 IS A DECISION TO BE MADE, NOT AN ERROR TO BE REPORTED
 * =============================================================================
 *
 * `PATCH /api/notes/{id}` answers **409** with `details.reason:
 * 'stale_base_version'` and `details.currentVersion` when the note moved under
 * the editor — two tabs, a phone and a laptop, a regeneration that committed
 * while somebody was typing. Both bodies are real work and the API deliberately
 * refuses to pick one. The whole point of that refusal is lost if the client
 * then renders "Conflict" in a red alert with a Retry button.
 *
 * #58 rejects the Retry button by name, and the reason is worth stating
 * precisely: RETRYING IS NOT A NEUTRAL ACTION HERE. A retry means re-sending
 * the same body with a fresh `baseVersion`, which is exactly the silent
 * overwrite the version check exists to prevent. A button labelled "Retry"
 * would read to a user as "try the thing that failed again" and would in fact
 * mean "destroy the other version". So there is no such button anywhere below.
 *
 * =============================================================================
 * THE THREE THINGS THIS DIALOG MUST DO
 * =============================================================================
 *
 * 1. SAY WHAT HAPPENED in words that name the cause — the note changed
 *    somewhere else — rather than a status code.
 * 2. SHOW WHAT THE OTHER VERSION CONTAINS. A user cannot choose between two
 *    texts they have only been told about; the current body is rendered here,
 *    in full and scrollable, beside their own.
 * 3. OFFER A REAL CHOICE, and make the safe one easy. "Copy my text" puts the
 *    unsaved work on the clipboard so it survives whatever happens next;
 *    "Keep editing" closes the dialog with the draft untouched; "Discard mine
 *    and reload" is the only path that loses anything, is labelled as such, and
 *    is never the auto-focused default.
 *
 * ⚠ NOTHING IN THIS DIALOG WRITES TO THE API. Every action is local — copy,
 * close, or reload the server's version. A conflict resolution that saved
 * something on the user's behalf would be making the decision this component
 * exists to hand to them.
 *
 * THE CLIPBOARD MAY NOT BE THERE. `navigator.clipboard` is absent on insecure
 * origins and in some embedded webviews, and it can reject. Either way the
 * dialog says so and points at the text below, which is selectable — it never
 * reports a copy that did not happen.
 */

import { useCallback, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

export interface NoteConflictDialogProps {
  open: boolean;
  /** The version the editor was based on. */
  baseVersion: number;
  /** What the note is actually at now, from `details.currentVersion`. */
  currentVersion: number | null;
  /** The draft that was refused. Shown, and copyable. */
  mine: string;
  /** The body the note currently holds, re-read after the refusal. */
  theirs: string | null;
  /** Close with the draft untouched — the user keeps editing. */
  onKeepEditing: () => void;
  /** Take the server's version, losing the draft. Named plainly on the button. */
  onDiscardAndReload: () => void;
}

/** One of the two texts, quoted so neither can be mistaken for the page. */
function Quote({ title, text }: { title: string; text: string }) {
  return (
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        {title}
      </Typography>
      <Box
        sx={{
          borderLeft: 3,
          borderColor: 'divider',
          pl: 1.5,
          // Capped and scrollable: a note is a page or two of prose and an
          // uncapped quote would push the buttons off a phone screen — which
          // would leave the user unable to reach the choice this dialog is for.
          maxHeight: 220,
          overflowY: 'auto',
        }}
      >
        <Typography
          variant="body2"
          component="pre"
          sx={{
            // `pre-wrap`, because markdown's meaning is in its line structure
            // and a collapsed quote can make two different bodies look alike.
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            m: 0,
          }}
        >
          {text || '(empty)'}
        </Typography>
      </Box>
    </Box>
  );
}

export function NoteConflictDialog({
  open,
  baseVersion,
  currentVersion,
  mine,
  theirs,
  onKeepEditing,
  onDiscardAndReload,
}: NoteConflictDialogProps) {
  const theme = useTheme();
  // The `down('sm')` compact-window convention shared with `SettingsHub`,
  // `AppBar` and the transcript export dialog — CLAUDE.md's rule 5 gates. The
  // boundary is `sm` (600px) and never `md`.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const copyMine = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mine);
      setCopied('done');
    } catch {
      // Never reported as a success. See the header.
      setCopied('failed');
    }
  }, [mine]);

  return (
    <Dialog
      open={open}
      // ⚠ NO `onClose`. A backdrop click or an Escape must not dismiss the one
      // screen holding the user's unsaved text — "Keep editing" is right there
      // and does the same thing deliberately.
      fullWidth
      maxWidth="md"
      fullScreen={isCompactWindow}
      aria-labelledby="note-conflict-title"
    >
      <DialogTitle id="note-conflict-title">This note changed somewhere else</DialogTitle>

      <DialogContent dividers>
        <DialogContentText component="div" sx={{ mb: 2 }}>
          <Typography variant="body2" component="p">
            You were editing version {baseVersion}
            {currentVersion !== null ? `, and the note is now at version ${currentVersion}` : ''}.
            Another tab, another device or a regeneration saved first, so your text was{' '}
            <strong>not saved</strong> — and nothing of theirs was overwritten.
          </Typography>
          <Typography variant="body2" component="p" sx={{ mt: 1 }}>
            Both versions are real work. Copy your text somewhere safe first if you want to
            keep it, then take the current version and paste yours back in.
          </Typography>
        </DialogContentText>

        {copied === 'done' && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Your text is on the clipboard.
          </Alert>
        )}
        {copied === 'failed' && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            This browser would not let the page use the clipboard. Your text is below — select
            it and copy it by hand.
          </Alert>
        )}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <Quote title={`Your unsaved text (based on version ${baseVersion})`} text={mine} />
          <Quote
            title={
              currentVersion !== null
                ? `What the note says now (version ${currentVersion})`
                : 'What the note says now'
            }
            text={theirs ?? 'Loading the current version…'}
          />
        </Stack>
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button startIcon={<ContentCopyIcon />} onClick={() => void copyMine()}>
          Copy my text
        </Button>
        {/* THE SAFE CHOICE IS THE PROMINENT ONE. The user's draft is still on
            the page behind this dialog, and closing keeps it there. */}
        <Button variant="contained" onClick={onKeepEditing}>
          Keep editing
        </Button>
        {/* ⚠ NOT "Retry". This is the only action that loses anything, and it
            says what it loses. */}
        <Button color="error" onClick={onDiscardAndReload}>
          Discard mine and reload
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default NoteConflictDialog;
