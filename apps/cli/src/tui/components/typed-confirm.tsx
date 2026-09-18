import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, type ReactNode } from 'react';

import { ErrorNotice } from '../layout.js';

// =============================================================================
// TypedConfirm — "type its name to authorise this"  (issue #268)
// =============================================================================
//
// WHY THIS EXISTS, WHEN `ConfirmDialog` ALREADY DOES.
//
// `confirm-dialog.tsx` is a two-item `SelectInput`, and it is the right
// component for "are you sure?" - its whole defence is that the cancel choice
// is first and selected by default, so the destructive answer costs a
// deliberate arrow key. That is enough for aborting an install.
//
// It is NOT enough for destroying a database or emptying a bucket, and #261
// recorded exactly that: it left `uninstall` off the deploy TUI menu rather
// than let a y/N dialog stand in for a typed confirmation, because doing so
// "would quietly weaken the guarantee". The guarantee a typed name makes and a
// y/N cannot is not about the number of keystrokes - it is that THE OPERATOR
// HAS TO KNOW AND REPRODUCE WHICH RESOURCE IS BEING DESTROYED. Somebody who
// believes they are in the staging deployment types `staging` and is stopped;
// the same person presses ↓ Enter on a y/N and is not.
//
// So this is the component `runUninstall`'s `requireConfirmation` and
// `requireResourceConfirmation` already require on the CLI path, brought to
// the TUI unchanged. The screen passes what the non-interactive flag would
// have carried, and this asks for the same string.
//
// SCREEN CONTRACT, the same one every component in this directory follows.
// Pure over props; the answer leaves through `onResult('confirmed' | 'cancelled')`
// and the screen decides what to do with it. Keys are taken only while
// `isActive`, so a screen showing this over something else has exactly one
// component holding the keyboard.
//
// ESC IS NOT BOUND HERE. One key, one handler (`ConfirmDialog`'s rule): the
// screen owns Esc, and this component would otherwise fire on the same
// keystroke. What it does bind is an EMPTY SUBMIT as the cancel: pressing
// Enter on a blank field is the operator declining, not an error to correct,
// and it is the gesture somebody reaches for when they have decided against
// it and want out.
//
// THE EXPECTED NAME IS SHOWN. This is a confirmation, never a memory test -
// `requireConfirmation` prints it on the CLI path too (`--confirm ${name}`).
// Hiding it would not add safety, because the name is on the screen above in
// the inventory anyway; it would only add a way to get stuck.
//
// AND IT IS COMPARED EXACTLY, after trimming the surrounding whitespace a
// paste brings with it. No case folding: `Staging` and `staging` can be two
// real deployments, and a comparison that cannot tell them apart is not the
// guarantee this component exists to make.
// =============================================================================

export type TypedConfirmResult = 'confirmed' | 'cancelled';

export interface TypedConfirmProps {
  /** The question, in the warning colour. */
  message: string;
  /** Lines under the question — what will be destroyed, and what will not. */
  detail?: readonly string[] | undefined;
  /** The exact string that authorises this. Shown, and compared exactly. */
  expected: string;
  /** What `expected` names, for the prompt: "app", "database", "bucket". */
  noun: string;
  onResult: (result: TypedConfirmResult) => void;
  /** Keys are ignored and the cursor hidden while false. Default true. */
  isActive?: boolean | undefined;
}

/** What a submitted value authorises. The pure half of `TypedConfirm`. */
export type TypedConfirmVerdict = 'confirmed' | 'cancelled' | 'mismatch';

/**
 * Exactly three outcomes, and the middle one is why this is not a boolean.
 *
 * An EMPTY submit is the operator declining and closes the dialog. A WRONG
 * one is a mistake to correct in place, so it keeps the dialog open and shows
 * why - `text-field.tsx`'s rule that "a mistake is corrected where it was
 * made, not by starting again". Collapsing the two into `false` would make
 * one typo abandon a teardown half-way through.
 */
export function typedConfirmVerdict(typed: string, expected: string): TypedConfirmVerdict {
  const value = typed.trim();
  if (value === '') return 'cancelled';
  return value === expected ? 'confirmed' : 'mismatch';
}

/** The message shown under the field when the wrong name was typed. */
export function typedConfirmMismatch(typed: string, expected: string, noun: string): string {
  return (
    `"${typed.trim()}" is not ${expected}. Type the ${noun}'s own name exactly, ` +
    'or press Enter on an empty field to stop.'
  );
}

export function TypedConfirm({
  message,
  detail,
  expected,
  noun,
  onResult,
  isActive,
}: TypedConfirmProps): ReactNode {
  const active = isActive ?? true;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color="yellow">
          {message}
        </Text>
        {detail === undefined
          ? null
          : detail.map((line, index) => (
              <Text key={`${index}:${line}`} dimColor>
                {line}
              </Text>
            ))}
      </Box>

      <Box flexDirection="column">
        <Box>
          <Text bold={active} dimColor={!active}>{`Type ${expected} to confirm:`}</Text>
          <Text>{'  '}</Text>
          <TextInput
            value={value}
            onChange={(next) => {
              setValue(next);
              // Cleared as soon as they start fixing it: an error still on
              // screen while the value under it has changed is stale advice.
              if (error !== undefined) setError(undefined);
            }}
            focus={active}
            showCursor={active}
            placeholder={expected}
            onSubmit={(submitted) => {
              const verdict = typedConfirmVerdict(submitted, expected);
              if (verdict === 'mismatch') {
                setError(typedConfirmMismatch(submitted, expected, noun));
                return;
              }
              onResult(verdict);
            }}
          />
        </Box>
        {active && error !== undefined ? (
          <Box marginLeft={2}>
            <ErrorNotice message={error} />
          </Box>
        ) : null}
      </Box>

      <Text dimColor>Enter on an empty field stops without destroying anything.</Text>
    </Box>
  );
}
