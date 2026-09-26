/**
 * One group of proposed rows — People, Organizations, … Relations, Closes
 * (#367; ontology.md §8). An `h3` with the count, Accept all / Reject all over
 * the group's non-`known` rows (#366's bulk endpoint; the server skips
 * sensitive facts and closings and says so), the rows, then the two collapsed
 * disclosures for rows that are already in the graph or were rejected before.
 */

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import type { BulkDecision, ProposalItem } from '../../../services/graph';
import { ProposalItemRow } from './ProposalItemRow';
import type { ProposalRowHandlers } from './ProposalItemRow';
import { bulkTargetIds } from './proposalGrouping';
import type { ProposalGroupView } from './proposalGrouping';

export interface ProposalGroupProps extends ProposalRowHandlers {
  group: ProposalGroupView;
  items: readonly ProposalItem[];
  readOnly: boolean;
  pendingItemIds: ReadonlySet<string>;
  onBulk: (group: ProposalGroupView, itemIds: string[], decision: BulkDecision) => void;
}

function Disclosure({
  label,
  rows,
  render,
}: {
  label: string;
  rows: ProposalItem[];
  render: (item: ProposalItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      <Button
        size="small"
        color="inherit"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        endIcon={
          <ExpandMoreIcon
            fontSize="small"
            sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
          />
        }
      >
        {label} ({rows.length})
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box component="ul" id={id} sx={{ m: 0, p: 0, pl: 1 }}>
          {rows.map(render)}
        </Box>
      </Collapse>
    </Box>
  );
}

export function ProposalGroup({
  group,
  items,
  readOnly,
  pendingItemIds,
  onBulk,
  ...handlers
}: ProposalGroupProps) {
  const headingId = useId();
  const targets = bulkTargetIds(group);
  const count = group.rows.length + group.known.length + group.rejectedBefore.length;
  const busy = targets.some((id) => pendingItemIds.has(id));

  const renderRow = (item: ProposalItem) => (
    <ProposalItemRow
      key={item.id}
      item={item}
      items={items}
      readOnly={readOnly}
      busy={pendingItemIds.has(item.id)}
      {...handlers}
    />
  );

  return (
    <Box component="section" aria-labelledby={headingId} sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
        <Typography id={headingId} variant="subtitle2" component="h3" sx={{ flexGrow: 1 }}>
          {group.label}{' '}
          <Typography component="span" variant="body2" color="text.secondary">
            ({count})
          </Typography>
        </Typography>
        {!readOnly && targets.length > 0 && (
          <>
            <Button
              size="small"
              disabled={busy}
              aria-label={`Accept all ${group.label}`}
              onClick={() => onBulk(group, targets, 'accept')}
            >
              Accept all
            </Button>
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              aria-label={`Reject all ${group.label}`}
              onClick={() => onBulk(group, targets, 'reject')}
            >
              Reject all
            </Button>
          </>
        )}
      </Box>
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {group.rows.map(renderRow)}
        <Disclosure label="Already in your graph" rows={group.known} render={renderRow} />
        <Disclosure label="Rejected before" rows={group.rejectedBefore} render={renderRow} />
      </Box>
    </Box>
  );
}

export default ProposalGroup;
