import { RateLimitError as QueueRateLimitError } from '../jobs/rate-limit.error';
import {
  AiAuthError,
  AiBudgetError,
  AiInputError,
  AiRefusedError,
  RateLimitError,
  isTerminalAiError,
} from './ai-errors';

// =============================================================================
// AI error taxonomy (issue #47, epic #45)
// =============================================================================
//
// Three properties, each of which has a specific, expensive failure mode if it
// silently stops holding:
//
//   1. `instanceof` WORKS. Extending a built-in breaks it under a downlevelled
//      target, and the symptom is the worst one available: every domain failure
//      is classified as an ordinary bug, charged an attempt, and reported to the
//      user with the wrong sentence. Every class restores its prototype
//      explicitly; these tests are what notice if one stops.
//
//   2. `RateLimitError` IS THE QUEUE'S OWN CLASS, re-exported and not
//      redefined. The deferral path keys off `err instanceof RateLimitError`
//      imported from `jobs/rate-limit.error`; a second class with the same name
//      here would satisfy no such check, and a provider throttle would fail
//      permanently on a condition that was never the job's fault.
//
//   3. `isTerminalAiError` IS TOTAL AND DEFAULTS TO "RETRYABLE". It is called
//      from a failure path on a value that is `unknown` by construction, and
//      the cost of a false positive (a job abandoned on a network blip) is far
//      worse than a false negative (one wasted attempt).
// =============================================================================

describe('AI error taxonomy', () => {
  describe('instanceof survives the class hierarchy', () => {
    it.each([
      ['AiAuthError', new AiAuthError('refused', 'openai'), AiAuthError],
      ['AiInputError', new AiInputError('bad request', 'detail', 'openai'), AiInputError],
      ['AiRefusedError', new AiRefusedError('declined', 'detail', 'openai'), AiRefusedError],
      ['AiBudgetError', new AiBudgetError('too long', 14200, 11500, 'openai'), AiBudgetError],
    ])('%s is an Error and an instance of itself', (name, err, ctor) => {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ctor as never);
      expect(err.name).toBe(name);
    });

    it('keeps the four classes distinguishable from one another', () => {
      // `AiInputError` and `AiRefusedError` are both terminal, so the ONLY
      // thing the split buys is the sentence a user is shown. If they ever
      // collapsed into one class, that distinction would vanish silently.
      expect(new AiInputError('x')).not.toBeInstanceOf(AiRefusedError);
      expect(new AiRefusedError('x')).not.toBeInstanceOf(AiInputError);
      expect(new AiAuthError('x')).not.toBeInstanceOf(AiBudgetError);
    });
  });

  describe('RateLimitError', () => {
    it('IS the queue\'s class, not a second definition of the same name', () => {
      const err = new RateLimitError('throttled', 30_000);

      // ⚠ The assertion that matters. `JobTerminalService` checks against the
      // class imported from `jobs/rate-limit.error`; a look-alike declared here
      // would pass every test written about THIS module and fail the one check
      // that decides whether the job is deferred or failed.
      expect(err).toBeInstanceOf(QueueRateLimitError);
      expect(RateLimitError).toBe(QueueRateLimitError);
      expect(err.retryAfterMs).toBe(30_000);
    });

    it('is NOT terminal — it is a deferral, not a failure', () => {
      expect(isTerminalAiError(new RateLimitError('throttled'))).toBe(false);
    });
  });

  describe('AiBudgetError carries the numbers', () => {
    it('records what was required and what was available', () => {
      const err = new AiBudgetError('too long', 14_200, 11_500, 'openai');

      // docs/specs/notes.md §3.3 forbids silent truncation and requires the
      // refusal to name a figure the user can act on. An error that could only
      // say "too large" would satisfy the type and defeat the requirement,
      // which is why these are constructor arguments rather than optional
      // extras.
      expect(err.requiredTokens).toBe(14_200);
      expect(err.availableTokens).toBe(11_500);
    });
  });

  describe('isTerminalAiError', () => {
    it('recognises all four domain classes', () => {
      expect(isTerminalAiError(new AiAuthError('x'))).toBe(true);
      expect(isTerminalAiError(new AiInputError('x'))).toBe(true);
      expect(isTerminalAiError(new AiRefusedError('x'))).toBe(true);
      expect(isTerminalAiError(new AiBudgetError('x', 1, 0))).toBe(true);
    });

    it('recognises a domain error that crossed a process boundary', () => {
      // A worker node cannot throw a typed error over HTTP, so it reports the
      // conclusion as a flag. A prototype is not checkable there; a boolean on
      // the payload is.
      expect(isTerminalAiError({ isDomainError: true, message: 'refused' })).toBe(true);
    });

    it('defaults to RETRYABLE for everything it does not recognise, and never throws', () => {
      for (const value of [
        new Error('socket hang up'),
        new TypeError('undefined is not a function'),
        'a string',
        null,
        undefined,
        42,
        {},
        { isDomainError: 'yes' }, // truthy but not `true` — not a marker
      ]) {
        expect(isTerminalAiError(value)).toBe(false);
      }
    });
  });

  describe('messages carry no key material', () => {
    it('records only the provider id and the provider\'s own words', () => {
      const err = new AiInputError(
        'The AI provider rejected the request (HTTP 400).',
        'Unknown parameter: foo',
        'openai',
      );

      // These messages reach `Job.lastError`, the application log and an API
      // response, and the key in this epic is an individual user's.
      expect(err.providerId).toBe('openai');
      expect(err.providerMessage).toBe('Unknown parameter: foo');
      expect(JSON.stringify({ ...err, msg: err.message })).not.toMatch(/sk-/);
    });
  });
});
