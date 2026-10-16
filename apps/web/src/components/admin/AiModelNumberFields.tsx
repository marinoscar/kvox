/**
 * The numeric fields of the AI limits section — issue #477, epic #472
 * (repurposed from the per-model token override of #78 / #97).
 *
 * WHAT CHANGED. The per-model context window / output ceiling override edited a
 * permitted-models list that no longer exists here: the platform's AI models
 * page owns the catalogue and each model's limits. What this module keeps is the
 * discipline that was worth keeping, applied to the four deployment-wide
 * ceilings the app's `ai` namespace extension still carries
 * (`maxInputTokens`, `maxOutputTokens`, `requestTimeoutMs`, `maxDocumentBytes`).
 *
 * THE DRAFT IS A STRING, NOT A NUMBER. ⚠ NEVER STORE THESE AS `number | null`
 * WHILE THEY ARE BEING EDITED. A controlled numeric input whose state is parsed
 * on every keystroke destroys the intermediate values a person types on the way
 * to a real one: clearing the field to retype it becomes `NaN`, a leading `-`
 * or a lone `0` round-trips to something else, and the caret jumps. Strings all
 * the way to the submit, with one parse at the boundary
 * ({@link parseOptionalInteger}).
 *
 * OPTIONAL MEANS BLANK IS VALID. `maxInputTokens` and `maxOutputTokens` are
 * optional spend caps: blank is `null` on the wire ("the model's own maximum
 * governs"), so only a value somebody typed is range-checked. The timeout and
 * the document ceiling always carry a number.
 *
 * No `useMediaQuery`: the fields stack through `sx` breakpoint values alone, so
 * Settings UI Pattern rule 5's five coupled gates are untouched.
 */

import TextField from '@mui/material/TextField';
import type { ReactNode } from 'react';

/** An inclusive integer range. Mirrors the `ai` namespace's stored schema. */
export interface IntegerBounds {
  min: number;
  max: number;
}

/**
 * The message for one field, or `null` when it is fine.
 *
 * `optional` makes a blank field valid (no cap); otherwise blank is an error.
 * Catches `1e6`, `1024.5` and `12abc`, which `parseInt` would read as a
 * plausible number that is not what was typed.
 */
export function integerFieldError(
  raw: string,
  bounds: IntegerBounds,
  unit: string,
  optional: boolean,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 && optional) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== trimmed ||
    parsed < bounds.min ||
    parsed > bounds.max
  ) {
    return `Must be a whole number between ${bounds.min.toLocaleString()} and ${bounds.max.toLocaleString()} ${unit}.`;
  }
  return null;
}

/** A blank optional cap is `null` on the wire; anything else is the integer typed. */
export function parseOptionalInteger(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : Number.parseInt(trimmed, 10);
}

export interface AiLimitNumberFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
  /** Shown while there is no error. */
  helperText: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}

/** One labelled numeric field of the limits section. */
export function AiLimitNumberField({
  label,
  value,
  onChange,
  error,
  helperText,
  disabled,
  placeholder,
}: AiLimitNumberFieldProps) {
  return (
    <TextField
      fullWidth
      type="number"
      label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      error={!!error}
      helperText={error ?? helperText}
      slotProps={{ inputLabel: { shrink: true } }}
    />
  );
}

export default AiLimitNumberField;
