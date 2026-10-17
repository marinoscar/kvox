/**
 * "Which model should write this?" — one picker, two surfaces. Issue #109.
 *
 * =============================================================================
 * WHY THIS IS A COMPONENT AND NOT TWO SELECTS
 * =============================================================================
 *
 * `/notes/new` and the regenerate dialog ask the identical question over the
 * identical list (`GET /api/ai-tasks/config`'s `models`, already narrowed by
 * deployment policy), and the one thing that is easy to get wrong is the same
 * in both: rendering `model.id` where `model.label` belongs. The id is a vendor
 * string — `gpt-4o-mini-2024-07-18` — and the label is what #97's resolution
 * chain produced for a human to read. Two hand-written selects is how one of
 * them ends up showing the other.
 *
 * ⚠ IT RENDERS WHAT IT IS GIVEN AND RESOLVES NOTHING. Choosing the default, and
 * deciding whether a note's recorded model is still permitted, are decisions
 * about a note — they belong to the surface that holds one. This component has
 * no opinion about which option should be selected, which is what lets both
 * callers use it without either inheriting the other's rules.
 */

import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { useId } from 'react';

import type { NotesAiModel } from '../ai.js';

/**
 * Props of {@link ModelSelect}.
 *
 * @stability experimental
 */
export interface ModelSelectProps {
  /** The selected model id. */
  value: string;
  /** Called with the id of the model the user picked. */
  onChange: (value: string) => void;
  /** The models to offer. */
  models: readonly NotesAiModel[];
  /** Defaults to "Model". Named when a surface needs to disambiguate it. */
  label?: string;
  /** One sentence under the field. */
  helperText?: string;
  /** Disables the field. */
  disabled?: boolean;
  /** Draws the field in its error state; `helperText` carries the reason. */
  error?: boolean;
}

/**
 * The model picker the new-note form, the regenerate dialog, Ask and the
 * extract dialog share. It shows each model's label, never its id.
 *
 * @param props - See {@link ModelSelectProps}.
 * @returns The field.
 *
 * @stability experimental
 */
export function ModelSelect({
  value,
  onChange,
  models,
  label = 'Model',
  helperText,
  disabled = false,
  error = false,
}: ModelSelectProps) {
  // A generated id rather than a constant: unlike the generation-context panel,
  // two of these can legitimately be on one page (a form and a dialog over it),
  // and a duplicated `id` would point both labels at the first select.
  const labelId = useId();

  return (
    <FormControl fullWidth size="small" disabled={disabled} error={error}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <MenuItem key={model.id} value={model.id}>
            {/* ⚠ THE LABEL, NEVER THE ID. See the file header. */}
            {model.label}
          </MenuItem>
        ))}
      </Select>
      {helperText && <FormHelperText>{helperText}</FormHelperText>}
    </FormControl>
  );
}

