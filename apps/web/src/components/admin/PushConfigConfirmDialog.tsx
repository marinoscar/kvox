/**
 * The rotate / remove confirmation dialog for Web Push (VAPID) config,
 * issue #355.
 *
 * ONE COMPONENT FOR BOTH INTENTS, mirroring `DbBackupRestoreDialog`'s reason
 * for being one: rotate and remove need exactly the same safety machinery —
 * a stated consequence and a TYPED CONFIRMATION LITERAL — and differ only in
 * their copy and which literal they require. `action` selects between them
 * and nothing else forks.
 *
 * THE TWO LITERALS ARE DIFFERENT WORDS ON PURPOSE (`ROTATE_CONFIRMATION` /
 * `REMOVE_CONFIRMATION`, `services/pushConfig.ts`) — the same reasoning as
 * `RESTORE`/`ROLLBACK`: a confirmation typed for the wrong dialog, or a body
 * copied from one route to the other, must not satisfy the other action.
 * The typed text is cleared every time the dialog opens or `action` changes,
 * so a value typed for Rotate can never be reused to confirm Remove.
 *
 * ⚠ THE ROTATE WARNING'S RECOVERY CLAIM IS DELIBERATELY MODEST. As of this
 * writing there is no client-side re-subscribe-on-reopen mechanism anywhere
 * in this codebase (`docs/runbooks/vapid-keys.md` §4, checked directly) — a
 * subscriber's browser must call `pushManager.subscribe` again through
 * whatever flow does that (e.g. toggling notifications off and back on), and
 * nothing makes that happen automatically just because the app is reopened.
 * Do not soften this copy to "reopening the app fixes it" without re-reading
 * that section first; it will be wrong again the moment it is written.
 */

import { useEffect, useState } from 'react';
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
import { REMOVE_CONFIRMATION, ROTATE_CONFIRMATION } from '../../services/pushConfig';

export type PushConfigDialogAction = 'rotate' | 'remove';

export interface PushConfigConfirmDialogProps {
  /** `null` closes the dialog; a specific action opens it in that mode. */
  action: PushConfigDialogAction | null;
  isWorking: boolean;
  /** The last failure from the hook's action, or `null`. */
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const COPY: Record<
  PushConfigDialogAction,
  { title: string; consequence: string; confirmLabel: string }
> = {
  rotate: {
    title: 'Rotate the VAPID key pair?',
    consequence:
      'Rotating replaces the key pair. Every existing push subscriber stops receiving ' +
      'notifications immediately. Recovery is not automatic — this app has no ' +
      're-subscribe-on-reopen mechanism, so each subscriber has to re-trigger their ' +
      "browser's subscribe flow (for example, turning notifications off and back on) " +
      'before push works for them again.',
    confirmLabel: 'Rotate keys',
  },
  remove: {
    title: 'Remove the web push configuration?',
    consequence:
      'Removing deletes the stored key pair entirely — there is no key left to fall back ' +
      'to. Every existing push subscriber stops receiving notifications, exactly as with ' +
      'a rotation, and the same manual re-subscribe is needed to recover once a new key ' +
      'pair is generated. This app keeps working; only web push stops.',
    confirmLabel: 'Remove configuration',
  },
};

export function PushConfigConfirmDialog({
  action,
  isWorking,
  error,
  onConfirm,
  onClose,
}: PushConfigConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  // Every opening starts from nothing — cleared on open AND on a switch
  // between actions, so a literal typed for one can never carry over and
  // satisfy the other. Mirrors `DbBackupRestoreDialog`.
  useEffect(() => {
    if (!action) return;
    setTyped('');
  }, [action]);

  if (!action) return null;

  const literal = action === 'rotate' ? ROTATE_CONFIRMATION : REMOVE_CONFIRMATION;
  const copy = COPY[action];
  const typedMatches = typed.trim() === literal;

  return (
    <Dialog open={!!action} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Alert severity="warning">
          <AlertTitle>This cannot be undone</AlertTitle>
          {copy.consequence}
        </Alert>

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
          {isWorking ? 'Working…' : copy.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** For a component test asserting Rotate's literal doesn't satisfy Remove's dialog, and vice versa. */
export const PUSH_CONFIG_CONFIRM_LITERALS: Record<PushConfigDialogAction, string> = {
  rotate: ROTATE_CONFIRMATION,
  remove: REMOVE_CONFIRMATION,
};
