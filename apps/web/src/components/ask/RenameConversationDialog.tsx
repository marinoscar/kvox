/**
 * `RenameConversationDialog` — give a saved conversation a title (#380).
 * 1–120 characters after trimming (#376's `renameAskConversationSchema`).
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { ASK_TITLE_MAX_CHARS } from '../../services/ask';
import { ApiError } from '../../services/api';

export interface RenameConversationDialogProps {
  open: boolean;
  initialTitle: string | null;
  onClose: () => void;
  /** Rejects with the API error, which is shown in the dialog. */
  onRename: (title: string) => Promise<unknown>;
}

export function RenameConversationDialog({ open, initialTitle, onClose, onRename }: RenameConversationDialogProps) {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setTitle(initialTitle ?? '');
      setError(null);
    }
  }, [initialTitle, open]);

  const trimmed = title.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= ASK_TITLE_MAX_CHARS;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : 'Could not rename this conversation');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="xs">
      <form onSubmit={submit} noValidate>
        <DialogTitle id={titleId}>Rename conversation</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            error={title.length > 0 && !valid}
            helperText={`${trimmed.length}/${ASK_TITLE_MAX_CHARS}`}
            slotProps={{ htmlInput: { maxLength: ASK_TITLE_MAX_CHARS + 20 } }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={!valid || saving}>
            Save
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default RenameConversationDialog;
