import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { ReactNode } from 'react';

// =============================================================================
// SelectField — one question with a fixed set of answers  (issue #129)
// =============================================================================
//
// SCREEN CONTRACT. Controlled like `TextField`: the screen owns `value`;
// highlighting a choice reports it through `onChange`, Enter reports it again
// through `onSubmit`. Keyboard handling is gated by `isActive` — the list is
// only drawn while active, and collapses to "label  chosen" otherwise, so a
// form of several selects reads as a form rather than a wall of lists.
//
// Used for yes/no (`POSTGRES_SSL`), keep/edit/skip, and the confirm choices
// `ConfirmDialog` builds on it. ink-select-input owns ↑/↓ while focused,
// which is why `Form` moves between fields with Tab and never with the arrows
// when a select is active.
// =============================================================================

export interface SelectChoice<V extends string = string> {
  value: V;
  label: string;
  /** One line shown under the list while this choice is highlighted. */
  hint?: string | undefined;
}

export interface SelectFieldProps<V extends string = string> {
  label: string;
  choices: ReadonlyArray<SelectChoice<V>>;
  value: V;
  /** The highlighted choice changed. */
  onChange: (value: V) => void;
  /** Enter on a choice. */
  onSubmit?: ((value: V) => void) | undefined;
  /** One line of help shown above the field. */
  help?: string | undefined;
  /** The list is drawn and takes keys only while true. Default true. */
  isActive?: boolean | undefined;
  /** Pad the label to this many columns, so a form's fields line up. */
  labelWidth?: number | undefined;
}

/** Index of `value` in `choices`, or 0 when it is not a choice. */
export function choiceIndex<V extends string>(choices: ReadonlyArray<SelectChoice<V>>, value: V): number {
  const index = choices.findIndex((choice) => choice.value === value);
  return index < 0 ? 0 : index;
}

export function SelectField<V extends string = string>({
  label,
  choices,
  value,
  onChange,
  onSubmit,
  help,
  isActive,
  labelWidth,
}: SelectFieldProps<V>): ReactNode {
  const active = isActive ?? true;
  const current = choices[choiceIndex(choices, value)];
  const paddedLabel = label.padEnd(labelWidth ?? label.length);

  if (!active) {
    return (
      <Box>
        <Text dimColor>{paddedLabel}</Text>
        <Text>{'  '}</Text>
        <Text>{current?.label ?? ''}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {help !== undefined && help !== '' ? <Text dimColor>{help.split('\n')[0]}</Text> : null}
      <Text bold>{paddedLabel}</Text>
      <Box marginLeft={2} flexDirection="column">
        <SelectInput
          items={choices.map((choice) => ({ key: choice.value, label: choice.label, value: choice.value }))}
          initialIndex={choiceIndex(choices, value)}
          isFocused={active}
          onHighlight={(item) => onChange(item.value)}
          onSelect={(item) => {
            onChange(item.value);
            onSubmit?.(item.value);
          }}
        />
        {current?.hint !== undefined ? <Text dimColor>{current.hint}</Text> : null}
      </Box>
    </Box>
  );
}
