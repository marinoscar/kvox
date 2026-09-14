/**
 * The permitted-models editor — issue #78, epic #45; the token-limit demand
 * removed by #97.
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
 * ⚠ #97: THE NUMBERS ARE NOW AN OVERRIDE, AND NO ROW MAY DEMAND THEM
 * =============================================================================
 *
 * #78's rule was "a row shows the number fields, REQUIRED, when the id resolves
 * to no descriptor in the build catalogue". That rule was correct for an API
 * that could not resolve such an id at all, and it made permitting a model an
 * exercise in reading vendor documentation — per model, for every dated snapshot
 * a vendor ships. #97 moved the resolution into the API (exact catalogue hit,
 * then a dated-snapshot match, then a conservative floor), so there is no longer
 * an id this deployment cannot budget for, and there is nothing left for a row
 * to demand.
 *
 * A row now STATES what applies and offers to change it:
 *
 *   • one line of text — the effective context window and output ceiling, and a
 *     chip saying where they came from (`AiModelLimits`);
 *   • an `Override` press that reveals the same two fields, optional;
 *   • an existing override always expanded, because an override nobody can see
 *     is one nobody can remove — and the next save, built from what the form
 *     holds, would carry it forever. That rule survives from #78 unchanged; it
 *     is the one thing about this list that did not change.
 *
 * ⚠ THE PROVENANCE IS DISPLAY-ONLY AND IS NEVER SENT BACK. `toAllowedModels`
 * builds a request from `id`, `label` and the two override numbers, full stop.
 * Echoing the server's own inference to it as though an administrator had chosen
 * it would freeze today's numbers into the stored policy and outlive the release
 * that corrects them — the same argument that keeps a known model's numbers
 * blank rather than copied out of the catalogue.
 *
 * =============================================================================
 * ⚠ THE MANUAL PATH IS NOT A FALLBACK. IT IS THE GUARANTEE.
 * =============================================================================
 *
 * "Load models from the provider" is a convenience, and the list behind it is
 * FILTERED HEURISTICALLY on the API side to plausible chat models (with a
 * "show every model" escape hatch since #97, which is an admission that the
 * heuristic can be wrong, not a replacement for this path). A vendor's list is
 * also key-scoped — on OpenAI, project-scoped — so two administrators can
 * legitimately see different lists.
 *
 * So "Add a model by hand" below is a first-class control, not a disclosure
 * behind an accordion, and it never consults the filter, the catalogue or the
 * vendor. It must survive every future redesign of this section: any id the
 * administrator can name is permittable, and since #97 that takes an id and
 * nothing else.
 */

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
  type AiAllowedModelView,
  type AiModelDescriptor,
} from '../../services/ai';
import {
  AiModelLimitChip,
  AiModelLimits,
  describeModelLimits,
  effectiveModelLimits,
  isModelOverridden,
  type ModelLimitProvenance,
} from './AiModelLimits';
import {
  EMPTY_MODEL_NUMBERS,
  hasModelNumbersError,
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
 * typed into — and they are an OVERRIDE, blank in the ordinary case.
 *
 * `provenance` is what the API resolved for this id, carried purely so the row
 * can say so. `null` means nothing has answered for it yet: a model just added
 * by hand, or an API too old to report it. Both render as "this deployment
 * decides", which is true.
 */
export interface PermittedModelDraft {
  id: string;
  /** The entry's own label, or `''` when it has none and the catalogue's is used. */
  label: string;
  numbers: ModelNumbersDraft;
  /** Display only. ⚠ Never sent back — see the file header. */
  provenance: ModelLimitProvenance | null;
}

/** Seed the editor from what the API returned. */
export function toPermittedDrafts(entries: AiAllowedModelView[]): PermittedModelDraft[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label ?? '',
    // ⚠ THE ENTRY'S OWN NUMBERS, WHICH ARE THE OVERRIDE — not the resolved pair.
    // Seeding these boxes from a resolved number would turn the API's inference
    // into stored policy on the next save. See `AiAllowedModelView`.
    numbers: toModelNumbersDraft(entry.contextWindowTokens, entry.maxOutputTokens),
    provenance: entry.source
      ? {
          source: entry.source,
          derivedFrom: entry.derivedFrom ?? null,
          contextWindowTokens: entry.contextWindowTokens ?? null,
          maxOutputTokens: entry.maxOutputTokens ?? null,
        }
      : null,
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
 * What one row should SAY its limits are.
 *
 * ⚠ THE BUILD CATALOGUE WINS OVER THE CARRIED PROVENANCE WHEN IT HAS AN ANSWER,
 * because it is the one source that promises both numbers. A carried provenance
 * of `source: 'catalogue'` says the same thing with the numbers possibly absent
 * (an entry with no override carries none of its own), so preferring the
 * descriptor is how a known model shows real numbers rather than "not stated".
 * For everything else — a dated snapshot, a floor — the carried provenance is
 * the only source there is.
 */
export function rowProvenance(
  draft: PermittedModelDraft,
  catalogue: AiModelDescriptor[],
): ModelLimitProvenance | null {
  const descriptor = catalogueDescriptor(draft.id, catalogue);
  if (descriptor) {
    return {
      source: 'catalogue',
      derivedFrom: null,
      contextWindowTokens: descriptor.contextWindowTokens,
      maxOutputTokens: descriptor.maxOutputTokens,
    };
  }
  return draft.provenance;
}

/**
 * Whether anything in the list would be refused — a number that was typed and
 * cannot be used, or more entries than the API accepts.
 *
 * ⚠ A MISSING NUMBER IS NOT AN ERROR ANY MORE (#97). This function used to
 * report a row whose id the catalogue did not carry and whose boxes were empty;
 * that row is now a complete, offerable policy entry and reporting it disabled
 * `Save changes` for the one state every fresh deployment starts in.
 *
 * EXPORTED SO THE PAGE CAN DISABLE SAVE ON IT. The page owns the submit, so it
 * has to be able to ask this question without re-deriving what counts as a valid
 * override — which is the rule most likely to drift if it existed in two places.
 */
export function permittedModelsHaveError(
  drafts: PermittedModelDraft[],
  catalogue: AiModelDescriptor[],
): boolean {
  if (drafts.length > AI_ALLOWED_MODELS_MAX) return true;

  return drafts.some((draft) =>
    hasModelNumbersError(
      validateModelNumbers(
        draft.numbers,
        effectiveModelLimits(rowProvenance(draft, catalogue)),
      ),
    ),
  );
}

/**
 * The one parse, at the submit boundary.
 *
 * `label` is omitted when blank rather than sent as `''`: the schema's
 * `min(1)` would refuse an empty string, and an absent label is the state that
 * means "use the catalogue's, then the id" — which is what a blank box means.
 *
 * ⚠ `provenance` IS NOT IN THE RESULT AND MUST NOT BE. The return type is
 * {@link AiAllowedModel} — the WRITE shape — precisely so adding a display field
 * to the draft cannot leak into a request body by accident.
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
   * The models this build ships knowing — the ACTIVE PROVIDER'S
   * `capabilities.models`. Pass an empty array when no provider is registered;
   * that is not a special case, it simply means no row can show catalogue
   * numbers and each falls back to what the API reported for it.
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
  const newDescriptor = catalogueDescriptor(trimmedNewId, catalogue);
  const newProvenance: ModelLimitProvenance | null = newDescriptor
    ? {
        source: 'catalogue',
        derivedFrom: null,
        contextWindowTokens: newDescriptor.contextWindowTokens,
        maxOutputTokens: newDescriptor.maxOutputTokens,
      }
    : null;
  // Only ever about what was TYPED — an untouched empty form is valid, because
  // an id with no numbers is a complete entry since #97.
  const newNumbersErrors = validateModelNumbers(
    newNumbers,
    effectiveModelLimits(newProvenance),
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
    // The ONLY remaining reason to refuse: a number that was typed and cannot be
    // used. Blank boxes are the ordinary case and add the model.
    if (hasModelNumbersError(newNumbersErrors)) {
      setAddError('Fix the token limits you typed before adding this model.');
      return;
    }

    onChange([
      ...value,
      {
        id: trimmedNewId,
        label: '',
        numbers: newNumbers,
        // ⚠ THE CATALOGUE'S, OR NOTHING. This deployment has not been asked
        // about the id yet, and guessing a provenance here would put a sentence
        // on the row that no part of the system stands behind. `null` renders
        // honestly as "this deployment decides", and the next load replaces it
        // with the API's own answer.
        provenance: newProvenance,
      },
    ]);
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
        <Stack
          spacing={1.5}
          sx={{ mb: 2 }}
          component="ul"
          aria-label="Permitted models"
          role="list"
        >
          {value.map((draft, index) => {
            const provenance = rowProvenance(draft, catalogue);
            const overridden = isModelOverridden(draft.numbers);
            const description = describeModelLimits(provenance, overridden);

            return (
              <Paper
                key={`${draft.id}-${index}`}
                variant="outlined"
                component="li"
                sx={{ p: { xs: 1.5, sm: 2 }, listStyle: 'none' }}
              >
                {/* The identity row. `minWidth: 0` on the growing child is what
                    lets a long model id wrap instead of pushing the delete
                    button off a 360px screen. */}
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'flex-start', minWidth: 0 }}
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
                      {draft.label.trim() ||
                        catalogueDescriptor(draft.id, catalogue)?.label ||
                        'No display name — the id is shown'}
                    </Typography>
                  </Box>

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

                {/* Provenance and limits, on their own wrapping row: at 360px
                    the chip alone can take the full width, and putting it in the
                    identity row above would have squeezed the id to a column of
                    single characters. */}
                <Box sx={{ mt: 1 }}>
                  <AiModelLimitChip description={description} sx={{ mb: 0.5 }} />
                  <AiModelLimits
                    modelId={draft.id}
                    provenance={provenance}
                    draft={draft.numbers}
                    onChange={(numbers) => handleRowChange(index, { numbers })}
                    canOverride={!disabled}
                    disabled={disabled}
                    // The permitted list is short and every row here is a
                    // deliberate policy entry, so the sentence a conservative
                    // default needs is always worth its line.
                    showExplanation
                  />
                </Box>
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
      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Typography variant="subtitle2" component="h3" gutterBottom>
          Add a model by hand
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Any model id the provider accepts can be permitted here, whether or not it
          appears in <strong>Load models from provider</strong> — that list is the
          vendor&apos;s own, filtered to what looks like a chat model and scoped to whichever
          key asked for it, so a model missing from it is not a model this deployment
          cannot use. The id is all that is needed: this deployment works out the token
          limits, and you can override them afterwards.
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
              trimmedNewId.length > 0 && newDescriptor
                ? 'This build already knows this model, so its limits are already known.'
                : 'Exactly as the provider spells it, e.g. gpt-4o-mini.'
            }
          />

          <AiModelLimits
            modelId={trimmedNewId || 'the new model'}
            provenance={newProvenance}
            draft={newNumbers}
            onChange={setNewNumbers}
            canOverride={!disabled}
            disabled={disabled}
            showExplanation={false}
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
