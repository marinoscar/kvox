/**
 * Turn a text selection into a row of a draft proposal (#368, epic #346;
 * ontology.md §5.3, §8, §19). Full screen on a phone.
 *
 * "What is this?" — an entity, a fact (commitment / decision / claim /
 * person fact) or a relationship. Every type offered comes from the
 * effective ontology; every attribute from `SchemaForm`. The selection is
 * the row's evidence — sent as `evidence: [span]`, shown as a quote card —
 * so a row the user adds cites its source exactly like one the AI proposed.
 *
 * The row joins the DRAFT (`POST /api/graph/proposals/:id/items`) and is
 * committed with it; nothing here writes the graph (§8, §3.6).
 *
 * Errors: a 409 `stale_note_version`/`stale_segment_rev` means the text
 * changed after it was selected (Reload); `proposal_not_draft` means the
 * draft was sent or discarded elsewhere; a 400's `details.issues` are mapped
 * onto the fields; `span_mismatch`/`span_outside_source` ask for a new
 * selection.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';

import type { GraphSelection } from '../../../hooks/useTextSelection';
import { ApiError } from '../../../services/api';
import { addProposalItem, graphConflictReason, graphValidationIssues } from '../../../services/graph';
import type {
  AddProposalItemInput,
  EvidenceSpanInput,
  GraphEntitySearchResult,
  GraphOntology,
  PatchProposalItemResult,
  ProposalItem,
} from '../../../services/graph';
import { EntitySearchField } from '../schema/EntitySearchField';
import { SchemaForm } from '../schema/SchemaForm';
import { EndpointPicker } from './EndpointPicker';
import type { EndpointOption } from './EndpointPicker';

export type AddKind = 'entity' | 'item' | 'relation';

export interface AddToGraphDialogProps {
  open: boolean;
  onClose: () => void;
  selection: GraphSelection;
  proposalId: string;
  /** The draft's rows, for the "In this draft" endpoint options. */
  items: readonly ProposalItem[];
  ontology: GraphOntology | null;
  fullScreen?: boolean;
  onAdded: (result: PatchProposalItemResult, proposalId: string) => void;
  /** 409 stale span → reload the source. Default: reload the page. */
  onReload?: () => void;
}

export const STALE_SELECTION_MESSAGE = 'The text changed since you selected it — reload and select again';

const ITEM_KINDS = [
  { value: 'commitment', typeKey: 'Commitment', fallback: 'Commitment' },
  { value: 'decision', typeKey: 'Decision', fallback: 'Decision' },
  { value: 'claim', typeKey: 'Claim', fallback: 'Claim' },
  { value: 'person_fact', typeKey: 'PersonFact', fallback: 'Person fact' },
] as const;
type ItemKind = (typeof ITEM_KINDS)[number]['value'];

const PRECISIONS = [
  { value: 'day', label: 'Exact day' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'unknown', label: 'Unknown' },
] as const;

const SENSITIVITIES = [
  { value: 'business', label: 'Business' },
  { value: 'personal', label: 'Personal' },
  { value: 'sensitive', label: 'Sensitive' },
] as const;

/** A selection as #366's `evidenceSpanInputSchema`. */
export function selectionToEvidence(selection: GraphSelection): EvidenceSpanInput {
  const { source, quote } = selection;
  return source.kind === 'note'
    ? { source: 'note', noteVersion: source.noteVersion, charStart: source.charStart, charEnd: source.charEnd, quote }
    : {
        source: 'segment',
        segmentId: source.segmentId,
        segmentRev: source.segmentRev,
        charStart: source.charStart,
        charEnd: source.charEnd,
        quote,
      };
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <TextField
      label={label}
      type="date"
      size="small"
      fullWidth
      value={value}
      slotProps={{ inputLabel: { shrink: true } }}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function AddToGraphDialog({
  open,
  onClose,
  selection,
  proposalId,
  items,
  ontology,
  fullScreen,
  onAdded,
  onReload = () => window.location.reload(),
}: AddToGraphDialogProps) {
  const quote = selection.quote.trim();
  const [kind, setKind] = useState<AddKind>('entity');

  // Entity
  const entityTypes = useMemo(
    () => (ontology?.entityTypes ?? []).filter((type) => type.storage === 'entity' && !type.deprecated),
    [ontology],
  );
  const [entityType, setEntityType] = useState('');
  const [label, setLabel] = useState(quote.slice(0, 200));
  const [existing, setExisting] = useState(false);
  const [existingEntity, setExistingEntity] = useState<GraphEntitySearchResult | null>(null);
  const [props, setProps] = useState<Record<string, unknown>>({});

  // Fact
  const [itemKind, setItemKind] = useState<ItemKind>('decision');
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState(quote.slice(0, 2000));
  const [subject, setSubject] = useState<EndpointOption | null>(null);
  const [owner, setOwner] = useState<EndpointOption | null>(null);
  const [counterparty, setCounterparty] = useState<EndpointOption | null>(null);
  const [dueAt, setDueAt] = useState('');
  const [sensitivity, setSensitivity] = useState<string>('business');

  // Relationship
  const relationTypes = useMemo(() => (ontology?.relationTypes ?? []).filter((type) => !type.deprecated), [ontology]);
  const [relationType, setRelationType] = useState('');
  const [from, setFrom] = useState<EndpointOption | null>(null);
  const [to, setTo] = useState<EndpointOption | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [precision, setPrecision] = useState<string>('unknown');

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!entityType && entityTypes.length > 0) setEntityType(entityTypes[0].key);
  }, [entityType, entityTypes]);
  useEffect(() => {
    if (!relationType && relationTypes.length > 0) setRelationType(relationTypes[0].key);
  }, [relationType, relationTypes]);

  const itemTypeKey = ITEM_KINDS.find((entry) => entry.value === itemKind)!.typeKey;
  const itemType = ontology?.entityTypes.find((type) => type.key === itemTypeKey) ?? null;
  const entityTypeDef = entityTypes.find((type) => type.key === entityType) ?? null;
  const relationTypeDef = relationTypes.find((type) => type.key === relationType) ?? null;
  const subjectRequired = itemKind === 'claim' || itemKind === 'person_fact' || Boolean(itemType?.subjectRequired);

  const attributes =
    kind === 'entity' ? (entityTypeDef?.attributes ?? []) : kind === 'item' ? (itemType?.attributes ?? []) : (relationTypeDef?.props ?? []);

  const setKindAndReset = (next: AddKind | null) => {
    if (!next) return;
    setKind(next);
    setProps({});
    setFieldErrors({});
    setFormError(null);
  };

  const missing = (() => {
    if (kind === 'entity') return !entityType || !label.trim() || (existing && !existingEntity);
    if (kind === 'item') return !title.trim() || !statement.trim() || (subjectRequired && !subject);
    return !relationType || !from || !to;
  })();

  const buildBody = (): AddProposalItemInput => {
    const evidence = [selectionToEvidence(selection)];
    if (kind === 'entity') {
      return {
        kind: 'entity',
        payload: { type: entityType, label: label.trim(), aliases: [], props, occurredAt: null },
        ...(existing && existingEntity ? { existingEntityId: existingEntity.id } : {}),
        evidence,
      };
    }
    if (kind === 'item') {
      return {
        kind: 'item',
        payload: {
          kind: itemKind,
          title: title.trim(),
          statement: statement.trim(),
          subject: subject?.endpoint ?? null,
          owner: itemKind === 'commitment' ? (owner?.endpoint ?? null) : null,
          counterparty: itemKind === 'commitment' ? (counterparty?.endpoint ?? null) : null,
          meeting: null,
          status: itemKind === 'commitment' ? 'open' : null,
          occurredAt: null,
          dueAt: itemKind === 'commitment' ? orNull(dueAt) : null,
          sensitivity: itemKind === 'person_fact' ? sensitivity : null,
          validFrom: null,
          validTo: null,
          precision: 'unknown',
          props,
        },
        evidence,
      };
    }
    return {
      kind: 'relation',
      payload: {
        type: relationType,
        from: from!.endpoint,
        to: to!.endpoint,
        validFrom: orNull(validFrom),
        validTo: orNull(validTo),
        precision,
        props,
      },
      evidence,
    };
  };

  const submit = async () => {
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    setStale(false);
    try {
      const result = await addProposalItem(proposalId, buildBody());
      onAdded(result, proposalId);
    } catch (err) {
      setSaving(false);
      const reason = graphConflictReason(err);
      if (reason === 'stale_note_version' || reason === 'stale_segment_rev') {
        setStale(true);
        return;
      }
      if (reason === 'proposal_not_draft') {
        setFormError('This draft was sent or discarded in the meantime. Extract again to add to a new one.');
        return;
      }
      const details = err instanceof ApiError ? (err.details as { reason?: unknown } | undefined) : undefined;
      if (details?.reason === 'span_mismatch' || details?.reason === 'span_outside_source') {
        setFormError('That selection could not be matched to its source. Select the text again.');
        return;
      }
      const issues = graphValidationIssues(err);
      if (issues.length > 0) {
        const mapped: Record<string, string> = {};
        const unmapped: string[] = [];
        for (const issue of issues) {
          const path = issue.path[0] === 'payload' ? issue.path.slice(1) : issue.path;
          const [head, next] = path;
          if (head === 'props' && typeof next === 'string') mapped[`props.${next}`] = issue.message;
          else if (typeof head === 'string') mapped[head] = issue.message;
          else unmapped.push(issue.message);
        }
        setFieldErrors(mapped);
        setFormError(unmapped.length > 0 ? unmapped.join(' ') : 'Some fields need attention.');
        return;
      }
      setFormError(err instanceof ApiError && err.message ? err.message : 'This row could not be added');
    }
  };

  const propErrors = Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([key]) => key.startsWith('props.'))
      .map(([key, message]) => [key.slice('props.'.length), message]),
  );

  const sourceLine =
    selection.source.kind === 'note'
      ? `From your note, version ${selection.source.noteVersion}`
      : 'From a line of the transcript';

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="graph-add-title"
    >
      <DialogTitle id="graph-add-title">Add to graph</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Paper variant="outlined" component="figure" sx={{ m: 0, p: 1.5 }} aria-label="Evidence">
            <Box component="blockquote" sx={{ m: 0, fontStyle: 'italic', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Typography variant="body2">“{quote}”</Typography>
            </Box>
            <Typography variant="caption" color="text.secondary" component="figcaption">
              {sourceLine}
            </Typography>
          </Paper>

          <Box>
            <Typography id="graph-add-kind" variant="subtitle2" component="h3" sx={{ mb: 1 }}>
              What is this?
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={kind}
              onChange={(_event, next: AddKind | null) => setKindAndReset(next)}
              aria-labelledby="graph-add-kind"
            >
              <ToggleButton value="entity">An entity</ToggleButton>
              <ToggleButton value="item">A fact</ToggleButton>
              <ToggleButton value="relation">A relationship</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {!ontology && <Alert severity="info">Loading your graph schema…</Alert>}

          {kind === 'entity' && (
            <>
              <TextField
                select
                size="small"
                label="Type"
                value={entityType}
                onChange={(event) => {
                  setEntityType(event.target.value);
                  setProps({});
                  setExistingEntity(null);
                }}
                error={Boolean(fieldErrors.type)}
                helperText={fieldErrors.type}
              >
                {entityTypes.map((type) => (
                  <MenuItem key={type.key} value={type.key}>
                    {type.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                label="Name"
                required
                value={label}
                onChange={(event) => setLabel(event.target.value.slice(0, 200))}
                error={Boolean(fieldErrors.label)}
                helperText={fieldErrors.label}
              />
              <FormControlLabel
                control={<Checkbox checked={existing} onChange={(event) => setExisting(event.target.checked)} />}
                label="This is someone/something already in my graph"
              />
              {existing && (
                <EntitySearchField
                  label="Which one?"
                  types={entityType ? [entityType] : undefined}
                  value={existingEntity}
                  onChange={setExistingEntity}
                  error={fieldErrors.existingEntityId}
                />
              )}
            </>
          )}

          {kind === 'item' && (
            <>
              <TextField
                select
                size="small"
                label="Kind"
                value={itemKind}
                onChange={(event) => {
                  setItemKind(event.target.value as ItemKind);
                  setProps({});
                }}
              >
                {ITEM_KINDS.map((entry) => (
                  <MenuItem key={entry.value} value={entry.value}>
                    {ontology?.entityTypes.find((type) => type.key === entry.typeKey)?.label ?? entry.fallback}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                label="Title"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value.slice(0, 200))}
                error={Boolean(fieldErrors.title)}
                helperText={fieldErrors.title ?? 'A short name for this fact'}
              />
              <TextField
                size="small"
                label="Statement"
                required
                multiline
                minRows={2}
                value={statement}
                onChange={(event) => setStatement(event.target.value.slice(0, 2000))}
                error={Boolean(fieldErrors.statement)}
                helperText={fieldErrors.statement}
              />
              <EndpointPicker
                label="About"
                items={items}
                types={itemType?.subjectTypes ?? undefined}
                value={subject}
                onChange={setSubject}
                required={subjectRequired}
                error={fieldErrors.subject}
              />
              {itemKind === 'commitment' && (
                <>
                  <EndpointPicker label="Owner" items={items} types={['Person']} value={owner} onChange={setOwner} error={fieldErrors.owner} />
                  <EndpointPicker
                    label="Owed to"
                    items={items}
                    value={counterparty}
                    onChange={setCounterparty}
                    error={fieldErrors.counterparty}
                  />
                  <DateField label="Due" value={dueAt} onChange={setDueAt} />
                </>
              )}
              {itemKind === 'person_fact' && (
                <TextField
                  select
                  size="small"
                  label="Sensitivity"
                  value={sensitivity}
                  onChange={(event) => setSensitivity(event.target.value)}
                >
                  {SENSITIVITIES.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            </>
          )}

          {kind === 'relation' && (
            <>
              <TextField
                select
                size="small"
                label="Relationship"
                value={relationType}
                onChange={(event) => {
                  setRelationType(event.target.value);
                  setFrom(null);
                  setTo(null);
                  setProps({});
                }}
                error={Boolean(fieldErrors.type)}
                helperText={fieldErrors.type}
              >
                {relationTypes.map((type) => (
                  <MenuItem key={type.key} value={type.key}>
                    {type.label}
                  </MenuItem>
                ))}
              </TextField>
              <EndpointPicker
                label="From"
                items={items}
                types={relationTypeDef?.from}
                value={from}
                onChange={setFrom}
                required
                error={fieldErrors.from}
              />
              <EndpointPicker
                label="To"
                items={items}
                types={relationTypeDef?.to}
                value={to}
                onChange={setTo}
                required
                error={fieldErrors.to}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <DateField label="Valid from" value={validFrom} onChange={setValidFrom} />
                <DateField label="Valid to" value={validTo} onChange={setValidTo} />
                <TextField
                  select
                  size="small"
                  label="Date precision"
                  value={precision}
                  onChange={(event) => setPrecision(event.target.value)}
                  sx={{ minWidth: 140 }}
                >
                  {PRECISIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </>
          )}

          {!(kind === 'entity' && existing) && (
            <SchemaForm attributes={attributes} value={props} errors={propErrors} onChange={setProps} />
          )}

          {stale && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={onReload}>
                  Reload
                </Button>
              }
            >
              {STALE_SELECTION_MESSAGE}
            </Alert>
          )}
          {formError && <Alert severity="error">{formError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={saving || missing} loading={saving}>
          Add to draft
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AddToGraphDialog;
