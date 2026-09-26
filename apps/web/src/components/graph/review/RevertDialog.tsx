/**
 * Revert a committed proposal (#367; ontology.md §19 "revert").
 *
 * First ask: "Removes what this proposal added. Anything you've edited or used
 * since stays." → `revert(false)`. When #366 answers 409 `revert_conflict`,
 * list what it would have to keep and offer **Revert the rest**
 * (`confirmPartial: true`). A 409 `proposal_not_committed` means another tab
 * got there first: the sheet re-reads and this dialog closes.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import { ApiError } from '../../../services/api';
import { graphConflictReason, revertConflictDetails } from '../../../services/graph';
import type { RevertKept, RevertKeptWhy, RevertResult } from '../../../services/graph';

export const REVERT_WHY_COPY: Record<RevertKeptWhy, string> = {
  edited_since: 'edited since',
  referenced_since: 'used by something added since',
  merged_since: 'merged since',
  evidence_since: 'has newer evidence',
};

export interface RevertDialogProps {
  open: boolean;
  onClose: () => void;
  onRevert: (confirmPartial: boolean) => Promise<{ result: RevertResult }>;
  /** The proposal is no longer committed — re-read it. */
  onStale: () => void;
  onReverted: (result: RevertResult) => void;
}

export function RevertDialog({ open, onClose, onRevert, onStale, onReverted }: RevertDialogProps) {
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<{ kept: RevertKept[]; revertible: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConflicts(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const run = async (confirmPartial: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { result } = await onRevert(confirmPartial);
      onReverted(result);
      onClose();
    } catch (err) {
      const details = revertConflictDetails(err);
      if (details) {
        setConflicts({ kept: details.conflicts, revertible: details.revertible });
      } else if (graphConflictReason(err) === 'proposal_not_committed') {
        onStale();
        onClose();
      } else {
        setError(err instanceof ApiError ? err.message : 'This proposal could not be reverted');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} aria-labelledby="proposal-revert-title">
      <DialogTitle id="proposal-revert-title">Revert this proposal?</DialogTitle>
      <DialogContent>
        {conflicts ? (
          <>
            <DialogContentText>
              Some of what this proposal added has changed since, and will stay:
            </DialogContentText>
            <Box component="ul" sx={{ pl: 3, my: 1 }}>
              {conflicts.kept.map((row) => (
                <Typography component="li" variant="body2" key={`${row.kind}-${row.id}`}>
                  {row.label} — {REVERT_WHY_COPY[row.why] ?? row.why}
                </Typography>
              ))}
            </Box>
            <DialogContentText>
              {conflicts.revertible} {conflicts.revertible === 1 ? 'change' : 'changes'} can still be
              reverted.
            </DialogContentText>
          </>
        ) : (
          <DialogContentText>
            Removes what this proposal added. Anything you've edited or used since stays.
          </DialogContentText>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {conflicts ? (
          <Button color="error" variant="contained" disabled={busy} onClick={() => void run(true)}>
            Revert the rest
          </Button>
        ) : (
          <Button color="error" variant="contained" disabled={busy} onClick={() => void run(false)}>
            Revert
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default RevertDialog;
