/**
 * "Link to existing…" (#367; ontology.md §19).
 *
 * - An ENTITY row: "this is the existing X" → `decision: 'merge_into'` with the
 *   chosen entity's id (#366: at commit the proposed entity is not created;
 *   its name becomes an alias of the target and its evidence moves there).
 * - A RELATION/ITEM row: re-point one endpoint (`relinkTo: { field, target }`)
 *   at an existing entity, at another entity row of this proposal, or — for
 *   the optional owner/counterparty/meeting — at nothing.
 */

import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { useEffect, useMemo, useState } from 'react';

import type {
  EndpointRef,
  GraphEntitySearchResult,
  GraphOntology,
  PatchProposalItemInput,
  ProposalItem,
  RelinkField,
} from '../../../services/graph';
import { EntitySearchField } from '../schema/EntitySearchField';
import { endpointFields, isChecked } from './proposalGrouping';

const FIELD_LABELS: Record<RelinkField, string> = {
  from: 'From',
  to: 'To',
  subject: 'About',
  owner: 'Owner',
  counterparty: 'Owed to',
  meeting: 'Meeting',
};

const OPTIONAL_FIELDS: readonly RelinkField[] = ['owner', 'counterparty', 'meeting'];

export interface RelinkDialogProps {
  open: boolean;
  item: ProposalItem | null;
  items: readonly ProposalItem[];
  ontology: GraphOntology | null;
  initialField?: RelinkField;
  fullScreen?: boolean;
  onCancel: () => void;
  onConfirm: (body: PatchProposalItemInput) => void;
}

type TargetMode = 'existing' | 'proposal' | 'none';

/** Allowed entity types for one endpoint of this row, or undefined for "any". */
function allowedTypes(
  item: ProposalItem,
  field: RelinkField,
  ontology: GraphOntology | null,
): string[] | undefined {
  if (item.kind === 'entity') {
    const type = (item.effectivePayload as { type?: unknown }).type;
    return typeof type === 'string' ? [type] : undefined;
  }
  if (item.kind === 'relation' && ontology) {
    const typeKey = (item.effectivePayload as { type?: unknown }).type;
    const relation = ontology.relationTypes.find((type) => type.key === typeKey);
    if (relation) return field === 'from' ? relation.from : relation.to;
  }
  if (field === 'meeting') return ['Meeting'];
  if (field === 'owner' || field === 'counterparty') return ['Person', 'Organization'];
  return undefined;
}

export function RelinkDialog({
  open,
  item,
  items,
  ontology,
  initialField,
  fullScreen,
  onCancel,
  onConfirm,
}: RelinkDialogProps) {
  const fields = item ? endpointFields(item) : [];
  const [field, setField] = useState<RelinkField | null>(null);
  const [mode, setMode] = useState<TargetMode>('existing');
  const [existing, setExisting] = useState<GraphEntitySearchResult | null>(null);
  const [proposalRef, setProposalRef] = useState('');

  useEffect(() => {
    if (!open || !item) return;
    setField(initialField ?? (endpointFields(item)[0] ?? null));
    setMode('existing');
    setExisting(null);
    setProposalRef('');
  }, [initialField, item, open]);

  const types = item ? allowedTypes(item, field ?? 'from', ontology) : undefined;

  const proposalEntities = useMemo(
    () =>
      items.filter((row) => {
        if (row.kind !== 'entity' || row.id === item?.id || row.decision === 'reject') return false;
        const type = (row.effectivePayload as { type?: unknown }).type;
        return !types || (typeof type === 'string' && types.includes(type));
      }),
    [item?.id, items, types],
  );

  if (!item) return null;
  const isEntity = item.kind === 'entity';

  const confirm = () => {
    if (isEntity) {
      if (existing) onConfirm({ decision: 'merge_into', mergeIntoId: existing.id });
      return;
    }
    if (!field) return;
    let target: EndpointRef | null = null;
    if (mode === 'existing' && existing) target = { entityId: existing.id };
    else if (mode === 'proposal' && proposalRef) target = { ref: proposalRef };
    else if (mode !== 'none') return;
    onConfirm({
      decision: isChecked(item.decision) || item.decision === 'pending' ? 'accept' : item.decision,
      relinkTo: { field, target },
    });
  };

  const ready = isEntity
    ? existing !== null
    : field !== null &&
      ((mode === 'existing' && existing !== null) ||
        (mode === 'proposal' && proposalRef !== '') ||
        (mode === 'none' && OPTIONAL_FIELDS.includes(field)));

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="proposal-relink-title"
    >
      <DialogTitle id="proposal-relink-title">
        {isEntity ? `Link ${item.display.title} to an existing entity` : `Re-link ${item.display.title}`}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!isEntity && (
            <TextField
              select
              size="small"
              label="Which end"
              value={field ?? ''}
              onChange={(event) => setField(event.target.value as RelinkField)}
            >
              {fields.map((option) => (
                <MenuItem key={option} value={option}>
                  {FIELD_LABELS[option]}
                </MenuItem>
              ))}
            </TextField>
          )}
          {!isEntity && (
            <RadioGroup
              aria-label="Link to"
              value={mode}
              onChange={(event) => setMode(event.target.value as TargetMode)}
            >
              <FormControlLabel value="existing" control={<Radio />} label="Something already in your graph" />
              <FormControlLabel
                value="proposal"
                control={<Radio />}
                label="Something in this proposal"
                disabled={proposalEntities.length === 0}
              />
              {field && OPTIONAL_FIELDS.includes(field) && (
                <FormControlLabel value="none" control={<Radio />} label="Nobody" />
              )}
            </RadioGroup>
          )}
          {(isEntity || mode === 'existing') && (
            <EntitySearchField
              label="Search your graph"
              types={types}
              value={existing}
              onChange={setExisting}
              excludeIds={isEntity ? item.distinctFrom : []}
              autoFocus
            />
          )}
          {!isEntity && mode === 'proposal' && (
            <TextField
              select
              size="small"
              label="Row in this proposal"
              value={proposalRef}
              onChange={(event) => setProposalRef(event.target.value)}
            >
              {proposalEntities.map((row) => (
                <MenuItem key={row.id} value={String((row.effectivePayload as { ref?: unknown }).ref)}>
                  {row.display.title}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" disabled={!ready} onClick={confirm}>
          Link
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RelinkDialog;
