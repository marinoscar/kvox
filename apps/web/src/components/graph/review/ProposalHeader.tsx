/**
 * The sheet's sticky header (#367): title, status, the model the proposal was
 * extracted with (§20 — "the model used is shown on the proposal"), the
 * decision counts, and an overflow menu — Re-extract…, Discard draft, Show
 * what the AI saw.
 */

import CloseIcon from '@mui/icons-material/Close';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { ProposalStatus, ProposalSummary } from '../../../services/graph';

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  extracting: 'Extracting',
  draft: 'Draft',
  committed: 'Sent to graph',
  discarded: 'Discarded',
  failed: 'Failed',
  reverted: 'Reverted',
};

const STATUS_COLORS: Record<ProposalStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  extracting: 'info',
  draft: 'warning',
  committed: 'success',
  discarded: 'default',
  failed: 'error',
  reverted: 'default',
};

export interface ProposalHeaderProps {
  headingId: string;
  summary: ProposalSummary | null;
  modelLabel: string | null;
  canWrite: boolean;
  onClose: () => void;
  onReextract: () => void;
  onDiscard: () => void;
  onShowContext: () => void;
  headerSlot?: ReactNode;
}

export function ProposalHeader({
  headingId,
  summary,
  modelLabel,
  canWrite,
  onClose,
  onReextract,
  onDiscard,
  onShowContext,
  headerSlot,
}: ProposalHeaderProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const counts = summary?.counts;
  const canDiscard = canWrite && (summary?.status === 'draft' || summary?.status === 'failed');
  const canReextract = canWrite && summary !== null && summary.status !== 'extracting' && summary.noteId !== null;

  return (
    <Box sx={{ px: 2, pt: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography id={headingId} variant="h6" component="h2" sx={{ flexGrow: 1, fontSize: '1.05rem' }}>
          Graph proposal
        </Typography>
        {summary && (
          <Chip size="small" label={PROPOSAL_STATUS_LABELS[summary.status]} color={STATUS_COLORS[summary.status]} />
        )}
        {summary && (canReextract || canDiscard || summary.status !== 'extracting') && (
          <IconButton
            size="small"
            aria-label="Proposal actions"
            aria-haspopup="menu"
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        )}
        <IconButton size="small" aria-label="Close graph proposal" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {summary?.model && (
        <Typography variant="caption" color="text.secondary" component="div">
          Extracted with {modelLabel ?? summary.model}
        </Typography>
      )}
      {counts && summary?.status !== 'extracting' && summary?.status !== 'failed' && (
        <Typography variant="caption" color="text.secondary" component="div">
          {counts.accepted} to send · {counts.pending} undecided · {counts.rejected} rejected
        </Typography>
      )}
      {headerSlot}
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {canReextract && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onReextract();
            }}
          >
            Re-extract…
          </MenuItem>
        )}
        {canDiscard && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onDiscard();
            }}
          >
            Discard draft
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onShowContext();
          }}
        >
          Show what the AI saw
        </MenuItem>
      </Menu>
    </Box>
  );
}

export default ProposalHeader;
