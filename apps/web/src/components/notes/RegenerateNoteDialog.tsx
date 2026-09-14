/**
 * "Regenerate this note?" — issue #58, epic #45.
 *
 * =============================================================================
 * TWO FACTS, BOTH STATED, BOTH EASY TO GET WRONG BY OMISSION
 * =============================================================================
 *
 * 1. **IT SPENDS THE USER'S OWN MONEY.** This application has no AI key of its
 *    own; a generation is billed to the provider account whose key the user
 *    saved (#55). A regenerate button that quietly re-ran a model would be
 *    spending somebody else's money without telling them, which is the one
 *    thing an AI feature funded this way must never do. So the confirmation
 *    names it in the dialog, not in a tooltip and not in the settings page.
 *
 * 2. **NOTHING IS LOST.** The current body is already a version and stays one:
 *    a successful regeneration APPENDS the next version rather than overwriting
 *    anything, and a `ready` note keeps showing its last good text until the
 *    new generation commits. A user who does not know that reads "Regenerate"
 *    as "throw away what I have and hope", which makes the feature unusable on
 *    a note they care about — precisely the note they most want to improve.
 *
 * Both sentences are in the dialog body rather than in the button label,
 * because a button cannot carry them and a user who has already pressed it is
 * past the point where they help.
 *
 * =============================================================================
 * ⚠ THIS DIALOG DOES NOT CHECK FOR A KEY — ITS CALLER DOES, ONE LEVEL UP
 * =============================================================================
 *
 * With `keyConfigured: false` the note page renders `AiKeyRequired` in place of
 * the regenerate control entirely, and READING AND EXPORTING GO ON WORKING. A
 * missing key gates the one action that needs a provider account; it must never
 * gate the user's own note. Putting that branch here would mean a dialog that
 * sometimes opens onto a refusal, which is a worse version of the same thing.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

export interface RegenerateNoteDialogProps {
  open: boolean;
  /** The version that is kept — named, so "kept as a version" is checkable. */
  currentVersion: number;
  /** The template the note will be regenerated with, when it still has one. */
  templateName: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RegenerateNoteDialog({
  open,
  currentVersion,
  templateName,
  busy,
  error,
  onCancel,
  onConfirm,
}: RegenerateNoteDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      fullWidth
      maxWidth="sm"
      aria-labelledby="note-regenerate-title"
    >
      <DialogTitle id="note-regenerate-title">Regenerate this note?</DialogTitle>

      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body2" component="p">
            Your AI provider will write this note again
            {templateName ? ` using ${templateName}` : ''}.{' '}
            {/* FACT 1 — the cost, in the user's own terms. */}
            <strong>This runs on your own provider account and costs you money again</strong>,
            the same as the first generation did.
          </Typography>
          <Typography variant="body2" component="p" sx={{ mt: 1.5 }}>
            {/* FACT 2 — what happens to what is already here. */}
            Nothing is lost. The note as it stands is kept as{' '}
            <strong>version {currentVersion}</strong> in the history, and the new text is
            added as the next version — so you can read both and go back at any time.
          </Typography>
        </DialogContentText>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : 'Regenerate'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RegenerateNoteDialog;
