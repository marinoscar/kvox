import { describe, expect, it } from 'vitest';

import {
  firstInvalidField,
  focusIndexFor,
  formLabelWidth,
  formValue,
  type FormFieldSpec,
} from './form.js';
import { choiceIndex } from './select-field.js';

// The Form's focus and submit decisions, asserted as the data they derive
// from (tui/screens/deploy.test.ts's rule: no ink-testing-library).

const FIELDS: FormFieldSpec[] = [
  { kind: 'text', key: 'POSTGRES_HOST', label: 'Host', validate: (v) => (v === '' ? 'is required' : undefined) },
  { kind: 'text', key: 'POSTGRES_PORT', label: 'Port', validate: (v) => (/^\d+$/.test(v) ? undefined : 'must be a number') },
  {
    kind: 'select',
    key: 'POSTGRES_SSL',
    label: 'SSL',
    choices: [
      { value: 'false', label: 'No' },
      { value: 'true', label: 'Yes' },
    ],
  },
];

describe('firstInvalidField', () => {
  it('is -1 when every text field is valid', () => {
    expect(firstInvalidField(FIELDS, { POSTGRES_HOST: 'db', POSTGRES_PORT: '5432' })).toBe(-1);
  });

  it('names the first invalid field so focus lands there on submit', () => {
    expect(firstInvalidField(FIELDS, { POSTGRES_HOST: 'db', POSTGRES_PORT: 'x' })).toBe(1);
    expect(firstInvalidField(FIELDS, { POSTGRES_PORT: 'x' })).toBe(0);
  });

  it('treats a missing answer as the empty string', () => {
    expect(firstInvalidField(FIELDS, {})).toBe(0);
  });

  it('never blames a select: a choice list cannot hold an invalid value', () => {
    expect(firstInvalidField([FIELDS[2] as FormFieldSpec], {})).toBe(-1);
  });
});

describe('formValue', () => {
  it('returns the answer when there is one', () => {
    expect(formValue(FIELDS[0] as FormFieldSpec, { POSTGRES_HOST: 'db' })).toBe('db');
  });

  it('defaults a text field to empty and a select to its first choice', () => {
    expect(formValue(FIELDS[0] as FormFieldSpec, {})).toBe('');
    expect(formValue(FIELDS[2] as FormFieldSpec, {})).toBe('false');
  });
});

describe('formLabelWidth', () => {
  it('is the widest label, so every field pads to the same column', () => {
    expect(formLabelWidth(FIELDS)).toBe(4);
    expect(formLabelWidth([])).toBe(0);
  });
});

describe('choiceIndex', () => {
  const choices = [
    { value: 'keep', label: 'Keep' },
    { value: 'edit', label: 'Edit' },
  ];

  it('finds the current value', () => {
    expect(choiceIndex(choices, 'edit')).toBe(1);
  });

  it('falls back to the first choice for a value that is not a choice', () => {
    expect(choiceIndex(choices, 'skip')).toBe(0);
  });
});

describe('focusIndexFor', () => {
  it('finds the field a screen names, so a failed check lands on it', () => {
    expect(focusIndexFor(FIELDS, 'POSTGRES_PORT')).toBe(1);
  });

  it('is -1 when nothing is named, which moves no focus at all', () => {
    expect(focusIndexFor(FIELDS, undefined)).toBe(-1);
  });

  it('is -1 for a field this step does not have, rather than blaming field 0', () => {
    // The step's own fallback decides where to go; silently focusing the first
    // field would put the cursor on an answer that was accepted.
    expect(focusIndexFor(FIELDS, 'JWT_SECRET')).toBe(-1);
  });
});
