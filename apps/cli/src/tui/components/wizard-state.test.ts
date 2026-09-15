import { describe, expect, it } from 'vitest';

import { canGoBack, clampIndex, wizardReduce, type WizardStep } from './wizard-state.js';

// The hook (use-wizard.ts) needs ink's render context; the reducer under it
// does not, and it is the reducer that decides every move — so, per the rule
// in tui/screens/deploy.test.ts, the transitions are asserted as data.

const STEPS: WizardStep[] = [
  { id: 'domain', title: 'Domain' },
  { id: 'database', title: 'Database' },
  { id: 'review', title: 'Review' },
];

describe('wizardReduce', () => {
  it('next advances by one', () => {
    expect(wizardReduce(0, STEPS, { type: 'next' })).toEqual({ kind: 'move', index: 1 });
  });

  it('next stays when the step vetoes it', () => {
    // Validation failed: the cursor must not carry an invalid answer forward.
    expect(wizardReduce(1, STEPS, { type: 'next', allowed: false })).toEqual({ kind: 'stay', index: 1 });
  });

  it('next on the last step finishes rather than moving past the end', () => {
    expect(wizardReduce(2, STEPS, { type: 'next' })).toEqual({ kind: 'finish', index: 2 });
  });

  it('a vetoed next on the last step does not finish', () => {
    expect(wizardReduce(2, STEPS, { type: 'next', allowed: false })).toEqual({ kind: 'stay', index: 2 });
  });

  it('back moves one step earlier', () => {
    expect(wizardReduce(2, STEPS, { type: 'back' })).toEqual({ kind: 'move', index: 1 });
  });

  it('back at step 0 cancels', () => {
    expect(wizardReduce(0, STEPS, { type: 'back' })).toEqual({ kind: 'cancel', index: 0 });
  });

  it('jump moves to the step with that id', () => {
    expect(wizardReduce(0, STEPS, { type: 'jump', id: 'review' })).toEqual({ kind: 'move', index: 2 });
  });

  it('jump to an unknown id is a no-op', () => {
    expect(wizardReduce(1, STEPS, { type: 'jump', id: 'nope' })).toEqual({ kind: 'stay', index: 1 });
  });

  it('jump to the current step is a no-op', () => {
    expect(wizardReduce(1, STEPS, { type: 'jump', id: 'database' })).toEqual({ kind: 'stay', index: 1 });
  });

  it('clamps an index left past the end by a shrunken step list', () => {
    // A conditional step removed by an earlier answer must not leave the
    // cursor pointing at nothing.
    expect(wizardReduce(5, STEPS, { type: 'back' })).toEqual({ kind: 'move', index: 1 });
    expect(wizardReduce(5, STEPS, { type: 'next' })).toEqual({ kind: 'finish', index: 2 });
  });

  it('an empty step list finishes immediately and cancels on back', () => {
    expect(wizardReduce(0, [], { type: 'next' })).toEqual({ kind: 'finish', index: 0 });
    expect(wizardReduce(0, [], { type: 'back' })).toEqual({ kind: 'cancel', index: 0 });
  });
});

describe('canGoBack', () => {
  it('is false only on the first step', () => {
    expect(canGoBack(0)).toBe(false);
    expect(canGoBack(1)).toBe(true);
  });
});

describe('clampIndex', () => {
  it('keeps the index inside the list', () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(4, 0)).toBe(0);
  });
});
