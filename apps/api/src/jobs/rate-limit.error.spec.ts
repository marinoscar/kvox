// =============================================================================
// Unit tests for rate-limit classification (issue #261, epic #254)
// =============================================================================
//
// This is the discrimination the entire terminal path hangs off: get it wrong
// in the false-negative direction and a throttled backfill burns its attempt
// budget and fails permanently; get it wrong in the false-positive direction
// and a genuine bug sits in deferral for an hour instead of surfacing. Both
// directions are asserted, and the shapes tested are the ones real SDKs
// actually throw.
// =============================================================================

import { classifyRateLimit, parseRetryAfterMs, RateLimitError } from './rate-limit.error';

/** A fixed "now" so the HTTP-date cases are exact rather than approximate. */
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

describe('RateLimitError', () => {
  it('survives transpilation: instanceof still works', () => {
    // ⚠ The regression this guards is silent and severe — a `false` here
    // means every provider throttle is classified as an ordinary bug.
    const error: unknown = new RateLimitError('slow down', 5_000);

    expect(error instanceof RateLimitError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it('is catchable as itself and carries its message, name and delay', () => {
    try {
      throw new RateLimitError('provider said 429', 12_345);
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).message).toBe('provider said 429');
      expect((error as RateLimitError).name).toBe('RateLimitError');
      expect((error as RateLimitError).retryAfterMs).toBe(12_345);
    }
  });

  it('allows the delay to be omitted', () => {
    expect(new RateLimitError('no hint').retryAfterMs).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  describe('delta-seconds form', () => {
    it('parses integer seconds', () => {
      expect(parseRetryAfterMs('120', NOW)).toBe(120_000);
      expect(parseRetryAfterMs('0', NOW)).toBe(0);
      expect(parseRetryAfterMs('  30  ', NOW)).toBe(30_000);
    });

    it('accepts a number as well as a string', () => {
      expect(parseRetryAfterMs(60, NOW)).toBe(60_000);
    });
  });

  describe('HTTP-date form', () => {
    it('parses an HTTP-date into a delay relative to now', () => {
      const at = new Date(NOW + 90_000).toUTCString();

      expect(parseRetryAfterMs(at, NOW)).toBe(90_000);
    });

    it('parses the RFC example format', () => {
      const header = 'Wed, 21 Oct 2015 07:28:00 GMT';
      const now = Date.UTC(2015, 9, 21, 7, 27, 0);

      expect(parseRetryAfterMs(header, now)).toBe(60_000);
    });

    it('returns null for a date already in the past — that is no wait, not zero', () => {
      const past = new Date(NOW - 60_000).toUTCString();

      expect(parseRetryAfterMs(past, NOW)).toBeNull();
    });
  });

  describe('absent or unparseable input yields null', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['whitespace', '   '],
      ['prose', 'soon'],
      ['a unit suffix', '30 minutes'],
      ['exponential notation', '1e3'],
      ['a fractional value', '1.5'],
      ['a negative value', '-5'],
      ['a malformed date', 'Wed, 99 Zzz 2015 07:28:00 GMT'],
    ])('%s', (_label, header) => {
      expect(parseRetryAfterMs(header as string | null | undefined, NOW)).toBeNull();
    });
  });
});

describe('classifyRateLimit', () => {
  describe('recognised as a rate limit', () => {
    it('an explicit RateLimitError, carrying its own delay', () => {
      expect(classifyRateLimit(new RateLimitError('x', 7_000), NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: 7_000,
      });
    });

    it.each([
      ['429 on `status`', { status: 429 }],
      ['429 on `statusCode`', { statusCode: 429 }],
      ['503 on `response.status`', { response: { status: 503 } }],
      ['529 overload on `status`', { status: 529 }],
      ['429 on `$metadata.httpStatusCode`', { $metadata: { httpStatusCode: 429 } }],
    ])('%s', (_label, err) => {
      expect(classifyRateLimit(err, NOW).rateLimited).toBe(true);
    });

    it.each([
      ['ThrottlingException on `name`', { name: 'ThrottlingException', status: 400 }],
      ['TooManyRequestsException on `name`', { name: 'TooManyRequestsException' }],
      ['SlowDown on `code`', { code: 'SlowDown', status: 400 }],
      ['RequestThrottled on `code`', { code: 'RequestThrottled' }],
      [
        'ProvisionedThroughputExceededException on `name`',
        { name: 'ProvisionedThroughputExceededException' },
      ],
      [
        'a fully-qualified `__type`',
        { __type: 'com.amazonaws.dynamodb.v20120810#ThrottlingException' },
      ],
    ])('%s (an AWS throttle name, often with a 400 status)', (_label, err) => {
      // The status-only reading of these is "client error, fail permanently",
      // which is exactly wrong.
      expect(classifyRateLimit(err, NOW).rateLimited).toBe(true);
    });

    it('is case-insensitive about the name', () => {
      expect(classifyRateLimit({ code: 'slowdown' }, NOW).rateLimited).toBe(true);
    });
  });

  describe('NOT a rate limit', () => {
    it.each([
      ['a plain Error', new Error('null is not an object')],
      ['a 500', { status: 500 }],
      ['a 502', { status: 502 }],
      ['a 400 with no throttle name', { status: 400, name: 'ValidationException' }],
      ['a 404', { response: { status: 404 } }],
      ['a string', 'boom'],
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['an empty object', {}],
    ])('%s', (_label, err) => {
      expect(classifyRateLimit(err, NOW)).toEqual({ rateLimited: false, retryAfterMs: null });
    });

    it('never throws, whatever it is handed', () => {
      const hostile = {
        get status() {
          throw new Error('exploding getter');
        },
      };

      // A classifier that throws inside a failure path loses the failure
      // handling entirely, so this must degrade rather than blow up.
      expect(() => classifyRateLimit(hostile, NOW)).not.toThrow();
    });
  });

  describe('Retry-After extraction', () => {
    it('reads a plain lowercase header object', () => {
      expect(classifyRateLimit({ status: 429, headers: { 'retry-after': '45' } }, NOW)).toEqual({
        rateLimited: true,
        retryAfterMs: 45_000,
      });
    });

    it('reads a mixed-case header name', () => {
      expect(
        classifyRateLimit({ status: 429, headers: { 'Retry-After': '45' } }, NOW).retryAfterMs
      ).toBe(45_000);
    });

    it('reads it from `response.headers`', () => {
      expect(
        classifyRateLimit({ response: { status: 503, headers: { 'retry-after': '2' } } }, NOW)
          .retryAfterMs
      ).toBe(2_000);
    });

    it('reads a fetch `Headers`-like container via get()', () => {
      const headers = new Map([['retry-after', '15']]);

      expect(
        classifyRateLimit(
          { status: 429, headers: { get: (name: string) => headers.get(name) ?? null } },
          NOW
        ).retryAfterMs
      ).toBe(15_000);
    });

    it('reads an HTTP-date header', () => {
      const at = new Date(NOW + 30_000).toUTCString();

      expect(classifyRateLimit({ status: 429, headers: { 'retry-after': at } }, NOW).retryAfterMs)
        .toBe(30_000);
    });

    it('is null when the header is absent or unparseable — pure backoff', () => {
      expect(classifyRateLimit({ status: 429 }, NOW).retryAfterMs).toBeNull();
      expect(
        classifyRateLimit({ status: 429, headers: { 'retry-after': 'soon' } }, NOW).retryAfterMs
      ).toBeNull();
    });
  });
});
