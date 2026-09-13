/**
 * Admin → Worker Nodes → the credential, shown once (issue #271, epic #254).
 *
 * Modelled on `components/settings/PatTokenRevealDialog.tsx`, deliberately down
 * to the arrangement: a warning banner first, a read-only monospace field with
 * a copy button in its end adornment, and a single "Done" action. That
 * treatment is not decoration — it is the app's established shape for "this
 * secret exists for the length of this dialog and then it is gone", and an
 * operator who has seen it once for a personal access token recognises the
 * stakes immediately.
 *
 * =============================================================================
 * THE SHOW-ONCE CLAIM IS LITERAL, WHICH IS WHY THE COPY IS BLUNT
 * =============================================================================
 *
 * `node-credential.service.ts` stores a sha256 hash of the token and nothing
 * else. There is no "reveal again", no support path, and no admin override that
 * recovers it: the `AdminNodeCredentialDto` the list renders has no `token`
 * FIELD AT ALL, so nothing downstream of this dialog could display it even by
 * mistake. The banner therefore states the consequence ("you will not be able
 * to see it again") rather than hedging with "may not" — a hedge invites the
 * reader to close the dialog and go looking.
 *
 * A COPY BUTTON, NOT ONLY SELECTABLE TEXT. Selecting a 40-character token by
 * dragging is the step where half of one gets copied, pasted into a node's
 * config, and produces a 401 an hour later that nobody connects to a mis-drag.
 * The clipboard write is wrapped in try/catch and its failure is SILENT-ish by
 * design: the field is still there, still complete, and still selectable, so a
 * browser that denies clipboard access degrades to the manual path rather than
 * to an error dialog stacked on top of the one secret the operator must not
 * lose focus from.
 *
 * `expiresAt: null` IS RENDERED AS "Never expires", not omitted. It is the
 * default and the intended answer for an unattended worker, and this is the
 * last moment the operator sees the credential's terms next to its value.
 */

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { NodeCredentialCreated } from '../../services/nodes';

interface NodeCredentialRevealDialogProps {
  open: boolean;
  onClose: () => void;
  /** The create response. `null` while no credential is being revealed. */
  credential: NodeCredentialCreated | null;
}

export function NodeCredentialRevealDialog({
  open,
  onClose,
  credential,
}: NodeCredentialRevealDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(credential.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard access denied or unavailable. The field beside this button is
      // still complete and still selectable — see the file header on why that
      // is the right fallback rather than an error on top of a secret.
    }
  };

  const handleClose = () => {
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Node credential created</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copy this credential now. It is shown once and cannot be retrieved again — if you
            lose it, revoke it and create another.
          </Alert>

          <TextField
            label="Node credential"
            value={credential?.token ?? ''}
            fullWidth
            slotProps={{
              input: {
                readOnly: true,
                sx: { fontFamily: 'monospace' },
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title={copied ? 'Copied' : 'Copy credential'}>
                      <IconButton
                        onClick={() => void handleCopy()}
                        edge="end"
                        aria-label="copy node credential"
                      >
                        {copied ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ),
              },
            }}
          />

          {copied && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Credential copied to clipboard
            </Alert>
          )}

          {credential && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              {/* The terms, beside the value, while both are still on screen. */}
              <strong>{credential.name}</strong> ·{' '}
              {credential.expiresAt
                ? `Expires ${new Date(credential.expiresAt).toLocaleString()}`
                : 'Never expires — revoke it to cut the node off'}
            </Typography>
          )}

          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Give it to the worker as its node credential. It can reach the worker API and
            nothing else, and it cannot create further credentials.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={handleClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
