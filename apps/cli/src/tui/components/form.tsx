import { Box, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';

import { fieldState, type TextFieldSpec } from './field-state.js';
import { SelectField, type SelectChoice } from './select-field.js';
import { TextField } from './text-field.js';

// =============================================================================
// Form — the fields of one wizard step  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. The screen owns the answers (`values`) and hears every
// keystroke through `onChange(key, value)`; the form owns only WHICH field
// has the keyboard. `onSubmit` fires from Enter on the last field, and only
// when every field is valid — otherwise focus goes to the first invalid one
// with its error shown. Keys are ignored while `isActive` is false, exactly
// as `ScrollBox` gates its arrow keys, so a screen showing a dialog over the
// form passes `isActive: false`.
//
// ONE FIELD ACCEPTS INPUT AT ANY MOMENT (invoke.tsx's invariant). The keys
// that move focus are:
//
//   Tab            next field   — unless the active text field is about to
//                                 accept its suggestion with it (fieldState)
//   Shift-Tab      previous field
//   ↓ / ↑          next / previous, on a TEXT field only: a select owns the
//                  arrows for its own choices while it is active
//   Enter          the field's own submit: next field, or `onSubmit` on the
//                  last
//
// Esc is deliberately NOT bound here — the wizard hook owns it (back a step),
// and two handlers for one key is how a keypress does two things.
// =============================================================================

export type FormFieldSpec =
  | ({ kind: 'text'; key: string } & TextFieldSpec)
  | {
      kind: 'select';
      key: string;
      label: string;
      choices: ReadonlyArray<SelectChoice>;
      help?: string | undefined;
    };

export interface FormProps {
  fields: ReadonlyArray<FormFieldSpec>;
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
  /** Enter on the last field, with every field valid. */
  onSubmit: () => void;
  /** Keys are ignored while false. Default true. */
  isActive?: boolean | undefined;
  /**
   * Move the keyboard to this field.
   *
   * Focus is the form's own business (the contract above), with ONE exception:
   * a step that verifies its answers after the fact — the install wizard's
   * database step running `database-credentials` (#131) — learns which field
   * was wrong only once the form has already submitted. Re-entering the step
   * at field one would make the operator Tab past four correct answers to
   * reach the password. Changing this prop moves focus; it is not a
   * controlled index, so the form still owns every move the keys make. A
   * screen that may blame the SAME field twice clears this back to undefined
   * between attempts — an unchanged prop moves nothing.
   */
  focusKey?: string | undefined;
}

/** The value a form shows for `field`: the answer, or the select's first choice. */
export function formValue(field: FormFieldSpec, values: Readonly<Record<string, string>>): string {
  const answer = values[field.key];
  if (answer !== undefined) return answer;
  return field.kind === 'select' ? (field.choices[0]?.value ?? '') : '';
}

/** Index of the first field whose value fails validation, or -1. */
export function firstInvalidField(
  fields: ReadonlyArray<FormFieldSpec>,
  values: Readonly<Record<string, string>>,
): number {
  return fields.findIndex(
    (field) => field.kind === 'text' && !fieldState(formValue(field, values), field).valid,
  );
}

/** Index of `key` in `fields`, or -1 when no field has it. */
export function focusIndexFor(
  fields: ReadonlyArray<FormFieldSpec>,
  key: string | undefined,
): number {
  if (key === undefined) return -1;
  return fields.findIndex((field) => field.key === key);
}

/** The label column: the widest label, so the fields line up. */
export function formLabelWidth(fields: ReadonlyArray<FormFieldSpec>): number {
  return fields.reduce((widest, field) => Math.max(widest, field.label.length), 0);
}

export function Form({
  fields,
  values,
  onChange,
  onSubmit,
  isActive,
  focusKey,
}: FormProps): ReactNode {
  const active = isActive ?? true;
  const [rawIndex, setIndex] = useState(0);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const last = Math.max(0, fields.length - 1);
  const index = Math.min(rawIndex, last);

  // A different step's fields arrive as a new key list; start at its top.
  const fieldKeys = JSON.stringify(fields.map((field) => field.key));
  useEffect(() => {
    setIndex(0);
    setSubmitAttempted(false);
  }, [fieldKeys]);

  // After `fieldKeys`, so a step that re-enters with BOTH a new field list and
  // a field to blame lands on the blamed field rather than being reset to the
  // top by the effect above.
  useEffect(() => {
    const target = focusIndexFor(fields, focusKey);
    if (target >= 0) {
      setIndex(target);
      setSubmitAttempted(true);
    }
    // `fields` is excluded deliberately: this must fire when the SCREEN names a
    // field, not on every render that rebuilds the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, fieldKeys]);

  const current = fields[index];
  const currentState =
    current?.kind === 'text' ? fieldState(formValue(current, values), current) : undefined;

  const submit = (): void => {
    const invalid = firstInvalidField(fields, values);
    if (invalid >= 0) {
      setSubmitAttempted(true);
      setIndex(invalid);
      return;
    }
    onSubmit();
  };

  const advance = (): void => {
    if (index >= last) submit();
    else setIndex(index + 1);
  };

  useInput(
    (_input, key) => {
      if (key.tab) {
        if (key.shift) setIndex(Math.max(0, index - 1));
        else if (currentState?.tabAccepts !== true) setIndex(Math.min(last, index + 1));
        return;
      }
      if (current?.kind !== 'text') return;
      if (key.downArrow) setIndex(Math.min(last, index + 1));
      else if (key.upArrow) setIndex(Math.max(0, index - 1));
    },
    { isActive: active && fields.length > 0 },
  );

  const labelWidth = formLabelWidth(fields);

  return (
    <Box flexDirection="column">
      {fields.map((field, position) => {
        const fieldActive = active && position === index;
        const value = formValue(field, values);

        if (field.kind === 'select') {
          const { kind: _kind, key, ...spec } = field;
          return (
            <SelectField
              key={key}
              {...spec}
              value={value}
              isActive={fieldActive}
              labelWidth={labelWidth}
              onChange={(next) => onChange(key, next)}
              onSubmit={() => advance()}
            />
          );
        }

        const { kind: _kind, key, ...spec } = field;
        return (
          <TextField
            key={key}
            {...spec}
            value={value}
            isActive={fieldActive}
            labelWidth={labelWidth}
            showError={submitAttempted}
            onChange={(next) => onChange(key, next)}
            onSubmit={() => advance()}
          />
        );
      })}
    </Box>
  );
}
