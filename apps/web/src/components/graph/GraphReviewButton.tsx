/**
 * The note page's entry into the proposal review sheet (#367): "Graph", with
 * a badge counting the draft's undecided rows, or a dot while an extraction
 * runs. The page renders it only for `graph:read` on a deployment with
 * connected knowledge on (`aiConfig.graphEnabled`).
 */

import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import Badge from '@mui/material/Badge';
import Button from '@mui/material/Button';

import type { ProposalSummary } from '../../services/graph';

export interface GraphReviewButtonProps {
  /** `undefined` while loading, `null` when nothing was extracted. */
  summary: ProposalSummary | null | undefined;
  open: boolean;
  onClick: () => void;
}

export function graphButtonLabel(summary: ProposalSummary | null | undefined): string {
  if (summary?.status === 'extracting') return 'Graph proposal, extracting';
  if (summary?.status === 'draft' && summary.counts.pending > 0) {
    return `Graph proposal, ${summary.counts.pending} undecided`;
  }
  return 'Graph proposal';
}

export function GraphReviewButton({ summary, open, onClick }: GraphReviewButtonProps) {
  const pending = summary?.status === 'draft' ? summary.counts.pending : 0;
  const extracting = summary?.status === 'extracting';
  return (
    <Button
      size="small"
      aria-label={graphButtonLabel(summary)}
      aria-expanded={open}
      onClick={onClick}
      startIcon={
        <Badge
          color="primary"
          variant={extracting ? 'dot' : 'standard'}
          badgeContent={extracting ? ' ' : pending}
          invisible={!extracting && pending === 0}
          max={99}
        >
          <HubOutlinedIcon fontSize="small" />
        </Badge>
      }
    >
      Graph
    </Button>
  );
}

export default GraphReviewButton;
