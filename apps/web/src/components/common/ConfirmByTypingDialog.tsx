/**
 * "Type this exact word to confirm" — the one dialog every irreversible action
 * in this app is gated behind.
 *
 * EXTRACTED FROM `components/admin/PushConfigConfirmDialog.tsx` by issue #80,
 * rather than copied. That file was the third implementation of this shape
 * (after `DbBackupRestoreDialog`) and #80 needed a fourth, at which point the
 * choice was between a fourth hand-rolled copy of the safety machinery or one
 * component the copies become thin wrappers over. The machinery is small but
 * every piece of it is load-bearing, and each is a way a copy can be subtly
 * wrong in a direction nobody notices until somebody deletes the wrong thing:
 *
 *   • THE TYPED TEXT IS CLEARED ON EVERY OPEN AND ON EVERY CHANGE OF
 *     `resetKey`. This is the piece that makes different literals for different
 *     actions actually mean something: without it, a user who types `ROTATE`,
 *     cancels, and opens Remove arrives at a dialog with stale text in the box,
 *     and the only thing standing between them and the wrong destructive action
 *     is that the two words happen to differ. A copy that forgets the
 *     `resetKey` half clears on open and looks completely correct.
 *   • THE COMPARISON IS `typed.trim() === literal` — exact, case-sensitive,
 *     never `toUpperCase()` or `includes`. A confirmation a user can satisfy by
 *     typing lowercase is a confirmation they can satisfy without reading.
 *   • THE CONFIRM BUTTON IS DISABLED UNTIL IT MATCHES, and is `color="error"`.
 *
 * =============================================================================
 * WHAT THIS COMPONENT DOES NOT DO
 * =============================================================================
 *
 * It holds no copy, knows no action names and imports no service. `title`,
 * `consequence` and `confirmLabel` are the caller's, and `literal` is passed in
 * from the constant the SERVICE module exports (`ROTATE_CONFIRMATION`,
 * `USER_DATA_CONFIRMATION[scope]`) so the string the user types is the same
 * object the request body carries rather than a second spelling of it.
 *
 * `consequence` is a `ReactNode`, not a string, and that is the one deliberate
 * generalisation beyond what the push dialog needed: #80's copy is a list of
 * three separately-surprising force semantics, and flattening those into one
 * paragraph to fit a `string` prop would be letting the component's type
 * dictate the wording of a warning.
 *
 * ⚠ REJECTED: a `scope`/`action` union prop with a COPY record inside, which is
 * what both existing dialogs do. That works when one component serves two
 * intents from one feature; it does not survive two features, because the union
 * would have to name `rotate | remove | transcripts | notes | files | content |
 * everything` and this file would import from both services to build the
 * record. The per-feature wrapper (`PushConfigConfirmDialog`,
 * `UserDataDeleteDialog`) is where a COPY record belongs, and both still have
 * one.
 */

import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';

export interface ConfirmByTypingDialogProps {
  open: boolean;
  /** The exact string that must be typed. Comes from the service module's constant. */
  literal: string;
  title: string;
  /** What will happen. A node so a caller can state several distinct consequences. */
  consequence: ReactNode;
  /** The confirm button's label — a verb phrase naming the action, never "OK". */
  confirmLabel: string;
  isWorking: boolean;
  /** The last failure from the caller's action, or `null`. */
  error: string | null;
  /**
   * Changing this clears whatever has been typed. Pass the identity of the
   * action being confirmed (the scope, the mode) so text typed for one can
   * never carry over to another when the same dialog instance is reused.
   */
  resetKey?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  /** Anything else to show below the warning — extra detail, a list, a count. */
  children?: ReactNode;
}

export function ConfirmByTypingDialog({
  open,
  literal,
  title,
  consequence,
  confirmLabel,
  isWorking,
  error,
  resetKey = null,
  onConfirm,
  onClose,
  children,
}: ConfirmByTypingDialogProps) {
  const [typed, setTyped] = useState('');
  // The dialog's own title element, wired to `aria-labelledby`: MUI does not
  // infer it from `DialogTitle`, so without this the dialog is announced with
  // no name at all.
  const titleId = useId();

  // Every opening starts from nothing — cleared on open AND on a change of
  // `resetKey`, so a literal typed for one action can never carry over and
  // satisfy another. See the file header; this is the piece a copy loses.
  useEffect(() => {
    if (!open) return;
    setTyped('');
  }, [open, resetKey]);

  if (!open) return null;

  const typedMatches = typed.trim() === literal;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Alert severity="warning">
          <AlertTitle>This cannot be undone</AlertTitle>
          {consequence}
        </Alert>

        {children}

        <Box sx={{ mt: 3 }}>
          <TextField
            fullWidth
            label={`Type ${literal} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            slotProps={{ htmlInput: { 'aria-label': `Type ${literal} to confirm` } }}
            helperText="This must be typed exactly, in capitals. Nothing happens until it matches."
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isWorking}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={!typedMatches || isWorking}
          onClick={onConfirm}
        >
          {isWorking ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
