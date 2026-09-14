/**
 * The permitted-models editor — issue #78, epic #45.
 *
 * =============================================================================
 * WHAT THIS REPLACED, AND WHY THE TEXTAREA HAD TO GO
 * =============================================================================
 *
 * Until #78 this was a multiline `TextField` holding one model id per line, and
 * that was the honest shape for the data it edited: `allowedModels` was
 * `string[]`, and every id in it was resolved against a four-entry catalogue
 * compiled into the API. An id the catalogue did not carry could be typed,
 * saved and listed back, and was then silently never offered to anyone.
 *
 * #78 widened an entry to carry its own `contextWindowTokens` and
 * `maxOutputTokens`, which is what makes a model no release of this application
 * has heard of genuinely permittable. A textarea cannot express that: two
 * numbers per line is a syntax an administrator has to be taught, mistypes
 * invisibly, and cannot be validated field by field. So the textarea became a
 * list of rows, and `parseModelList` was retired rather than extended.
 *
 * =============================================================================
 * ⚠ THE NUMBER FIELDS APPEAR EXACTLY WHEN THIS BUILD CANNOT ANSWER
 * =============================================================================
 *
 * A row shows {@link AiModelNumberFields} when the id resolves to NO descriptor
 * in the active provider's catalogue — and then both numbers are REQUIRED,
 * because `resolveAllowedModel` needs both or resolves to nothing (see that
 * component's header for why neither can be defaulted).
 *
 * It ALSO shows them, un-required, when the stored entry already carries a
 * number even though the catalogue knows the model. That second case is not
 * symmetry for its own sake: the entry's numbers OVERRIDE the catalogue's, and
 * that override is the documented way to correct a stale context window in this
 * application's own catalogue without waiting for a release. A row that hid the
 * fields because the id happened to be known would render an override the
 * administrator could neither see nor remove — and the next save, built from
 * what the form shows, would silently drop it.
 *
 * =============================================================================
 * ⚠ THE MANUAL PATH IS NOT A FALLBACK. IT IS THE GUARANTEE.
 * =============================================================================
 *
 * "Load models from the provider" is a convenience, and the list behind it is
 * FILTERED HEURISTICALLY on the API side to plausible chat models. A heuristic
 * is exactly the kind of thing that is right for two years and then quietly
 * wrong about the model somebody needs on a Tuesday — and a vendor's list is
 * also key-scoped (on OpenAI, project-scoped), so two administrators can
 * legitimately see different lists.
 *
 * So "Add a model by hand" below is a first-class control, not a disclosure
 * behind an accordion, and it never consults the filter, the catalogue or the
 * vendor. It must survive every future redesign of this section: any id the
 * administrator can name, plus the two numbers, is permittable. The help text
 * says so in words, because a reader who does not know that will assume a model
 * missing from the discovery dialog cannot be used here.
 */

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import {
  AI_ALLOWED_MODELS_MAX,
  type AiAllowedModel,
  type AiModelDescriptor,
} from '../../services/ai';
import {
  AiModelNumberFields,
  EMPTY_MODEL_NUMBERS,
  hasModelNumbersError,
  isModelNumbersEmpty,
  parseModelNumbers,
  toModelNumbersDraft,
  validateModelNumbers,
  type ModelNumbersDraft,
} from './AiModelNumberFields';

/**
 * One permitted model mid-edit.
 *
 * The numbers are STRINGS — see `AiModelNumberFields`' header for why a
 * controlled numeric input must not hold a parsed value while it is being
 * typed into.
 */
export interface PermittedModelDraft {
  id: string;
  /** The entry's own label, or `''` when it has none and the catalogue's is used. */
  label: string;
  numbers: ModelNumbersDraft;
}

/** Seed the editor from what the API returned. */
export function toPermittedDrafts(entries: AiAllowedModel[]): PermittedModelDraft[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label ?? '',
    numbers: toModelNumbersDraft(entry.contextWindowTokens, entry.maxOutputTokens),
  }));
}

/** Whether the active provider's catalogue can answer for this id. */
export function catalogueDescriptor(
  id: string,
  catalogue: AiModelDescriptor[],
): AiModelDescriptor | undefined {
  return catalogue.find((model) => model.id === id.trim());
}

/**
 * Whether anything in the list would be refused — a row missing a number this
 * build cannot supply, one out of bounds, or more entries than the API accepts.
 *
 * EXPORTED SO THE PAGE CAN DISABLE SAVE ON IT. The page owns the submit, so it
 * has to be able to ask this question without re-deriving the "when are the
 * numbers required" rule — which is the rule most likely to drift if it existed
 * in two places.
 */
export function permittedModelsHaveError(
  drafts: PermittedModelDraft[],
  catalogue: AiModelDescriptor[],
): boolean {
  if (drafts.length > AI_ALLOWED_MODELS_MAX) return true;

  return drafts.some((draft) => {
    const required = !catalogueDescriptor(draft.id, catalogue);
    return hasModelNumbersError(validateModelNumbers(draft.numbers, required));
  });
}

/**
 * The one parse, at the submit boundary.
 *
 * `label` is omitted when blank rather than sent as `''`: the schema's
 * `min(1)` would refuse an empty string, and an absent label is the state that
 * means "use the catalogue's, then the id" — which is what a blank box means.
 */
export function toAllowedModels(drafts: PermittedModelDraft[]): AiAllowedModel[] {
  return drafts.map((draft) => {
    const label = draft.label.trim();
    return {
      id: draft.id.trim(),
      ...(label.length > 0 ? { label } : {}),
      ...parseModelNumbers(draft.numbers),
    };
  });
}

export interface AiPermittedModelsProps {
  value: PermittedModelDraft[];
  onChange: (next: PermittedModelDraft[]) => void;
  /**
   * The models this build can budget for without being told anything — the
   * ACTIVE PROVIDER'S `capabilities.models`. Pass an empty array when no
   * provider is registered; that is not a special case, it simply means every
   * row needs its numbers typed.
   */
  catalogue: AiModelDescriptor[];
  disabled?: boolean;
}

export function AiPermittedModels({
  value,
  onChange,
  catalogue,
  disabled,
}: AiPermittedModelsProps) {
  // The manual-add row's own draft. Local rather than lifted: it is a staging
  // area that becomes a real entry only on "Add", and a half-typed id in the
  // page's `allowedModels` state would be saved by a Save click that happened
  // to land first.
  const [newId, setNewId] = useState('');
  const [newNumbers, setNewNumbers] = useState<ModelNumbersDraft>(EMPTY_MODEL_NUMBERS);
  const [addError, setAddError] = useState<string | null>(null);

  const atCapacity = value.length >= AI_ALLOWED_MODELS_MAX;
  const trimmedNewId = newId.trim();
  const newIsKnown = !!catalogueDescriptor(trimmedNewId, catalogue);
  // Numbers are required for the staged row exactly when the catalogue cannot
  // answer — and only once an id has been typed, so an untouched empty form
  // does not shout at somebody who has not started.
  const newNumbersErrors = validateModelNumbers(
    newNumbers,
    trimmedNewId.length > 0 && !newIsKnown,
  );

  const handleRemove = (index: number) => {
    onChange(value.filter((_, position) => position !== index));
  };

  const handleRowChange = (index: number, next: Partial<PermittedModelDraft>) => {
    onChange(
      value.map((draft, position) =>
        position === index ? { ...draft, ...next } : draft,
      ),
    );
  };

  const handleAdd = () => {
    setAddError(null);

    if (trimmedNewId.length === 0) {
      setAddError('Enter the model id exactly as the provider spells it.');
      return;
    }
    // A DUPLICATE IS REFUSED RATHER THAN MERGED. Merging would have to choose
    // between the numbers already on the list and the ones just typed, and
    // either choice silently discards something the administrator entered.
    if (value.some((draft) => draft.id.trim() === trimmedNewId)) {
      setAddError(`“${trimmedNewId}” is already permitted — edit the row above instead.`);
      return;
    }
    if (atCapacity) {
      setAddError(`At most ${AI_ALLOWED_MODELS_MAX} models can be permitted.`);
      return;
    }
    if (hasModelNumbersError(newNumbersErrors)) {
      setAddError('Fix the context window and output ceiling before adding this model.');
      return;
    }

    onChange([...value, { id: trimmedNewId, label: '', numbers: newNumbers }]);
    setNewId('');
    setNewNumbers(EMPTY_MODEL_NUMBERS);
  };

  return (
    <Box>
      {value.length === 0 ? (
        // AN EMPTY LIST IS LEGAL AND MEANS SOMETHING, so it is stated rather
        // than left as blank space: it closes AI by policy without touching the
        // master switch, which is a deliberately representable state.
        <Alert severity="warning" sx={{ mb: 2 }}>
          No models are permitted, so no user of this deployment can generate anything —
          whatever key they have saved. That is a valid way to close the feature by policy
          without losing the rest of this configuration; add a model below to reopen it.
        </Alert>
      ) : (
        <Stack spacing={2} sx={{ mb: 2 }} component="ul" aria-label="Permitted models" role="list">
          {value.map((draft, index) => {
            const descriptor = catalogueDescriptor(draft.id, catalogue);
            const required = !descriptor;
            // See the file header: shown when this build cannot answer, and
            // ALSO when the entry carries an override the administrator must be
            // able to see and remove.
            const showNumbers = required || !isModelNumbersEmpty(draft.numbers);
            const errors = validateModelNumbers(draft.numbers, required);

            return (
              <Paper
                key={`${draft.id}-${index}`}
                variant="outlined"
                component="li"
                sx={{ p: 2, listStyle: 'none' }}
              >
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, mb: showNumbers ? 2 : 0 }}
                >
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography
                      variant="subtitle2"
                      component="p"
                      sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                    >
                      {draft.id}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {draft.label.trim() || descriptor?.label || 'No display name — the id is shown'}
                    </Typography>
                  </Box>

                  {/* Known/unknown, said plainly on the row rather than only
                      implied by whether two boxes appeared below it. */}
                  <Chip
                    size="small"
                    label={descriptor ? 'Known to this build' : 'Needs token limits'}
                    color={descriptor ? 'default' : 'warning'}
                    variant={descriptor ? 'outlined' : 'filled'}
                  />

                  <Tooltip title={`Stop permitting ${draft.id}`}>
                    {/* A `span` so the tooltip still has a host when the button
                        is disabled for a read-only administrator — a disabled
                        button fires no pointer events of its own. */}
                    <span>
                      <IconButton
                        aria-label={`Stop permitting ${draft.id}`}
                        onClick={() => handleRemove(index)}
                        disabled={disabled}
                        size="small"
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>

                {showNumbers && (
                  <AiModelNumberFields
                    modelId={draft.id}
                    draft={draft.numbers}
                    errors={errors}
                    onChange={(numbers) => handleRowChange(index, { numbers })}
                    disabled={disabled}
                    required={required}
                  />
                )}
              </Paper>
            );
          })}
        </Stack>
      )}

      {value.length > AI_ALLOWED_MODELS_MAX && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {value.length} models are listed and the API accepts at most{' '}
          {AI_ALLOWED_MODELS_MAX}. Remove {value.length - AI_ALLOWED_MODELS_MAX} before
          saving.
        </Alert>
      )}

      {/* ====================================================================
          ⚠ THE MANUAL PATH. First-class, never behind a disclosure — see the
          file header for why the vendor list must not be the only way in.
          ================================================================= */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" component="h3" gutterBottom>
          Add a model by hand
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Any model id the provider accepts can be permitted here, whether or not it
          appears in <strong>Load models from provider</strong> — that list is the
          vendor&apos;s own, filtered to what looks like a chat model and scoped to whichever
          key asked for it, so a model missing from it is not a model this deployment
          cannot use. Supply a context window and output ceiling for anything this build
          does not already know.
        </Typography>

        <Stack spacing={2}>
          <TextField
            fullWidth
            size="small"
            label="Model id"
            value={newId}
            onChange={(event) => {
              setNewId(event.target.value);
              setAddError(null);
            }}
            disabled={disabled}
            helperText={
              trimmedNewId.length > 0 && newIsKnown
                ? 'This build already knows this model — the token limits below are optional.'
                : 'Exactly as the provider spells it, e.g. gpt-4o-mini.'
            }
          />

          <AiModelNumberFields
            modelId={trimmedNewId || 'the new model'}
            draft={newNumbers}
            errors={newNumbersErrors}
            onChange={setNewNumbers}
            disabled={disabled}
            required={trimmedNewId.length > 0 && !newIsKnown}
          />

          {addError && <Alert severity="error">{addError}</Alert>}

          <Box>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={handleAdd}
              disabled={disabled || atCapacity}
            >
              Add model
            </Button>
          </Box>
        </Stack>
      </Paper>
    </Box>
  );
}

export default AiPermittedModels;
