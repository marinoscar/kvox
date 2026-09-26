/**
 * One line in the review sheet's header saying how the proposal was steered
 * (#368; ontology.md §19): "Focused on Sarah Chen, Q2 pilot · 3 types ·
 * instructions", with **Edit guidance** re-opening the extract dialog in
 * re-extract mode. Renders nothing for a proposal extracted unguided.
 */

import TuneIcon from '@mui/icons-material/Tune';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import type { ProposalItem, UserGuidance } from '../../../services/graph';
import { guidanceSummary } from './guidance';

export interface GuidanceSummaryProps {
  guidance: UserGuidance | null | undefined;
  items?: readonly ProposalItem[];
  /** Absent: the line is read-only (no `graph:write`). */
  onEdit?: () => void;
}

export function GuidanceSummary({ guidance, items = [], onEdit }: GuidanceSummaryProps) {
  const text = guidanceSummary(guidance, items);
  if (!text) return null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <TuneIcon fontSize="small" color="action" aria-hidden />
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
        {text}
      </Typography>
      {onEdit && (
        <Button size="small" onClick={onEdit} sx={{ minHeight: 32 }}>
          Edit guidance
        </Button>
      )}
    </Box>
  );
}

export default GuidanceSummary;
