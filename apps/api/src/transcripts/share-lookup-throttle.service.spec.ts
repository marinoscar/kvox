import { HttpException, HttpStatus } from '@nestjs/common';

import {
  SHARE_LOOKUP_MAX_MISSES,
  SHARE_LOOKUP_THROTTLED_MESSAGE,
  ShareLookupThrottleService,
  WINDOW_MS,
} from './share-lookup-throttle.service';

// =============================================================================
// ShareLookupThrottleService (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// The three properties this limiter is FOR, each asserted directly:
//
//   1. A run of misses by one account is eventually refused with 429.
//   2. A SUCCESS costs nothing — sharing with eight colleagues in a row is the
//      feature working, and an honest owner must never meet this limit.
//   3. Accounts are counted separately, so one enumerator cannot lock everybody
//      else out of sharing.
//
// Clock-dependent behaviour is driven by the explicit `now` parameter rather
// than by fake timers: a limiter whose window can only be tested by advancing
// global time is a limiter nobody re-tests after changing it.
// =============================================================================

describe('ShareLookupThrottleService', () => {
  let throttle: ShareLookupThrottleService;

  beforeEach(() => {
    throttle = new ShareLookupThrottleService();
  });

  /** Burn `count` misses for `userId`, all at the same instant. */
  function burn(userId: string, count: number, now = 1_000): void {
    for (let index = 0; index < count; index += 1) throttle.recordMiss(userId, now);
  }

  it('allows a caller who has missed nothing', () => {
    expect(() => throttle.assertAllowed('user-1')).not.toThrow();
  });

  it('allows exactly the budget of misses, then refuses', () => {
    burn('user-1', SHARE_LOOKUP_MAX_MISSES - 1);

    expect(() => throttle.assertAllowed('user-1', 1_000)).not.toThrow();

    throttle.recordMiss('user-1', 1_000);

    expect(() => throttle.assertAllowed('user-1', 1_000)).toThrow(HttpException);
  });

  it('answers 429 with the generic wait message and a retry hint', () => {
    burn('user-1', SHARE_LOOKUP_MAX_MISSES);

    try {
      throttle.assertAllowed('user-1', 1_000);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);

      const thrown = error as HttpException;

      expect(thrown.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

      const body = thrown.getResponse() as { message: string; details: { retryAfterSeconds: number } };

      expect(body.message).toBe(SHARE_LOOKUP_THROTTLED_MESSAGE);
      // NAMES NO ADDRESS AND NO USER — the message is the same one every
      // throttled caller gets, for the same reason the 404 is generic.
      expect(body.message).not.toMatch(/@/);
      expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
    }
  });

  it('does NOT charge a successful share — only `recordMiss` moves the counter', () => {
    // The service has no "record hit" method at all, which is the point: an
    // owner adding the whole team one address at a time can call the endpoint
    // as many times as they have colleagues.
    for (let index = 0; index < SHARE_LOOKUP_MAX_MISSES * 5; index += 1) {
      expect(() => throttle.assertAllowed('user-1', 1_000)).not.toThrow();
    }
  });

  it('counts each account separately, so one enumerator cannot lock out the rest', () => {
    burn('attacker', SHARE_LOOKUP_MAX_MISSES);

    expect(() => throttle.assertAllowed('attacker', 1_000)).toThrow(HttpException);
    expect(() => throttle.assertAllowed('somebody-else', 1_000)).not.toThrow();
  });

  it('forgets the window once it has expired', () => {
    burn('user-1', SHARE_LOOKUP_MAX_MISSES, 1_000);

    expect(() => throttle.assertAllowed('user-1', 1_000)).toThrow(HttpException);
    expect(() => throttle.assertAllowed('user-1', 1_000 + WINDOW_MS)).not.toThrow();
  });

  it('keeps the window FIXED rather than sliding — a miss late in it does not extend it', () => {
    burn('user-1', SHARE_LOOKUP_MAX_MISSES - 1, 1_000);
    throttle.recordMiss('user-1', 1_000 + WINDOW_MS - 1);

    expect(() => throttle.assertAllowed('user-1', 1_000 + WINDOW_MS - 1)).toThrow(HttpException);
    // One millisecond later the window that STARTED at 1_000 has expired, even
    // though a miss landed inside it moments ago.
    expect(() => throttle.assertAllowed('user-1', 1_000 + WINDOW_MS)).not.toThrow();
  });

  it('reset() clears one account', () => {
    burn('user-1', SHARE_LOOKUP_MAX_MISSES);
    throttle.reset('user-1');

    expect(() => throttle.assertAllowed('user-1', 1_000)).not.toThrow();
  });
});
