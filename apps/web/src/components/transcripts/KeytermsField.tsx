/**
 * "Names & terms in this recording" — the keyterms input on the New-transcript
 * screen (issue #327, epic #326).
 *
 * A chip list rather than a textarea because each term is sent as its own
 * entry, and the limits (words and characters) are PER TERM: a chip is the one
 * shape that shows the user exactly which unit a limit applies to.
 *
 * Three ways in, all funnelled through `addKeyterms` so they cannot disagree:
 *   - Enter (Autocomplete's own `freeSolo` commit) or picking a suggestion;
 *   - typing a comma, which commits everything before it;
 *   - pasting a comma- or newline-separated list, which becomes several chips.
 * Leaving the field also commits whatever is half-typed, so a term the user
 * typed but never pressed Enter on is not silently dropped at Start.
 *
 * A refused term stays in the input with an inline error, so it can be
 * shortened rather than retyped.
 */

import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { useState } from 'react';
import type { ClipboardEvent } from 'react';

import { addKeyterms, splitKeytermInput } from '../../pages/newTranscript';

export interface KeytermsFieldProps {
  value: string[];
  onChange: (terms: string[]) => void;
  /** The deployment's ceiling, from `GET /api/transcription/config`. */
  maxKeyterms: number;
  /** Offered, never pre-selected. */
  suggestions?: readonly string[];
  disabled?: boolean;
}

const HELPER_TEXT =
  "Helps the transcription spell names, companies and jargon correctly (e.g. people's names). Press Enter or type a comma after each.";

export function KeytermsField({
  value,
  onChange,
  maxKeyterms,
  suggestions = [],
  disabled = false,
}: KeytermsFieldProps) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Commit `candidates`; returns true when every one was accepted. */
  const commit = (candidates: string[]): boolean => {
    const result = addKeyterms(value, candidates, maxKeyterms);
    if (result.terms.length !== value.length) onChange(result.terms);
    setError(result.error);
    return result.error === null;
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[,\n\r]/.test(text)) return;
    event.preventDefault();
    const parts = splitKeytermInput(`${inputValue}${text}`);
    if (commit(parts)) setInputValue('');
  };

  const lowerValue = new Set(value.map((term) => term.toLowerCase()));
  const options = suggestions.filter((name) => !lowerValue.has(name.toLowerCase()));

  return (
    <Autocomplete
      multiple
      freeSolo
      disabled={disabled}
      options={options}
      value={value}
      inputValue={inputValue}
      onChange={(_event, next, reason) => {
        if (reason === 'createOption' || reason === 'selectOption') {
          const added = next[next.length - 1];
          if (typeof added !== 'string') return;
          if (commit([added])) setInputValue('');
          else setInputValue(added);
          return;
        }
        // Removing a chip or clearing the list: nothing to validate.
        setError(null);
        onChange(next.filter((term): term is string => typeof term === 'string'));
      }}
      onInputChange={(_event, next, reason) => {
        if (reason !== 'input') {
          // `reset` fires after a commit; keep a refused term visible instead.
          if (reason === 'clear') setInputValue('');
          return;
        }
        if (/[,\n\r]/.test(next)) {
          // Everything before the last separator is committed; the tail keeps
          // being typed.
          const lastSeparator = Math.max(
            next.lastIndexOf(','),
            next.lastIndexOf('\n'),
            next.lastIndexOf('\r'),
          );
          const head = next.slice(0, lastSeparator);
          const tail = next.slice(lastSeparator + 1);
          if (commit(splitKeytermInput(head))) setInputValue(tail.trimStart());
          else setInputValue(head);
          return;
        }
        if (error) setError(null);
        setInputValue(next);
      }}
      onBlur={() => {
        if (inputValue.trim() && commit([inputValue])) setInputValue('');
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Names & terms in this recording"
          placeholder={value.length === 0 ? 'e.g. Ana Solís, Kvox, OKRs' : undefined}
          error={error !== null}
          helperText={error ?? HELPER_TEXT}
          slotProps={{
            ...params.slotProps,
            htmlInput: {
              ...params.slotProps?.htmlInput,
              onPaste: handlePaste,
            },
          }}
        />
      )}
    />
  );
}

export default KeytermsField;
