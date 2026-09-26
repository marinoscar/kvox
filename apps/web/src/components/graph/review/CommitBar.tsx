/**
 * The sheet's footer on a draft (#367; ontology.md §8): **Send to graph (n)**
 * and **Discard**.
 *
 * Undecided rows are neither sent nor remembered as rejected (#366's
 * `skippedPending`), which is easy to miss — so a commit with any still
 * pending asks first. (Discard's confirmation is the sheet's, shared with the
 * header menu's "Discard draft".)
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { useState } from 'react';

import type { ProposalCounts } from '../../../services/graph';

export interface CommitBarProps {
  counts: ProposalCounts;
  /** A commit or discard is in flight. */
  busy: boolean;
  onCommit: () => void;
  onDiscard: () => void;
}

export function CommitBar({ counts, busy, onCommit, onDiscard }: CommitBarProps) {
  const [confirm, setConfirm] = useState<'commit' | null>(null);

  const commit = () => {
    if (counts.pending > 0) {
      setConfirm('commit');
      return;
    }
    onCommit();
  };

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        justifyContent: 'flex-end',
        alignItems: 'center',
        px: 2,
        py: 1.5,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Button color="inherit" disabled={busy} onClick={onDiscard}>
        Discard
      </Button>
      <Button variant="contained" disabled={busy || counts.accepted === 0} onClick={commit}>
        Send to graph ({counts.accepted})
      </Button>

      <Dialog
        open={confirm === 'commit'}
        onClose={() => setConfirm(null)}
        aria-labelledby="proposal-commit-confirm-title"
      >
        <DialogTitle id="proposal-commit-confirm-title">Send with undecided rows?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {counts.pending} {counts.pending === 1 ? 'row is' : 'rows are'} still undecided. They
            won't be sent, and they won't be remembered as rejected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Keep reviewing</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirm(null);
              onCommit();
            }}
          >
            Send {counts.accepted}
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}

export default CommitBar;
