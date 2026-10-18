import { AiError } from '@marinoscar/platform-api/ai';

import { COPILOT_SIGN_IN_MESSAGE, copilotErrorFromData, copilotErrorFromThrown, redactTokens } from './copilot-errors.js';

// =============================================================================
// The Copilot error table and the token redaction (#581)
// =============================================================================

describe('copilotErrorFromData: the mapping table', () => {
  it.each([
    // [errorType, statusCode, code]
    ['rate_limit', undefined, 'AI_RATE_LIMITED'],
    ['quota', undefined, 'AI_RATE_LIMITED'],
    ['RATE_LIMIT', undefined, 'AI_RATE_LIMITED'],
    ['query', 429, 'AI_RATE_LIMITED'],
    [undefined, 429, 'AI_RATE_LIMITED'],
    ['authentication', undefined, 'AI_KEY_INVALID'],
    ['authorization', undefined, 'AI_KEY_INVALID'],
    ['query', 401, 'AI_KEY_INVALID'],
    ['query', 403, 'AI_KEY_INVALID'],
    [undefined, 401, 'AI_KEY_INVALID'],
    ['context_limit', undefined, 'AI_INVALID_REQUEST'],
    ['query', 413, 'AI_INVALID_REQUEST'],
    ['query', 400, 'AI_INVALID_REQUEST'],
    ['query', 422, 'AI_INVALID_REQUEST'],
    ['content_filter', undefined, 'AI_CONTENT_FILTERED'],
    ['content-filter', undefined, 'AI_CONTENT_FILTERED'],
    ['query', 500, 'AI_PROVIDER_UNAVAILABLE'],
    ['query', 503, 'AI_PROVIDER_UNAVAILABLE'],
    ['something_new', undefined, 'AI_PROVIDER_UNAVAILABLE'],
    [undefined, undefined, 'AI_PROVIDER_UNAVAILABLE'],
  ] as const)('errorType %p / status %p is %s', (errorType, statusCode, code) => {
    const error = copilotErrorFromData({ ...(errorType !== undefined ? { errorType } : {}), ...(statusCode !== undefined ? { statusCode } : {}), message: 'm' });
    expect(AiError.isAiError(error)).toBe(true);
    expect(error.code).toBe(code);
  });

  it('lets the type win over a status: rate_limit with 500 is still a rate limit', () => {
    expect(copilotErrorFromData({ errorType: 'rate_limit', statusCode: 500, message: 'm' }).code).toBe('AI_RATE_LIMITED');
    expect(copilotErrorFromData({ errorType: 'authentication', statusCode: 429, message: 'm' }).code).toBe('AI_RATE_LIMITED');
  });

  it('carries no retry hint (SDK 1.0.22 reports none) unless a numeric one is present', () => {
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm' }).retryAfterMs).toBeUndefined();
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm', retryAfterSeconds: 7 }).retryAfterMs).toBe(7000);
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm', retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm', retryAfterMs: 1500, retryAfterSeconds: 9 }).retryAfterMs).toBe(1500);
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm', retryAfterSeconds: -1 }).retryAfterMs).toBeUndefined();
    expect(copilotErrorFromData({ errorType: 'rate_limit', message: 'm', retryAfterSeconds: Number.NaN }).retryAfterMs).toBeUndefined();
    // A hint on another error is not a hint.
    expect(copilotErrorFromData({ errorType: 'authentication', message: 'm', retryAfterSeconds: 7 }).retryAfterMs).toBeUndefined();
  });

  it('prefixes the message, reads message then errorMessage, and caps it at 300 characters', () => {
    expect(copilotErrorFromData({ errorType: 'query', message: 'plain' }).message).toBe('GitHub Copilot: plain');
    expect(copilotErrorFromData({ errorMessage: 'from call failure' }).message).toBe('GitHub Copilot: from call failure');
    expect(copilotErrorFromData({ message: 'a', errorMessage: 'b' }).message).toBe('GitHub Copilot: a');
    expect(copilotErrorFromData({}).message).toBe('GitHub Copilot: the request failed');
    expect(copilotErrorFromData({ message: 'x'.repeat(5000) }).message).toBe(`GitHub Copilot: ${'x'.repeat(300)}`);
  });

  it('keeps only errorType, statusCode and errorCode in details', () => {
    const error = copilotErrorFromData({
      errorType: 'rate_limit',
      statusCode: 429,
      errorCode: 'too_many',
      message: 'm',
      errorMessage: 'em',
      retryAfterSeconds: 3,
    });
    const details = error.toJSON().details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['errorCode', 'errorType', 'reason', 'retryAfterMs', 'statusCode']);
    expect(details).toMatchObject({ errorType: 'rate_limit', statusCode: 429, errorCode: 'too_many', reason: 'AI_RATE_LIMITED' });
  });

  it('caps and redacts the detail strings', () => {
    const error = copilotErrorFromData({ errorType: `gho_${'A'.repeat(50)}`, errorCode: `${'z'.repeat(500)}`, message: 'm' });
    const details = error.toJSON().details as Record<string, string>;
    expect(details.errorType).toBe('[redacted]');
    expect(details.errorCode).toHaveLength(100);
  });
});

describe('copilotErrorFromThrown', () => {
  it('passes an AiError through as the same object', () => {
    const own = new AiError('AI_CAPABILITY_UNSUPPORTED', 'mine');
    expect(copilotErrorFromThrown(own)).toBe(own);
  });

  it.each([
    [new Error('User is Not Authenticated')],
    ['not authenticated'],
    [{ message: 'Session failed: not  authenticated yet' }],
  ])('turns %p into AI_KEY_REQUIRED with the sign-in sentence', (thrown) => {
    const error = copilotErrorFromThrown(thrown);
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(error.message).toBe(COPILOT_SIGN_IN_MESSAGE);
  });

  it.each([
    [new Error('socket hang up'), 'GitHub Copilot: socket hang up'],
    ['a plain string', 'GitHub Copilot: a plain string'],
    [{ message: 'object with message' }, 'GitHub Copilot: object with message'],
    [{ nothing: true }, 'GitHub Copilot: the request failed'],
    [null, 'GitHub Copilot: the request failed'],
    [undefined, 'GitHub Copilot: the request failed'],
  ])('turns %p into AI_PROVIDER_UNAVAILABLE', (thrown, message) => {
    const error = copilotErrorFromThrown(thrown);
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toBe(message);
  });

  it('redacts and caps what it keeps', () => {
    const error = copilotErrorFromThrown(new Error(`failed with gho_SECRETSECRETSECRET and ${'y'.repeat(1000)}`));
    expect(error.message).not.toContain('gho_');
    expect(error.message.length).toBeLessThanOrEqual('GitHub Copilot: '.length + 300);
  });
});

describe('redactTokens', () => {
  it.each([
    'gho_abcDEF0123456789',
    'ghp_abcDEF0123456789',
    'ghu_abcDEF0123456789',
    'ghs_abcDEF0123456789',
    'ghr_abcDEF0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijkl',
    'sk-abcdefghij1234567890',
    'sk-proj-abc_DEF-123456',
    'Bearer abc.def-ghi_jkl~mno+pqr/stu=',
    'bearer lowercase.token.value',
  ])('redacts %s', (token) => {
    const out = redactTokens(`before ${token} after`);
    expect(out).toBe('before [redacted] after');
  });

  it('redacts every occurrence and leaves ordinary text alone', () => {
    expect(redactTokens('a gho_1 b ghu_2 c')).toBe('a [redacted] b [redacted] c');
    expect(redactTokens('No secrets here: sk-short, ghost_x, github.com')).toBe('No secrets here: sk-short, ghost_x, github.com');
    expect(redactTokens('')).toBe('');
  });

  it('is repeatable (global patterns keep no state between calls)', () => {
    for (let i = 0; i < 3; i += 1) expect(redactTokens('gho_aaa gho_bbb')).toBe('[redacted] [redacted]');
  });
});
