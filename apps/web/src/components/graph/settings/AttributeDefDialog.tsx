/**
 * Add or edit one of the user's own attribute definitions (#369, §17.3).
 *
 * `entityType` and `kind` are chosen once, at creation, and shown read-only on
 * edit — #355 refuses a change to either (a stored value's meaning depends on
 * both). `key` is server-generated and never shown as editable.
 *
 * Full screen on a phone, like every other form dialog in this app at `sm`.
 * A 400/409 from #355 is attributed to the field it concerns
 * (`attributeDefErrorField`) and otherwise shown above the form — never
 * swallowed.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { ATTRIBUTE_KINDS } from '@app/shared/ontology';

import {
  ATTRIBUTE_KIND_LABELS,
  ATTRIBUTE_LABEL_MAX_LENGTH,
  attributeDefErrorField,
  EXTRACTION_HINT_MAX_LENGTH,
  SENSITIVITY_LABELS,
} from '../../../services/graph';
import type {
  AttributeDef,
  AttributeDefField,
  AttributeDefOptions,
  AttributeKind,
  CreateAttributeDefInput,
  PatchAttributeDefInput,
  Sensitivity,
} from '../../../services/graph';
import {
  ChoicesEditor,
  choicesError,
  choiceValuesFor,
  newChoiceDraft,
  type ChoiceDraft,
} from './ChoicesEditor';

/** An entity type the user may attach an attribute to. */
export interface AttributeEntityTypeOption {
  key: string;
  label: string;
  sensitivityDefault: Sensitivity;
}

interface AttributeDefDialogProps {
  open: boolean;
  /** Absent: create. Present: edit that definition. */
  def?: AttributeDef | null;
  entityTypes: AttributeEntityTypeOption[];
  /** Preselected entity type for a new definition (the browser's filter). */
  defaultEntityType?: string;
  onClose: () => void;
  onCreate: (input: CreateAttributeDefInput) => Promise<unknown>;
  onUpdate: (id: string, input: PatchAttributeDefInput) => Promise<unknown>;
}

const CHOICE_KINDS: AttributeKind[] = ['select', 'multi_select'];
const SENSITIVITY_DEFAULT = '__default__';

type FieldErrors = Partial<Record<AttributeDefField, string>>;

export function AttributeDefDialog({
  open,
  def,
  entityTypes,
  defaultEntityType,
  onClose,
  onCreate,
  onUpdate,
}: AttributeDefDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const isEdit = Boolean(def);

  const [entityType, setEntityType] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AttributeKind>('text');
  const [choices, setChoices] = useState<ChoiceDraft[]>([]);
  const [targetTypes, setTargetTypes] = useState<string[]>([]);
  const [extractable, setExtractable] = useState(false);
  const [hint, setHint] = useState('');
  const [sensitivity, setSensitivity] = useState<Sensitivity | null>(null);
  const [sortOrder, setSortOrder] = useState('0');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset on every open, from the definition being edited or from blank.
  useEffect(() => {
    if (!open) return;
    setEntityType(def?.entityType ?? defaultEntityType ?? entityTypes[0]?.key ?? '');
    setLabel(def?.label ?? '');
    setKind(def?.kind ?? 'text');
    setChoices(
      def?.options?.choices?.length
        ? def.options.choices.map((c) => newChoiceDraft(c, true))
        : [newChoiceDraft()],
    );
    setTargetTypes(def?.options?.targetTypes ?? []);
    setExtractable(def?.extractable ?? false);
    setHint(def?.extractionHint ?? '');
    setSensitivity(def?.sensitivity ?? null);
    setSortOrder(String(def?.sortOrder ?? 0));
    setErrors({});
    setFormError(null);
    setIsSubmitting(false);
    // Only on open: re-running when `entityTypes` refreshes would wipe a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, def]);

  const typeOptions = useMemo(() => {
    // An edited definition may sit on a type no longer in the effective schema
    // (its domain was switched off); it must still render.
    if (entityType && !entityTypes.some((t) => t.key === entityType)) {
      return [
        ...entityTypes,
        { key: entityType, label: entityType, sensitivityDefault: 'business' as Sensitivity },
      ];
    }
    return entityTypes;
  }, [entityTypes, entityType]);

  const typeDefault = typeOptions.find((t) => t.key === entityType)?.sensitivityDefault;

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!entityType) next.entityType = 'Choose an entity type.';
    if (!label.trim()) next.label = 'Give the attribute a name.';
    if (CHOICE_KINDS.includes(kind)) {
      const problem = choicesError(choices);
      if (problem) next.choices = problem;
    }
    if (kind === 'entity_ref' && targetTypes.length === 0) {
      next.targetTypes = 'Choose at least one type it can link to.';
    }
    if (extractable && !hint.trim()) {
      next.extractionHint = 'Describe what extraction should look for.';
    }
    if (hint.length > EXTRACTION_HINT_MAX_LENGTH) {
      next.extractionHint = `At most ${EXTRACTION_HINT_MAX_LENGTH} characters.`;
    }
    const order = Number(sortOrder);
    if (!Number.isInteger(order) || order < 0 || order > 10000) {
      next.sortOrder = 'A whole number from 0 to 10000.';
    }
    return next;
  }

  function options(): AttributeDefOptions | undefined {
    if (CHOICE_KINDS.includes(kind)) return { choices: choiceValuesFor(choices) };
    if (kind === 'entity_ref') return { targetTypes };
    return undefined;
  }

  function patchBody(current: AttributeDef): PatchAttributeDefInput {
    const body: PatchAttributeDefInput = {};
    const trimmedHint = hint.trim() || null;
    if (label.trim() !== current.label) body.label = label.trim();
    if (extractable !== current.extractable) body.extractable = extractable;
    if (trimmedHint !== current.extractionHint) body.extractionHint = trimmedHint;
    if (sensitivity !== current.sensitivity) body.sensitivity = sensitivity;
    if (Number(sortOrder) !== current.sortOrder) body.sortOrder = Number(sortOrder);
    const nextOptions = options();
    if (nextOptions && JSON.stringify(nextOptions) !== JSON.stringify(current.options ?? {})) {
      body.options = nextOptions;
    }
    return body;
  }

  async function handleSubmit() {
    const found = validate();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setIsSubmitting(true);
    try {
      if (def) {
        const body = patchBody(def);
        if (Object.keys(body).length > 0) await onUpdate(def.id, body);
      } else {
        const trimmedHint = hint.trim();
        await onCreate({
          entityType,
          label: label.trim(),
          kind,
          ...(options() ? { options: options() } : {}),
          extractable,
          ...(trimmedHint ? { extractionHint: trimmedHint } : {}),
          ...(sensitivity !== null ? { sensitivity } : {}),
          sortOrder: Number(sortOrder),
        });
      }
      onClose();
    } catch (err) {
      const field = attributeDefErrorField(err);
      const message = err instanceof Error ? err.message : 'Could not save the attribute.';
      if (field) setErrors({ [field]: message });
      else setFormError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const title = isEdit ? 'Edit attribute' : 'Add attribute';

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="attribute-def-dialog-title"
    >
      <DialogTitle id="attribute-def-dialog-title">{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {formError && <Alert severity="error">{formError}</Alert>}

          <FormControl fullWidth error={Boolean(errors.entityType)} disabled={isEdit}>
            <InputLabel id="attribute-entity-type-label">Entity type</InputLabel>
            <Select
              labelId="attribute-entity-type-label"
              label="Entity type"
              value={entityType}
              onChange={(event) => setEntityType(event.target.value)}
            >
              {typeOptions.map((type) => (
                <MenuItem key={type.key} value={type.key}>
                  {type.label}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>
              {errors.entityType ?? (isEdit ? 'Fixed once the attribute exists.' : ' ')}
            </FormHelperText>
          </FormControl>

          <TextField
            label="Label"
            required
            fullWidth
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            slotProps={{ htmlInput: { maxLength: ATTRIBUTE_LABEL_MAX_LENGTH } }}
            error={Boolean(errors.label)}
            helperText={errors.label ?? ' '}
          />

          <FormControl fullWidth disabled={isEdit}>
            <InputLabel id="attribute-kind-label">Kind</InputLabel>
            <Select
              labelId="attribute-kind-label"
              label="Kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as AttributeKind)}
            >
              {ATTRIBUTE_KINDS.map((k) => (
                <MenuItem key={k} value={k}>
                  {ATTRIBUTE_KIND_LABELS[k]}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>
              {isEdit ? 'Fixed once the attribute exists.' : 'Cannot be changed later.'}
            </FormHelperText>
          </FormControl>

          {CHOICE_KINDS.includes(kind) && (
            <ChoicesEditor
              choices={choices}
              onChange={setChoices}
              error={errors.choices}
              disabled={isSubmitting}
            />
          )}

          {kind === 'entity_ref' && (
            <FormControl fullWidth error={Boolean(errors.targetTypes)}>
              <InputLabel id="attribute-target-types-label">Links to</InputLabel>
              <Select
                labelId="attribute-target-types-label"
                label="Links to"
                multiple
                value={targetTypes}
                onChange={(event) => {
                  const value = event.target.value;
                  setTargetTypes(typeof value === 'string' ? value.split(',') : value);
                }}
                renderValue={(selected) =>
                  selected
                    .map((key) => typeOptions.find((t) => t.key === key)?.label ?? key)
                    .join(', ')
                }
              >
                {typeOptions.map((type) => (
                  <MenuItem key={type.key} value={type.key}>
                    <Checkbox checked={targetTypes.includes(type.key)} />
                    <ListItemText primary={type.label} />
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>{errors.targetTypes ?? 'The kinds of entity this can point at.'}</FormHelperText>
            </FormControl>
          )}

          <FormControlLabel
            control={
              <Switch
                checked={extractable}
                onChange={(event) => setExtractable(event.target.checked)}
              />
            }
            label="Let extraction fill this in"
          />

          <TextField
            label="Hint for extraction"
            fullWidth
            multiline
            minRows={2}
            required={extractable}
            value={hint}
            onChange={(event) => setHint(event.target.value)}
            placeholder="How this person is addressed informally, e.g. by teammates"
            slotProps={{ htmlInput: { maxLength: EXTRACTION_HINT_MAX_LENGTH } }}
            error={Boolean(errors.extractionHint)}
            helperText={
              errors.extractionHint ??
              `${hint.length}/${EXTRACTION_HINT_MAX_LENGTH} — what the AI should look for.`
            }
          />

          <FormControl fullWidth>
            <InputLabel id="attribute-sensitivity-label">Sensitivity</InputLabel>
            <Select
              labelId="attribute-sensitivity-label"
              label="Sensitivity"
              value={sensitivity ?? SENSITIVITY_DEFAULT}
              onChange={(event) =>
                setSensitivity(
                  event.target.value === SENSITIVITY_DEFAULT
                    ? null
                    : (event.target.value as Sensitivity),
                )
              }
            >
              <MenuItem value={SENSITIVITY_DEFAULT}>
                Same as the type{typeDefault ? ` (${SENSITIVITY_LABELS[typeDefault]})` : ''}
              </MenuItem>
              {(Object.keys(SENSITIVITY_LABELS) as Sensitivity[]).map((s) => (
                <MenuItem key={s} value={s}>
                  {SENSITIVITY_LABELS[s]}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>Sensitive values never leave this deployment.</FormHelperText>
          </FormControl>

          <TextField
            label="Sort order"
            type="number"
            fullWidth
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            slotProps={{ htmlInput: { min: 0, max: 10000, step: 1 } }}
            error={Boolean(errors.sortOrder)}
            helperText={errors.sortOrder ?? 'Lower numbers are listed first.'}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void handleSubmit()} disabled={isSubmitting}>
          {isEdit ? 'Save' : 'Add attribute'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AttributeDefDialog;
