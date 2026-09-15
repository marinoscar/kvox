import { describe, expect, it } from 'vitest';

import { acceptSuggestion, fieldState, SECRET_MASK, type TextFieldSpec } from './field-state.js';

// TextField's validator/suggestion/masking logic, extracted so it is tested
// as data (tui/screens/deploy.test.ts's rule: no ink-testing-library).

const HOSTNAME: TextFieldSpec = {
  label: 'Domain',
  validate: (value) => (/^[a-z0-9.-]+$/i.test(value) ? undefined : 'must be a hostname'),
};

describe('fieldState', () => {
  it('reports the validator error text and marks the value invalid', () => {
    const state = fieldState('not a host', HOSTNAME);

    expect(state.error).toBe('must be a hostname');
    expect(state.valid).toBe(false);
  });

  it('is valid when the validator accepts', () => {
    const state = fieldState('app.example.com', HOSTNAME);

    expect(state.error).toBeUndefined();
    expect(state.valid).toBe(true);
  });

  it('is valid with no validator at all', () => {
    expect(fieldState('anything', { label: 'Free' }).valid).toBe(true);
  });

  it('offers the suggestion while the field is empty, and Tab accepts it', () => {
    const spec: TextFieldSpec = {
      label: 'Port',
      suggestion: { value: '3535', reason: 'first free loopback port' },
    };

    const empty = fieldState('', spec);
    expect(empty.suggestion).toEqual({ value: '3535', reason: 'first free loopback port' });
    expect(empty.suggestionDisplay).toBe('3535');
    expect(empty.tabAccepts).toBe(true);
    expect(acceptSuggestion('', spec)).toBe('3535');
  });

  it('withdraws the suggestion once anything is typed, so Tab moves focus instead', () => {
    const spec: TextFieldSpec = { label: 'Port', suggestion: { value: '3535', reason: 'free' } };

    const typed = fieldState('36', spec);
    expect(typed.suggestion).toBeUndefined();
    expect(typed.tabAccepts).toBe(false);
    // Never replaces what the operator typed.
    expect(acceptSuggestion('36', spec)).toBe('36');
  });

  it('never offers a suggestion the spec does not carry', () => {
    const state = fieldState('', HOSTNAME);

    expect(state.suggestion).toBeUndefined();
    expect(state.tabAccepts).toBe(false);
    expect(acceptSuggestion('', HOSTNAME)).toBe('');
  });

  it('masks a secret one character per typed character', () => {
    const state = fieldState('hunter2', { label: 'Password', secret: true });

    expect(state.display).toBe(SECRET_MASK.repeat(7));
    expect(state.display).toHaveLength(7);
    expect(state.display).not.toContain('hunter');
  });

  it('shows a non-secret value as typed', () => {
    expect(fieldState('hunter2', { label: 'User' }).display).toBe('hunter2');
  });

  it('masks a secret suggestion too, so a generated key is not printed', () => {
    const state = fieldState('', {
      label: 'JWT_SECRET',
      secret: true,
      suggestion: { value: 'abcdefgh', reason: 'generated' },
    });

    expect(state.suggestionDisplay).toBe(SECRET_MASK.repeat(8));
    expect(state.suggestionDisplay).not.toContain('abcdefgh');
    // Accepting still fills in the real value.
    expect(acceptSuggestion('', { label: 'x', secret: true, suggestion: { value: 'abcdefgh', reason: 'g' } })).toBe(
      'abcdefgh',
    );
  });
});
