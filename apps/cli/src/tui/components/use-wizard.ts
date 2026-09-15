import { useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';

import {
  canGoBack,
  clampIndex,
  wizardReduce,
  type WizardStep,
  type WizardTransition,
} from './wizard-state.js';

// =============================================================================
// useWizard — the step stack a wizard screen keeps inside one route
// =============================================================================
//
// SCREEN CONTRACT. A screen (tui/screens/*.tsx) owns the route: it receives
// `onDone` from app.tsx, owns the AbortController for any work it starts, and
// aborts it on unmount. This hook owns exactly one thing on the screen's
// behalf — which step is showing — and reports the two ways of leaving the
// wizard as callbacks: `onFinish` after `next()` on the last step, `onCancel`
// after `back()` (or Esc) on the first. The screen wires `onCancel` to
// `onDone`; it does not add routes (routes.ts is closed).
//
// Esc is handled HERE, gated by `isActive` exactly as ScrollBox gates its
// arrow keys, so a screen that shows a ConfirmDialog over the wizard passes
// `isActive: false` and the dialog gets the keyboard instead of the wizard
// stepping backwards underneath it.
// =============================================================================

export interface UseWizardOptions {
  /** `next()` on the last step. */
  onFinish: () => void;
  /** `back()` or Esc on the first step. */
  onCancel: () => void;
  /**
   * The step's veto. Called before leaving `step` forward; return `false` to
   * stay (validation failed, a live check has not passed yet). Not consulted
   * by `back()` — going backwards never needs the current answer to be valid.
   */
  canLeave?: ((step: WizardStep) => boolean) | undefined;
  /** Esc is ignored while false. Default true. */
  isActive?: boolean | undefined;
}

export interface WizardControls {
  index: number;
  step: WizardStep;
  /** Advance; `false` when the step vetoed it. */
  next: () => boolean;
  /** One step back, or `onCancel` from the first. */
  back: () => void;
  /** Move to a step by id; `false` (and no move) for an unknown id. */
  jump: (id: string) => boolean;
  /** Whether `back()` would move rather than cancel. */
  canBack: boolean;
  isLast: boolean;
}

export function useWizard(
  steps: readonly WizardStep[],
  options: UseWizardOptions,
): WizardControls {
  const [rawIndex, setIndex] = useState(0);
  const index = clampIndex(rawIndex, steps.length);

  // The handlers read the CURRENT index through a ref rather than closing
  // over `index`, so two moves in one tick (a check that passes and calls
  // `next()` from a resolved promise while a keypress is being handled) do
  // not both compute from the same stale value.
  const indexRef = useRef(index);
  indexRef.current = index;

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const apply = useCallback((transition: WizardTransition): void => {
    switch (transition.kind) {
      case 'move':
        indexRef.current = transition.index;
        setIndex(transition.index);
        return;
      case 'finish':
        optionsRef.current.onFinish();
        return;
      case 'cancel':
        optionsRef.current.onCancel();
        return;
      case 'stay':
        return;
    }
  }, []);

  const next = useCallback((): boolean => {
    const current = stepsRef.current[indexRef.current];
    const allowed = current === undefined ? true : (optionsRef.current.canLeave?.(current) ?? true);
    const transition = wizardReduce(indexRef.current, stepsRef.current, { type: 'next', allowed });
    apply(transition);
    return transition.kind !== 'stay';
  }, [apply]);

  const back = useCallback((): void => {
    apply(wizardReduce(indexRef.current, stepsRef.current, { type: 'back' }));
  }, [apply]);

  const jump = useCallback(
    (id: string): boolean => {
      const transition = wizardReduce(indexRef.current, stepsRef.current, { type: 'jump', id });
      apply(transition);
      return transition.kind === 'move';
    },
    [apply],
  );

  useInput(
    (_input, key) => {
      if (key.escape) back();
    },
    { isActive: options.isActive ?? true },
  );

  const step = steps[index] ?? { id: '', title: '' };

  return {
    index,
    step,
    next,
    back,
    jump,
    canBack: canGoBack(index),
    isLast: index >= steps.length - 1,
  };
}
