import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState, type ReactNode } from 'react';

import { ErrorNotice } from '../layout.js';
import { acceptSuggestion, fieldState, SECRET_MASK, type TextFieldSpec } from './field-state.js';

// =============================================================================
// TextField — one question  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. Controlled: the screen (or `Form`) owns `value` and gets
// every change through `onChange`; this component keeps only the one bit of
// UI state that is nobody else's business — whether the operator has tried
// to submit yet, which decides when the validator's message is shown.
// Keyboard handling is gated by `isActive`, exactly as `ScrollBox` gates its
// arrow keys, so a form of several fields has one that owns the keyboard.
//
// ENTER SUBMITS ONLY WHEN VALID. An invalid value shows its error UNDER the
// field and stays on it — invoke.tsx's rule that a mistake is corrected where
// it was made, not by starting again. The error is shown after the first
// attempt rather than while typing, because every hostname is invalid until
// its last character and a field that shouts through all of them is noise.
//
// TAB ACCEPTS THE SUGGESTION while the field is empty (`fieldState`); Form
// asks the same function, so Tab never both fills a value and moves focus.
// ink-text-input itself ignores Tab, ↑ and ↓ — which is what leaves them free
// for this component and for `Form` to bind.
// =============================================================================

export interface TextFieldProps extends TextFieldSpec {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter, only with a value the validator accepts. */
  onSubmit: (value: string) => void;
  /** Keys are ignored and the cursor hidden while false. Default true. */
  isActive?: boolean | undefined;
  /** Pad the label to this many columns, so a form's fields line up. */
  labelWidth?: number | undefined;
  /** Show the validator's message even before a submit attempt. */
  showError?: boolean | undefined;
}

export function TextField({
  value,
  onChange,
  onSubmit,
  isActive,
  labelWidth,
  showError,
  ...spec
}: TextFieldProps): ReactNode {
  const active = isActive ?? true;
  const [attempted, setAttempted] = useState(false);
  const state = fieldState(value, spec);

  useInput(
    (_input, key) => {
      if (key.tab && !key.shift && state.tabAccepts) onChange(acceptSuggestion(value, spec));
    },
    { isActive: active },
  );

  const errorShown = (attempted || showError === true) && state.error !== undefined;
  const label = spec.label.padEnd(labelWidth ?? spec.label.length);

  return (
    <Box flexDirection="column">
      {active && spec.help !== undefined && spec.help !== '' ? (
        <Text dimColor>{spec.help.split('\n')[0]}</Text>
      ) : null}

      <Box>
        <Text dimColor={!active} bold={active}>
          {label}
        </Text>
        <Text>{'  '}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          focus={active}
          showCursor={active}
          placeholder={spec.placeholder ?? state.suggestionDisplay ?? ''}
          {...(spec.secret === true ? { mask: SECRET_MASK } : {})}
          onSubmit={(submitted) => {
            if (!fieldState(submitted, spec).valid) {
              setAttempted(true);
              return;
            }
            setAttempted(false);
            onSubmit(submitted);
          }}
        />
      </Box>

      {active && state.suggestion !== undefined ? (
        <Box marginLeft={2}>
          <Text dimColor>
            → {state.suggestionDisplay} ({state.suggestion.reason}) · tab to accept
          </Text>
        </Box>
      ) : null}

      {active && errorShown && state.error !== undefined ? (
        <Box marginLeft={2}>
          <ErrorNotice message={`${spec.label} ${state.error}`} />
        </Box>
      ) : null}
    </Box>
  );
}
