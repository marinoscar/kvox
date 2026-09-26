/**
 * One proposed row (#367; ontology.md §8, §19 "Review UI and overrides").
 *
 * checkbox (checked ⇔ the row will be sent) · title/subtitle · resolution and
 * flag chips · "Evidence (n)" · a "More actions" menu. Every action becomes
 * exactly one #366 `PATCH …/items/:itemId` body via `onDecide`, except Edit,
 * Change type and Link, which open the sheet's dialogs first.
 *
 * Sensitive person facts and closings get an explicit "Accept" button: a
 * group's Accept all never ticks them (§5.6). A relation/item whose endpoint
 * entity row is rejected or undecided cannot be ticked — the sheet names the
 * endpoint to accept or link first (`blockingEndpoints`).
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

import type {
  PatchProposalItemInput,
  ProposalEvidence,
  ProposalItem,
  RelinkField,
} from '../../../services/graph';
import { EvidenceList } from './EvidenceList';
import { flagChips } from './flagCopy';
import { blockingEndpoints, isChecked, requiresIndividualAccept } from './proposalGrouping';

export interface ProposalRowHandlers {
  onDecide: (item: ProposalItem, body: PatchProposalItemInput) => void;
  onEdit: (item: ProposalItem, mode: 'edit' | 'type') => void;
  onRelink: (item: ProposalItem, field?: RelinkField) => void;
  onPlay?: (evidence: ProposalEvidence) => void;
  onShowInNote?: (evidence: ProposalEvidence) => void;
  onNavigate?: () => void;
}

export interface ProposalItemRowProps extends ProposalRowHandlers {
  item: ProposalItem;
  /** Every row of the proposal, for endpoint blocking. */
  items: readonly ProposalItem[];
  /** Committed, reverted, or no `graph:write`: nothing can change. */
  readOnly: boolean;
  /** A write for this row is in flight. */
  busy?: boolean;
}

interface ResolutionChip {
  label: string;
  color: 'success' | 'warning' | 'default' | 'info';
}

function percent(score: number | null): string | null {
  return score === null ? null : `${Math.round(score * 100)}%`;
}

/** The chips describing where a row stands against the existing graph. */
export function resolutionChips(item: ProposalItem): ResolutionChip[] {
  const chips: ResolutionChip[] = [];
  if (item.origin === 'user') chips.push({ label: 'Added by you', color: 'info' });
  if (item.decision === 'edit') chips.push({ label: 'Edited', color: 'default' });
  if (item.kind !== 'entity') return chips;

  const res = item.resolution;
  if (item.decision === 'merge_into') {
    chips.push({ label: `Linked to ${res?.refLabel ?? 'an existing entity'}`, color: 'success' });
    return chips;
  }
  const uncertain =
    res?.adjudication?.verdict === 'uncertain' ||
    item.flags.includes('possible_duplicate') ||
    item.flags.includes('ambiguous');
  if (res?.ref && !uncertain) {
    const score = percent(res.score);
    chips.push({
      label: `Linked to ${res.refLabel ?? 'an existing entity'}${score ? ` · ${score}` : ''}`,
      color: 'success',
    });
  } else if (uncertain && (res?.refLabel || res?.candidates[0])) {
    chips.push({ label: `Might be ${res?.refLabel ?? res?.candidates[0]?.label}`, color: 'warning' });
  } else {
    chips.push({ label: 'New', color: 'default' });
  }
  return chips;
}

/** A decision that keeps the row where it is while another field changes. */
export function keepDecision(item: ProposalItem): Pick<PatchProposalItemInput, 'decision' | 'mergeIntoId'> {
  if (item.decision === 'merge_into' && item.mergeIntoId) {
    return { decision: 'merge_into', mergeIntoId: item.mergeIntoId };
  }
  // `accept` keeps an existing `editedPayload` (#366); `edit` would need it resent.
  if (item.decision === 'edit') return { decision: 'accept' };
  return { decision: item.decision };
}

export function ProposalItemRow({
  item,
  items,
  readOnly,
  busy = false,
  onDecide,
  onEdit,
  onRelink,
  onPlay,
  onShowInNote,
  onNavigate,
}: ProposalItemRowProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const evidenceId = useId();

  const checked = isChecked(item.decision);
  const blockers = blockingEndpoints(item, items);
  const individual = requiresIndividualAccept(item);
  const title = item.display.title;
  const staleEvidence = item.evidence.some((entry) => entry.stale);
  const candidates = (item.resolution?.candidates ?? []).filter(
    (candidate) => !item.distinctFrom.includes(candidate.entityId),
  );

  const decide = (body: PatchProposalItemInput) => {
    setMenuAnchor(null);
    onDecide(item, body);
  };

  return (
    <Box
      component="li"
      data-testid={`proposal-row-${item.id}`}
      sx={{ listStyle: 'none', py: 1, display: 'flex', gap: 0.5, alignItems: 'flex-start' }}
    >
      <Checkbox
        size="small"
        checked={checked}
        disabled={readOnly || busy || (blockers.length > 0 && !checked)}
        onChange={(event) => decide({ decision: event.target.checked ? 'accept' : 'reject' })}
        slotProps={{ input: { 'aria-label': `Send ${title} to graph` } }}
        sx={{ mt: -0.5 }}
      />
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            wordBreak: 'break-word',
            textDecoration: item.decision === 'reject' ? 'line-through' : 'none',
            color: item.decision === 'reject' ? 'text.secondary' : 'text.primary',
          }}
        >
          {title}
        </Typography>
        {item.display.subtitle && (
          <Typography variant="caption" color="text.secondary" component="div">
            {item.display.subtitle}
          </Typography>
        )}
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          {resolutionChips(item).map((chip) => (
            <Chip key={chip.label} size="small" label={chip.label} color={chip.color} variant="outlined" />
          ))}
          {flagChips(item.flags).map((chip) => (
            <Chip
              key={chip.key}
              size="small"
              label={chip.label}
              color={chip.tone === 'warning' ? 'warning' : 'default'}
              variant={chip.tone === 'warning' ? 'outlined' : 'filled'}
            />
          ))}
        </Stack>
        {blockers.length > 0 && (
          <Alert severity="warning" variant="outlined" sx={{ mt: 0.75, py: 0 }}>
            {blockers.map((blocker) => `Accept or link ${blocker.label} first`).join('. ')}
          </Alert>
        )}
        {staleEvidence && (
          <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>
            Text changed since
          </Typography>
        )}
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            size="small"
            aria-expanded={showEvidence}
            aria-controls={evidenceId}
            onClick={() => setShowEvidence((value) => !value)}
          >
            Evidence ({item.evidence.length})
          </Button>
          {individual && !checked && !readOnly && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy || blockers.length > 0}
              aria-label={`Accept ${title}`}
              onClick={() => decide({ decision: 'accept' })}
            >
              Accept
            </Button>
          )}
        </Stack>
        <Collapse in={showEvidence} unmountOnExit>
          <Box id={evidenceId} sx={{ mt: 0.5 }}>
            <EvidenceList
              evidence={item.evidence}
              onPlay={onPlay}
              onShowInNote={onShowInNote}
              onNavigate={onNavigate}
            />
          </Box>
        </Collapse>
      </Box>
      {!readOnly && (
        <>
          <IconButton
            size="small"
            aria-label={`More actions for ${title}`}
            aria-haspopup="menu"
            disabled={busy}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            {item.kind !== 'closing' && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onEdit(item, 'edit');
                }}
              >
                Edit…
              </MenuItem>
            )}
            {item.kind === 'entity' && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onEdit(item, 'type');
                }}
              >
                Change type…
              </MenuItem>
            )}
            {item.kind !== 'closing' && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onRelink(item);
                }}
              >
                Link to existing…
              </MenuItem>
            )}
            {item.kind === 'entity' &&
              candidates.map((candidate) => (
                <MenuItem
                  key={candidate.entityId}
                  onClick={() =>
                    decide({
                      ...keepDecision(item),
                      distinctFrom: [...item.distinctFrom, candidate.entityId],
                    })
                  }
                >
                  Not the same as {candidate.label}
                </MenuItem>
              ))}
            {item.decision !== 'reject' && (
              <MenuItem onClick={() => decide({ decision: 'reject' })}>Reject</MenuItem>
            )}
            {item.decision !== 'pending' && (
              <MenuItem onClick={() => decide({ decision: 'pending' })}>Undo decision</MenuItem>
            )}
          </Menu>
        </>
      )}
    </Box>
  );
}

export default ProposalItemRow;
