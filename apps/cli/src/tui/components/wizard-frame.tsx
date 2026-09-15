import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { Frame, NARROW_COLUMNS, TINY_COLUMNS, useTerminalSize } from '../layout.js';
import { contentWidth } from './content-width.js';
import { clampIndex, type WizardStep } from './wizard-state.js';

// =============================================================================
// WizardFrame — a Frame with a step rail  (issue #129, epic #118)
// =============================================================================
//
// SCREEN CONTRACT. Pure over props and stateless: the screen owns the step
// index (through `useWizard`) and passes it as `current`; this component only
// draws where the operator is. `hints` are the keys the CURRENT step's child
// answers to — the screen declares them per step, because a form step and a
// running step do not take the same keys and a hint line that lies is worse
// than none (see `KeyHints`).
//
// THE DEGRADE follows `Frame`'s three tiers exactly:
//
//   full   (>= NARROW_COLUMNS)  "1 Domain › 2 Database › 3 Review" rail,
//                               falling back to the narrow line when the rail
//                               would not fit the content width
//   narrow (>= TINY_COLUMNS)    "Step 2 of 9 — Database"
//   tiny   (<  TINY_COLUMNS)    the current step's content only, no rail
// =============================================================================

export interface WizardFrameProps {
  /** The wizard's name, shown in the Frame header. */
  title: string;
  steps: readonly WizardStep[];
  /** Index into `steps`; clamped. */
  current: number;
  /** Key hints for the current step's child. */
  hints?: string[] | undefined;
  children: ReactNode;
}

export type StepRail =
  | {
      mode: 'rail';
      segments: Array<{ index: number; title: string; state: 'done' | 'current' | 'todo' }>;
    }
  | { mode: 'line'; text: string }
  | { mode: 'none' };

/** Joins rail segments; also the string measured against the content width. */
export const RAIL_SEPARATOR = ' › ';

/**
 * Which rail to draw at this width — the pure half of `WizardFrame`.
 *
 * The rail is measured as the plain text ink would print (`"1 Domain › 2
 * Database"`), so a wizard with nine steps on a 60-column terminal gets the
 * one-line form rather than a rail wrapped across three rows.
 */
export function stepRail(steps: readonly WizardStep[], current: number, columns: number): StepRail {
  if (steps.length === 0 || columns < TINY_COLUMNS) return { mode: 'none' };

  const index = clampIndex(current, steps.length);
  const step = steps[index];
  const line = `Step ${index + 1} of ${steps.length} — ${step?.title ?? ''}`;

  if (columns < NARROW_COLUMNS) return { mode: 'line', text: line };

  const segments = steps.map((entry, position) => ({
    index: position,
    title: `${position + 1} ${entry.title}`,
    state: position < index ? ('done' as const) : position === index ? ('current' as const) : ('todo' as const),
  }));

  const railText = segments.map((segment) => segment.title).join(RAIL_SEPARATOR);
  if (railText.length > contentWidth(columns)) return { mode: 'line', text: line };

  return { mode: 'rail', segments };
}

export function WizardFrame({ title, steps, current, hints, children }: WizardFrameProps): ReactNode {
  const { columns } = useTerminalSize();
  const rail = stepRail(steps, current, columns);

  return (
    <Frame title={title} {...(hints === undefined ? {} : { hints })}>
      {rail.mode === 'none' ? null : (
        <Box marginBottom={1}>
          {rail.mode === 'line' ? (
            <Text dimColor>{rail.text}</Text>
          ) : (
            rail.segments.map((segment, position) => (
              <Text key={segment.index}>
                {position === 0 ? null : <Text dimColor>{RAIL_SEPARATOR}</Text>}
                {segment.state === 'current' ? (
                  <Text bold color="cyan">
                    {segment.title}
                  </Text>
                ) : segment.state === 'done' ? (
                  <Text color="green">{segment.title}</Text>
                ) : (
                  <Text dimColor>{segment.title}</Text>
                )}
              </Text>
            ))
          )}
        </Box>
      )}
      <Box flexDirection="column">{children}</Box>
    </Frame>
  );
}
