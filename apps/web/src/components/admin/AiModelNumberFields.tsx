/**
 * The two numbers a model this build has never heard of needs — issue #78,
 * epic #45.
 *
 * =============================================================================
 * WHY THIS PAIR EXISTS AT ALL, AND WHY IT IS ONE COMPONENT AND NOT TWO
 * =============================================================================
 *
 * `resolveAllowedModel` (`apps/api/src/ai/ai-model-resolution.ts`) requires
 * BOTH `contextWindowTokens` and `maxOutputTokens` to resolve an entry, and its
 * header states why neither may be defaulted: docs/specs/notes.md §3.3's budget
 * subtracts the output allowance from the window to get the input allowance, so
 * a descriptor missing the second has nothing to subtract, and the two
 * plausible repairs are both wrong — falling back to the deployment ceiling
 * silently promises an output length the model may refuse, and treating it as
 * zero publishes a model that can produce nothing.
 *
 * ⚠ SO A HALF-ANSWERED MODEL IS AN UNANSWERED MODEL. That is the whole reason
 * these two fields are one component with one validator rather than two
 * independent inputs: an administrator who fills in the window and leaves the
 * output ceiling blank has, from the API's point of view, told this deployment
 * nothing at all — the entry saves, lists back, and is silently never offered
 * to a single user. Binding them together is how "you must answer both" becomes
 * visible at the moment of typing instead of days later.
 *
 * =============================================================================
 * THE DRAFT IS TWO STRINGS, NOT TWO NUMBERS
 * =============================================================================
 *
 * ⚠ NEVER STORE THESE AS `number | null` WHILE THEY ARE BEING EDITED. A
 * controlled numeric input whose state is parsed on every keystroke destroys
 * the intermediate values a person types on the way to a real one: clearing the
 * field to retype it becomes `NaN`, a leading `-` or a lone `0` round-trips to
 * something else, and the caret jumps. Strings all the way to the submit, with
 * exactly one parse at the boundary ({@link parseModelNumbers}) — the same
 * discipline the token-ceiling fields on `AiSettingsPage` already use.
 *
 * An EMPTY string means "not supplied", which is a legitimate saved state for a
 * model the build catalogue already describes: the entry simply omits the field
 * and `resolveAllowedModel` falls through to the catalogue. It is only an error
 * when nothing else can answer — which is what `required` below expresses.
 *
 * The bounds are imported from `services/ai`, never retyped here: two copies of
 * a bound is how one of them quietly stops matching `aiAllowedModelSchema`.
 */

import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

import { AI_MODEL_BOUNDS } from '../../services/ai';

/** The two numbers mid-edit. `''` means "not supplied". See the file header. */
export interface ModelNumbersDraft {
  contextWindowTokens: string;
  maxOutputTokens: string;
}

/** An empty draft — the state a freshly added, unknown model starts in. */
export const EMPTY_MODEL_NUMBERS: ModelNumbersDraft = {
  contextWindowTokens: '',
  maxOutputTokens: '',
};

/** Turn stored (possibly absent) numbers back into an editable draft. */
export function toModelNumbersDraft(
  contextWindowTokens?: number,
  maxOutputTokens?: number,
): ModelNumbersDraft {
  return {
    contextWindowTokens:
      contextWindowTokens === undefined ? '' : String(contextWindowTokens),
    maxOutputTokens: maxOutputTokens === undefined ? '' : String(maxOutputTokens),
  };
}

/** Per-field messages, `null` where the field is fine. */
export interface ModelNumbersErrors {
  contextWindowTokens: string | null;
  maxOutputTokens: string | null;
}

function boundMessage(bound: { min: number; max: number }): string {
  return `Must be a whole number between ${bound.min.toLocaleString()} and ${bound.max.toLocaleString()} tokens.`;
}

function fieldError(
  raw: string,
  bound: { min: number; max: number },
  required: boolean,
): string | null {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return required
      ? 'This build does not know this model, so it cannot be offered without this number.'
      : null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  // `String(parsed) !== trimmed` catches `1e6`, `1024.5` and `12abc`, all of
  // which `parseInt` reads as a plausible-looking number that is not what was
  // typed. The schema would refuse them; this refuses them where the typing is.
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== trimmed ||
    parsed < bound.min ||
    parsed > bound.max
  ) {
    return boundMessage(bound);
  }

  return null;
}

/**
 * Validate a draft.
 *
 * `required` is true exactly when the model resolves to NO build-catalogue
 * descriptor — the caller decides that, because only it knows the catalogue.
 * Mirrors `aiAllowedModelSchema`'s bounds so a 400 is PREVENTED rather than
 * reported; the schema remains the guarantee.
 */
export function validateModelNumbers(
  draft: ModelNumbersDraft,
  required: boolean,
): ModelNumbersErrors {
  return {
    contextWindowTokens: fieldError(
      draft.contextWindowTokens,
      AI_MODEL_BOUNDS.contextWindowTokens,
      required,
    ),
    maxOutputTokens: fieldError(
      draft.maxOutputTokens,
      AI_MODEL_BOUNDS.maxOutputTokens,
      required,
    ),
  };
}

/** Whether a draft has anything wrong with it. */
export function hasModelNumbersError(errors: ModelNumbersErrors): boolean {
  return !!errors.contextWindowTokens || !!errors.maxOutputTokens;
}

/** True when the administrator has typed something into either field. */
export function isModelNumbersEmpty(draft: ModelNumbersDraft): boolean {
  return (
    draft.contextWindowTokens.trim().length === 0 &&
    draft.maxOutputTokens.trim().length === 0
  );
}

/**
 * The one parse, at the boundary.
 *
 * Returns `undefined` for a blank field so the entry OMITS it — which is not
 * the same as sending `null`, and matters: an omitted field lets
 * `resolveAllowedModel` fall through to the build catalogue, which is exactly
 * what a known model wants. Assumes the draft has already been validated; a
 * value that cannot be parsed is dropped rather than sent as `NaN`, because
 * `JSON.stringify(NaN)` is `null` and would be refused by the schema with a
 * message about a type, not about a range.
 */
export function parseModelNumbers(draft: ModelNumbersDraft): {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
} {
  const parse = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  };

  return {
    contextWindowTokens: parse(draft.contextWindowTokens),
    maxOutputTokens: parse(draft.maxOutputTokens),
  };
}

export interface AiModelNumberFieldsProps {
  /**
   * Disambiguates the labels for assistive technology.
   *
   * ⚠ REQUIRED, AND IT MUST BE THE MODEL ID. Several of these pairs can be on
   * screen at once — one per unknown permitted model, and one per checked
   * unknown model in the discovery dialog — and a screen-reader user hearing
   * "Context window" six times with nothing to tell them apart cannot fill the
   * form in. The visible label stays short; the accessible name carries the id.
   */
  modelId: string;
  draft: ModelNumbersDraft;
  errors: ModelNumbersErrors;
  onChange: (next: ModelNumbersDraft) => void;
  disabled?: boolean;
  /** Whether this build can answer for the model. Drives the fallback help text. */
  required: boolean;
}

/**
 * The pair, rendered.
 *
 * Stacks at `xs`, side by side from `sm` — with `sx` breakpoint values only.
 * ⚠ NOTHING HERE MOUNTS, UNMOUNTS OR RE-GATES ON A BREAKPOINT, so Settings UI
 * Pattern rule 5's five coupled gates are untouched by construction: there is
 * no `useMediaQuery` in this file and there must not be one.
 */
export function AiModelNumberFields({
  modelId,
  draft,
  errors,
  onChange,
  disabled,
  required,
}: AiModelNumberFieldsProps) {
  const fallbackHelp = required
    ? 'Read these off the vendor’s model documentation.'
    : 'Optional — leave blank to use the value this build already knows.';

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ width: '100%' }}>
      <TextField
        fullWidth
        size="small"
        type="number"
        label="Context window (tokens)"
        value={draft.contextWindowTokens}
        onChange={(event) =>
          onChange({ ...draft, contextWindowTokens: event.target.value })
        }
        disabled={disabled}
        required={required}
        error={!!errors.contextWindowTokens}
        helperText={errors.contextWindowTokens ?? fallbackHelp}
        slotProps={{
          htmlInput: {
            'aria-label': `Context window in tokens for ${modelId}`,
            min: AI_MODEL_BOUNDS.contextWindowTokens.min,
            max: AI_MODEL_BOUNDS.contextWindowTokens.max,
          },
        }}
      />
      <TextField
        fullWidth
        size="small"
        type="number"
        label="Max output (tokens)"
        value={draft.maxOutputTokens}
        onChange={(event) => onChange({ ...draft, maxOutputTokens: event.target.value })}
        disabled={disabled}
        required={required}
        error={!!errors.maxOutputTokens}
        helperText={errors.maxOutputTokens ?? fallbackHelp}
        slotProps={{
          htmlInput: {
            'aria-label': `Maximum output tokens for ${modelId}`,
            min: AI_MODEL_BOUNDS.maxOutputTokens.min,
            max: AI_MODEL_BOUNDS.maxOutputTokens.max,
          },
        }}
      />
    </Stack>
  );
}

export default AiModelNumberFields;
