/**
 * "Regenerate this note?" — the one-click "same again" confirmation, issue #312.
 *
 * The split button's main part lands here. It holds NO controls and reads
 * NOTHING: the note already carries the template's denormalised name, and the
 * request it confirms is the empty body `{}` — "keep the template, the context
 * and the model the note already has" — so there is nothing to fetch and
 * nothing to choose. Everything else lives one click away behind "Change
 * options…", which opens the full dialog.
 *
 * It still states the cost before anything is spent (#58): the sentence is the
 * shared `REGENERATE_COST_SENTENCE`, so this dialog and the options dialog
 * cannot drift apart on what the user is paying for.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

import type { Note } from '../../services/notes';
import { REGENERATE_COST_SENTENCE } from './regenerateInput';

export interface RegenerateSameConfirmDialogProps {
  open: boolean;
  note: Note;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onChangeOptions: () => void;
}

export function RegenerateSameConfirmDialog({
  open,
  note,
  busy,
  error,
  onCancel,
  onConfirm,
  onChangeOptions,
}: RegenerateSameConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      fullWidth
      maxWidth="xs"
      aria-labelledby="note-regenerate-same-title"
    >
      <DialogTitle id="note-regenerate-same-title">Regenerate this note?</DialogTitle>

      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body2" component="p">
            Uses the same template (<b>{note.templateName ?? 'Current template'}</b>), context
            and model. Your current version stays in History.
          </Typography>
          <Typography variant="body2" component="p" sx={{ mt: 1.5 }}>
            <strong>{REGENERATE_COST_SENTENCE}</strong>
          </Typography>
        </DialogContentText>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onChangeOptions} disabled={busy}>
          Change options…
        </Button>
        <Button variant="contained" onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : 'Regenerate'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RegenerateSameConfirmDialog;
