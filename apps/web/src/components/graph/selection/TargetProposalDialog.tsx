/**
 * Which draft does a selection join? (#368; ontology.md §8, §19)
 *
 * "Add to graph" never writes the graph: an added row joins a DRAFT proposal
 * and is committed with it. So:
 *   - no draft   → "Adding needs a draft." with Extract… (note page) or a
 *                  link to the transcript's notes (transcript page);
 *   - many       → a picker listing each draft's note and when it was made.
 * (One draft needs no dialog at all.)
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';

import type { ProposalSummary } from '../../../services/graph';
import { formatRelativeTime } from '../../../utils/relativeTime';

export interface TargetProposalDialogProps {
  open: boolean;
  onClose: () => void;
  /** `null` while loading; `[]` = no draft; several = pick one. */
  drafts: ProposalSummary[] | null;
  error?: string | null;
  onPick: (proposalId: string) => void;
  /** Note page: open the extract dialog. */
  onExtract?: () => void;
  /** Transcript page: go to the notes made from it. */
  onShowNotes?: () => void;
  fullScreen?: boolean;
}

export function TargetProposalDialog({
  open,
  onClose,
  drafts,
  error,
  onPick,
  onExtract,
  onShowNotes,
  fullScreen,
}: TargetProposalDialogProps) {
  const none = drafts !== null && drafts.length === 0;
  const title = none ? 'Adding needs a draft' : 'Add to which draft?';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      fullScreen={fullScreen && !none}
      aria-labelledby="graph-target-title"
    >
      <DialogTitle id="graph-target-title">{title}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        {!error && drafts === null && <LinearProgress aria-label="Looking for drafts" />}
        {!error && none && (
          <DialogContentText>
            {onExtract
              ? 'Extract this note first. What you selected can then be added to its draft.'
              : 'Extract a note of this transcript first. What you selected can then be added to its draft.'}
          </DialogContentText>
        )}
        {!error && drafts && drafts.length > 1 && (
          <>
            <DialogContentText sx={{ mb: 1 }}>
              Several notes of this transcript have a draft waiting for review.
            </DialogContentText>
            <List disablePadding aria-label="Drafts">
              {drafts.map((draft) => (
                <ListItemButton key={draft.id} onClick={() => onPick(draft.id)} sx={{ minHeight: 48 }}>
                  <ListItemText
                    primary={draft.noteTitle ?? 'Untitled note'}
                    secondary={`${draft.counts.pending} to review · ${formatRelativeTime(draft.createdAt)}`}
                  />
                </ListItemButton>
              ))}
            </List>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        {none && onExtract && (
          <Button variant="contained" onClick={onExtract}>
            Extract…
          </Button>
        )}
        {none && !onExtract && onShowNotes && (
          <Button variant="contained" onClick={onShowNotes}>
            Show notes
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default TargetProposalDialog;
