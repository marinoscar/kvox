import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import type { CopilotSignInChallenge } from '@marinoscar/kvox-contract/copilot';

/**
 * Props of {@link CopilotSignInDialog}.
 *
 * @stability experimental
 */
export interface CopilotSignInDialogProps {
  /** What the user must do. */
  challenge: CopilotSignInChallenge;
  /** A device code ran past its `expiresAt`. */
  expired: boolean;
  /** Open an address (the card supplies the host's opener). */
  onOpen: (url: string) => void;
  /** Start again with a new code or a new browser window. */
  onRestart: () => void;
  /** Stop waiting. */
  onCancel: () => void;
}

/**
 * The sign-in step: the device code with a copy button and the GitHub page, or
 * the "finish in your browser" hand-off, while the card waits for the user.
 *
 * @stability experimental
 */
export function CopilotSignInDialog({ challenge, expired, onOpen, onRestart, onCancel }: CopilotSignInDialogProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const titleId = 'copilot-signin-title';

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <Dialog open aria-labelledby={titleId} maxWidth="xs" fullWidth onClose={onCancel}>
      <DialogTitle id={titleId}>Sign in to GitHub Copilot</DialogTitle>
      <DialogContent>
        {challenge.kind === 'device' ? (
          expired ? (
            <Typography role="alert">This code has expired. Get a new code to keep signing in.</Typography>
          ) : (
            <Stack spacing={2}>
              <Typography variant="body2">
                Open the GitHub page and enter this code. KVox continues when you have finished.
              </Typography>
              <Typography
                component="p"
                variant="h4"
                aria-label={`Your code is ${challenge.userCode}`}
                sx={{ fontFamily: 'monospace', letterSpacing: '0.12em', textAlign: 'center', m: 0 }}
              >
                {challenge.userCode}
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                <Button variant="outlined" onClick={() => void copy(challenge.userCode)}>
                  Copy code
                </Button>
                <Button variant="contained" onClick={() => onOpen(challenge.verificationUri)}>
                  Open GitHub
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
                {copied === 'done'
                  ? 'Code copied.'
                  : copied === 'failed'
                    ? 'Copy failed. Select the code and copy it by hand.'
                    : ' '}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <CircularProgress size={16} aria-hidden="true" />
                <Typography variant="body2" color="text.secondary">
                  Waiting for you to finish on GitHub…
                </Typography>
              </Stack>
            </Stack>
          )
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2">
              Finish signing in with GitHub in your browser. KVox continues when you have finished.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} aria-hidden="true" />
              <Typography variant="body2" color="text.secondary">
                Waiting for GitHub…
              </Typography>
            </Stack>
            <div>
              <Button variant="outlined" onClick={() => onOpen(challenge.url)}>
                Open the sign-in page again
              </Button>
            </div>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        {expired ? (
          <Button variant="contained" onClick={onRestart}>
            Get a new code
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
