import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { ReactNode } from 'react';

// =============================================================================
// ConfirmDialog — "are you sure?"  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. Pure over props; the answer comes back through
// `onResult(true | false)` and the screen decides what to do with it — start
// the run, abort the controller it owns, or show the wizard again. The list
// takes keys only while `isActive`; the screen that shows this over a wizard
// passes `isActive: false` to `useWizard` for the duration, so Esc is not
// also stepping the wizard back underneath. Esc is NOT bound here for that
// reason: one key, one handler.
//
// "NO, GO BACK" IS FIRST AND SELECTED BY DEFAULT — the rule the deploy
// screen's confirm established (tui/screens/deploy.tsx, "confirming"): the
// action being confirmed mutates a server, and a destructive prompt whose
// default is yes is one stray Enter away from happening by accident.
//
// `danger` renders the message in the warning colour, for the abort prompt
// docs/specs/vps-deploy.md §14 requires ("this may leave a partial
// deployment; re-running install will resume safely").
// =============================================================================

export interface ConfirmDialogProps {
  /** The question. */
  message: string;
  /** Lines under the question — what will happen, what will not. */
  detail?: readonly string[] | undefined;
  /** Render `message` in the warning colour. */
  danger?: boolean | undefined;
  /** The affirmative choice's label, e.g. "Yes, abort the install". */
  confirmLabel: string;
  /** The default choice's label. Default "No, go back". */
  cancelLabel?: string | undefined;
  onResult: (confirmed: boolean) => void;
  /** The list takes keys only while true. Default true. */
  isActive?: boolean | undefined;
}

export interface ConfirmChoice {
  key: 'no' | 'yes';
  label: string;
  value: boolean;
}

export const DEFAULT_CANCEL_LABEL = 'No, go back';

/** Index of the choice highlighted when the dialog opens: the cancel choice. */
export const CONFIRM_DEFAULT_INDEX = 0;

/** The two choices, cancel first — the pure half of `ConfirmDialog`. */
export function confirmChoices(confirmLabel: string, cancelLabel?: string): ConfirmChoice[] {
  return [
    { key: 'no', label: cancelLabel ?? DEFAULT_CANCEL_LABEL, value: false },
    { key: 'yes', label: confirmLabel, value: true },
  ];
}

export function ConfirmDialog({
  message,
  detail,
  danger,
  confirmLabel,
  cancelLabel,
  onResult,
  isActive,
}: ConfirmDialogProps): ReactNode {
  const items = confirmChoices(confirmLabel, cancelLabel);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        {danger === true ? (
          <Text bold color="yellow">
            {message}
          </Text>
        ) : (
          <Text bold>{message}</Text>
        )}
        {detail === undefined
          ? null
          : detail.map((line, index) => (
              <Text key={`${index}:${line}`} dimColor>
                {line}
              </Text>
            ))}
      </Box>
      <SelectInput
        items={items}
        initialIndex={CONFIRM_DEFAULT_INDEX}
        isFocused={isActive ?? true}
        onSelect={(item) => onResult(item.value)}
      />
    </Box>
  );
}
