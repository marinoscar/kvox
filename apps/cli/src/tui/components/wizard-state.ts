// =============================================================================
// The wizard step stack, as a pure reducer  (issue #129, epic #118)
// =============================================================================
//
// `Route` (tui/routes.ts) is a closed union with NO history stack, on purpose:
// every screen returns to the menu and nowhere else. A multi-step wizard with
// Back therefore keeps its own step index INSIDE one route — this module is
// that index and the three moves that change it, with no React in it so the
// transitions can be tested as data (the rule tui/screens/deploy.test.ts
// states: no ink-testing-library, assert what a screen derives).
//
// Every move answers with a `WizardTransition` rather than mutating anything:
// the hook (use-wizard.ts) applies `move` to its state and turns `finish` /
// `cancel` into the callbacks the screen supplied. `stay` is the veto and the
// no-op in one shape, so a caller cannot forget to handle "nothing happened".
// =============================================================================

export interface WizardStep {
  /** Stable identifier, the target of `jump`. */
  id: string;
  /** Shown in the rail and in the "Step 2 of 9 — Database" line. */
  title: string;
}

export type WizardTransition =
  /** The index did not change: a vetoed `next`, or a `jump` to an unknown id. */
  | { kind: 'stay'; index: number }
  /** The index changed. */
  | { kind: 'move'; index: number }
  /** `next` on the last step: the wizard is complete. */
  | { kind: 'finish'; index: number }
  /** `back` on the first step: leave the wizard altogether. */
  | { kind: 'cancel'; index: number };

export type WizardAction =
  /**
   * Advance. `allowed: false` is the step's veto — its validation failed —
   * and the reducer stays put rather than carrying an invalid answer forward.
   */
  | { type: 'next'; allowed?: boolean | undefined }
  | { type: 'back' }
  | { type: 'jump'; id: string };

/**
 * Applies one action to the current index.
 *
 * `index` is clamped into `steps` first, so a step list that shrank under a
 * live wizard (a conditional step removed by an earlier answer) never leaves
 * the cursor pointing past the end.
 */
export function wizardReduce(
  index: number,
  steps: readonly WizardStep[],
  action: WizardAction,
): WizardTransition {
  const current = clampIndex(index, steps.length);

  switch (action.type) {
    case 'next': {
      if (action.allowed === false) return { kind: 'stay', index: current };
      if (current + 1 >= steps.length) return { kind: 'finish', index: current };
      return { kind: 'move', index: current + 1 };
    }
    case 'back': {
      if (current <= 0) return { kind: 'cancel', index: current };
      return { kind: 'move', index: current - 1 };
    }
    case 'jump': {
      const target = steps.findIndex((step) => step.id === action.id);
      // Unknown id: a no-op, not a throw. The ids come from the same list the
      // screen renders, so a miss is a programming error — but one that must
      // not crash a wizard the operator is halfway through.
      if (target < 0 || target === current) return { kind: 'stay', index: current };
      return { kind: 'move', index: target };
    }
  }
}

/** Whether `back` would move rather than cancel. */
export function canGoBack(index: number): boolean {
  return index > 0;
}

export function clampIndex(index: number, stepCount: number): number {
  if (stepCount <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), stepCount - 1);
}
