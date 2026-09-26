/**
 * Edit one proposed row — or change an entity's type (#367; ontology.md §13,
 * §19). A `Dialog`, full screen on a phone.
 *
 * Every attribute field comes from the effective ontology (`SchemaForm`); the
 * only fixed fields are the row kind's own payload fields (label/aliases for
 * an entity, type/endpoints/validity for a relation, title/statement/dates for
 * an item — #363's payload schemas). Save sends the WHOLE edited payload as
 * `decision: 'edit'`; a 400's `details.issues` are mapped back onto fields.
 *
 * "Change type" is the same dialog with a type picker first; attributes the
 * new type does not declare are named before save and dropped from it.
 */

import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';

import { ApiError } from '../../../services/api';
import { graphValidationIssues } from '../../../services/graph';
import type {
  EndpointRef,
  GraphAttribute,
  GraphOntology,
  ProposalItem,
  RelinkField,
} from '../../../services/graph';
import { SchemaForm } from '../schema/SchemaForm';
import { endpointFields, entityRowForRef, readEndpoint } from './proposalGrouping';

const PRECISIONS = [
  { value: 'day', label: 'Exact day' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'unknown', label: 'Unknown' },
] as const;

const ITEM_TYPE_KEYS: Record<string, string> = {
  commitment: 'Commitment',
  decision: 'Decision',
  claim: 'Claim',
  person_fact: 'PersonFact',
};

const SENSITIVITIES = [
  { value: 'business', label: 'Business' },
  { value: 'personal', label: 'Personal' },
  { value: 'sensitive', label: 'Sensitive' },
];

const FIELD_LABELS: Record<RelinkField, string> = {
  from: 'From',
  to: 'To',
  subject: 'About',
  owner: 'Owner',
  counterparty: 'Owed to',
  meeting: 'Meeting',
};

export interface ProposalItemEditorProps {
  open: boolean;
  item: ProposalItem | null;
  mode: 'edit' | 'type';
  ontology: GraphOntology | null;
  items: readonly ProposalItem[];
  fullScreen?: boolean;
  onCancel: () => void;
  /** PATCH `{ decision: 'edit', editedPayload }`. Rejects with the server's error. */
  onSave: (editedPayload: Record<string, unknown>) => Promise<void>;
  /** Re-point one endpoint (opens the relink dialog). */
  onRelink: (field: RelinkField) => void;
}

type Draft = Record<string, unknown>;

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

function propsOf(draft: Draft): Record<string, unknown> {
  const value = draft.props;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The entity type key a payload endpoint points at, when the proposal knows it. */
function endpointType(items: readonly ProposalItem[], endpoint: EndpointRef | null): string | null {
  if (!endpoint || !('ref' in endpoint)) return null;
  const row = entityRowForRef(items, endpoint.ref);
  const type = (row?.effectivePayload as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' ? type : null;
}

function endpointLabel(items: readonly ProposalItem[], endpoint: EndpointRef | null): string {
  if (!endpoint) return 'None';
  if ('ref' in endpoint) return entityRowForRef(items, endpoint.ref)?.display.title ?? endpoint.ref;
  return 'An existing entity';
}

/** Attribute keys holding a value that `attributes` does not declare. */
export function droppedAttributes(
  props: Record<string, unknown>,
  attributes: readonly GraphAttribute[],
): string[] {
  const keep = new Set(attributes.map((attribute) => attribute.key));
  return Object.entries(props)
    .filter(([key, value]) => !keep.has(key) && value !== null && value !== undefined && value !== '')
    .map(([key]) => key);
}

function DateField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: unknown;
  onChange: (value: string | null) => void;
  error?: string;
}) {
  return (
    <TextField
      label={label}
      type="date"
      size="small"
      fullWidth
      value={str(value)}
      error={Boolean(error)}
      helperText={error}
      slotProps={{ inputLabel: { shrink: true } }}
      onChange={(event) => onChange(orNull(event.target.value))}
    />
  );
}

export function ProposalItemEditor({
  open,
  item,
  mode,
  ontology,
  items,
  fullScreen,
  onCancel,
  onSave,
  onRelink,
}: ProposalItemEditorProps) {
  const [draft, setDraft] = useState<Draft>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && item) {
      setDraft(JSON.parse(JSON.stringify(item.effectivePayload)) as Draft);
      setFieldErrors({});
      setFormError(null);
      setSaving(false);
    }
  }, [open, item]);

  const kind = item?.kind ?? 'entity';
  const originalType = str(item?.effectivePayload.type);
  const typeKey =
    kind === 'item' ? (ITEM_TYPE_KEYS[str(draft.kind)] ?? str(draft.kind)) : str(draft.type);

  const entityType = ontology?.entityTypes.find((type) => type.key === typeKey) ?? null;
  const relationType =
    kind === 'relation' ? (ontology?.relationTypes.find((type) => type.key === typeKey) ?? null) : null;
  const attributes: readonly GraphAttribute[] =
    kind === 'relation' ? (relationType?.props ?? []) : (entityType?.attributes ?? []);

  const dropped = useMemo(
    () =>
      mode === 'type' && typeKey !== originalType && ontology
        ? droppedAttributes(propsOf(draft), attributes)
        : [],
    [attributes, draft, mode, ontology, originalType, typeKey],
  );
  const oldAttributes = ontology?.entityTypes.find((type) => type.key === originalType)?.attributes ?? [];
  const droppedLabels = dropped.map(
    (key) => oldAttributes.find((attribute) => attribute.key === key)?.label ?? key,
  );

  const relationTypeOptions = useMemo(() => {
    if (!ontology || !item || kind !== 'relation') return [];
    const fromType = endpointType(items, readEndpoint(item, 'from'));
    const toType = endpointType(items, readEndpoint(item, 'to'));
    return ontology.relationTypes.filter(
      (type) =>
        type.key === originalType ||
        (!type.deprecated &&
          (!fromType || type.from.includes(fromType)) &&
          (!toType || type.to.includes(toType))),
    );
  }, [item, items, kind, ontology, originalType]);

  const entityTypeOptions = useMemo(
    () =>
      (ontology?.entityTypes ?? []).filter(
        (type) => type.key === originalType || (type.storage === 'entity' && !type.deprecated),
      ),
    [ontology, originalType],
  );

  if (!item) return null;

  const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setFieldErrors({});
    setFormError(null);
    const payload: Draft = { ...draft };
    if (dropped.length > 0) {
      const props = { ...propsOf(draft) };
      for (const key of dropped) delete props[key];
      payload.props = props;
    }
    try {
      await onSave(payload);
    } catch (err) {
      const issues = graphValidationIssues(err);
      if (issues.length > 0) {
        const mapped: Record<string, string> = {};
        const unmapped: string[] = [];
        for (const issue of issues) {
          const [head, next] = issue.path;
          if (head === 'props' && typeof next === 'string') mapped[`props.${next}`] = issue.message;
          else if (typeof head === 'string') mapped[head] = issue.message;
          else unmapped.push(issue.message);
        }
        setFieldErrors(mapped);
        setFormError(unmapped.length > 0 ? unmapped.join(' ') : 'Some fields need attention.');
      } else {
        setFormError(err instanceof ApiError ? err.message : 'This row could not be saved');
      }
      setSaving(false);
    }
  };

  const propErrors = Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([key]) => key.startsWith('props.'))
      .map(([key, message]) => [key.slice('props.'.length), message]),
  );

  const endpointChips = endpointFields(item)
    .filter((field) => field !== 'meeting')
    .map((field) => {
      const endpoint = readEndpoint({ ...item, effectivePayload: draft }, field);
      if (kind === 'item' && field === 'counterparty' && str(draft.kind) !== 'commitment') return null;
      return (
        <Box key={field} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 64 }}>
            {FIELD_LABELS[field]}
          </Typography>
          <Chip size="small" label={endpointLabel(items, endpoint)} />
          <Button size="small" onClick={() => onRelink(field)} aria-label={`Change ${FIELD_LABELS[field]}`}>
            Change
          </Button>
        </Box>
      );
    });

  const validity =
    kind === 'item' || relationType?.temporal ? (
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <DateField label="Valid from" value={draft.validFrom} onChange={(v) => set('validFrom', v)} error={fieldErrors.validFrom} />
        <DateField label="Valid to" value={draft.validTo} onChange={(v) => set('validTo', v)} error={fieldErrors.validTo} />
        <TextField
          select
          size="small"
          label="Date precision"
          value={str(draft.precision) || 'unknown'}
          onChange={(event) => set('precision', event.target.value)}
          sx={{ minWidth: 140 }}
        >
          {PRECISIONS.map((precision) => (
            <MenuItem key={precision.value} value={precision.value}>
              {precision.label}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
    ) : null;

  const title = mode === 'type' ? `Change type of ${item.display.title}` : `Edit ${item.display.title}`;

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onCancel}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="proposal-editor-title"
    >
      <DialogTitle id="proposal-editor-title">{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!ontology && <Alert severity="info">Loading your graph schema…</Alert>}

          {kind === 'entity' && (
            <>
              {mode === 'type' && (
                <TextField
                  select
                  size="small"
                  label="Type"
                  value={typeKey}
                  onChange={(event) => set('type', event.target.value)}
                  error={Boolean(fieldErrors.type)}
                  helperText={fieldErrors.type}
                >
                  {entityTypeOptions.map((type) => (
                    <MenuItem key={type.key} value={type.key}>
                      {type.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {dropped.length > 0 && (
                <Alert severity="warning">These fields will be dropped: {droppedLabels.join(', ')}</Alert>
              )}
              <TextField
                size="small"
                label="Name"
                required
                value={str(draft.label)}
                error={Boolean(fieldErrors.label)}
                helperText={fieldErrors.label}
                onChange={(event) => set('label', event.target.value)}
              />
              <Autocomplete
                multiple
                freeSolo
                options={[] as string[]}
                value={Array.isArray(draft.aliases) ? (draft.aliases as string[]) : []}
                onChange={(_event, next) => set('aliases', next)}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    label="Also known as"
                    error={Boolean(fieldErrors.aliases)}
                    helperText={fieldErrors.aliases ?? 'Press Enter after each name'}
                  />
                )}
              />
              {typeKey === 'Meeting' && (
                <DateField label="Date" value={draft.occurredAt} onChange={(v) => set('occurredAt', v)} />
              )}
            </>
          )}

          {kind === 'relation' && (
            <>
              <TextField
                select
                size="small"
                label="Relationship"
                value={typeKey}
                onChange={(event) => set('type', event.target.value)}
                error={Boolean(fieldErrors.type)}
                helperText={fieldErrors.type}
              >
                {relationTypeOptions.map((type) => (
                  <MenuItem key={type.key} value={type.key}>
                    {type.label}
                  </MenuItem>
                ))}
              </TextField>
              {endpointChips}
              {validity}
            </>
          )}

          {kind === 'item' && (
            <>
              <TextField
                size="small"
                label="Title"
                required
                value={str(draft.title)}
                error={Boolean(fieldErrors.title)}
                helperText={fieldErrors.title}
                onChange={(event) => set('title', event.target.value)}
              />
              <TextField
                size="small"
                label="Statement"
                multiline
                minRows={2}
                required
                value={str(draft.statement)}
                error={Boolean(fieldErrors.statement)}
                helperText={fieldErrors.statement}
                onChange={(event) => set('statement', event.target.value)}
              />
              {endpointChips}
              {str(draft.kind) === 'commitment' && (
                <TextField
                  select
                  size="small"
                  label="Status"
                  value={str(draft.status) || 'open'}
                  onChange={(event) => set('status', event.target.value)}
                >
                  {(entityType?.statuses ?? ['open', 'done', 'dropped']).map((status) => (
                    <MenuItem key={status} value={status}>
                      {status}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <DateField label="Happened on" value={draft.occurredAt} onChange={(v) => set('occurredAt', v)} error={fieldErrors.occurredAt} />
                {str(draft.kind) === 'commitment' && (
                  <DateField label="Due" value={draft.dueAt} onChange={(v) => set('dueAt', v)} error={fieldErrors.dueAt} />
                )}
              </Stack>
              {validity}
              {str(draft.kind) === 'person_fact' && (
                <TextField
                  select
                  size="small"
                  label="Sensitivity"
                  value={str(draft.sensitivity) || 'personal'}
                  onChange={(event) => set('sensitivity', event.target.value)}
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

          <SchemaForm
            attributes={attributes}
            value={propsOf(draft)}
            errors={propErrors}
            onChange={(props) => set('props', props)}
          />

          {formError && <Alert severity="error">{formError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ProposalItemEditor;
