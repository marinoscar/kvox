/**
 * `DeleteConversationDialog` — "Delete this conversation? This can't be
 * undone." (#380). Deleting while an answer is still being written is
 * allowed: the job notices its row is gone and stops (#376).
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { useEffect, useId, useState } from 'react';

import { ApiError } from '../../services/api';

export interface DeleteConversationDialogProps {
  open: boolean;
  title: string | null;
  onClose: () => void;
  onDelete: () => Promise<unknown>;
}

export function DeleteConversationDialog({ open, title, onClose, onDelete }: DeleteConversationDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Could not delete this conversation');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={deleting ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id={titleId}>Delete this conversation?</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <DialogContentText id={bodyId}>
          {title ? `“${title}” will be deleted. ` : ''}This can&apos;t be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={() => void confirm()} disabled={deleting}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DeleteConversationDialog;
