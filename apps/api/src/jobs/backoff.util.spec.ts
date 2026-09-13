// =============================================================================
// Unit tests for the equal-jitter backoff (issue #261, epic #254)
// =============================================================================
//
// EVERY CASE PINS THE RNG. A range assertion on a jittered delay
// (`>= 1000 && <= 2000`) passes for a correct implementation and for one that
// ignores `attempt` entirely — which is the bug most worth catching — so the
// injectable `rand` is used to turn each case into a single expected number.
// The two extremes (`() => 0` and `() => 1`) also happen to prove the jitter
// WINDOW itself: half the exponential term to all of it.
// =============================================================================

import { computeBackoffMs } from './backoff.util';

/** The retry pair's shipped constants. */
const RETRY = { baseMs: 2_000, maxMs: 60_000 };

/** The rate-limit pair's shipped constants. */
const RATE_LIMIT = { baseMs: 30_000, maxMs: 900_000 };

describe('computeBackoffMs', () => {
  describe('the exponential term', () => {
    it('doubles per attempt, with the RNG at its floor', () => {
      // rand() === 0 → exactly half the exponential term.
      const floor = (attempt: number) => computeBackoffMs({ ...RETRY, attempt, rand: () => 0 });

      expect(floor(1)).toBe(1_000); // exp 2_000
      expect(floor(2)).toBe(2_000); // exp 4_000
      expect(floor(3)).toBe(4_000); // exp 8_000
      expect(floor(4)).toBe(8_000); // exp 16_000
    });

    it('reaches the full exponential term with the RNG at its ceiling', () => {
      const ceiling = (attempt: number) =>
        computeBackoffMs({ ...RETRY, attempt, rand: () => 0.999_999_9 });

      expect(ceiling(1)).toBe(2_000);
      expect(ceiling(2)).toBe(4_000);
      expect(ceiling(3)).toBe(8_000);
    });

    it('caps at maxMs however large the attempt gets', () => {
      // exp would be 2_000 * 2^9 = 1_024_000, far past the 60s ceiling.
      expect(computeBackoffMs({ ...RETRY, attempt: 10, rand: () => 0 })).toBe(30_000);
      expect(computeBackoffMs({ ...RETRY, attempt: 10, rand: () => 1 })).toBe(60_000);
      expect(computeBackoffMs({ ...RETRY, attempt: 99, rand: () => 1 })).toBe(60_000);
    });

    it('uses whatever constants it is handed — the rate-limit pair is the same function', () => {
      expect(computeBackoffMs({ ...RATE_LIMIT, attempt: 1, rand: () => 0 })).toBe(15_000);
      expect(computeBackoffMs({ ...RATE_LIMIT, attempt: 2, rand: () => 0 })).toBe(30_000);
      // 30_000 * 2^5 = 960_000, past the 900_000 ceiling.
      expect(computeBackoffMs({ ...RATE_LIMIT, attempt: 6, rand: () => 1 })).toBe(900_000);
    });
  });

  describe('jitter', () => {
    it('lands strictly inside [exp/2, exp] for the default RNG', () => {
      // The ONE property worth asserting as a range: that the default RNG is
      // wired at all, and that the window is the equal-jitter one.
      for (let i = 0; i < 200; i += 1) {
        const delay = computeBackoffMs({ ...RETRY, attempt: 3 });

        expect(delay).toBeGreaterThanOrEqual(4_000);
        expect(delay).toBeLessThanOrEqual(8_000);
      }
    });

    it('produces different delays for identical inputs — the herd breaks up', () => {
      // The whole reason jitter exists: every job deferred by one provider
      // outage must NOT retry in the same millisecond.
      const delays = new Set(
        Array.from({ length: 50 }, () => computeBackoffMs({ ...RETRY, attempt: 5 }))
      );

      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe('retryAfterMs', () => {
    it('is a floor: a longer provider request wins over our backoff', () => {
      expect(
        computeBackoffMs({ ...RETRY, attempt: 1, retryAfterMs: 120_000, rand: () => 1 })
      ).toBe(120_000);
    });

    it('is a floor, not an override: a shorter provider request does not shorten us', () => {
      // Attempt 6 is at the 60s ceiling; a provider saying "1s" must not
      // undo six consecutive failures' worth of backoff.
      expect(computeBackoffMs({ ...RETRY, attempt: 6, retryAfterMs: 1_000, rand: () => 1 })).toBe(
        60_000
      );
    });

    it('is ignored when null or undefined', () => {
      expect(computeBackoffMs({ ...RETRY, attempt: 1, retryAfterMs: null, rand: () => 0 })).toBe(
        1_000
      );
      expect(
        computeBackoffMs({ ...RETRY, attempt: 1, retryAfterMs: undefined, rand: () => 0 })
      ).toBe(1_000);
    });
  });

  describe('defensive input handling', () => {
    it('clamps an attempt below 1 rather than producing a sub-base delay', () => {
      // A caller reading a stale/un-charged row must not get a delay SHORTER
      // than the base — `2^-1` would halve it.
      expect(computeBackoffMs({ ...RETRY, attempt: 0, rand: () => 0 })).toBe(1_000);
      expect(computeBackoffMs({ ...RETRY, attempt: -5, rand: () => 0 })).toBe(1_000);
    });

    it('floors a fractional attempt', () => {
      expect(computeBackoffMs({ ...RETRY, attempt: 2.9, rand: () => 0 })).toBe(2_000);
    });

    it('always returns a non-negative integer', () => {
      const delay = computeBackoffMs({ ...RETRY, attempt: 3, rand: () => 0.333_333 });

      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });
});
