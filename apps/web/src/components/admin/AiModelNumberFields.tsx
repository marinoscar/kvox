/**
 * The two per-model token numbers — issue #78, epic #45; made OPTIONAL by #97.
 *
 * =============================================================================
 * ⚠ WHAT #97 CHANGED, AND WHY THE OLD RULE HAS TO GO RATHER THAN BE SOFTENED
 * =============================================================================
 *
 * These two fields used to be REQUIRED for any model the build catalogue did not
 * carry, because `resolveAllowedModel` (`apps/api/src/ai/ai-model-resolution.ts`)
 * had nothing else to fall back on: docs/specs/notes.md §3.3's budget subtracts
 * the output allowance from the window to get the input allowance, so an entry
 * missing either number resolved to nothing and was silently never offered. The
 * only safe client behaviour was to refuse to permit the model until somebody
 * typed both.
 *
 * That was correct and it was unusable. A vendor ships a dated snapshot per
 * model per release — `gpt-5.4-mini-2026-03-17` — so the discovery dialog
 * presented forty-odd rows, each with two red required boxes, and permitting a
 * model meant leaving the application to read vendor documentation. Issue #97
 * fixed it where it belonged, in resolution: a dated snapshot now resolves to
 * its family's real limits, and anything else to a conservative floor. There is
 * no longer such a thing as an entry that cannot be budgeted.
 *
 * ⚠ SO THE `required` FLAG IS GONE FROM THIS MODULE ENTIRELY, not defaulted to
 * false. A boolean nothing sets is a boolean somebody re-enables by accident —
 * and the message it carried ("this build does not know this model, so it cannot
 * be offered without this number") is now a false statement about how the API
 * behaves. Deleting the parameter makes reintroducing the demand a deliberate
 * edit to this file rather than one `true` at a call site.
 *
 * WHAT THESE FIELDS ARE NOW: an OVERRIDE. An administrator uses them when they
 * know better than the server's inference — most usefully to raise a
 * `source: 'default'` floor to the vendor's real window so large sources stop
 * being refused. Blank is the ordinary, complete, correct state.
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
 * An EMPTY string means "not supplied", and since #97 that is never an error in
 * itself: the entry simply omits the field and the API resolves the number.
 *
 * =============================================================================
 * ⚠ VALIDATION NOW ONLY EVER FIRES ON SOMETHING SOMEBODY TYPED
 * =============================================================================
 *
 * Three things are genuinely wrong and are reported inline: a value that is not
 * a whole number, one outside `aiAllowedModelSchema`'s bounds, and an output
 * ceiling larger than the context window it has to fit inside. Nothing else may
 * block a save. In particular a BLANK field is never an error, and neither is a
 * lone override — the missing half falls back to the resolved value rather than
 * to nothing, so half an override is partial, not fatal.
 *
 * The third check needs a number the administrator may not have typed, which is
 * why {@link validateModelNumbers} takes the EFFECTIVE limits: overriding only
 * the output ceiling is the common case, and comparing it against nothing would
 * let 200,000 output tokens sit inside a 128,000-token window unremarked. The
 * error is attached to the field that was actually typed, because an error on a
 * box somebody never touched is an error with no obvious fix.
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

/** An empty draft — and since #97, the state nearly every model stays in. */
export const EMPTY_MODEL_NUMBERS: ModelNumbersDraft = {
  contextWindowTokens: '',
  maxOutputTokens: '',
};

/**
 * The numbers that apply when the administrator overrides neither (#97).
 *
 * `null` per field means "nobody could say" — not zero and not unlimited. It is
 * rendered as an absence and compared against nothing.
 */
export interface EffectiveModelLimits {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
}

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

/**
 * Read one field, distinguishing "blank" from "typed but wrong".
 *
 * Returns `undefined` for blank — which is NOT an error and never has been
 * since #97 — and `null` for a value that was typed and cannot be used.
 */
function readField(
  raw: string,
  bound: { min: number; max: number },
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

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
    return null;
  }

  return parsed;
}

/**
 * Validate a draft against what would apply if it were left blank.
 *
 * ⚠ THERE IS NO `required` PARAMETER AND THERE MUST NOT BE ONE — see the file
 * header. A blank field is always valid. Mirrors `aiAllowedModelSchema`'s bounds
 * so a 400 is PREVENTED rather than reported; the schema remains the guarantee.
 */
export function validateModelNumbers(
  draft: ModelNumbersDraft,
  effective?: EffectiveModelLimits,
): ModelNumbersErrors {
  const context = readField(
    draft.contextWindowTokens,
    AI_MODEL_BOUNDS.contextWindowTokens,
  );
  const output = readField(draft.maxOutputTokens, AI_MODEL_BOUNDS.maxOutputTokens);

  const errors: ModelNumbersErrors = {
    contextWindowTokens:
      context === null ? boundMessage(AI_MODEL_BOUNDS.contextWindowTokens) : null,
    maxOutputTokens:
      output === null ? boundMessage(AI_MODEL_BOUNDS.maxOutputTokens) : null,
  };

  // The cross-field check, against the numbers that would actually be in force:
  // a typed value where there is one, the resolved value otherwise. Skipped
  // entirely if either side is already flagged, so one mistyped digit does not
  // produce two red boxes saying different things about the same keystroke.
  if (errors.contextWindowTokens || errors.maxOutputTokens) return errors;

  const effectiveContext = context ?? effective?.contextWindowTokens ?? null;
  const effectiveOutput = output ?? effective?.maxOutputTokens ?? null;

  if (
    effectiveContext !== null &&
    effectiveOutput !== null &&
    effectiveOutput > effectiveContext
  ) {
    const message =
      `The output ceiling cannot exceed the context window (${effectiveContext.toLocaleString()} tokens) — ` +
      'a completion has to fit inside it.';
    // Attached to whichever box was actually typed in, preferring the output
    // ceiling when both were: an error on a field somebody never touched reads
    // as a bug in the form rather than as something to correct.
    if (output !== undefined) {
      errors.maxOutputTokens = message;
    } else {
      errors.contextWindowTokens =
        'The context window cannot be smaller than the output ceiling ' +
        `(${effectiveOutput.toLocaleString()} tokens) that applies to this model.`;
    }
  }

  return errors;
}

/** Whether a draft has anything wrong with it. */
export function hasModelNumbersError(errors: ModelNumbersErrors): boolean {
  return !!errors.contextWindowTokens || !!errors.maxOutputTokens;
}

/** True when the administrator has typed nothing into either field. */
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
 * the same as sending `null`, and matters: an omitted field lets the API resolve
 * the number itself, which since #97 is what almost every entry wants. Assumes
 * the draft has already been validated; a value that cannot be parsed is dropped
 * rather than sent as `NaN`, because `JSON.stringify(NaN)` is `null` and would
 * be refused by the schema with a message about a type, not about a range.
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
   * screen at once — one per model whose override is open — and a screen-reader
   * user hearing "Context window" six times with nothing to tell them apart
   * cannot fill the form in. The visible label stays short; the accessible name
   * carries the id.
   */
  modelId: string;
  draft: ModelNumbersDraft;
  errors: ModelNumbersErrors;
  onChange: (next: ModelNumbersDraft) => void;
  disabled?: boolean;
  /**
   * What applies to each field when it is left blank, shown as its helper text.
   *
   * Naming the number somebody is about to replace is the difference between
   * "type something here" and "this is 128,000 unless you say otherwise" — and
   * it is the only way an administrator can tell whether overriding is worth
   * doing at all.
   */
  effective?: EffectiveModelLimits;
}

/**
 * The pair, rendered as OPTIONAL overrides.
 *
 * No asterisk, no error state on a blank field, and helper text that names what
 * applies if nothing is typed. Stacks at `xs`, side by side from `sm` — with
 * `sx` breakpoint values only. ⚠ NOTHING HERE MOUNTS, UNMOUNTS OR RE-GATES ON A
 * BREAKPOINT, so Settings UI Pattern rule 5's five coupled gates are untouched
 * by construction: there is no `useMediaQuery` in this file and there must not
 * be one.
 */
export function AiModelNumberFields({
  modelId,
  draft,
  errors,
  onChange,
  disabled,
  effective,
}: AiModelNumberFieldsProps) {
  const fallbackHelp = (value: number | null | undefined): string =>
    value === null || value === undefined
      ? 'Optional — leave blank unless you need to set this yourself.'
      : `Optional — ${value.toLocaleString()} is used if you leave this blank.`;

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
        error={!!errors.contextWindowTokens}
        helperText={
          errors.contextWindowTokens ?? fallbackHelp(effective?.contextWindowTokens)
        }
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
        error={!!errors.maxOutputTokens}
        helperText={errors.maxOutputTokens ?? fallbackHelp(effective?.maxOutputTokens)}
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
