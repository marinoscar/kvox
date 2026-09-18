import { describe, expect, it } from 'vitest';

import { typedConfirmMismatch, typedConfirmVerdict } from './typed-confirm.js';

// =============================================================================
// TypedConfirm, as data  (issue #268)
// =============================================================================
//
// `ink-testing-library` is not a dependency (tui/screens/*.test.ts's rule), so
// the verdict is asserted as the pure function the component draws from - the
// same shape `confirm-dialog.test.ts` takes with `confirmChoices`.
//
// THE PROPERTY WORTH PROTECTING is the one #261 named when it refused to put
// `uninstall` on the deploy menu: a y/N dialog standing in for a typed
// resource name weakens the guarantee while looking like it satisfies it. Each
// test below is one way that could be reintroduced by an "improvement".
// =============================================================================

describe('typedConfirmVerdict', () => {
  it('confirms only an exact match', () => {
    expect(typedConfirmVerdict('appdb', 'appdb')).toBe('confirmed');
  });

  it('trims the whitespace a paste brings, and nothing else', () => {
    expect(typedConfirmVerdict('  appdb \n', 'appdb')).toBe('confirmed');
  });

  it('does NOT fold case: Staging and staging can be two real deployments', () => {
    // A comparison that cannot tell them apart is not the guarantee this
    // component exists to make.
    expect(typedConfirmVerdict('STAGING', 'staging')).toBe('mismatch');
    expect(typedConfirmVerdict('Staging', 'staging')).toBe('mismatch');
  });

  it('refuses a prefix, a suffix and a superstring', () => {
    expect(typedConfirmVerdict('app', 'appdb')).toBe('mismatch');
    expect(typedConfirmVerdict('appdb2', 'appdb')).toBe('mismatch');
    expect(typedConfirmVerdict('myappdb', 'appdb')).toBe('mismatch');
  });

  it('refuses another resource’s name, which is the whole point', () => {
    // The bucket's name typed at the database's prompt. This is #268's rule 1
    // at the component: a word typed for one resource can never authorise
    // another, and the component cannot even see the other one.
    expect(typedConfirmVerdict('demo-bucket', 'appdb')).toBe('mismatch');
    expect(typedConfirmVerdict('appdb', 'demo-bucket')).toBe('mismatch');
  });

  it('refuses the affirmative words a y/N dialog would have accepted', () => {
    for (const word of ['y', 'Y', 'yes', 'YES', 'ok', 'true']) {
      expect(typedConfirmVerdict(word, 'appdb'), word).toBe('mismatch');
    }
  });

  it('treats an empty submit as CANCELLED, never as confirmation', () => {
    // Enter on a blank field is the operator declining and wanting out - the
    // gesture somebody reaches for once they have changed their mind.
    expect(typedConfirmVerdict('', 'appdb')).toBe('cancelled');
    expect(typedConfirmVerdict('   ', 'appdb')).toBe('cancelled');
  });

  it('never confirms against an empty expected value', () => {
    // A resource whose real name could not be read must not be confirmable by
    // pressing Enter - which is exactly what an `expected` of '' would allow
    // if the empty case were checked second.
    expect(typedConfirmVerdict('', '')).toBe('cancelled');
    expect(typedConfirmVerdict('anything', '')).toBe('mismatch');
  });

  it('keeps mismatch as a THIRD outcome, so one typo does not abandon the run', () => {
    // Collapsing mismatch into cancelled would send an operator who mistyped
    // one character back to the start of a teardown.
    const outcomes = new Set([
      typedConfirmVerdict('appdb', 'appdb'),
      typedConfirmVerdict('', 'appdb'),
      typedConfirmVerdict('appdbb', 'appdb'),
    ]);
    expect(outcomes).toEqual(new Set(['confirmed', 'cancelled', 'mismatch']));
  });
});

describe('typedConfirmMismatch', () => {
  it('names what was typed, what was expected, and the way out', () => {
    const message = typedConfirmMismatch('  appdbb ', 'appdb', 'database');

    expect(message).toContain('"appdbb"');
    expect(message).toContain('is not appdb');
    expect(message).toContain("database's own name");
    // The escape hatch, stated rather than left to be discovered.
    expect(message).toContain('Enter on an empty field');
  });
});
