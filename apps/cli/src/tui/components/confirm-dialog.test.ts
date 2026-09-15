import { describe, expect, it } from 'vitest';

import { CONFIRM_DEFAULT_INDEX, confirmChoices, DEFAULT_CANCEL_LABEL } from './confirm-dialog.js';

// The default selection as data (tui/screens/deploy.test.ts's rule).

describe('confirmChoices', () => {
  it('puts the cancel choice first, and the default index points at it', () => {
    const choices = confirmChoices('Yes, abort the install');
    const selected = choices[CONFIRM_DEFAULT_INDEX];

    // A destructive prompt whose default is yes is one stray Enter from
    // happening by accident (tui/screens/deploy.tsx's confirm).
    expect(selected?.value).toBe(false);
    expect(selected?.key).toBe('no');
    expect(selected?.label).toBe(DEFAULT_CANCEL_LABEL);
  });

  it('carries the confirm label on the affirmative choice', () => {
    const choices = confirmChoices('Yes, abort the install');

    expect(choices[1]).toEqual({ key: 'yes', label: 'Yes, abort the install', value: true });
  });

  it('lets the screen reword the cancel choice without moving it', () => {
    const choices = confirmChoices('Yes', 'Keep going');

    expect(choices[CONFIRM_DEFAULT_INDEX]).toEqual({ key: 'no', label: 'Keep going', value: false });
  });

  it('offers exactly two choices', () => {
    expect(confirmChoices('Yes')).toHaveLength(2);
  });
});
