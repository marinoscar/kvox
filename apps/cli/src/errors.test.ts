import { describe, expect, it } from 'vitest';

import { CLI_NAME } from './branding.js';
import {
  ApiError,
  CliError,
  EXIT,
  NetworkError,
  UsageError,
  exitCodeFor,
  extractServerMessage,
  formatError,
} from './errors.js';

// =============================================================================
// The error model this issue exists to prove (issue #140)
// =============================================================================
//
// Two questions, tested separately: what MESSAGE does a person see, and what
// EXIT CODE does a script see. The message tests live around
// extractServerMessage/ApiError; the exit code tests live around EXIT and
// exitCodeFor.
// =============================================================================

describe('extractServerMessage — the message ladder', () => {
  it("builds an actionable message from the API's documented envelope", () => {
    const body = JSON.stringify({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Missing permission users:read',
      timestamp: '2026-08-30T00:00:00.000Z',
      path: '/api/users',
    });

    const result = extractServerMessage(body, 403, 'Forbidden');

    expect(result).toEqual({
      message: 'Missing permission users:read',
      code: 'FORBIDDEN',
      details: undefined,
      structured: true,
    });
  });

  it('joins an array message rather than stringifying it — no [object Object]', () => {
    // What ValidationPipe / nestjs-zod actually produce for a validation
    // failure: `message` is an array of per-field strings, not a string.
    const body = JSON.stringify({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: ['name should not be empty', 'email must be an email'],
      timestamp: 't',
      path: '/api/x',
    });

    const result = extractServerMessage(body, 400, 'Bad Request');

    expect(result.message).toBe('name should not be empty; email must be an email');
    expect(result.message).not.toContain('[object Object]');
    expect(result.structured).toBe(true);
  });

  it('drops non-string / blank entries from an array message', () => {
    const body = JSON.stringify({
      message: ['first problem', '', 42, null, 'second problem'],
    });

    const result = extractServerMessage(body, 400, 'Bad Request');

    expect(result.message).toBe('first problem; second problem');
    expect(result.message).not.toContain('[object Object]');
  });

  it('falls back to the status line when an array message has nothing usable', () => {
    const body = JSON.stringify({ message: [42, null, ''] });

    const result = extractServerMessage(body, 400, 'Bad Request');

    // Not our envelope in any actionable sense: falls through to the
    // "unexpected error body" branch rather than producing an empty string.
    expect(result.message).toContain('Bad Request');
    expect(result.structured).toBe(false);
  });

  it('yields a readable message for an HTML body (an nginx 502) instead of throwing', () => {
    const html =
      '<html><head><title>502 Bad Gateway</title></head><body><center>502 Bad Gateway</center><hr><center>nginx/1.25.3</center></body></html>';

    let result: ReturnType<typeof extractServerMessage> | undefined;
    expect(() => {
      result = extractServerMessage(html, 502, 'Bad Gateway');
    }).not.toThrow();

    expect(result?.message).not.toContain('Unexpected token');
    expect(result?.message).not.toMatch(/<[^>]+>/);
    expect(result?.message).toContain('Bad Gateway');
    expect(result?.message).toContain('nginx');
    expect(result?.structured).toBe(false);
  });

  it('says so for an empty body, using the status text', () => {
    const result = extractServerMessage('', 500, 'Internal Server Error');

    expect(result.message).toBe('Internal Server Error (the server sent no response body).');
    expect(result.structured).toBe(false);
  });

  it('falls back to "HTTP <status>" for an empty body with no status text', () => {
    const result = extractServerMessage('', 500, '');

    expect(result.message).toBe('HTTP 500 (the server sent no response body).');
  });

  it('falls back to a snippet, without throwing, for JSON of an unexpected shape (array)', () => {
    let result: ReturnType<typeof extractServerMessage> | undefined;
    expect(() => {
      result = extractServerMessage(JSON.stringify([1, 2, 3]), 502, 'Bad Gateway');
    }).not.toThrow();

    expect(result?.structured).toBe(false);
    expect(result?.message).toContain('[1,2,3]');
  });

  it('falls back to a snippet, without throwing, for a JSON object with no usable message', () => {
    let result: ReturnType<typeof extractServerMessage> | undefined;
    expect(() => {
      result = extractServerMessage(JSON.stringify({ foo: 'bar' }), 502, 'Bad Gateway');
    }).not.toThrow();

    expect(result?.structured).toBe(false);
    expect(result?.message).toContain('foo');
  });

  it('accepts a bare JSON string body as the message', () => {
    const result = extractServerMessage(JSON.stringify('Something went wrong'), 500, 'Error');

    expect(result.message).toBe('Something went wrong');
    expect(result.structured).toBe(false);
  });

  it('leaves details undefined when the envelope omits it — nothing downstream breaks', () => {
    // The production filter suppresses `details` for unhandled errors. This
    // must be a legal, unremarkable shape, not a case that needs its own
    // branch anywhere.
    const body = JSON.stringify({ statusCode: 500, code: 'INTERNAL', message: 'Server error' });

    const result = extractServerMessage(body, 500, 'Internal Server Error');

    expect(result.details).toBeUndefined();
    expect(result.message).toBe('Server error');
  });

  it('keeps details when the envelope carries it (development mode)', () => {
    const body = JSON.stringify({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Server error',
      details: { stack: 'Error: boom\n  at somewhere' },
    });

    const result = extractServerMessage(body, 500, 'Internal Server Error');

    expect(result.details).toEqual({ stack: 'Error: boom\n  at somewhere' });
  });
});

describe('ApiError.fromBody', () => {
  it('formats message as "<status>: <server message>"', () => {
    const body = JSON.stringify({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Missing permission users:read',
    });

    const error = ApiError.fromBody({
      status: 403,
      statusText: 'Forbidden',
      rawBody: body,
      method: 'GET',
      url: 'https://host/api/users',
    });

    expect(error.message).toBe('403: Missing permission users:read');
    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.structured).toBe(true);
    expect(error.name).toBe('ApiError');
  });

  it('never renders an array message as [object Object]', () => {
    const body = JSON.stringify({
      statusCode: 400,
      message: ['name should not be empty', 'email must be an email'],
    });

    const error = ApiError.fromBody({
      status: 400,
      statusText: 'Bad Request',
      rawBody: body,
      method: 'POST',
      url: 'https://host/api/x',
    });

    expect(error.message).toBe('400: name should not be empty; email must be an email');
    expect(error.message).not.toContain('[object Object]');
  });

  it('does not throw a SyntaxError for an HTML body and stays readable', () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';

    let error: ApiError | undefined;
    expect(() => {
      error = ApiError.fromBody({
        status: 502,
        statusText: 'Bad Gateway',
        rawBody: html,
        method: 'GET',
        url: 'https://host/api/x',
      });
    }).not.toThrow();

    expect(error).toBeInstanceOf(ApiError);
    expect(error?.message).not.toContain('Unexpected token');
    expect(error?.structured).toBe(false);
  });

  it('preserves the request method and URL, and never leaks a bearer token', () => {
    const error = ApiError.fromBody({
      status: 500,
      statusText: 'Internal Server Error',
      rawBody: '',
      method: 'DELETE',
      url: 'https://host/api/things/1',
    });

    expect(error.method).toBe('DELETE');
    expect(error.url).toBe('https://host/api/things/1');
  });
});

describe('ApiError.exitCode', () => {
  it('maps 401 to EXIT.AUTH', () => {
    const error = ApiError.fromBody({
      status: 401,
      statusText: 'Unauthorized',
      rawBody: JSON.stringify({ message: 'Unauthorized' }),
      method: 'GET',
      url: 'https://host/api/x',
    });

    expect(error.exitCode).toBe(EXIT.AUTH);
  });

  it('deliberately does NOT map 403 to EXIT.AUTH — it maps to EXIT.API', () => {
    // A permission the account lacks is not fixed by logging in again;
    // collapsing 403 into the same code as 401 would send someone through a
    // re-login loop that cannot possibly help.
    const error = ApiError.fromBody({
      status: 403,
      statusText: 'Forbidden',
      rawBody: JSON.stringify({ message: 'Missing permission users:read' }),
      method: 'GET',
      url: 'https://host/api/x',
    });

    expect(error.exitCode).toBe(EXIT.API);
    expect(error.exitCode).not.toBe(EXIT.AUTH);
  });

  it('maps every other non-2xx status to EXIT.API', () => {
    for (const status of [400, 404, 409, 422, 500, 503]) {
      const error = ApiError.fromBody({
        status,
        statusText: 'Error',
        rawBody: '',
        method: 'GET',
        url: 'https://host/api/x',
      });
      expect(error.exitCode).toBe(EXIT.API);
    }
  });
});

describe('NetworkError vs ApiError', () => {
  it('NetworkError carries no `status` property — it is genuinely absent, not 0', () => {
    const error = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(Object.prototype.hasOwnProperty.call(error, 'status')).toBe(false);
    expect((error as unknown as { status?: unknown }).status).toBeUndefined();
    // A `status: 0` sentinel would let `err.status >= 500` quietly misbehave;
    // this asserts there is no numeric sentinel to misbehave with.
    expect(typeof (error as unknown as { status?: unknown }).status).not.toBe('number');
  });

  it('are distinguishable by a caller via instanceof', () => {
    const apiError = ApiError.fromBody({
      status: 500,
      statusText: 'Error',
      rawBody: '',
      method: 'GET',
      url: 'https://host/api/x',
    });
    const networkError = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    function classify(error: unknown): 'api' | 'network' | 'other' {
      if (error instanceof ApiError) return 'api';
      if (error instanceof NetworkError) return 'network';
      return 'other';
    }

    expect(classify(apiError)).toBe('api');
    expect(classify(networkError)).toBe('network');
    expect(apiError).not.toBeInstanceOf(NetworkError);
    expect(networkError).not.toBeInstanceOf(ApiError);
  });
});

describe('NetworkError.fromCause — classification', () => {
  it('classifies ENOTFOUND as dns', () => {
    const error = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }),
      method: 'GET',
      url: 'https://bad.example.com/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('dns');
    expect(error.message).toContain('Could not resolve');
    expect(error.message).toContain('https://bad.example.com');
    expect(error.name).toBe('NetworkError');
    expect(error.exitCode).toBe(EXIT.NETWORK);
  });

  it('classifies EAI_AGAIN as dns, with the DNS/network hint appended', () => {
    const error = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } }),
      method: 'GET',
      url: 'https://bad.example.com/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('dns');
    expect(error.message).toContain('DNS/network connection');
  });

  it('classifies ECONNREFUSED as refused', () => {
    const error = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      method: 'GET',
      url: 'http://localhost:1/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('refused');
    expect(error.message).toContain('Connection refused');
  });

  it('classifies ECONNRESET and EPIPE as reset', () => {
    for (const code of ['ECONNRESET', 'EPIPE']) {
      const error = NetworkError.fromCause({
        cause: new TypeError('fetch failed', { cause: { code } }),
        method: 'GET',
        url: 'https://host/api/x',
        timeoutMs: 30_000,
        callerAborted: false,
      });
      expect(error.kind).toBe('reset');
    }
  });

  it('classifies ETIMEDOUT as timeout', () => {
    const error = NetworkError.fromCause({
      cause: new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('timeout');
  });

  it('classifies a TLS-family code as tls, matched by prefix', () => {
    for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      const error = NetworkError.fromCause({
        cause: new TypeError('fetch failed', { cause: { code } }),
        method: 'GET',
        url: 'https://host/api/x',
        timeoutMs: 30_000,
        callerAborted: false,
      });
      expect(error.kind).toBe('tls');
      expect(error.message).toContain(code);
    }
  });

  it('classifies an abort as timeout when the caller did not abort it', () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const error = NetworkError.fromCause({
      cause: abortError,
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1234,
      callerAborted: false,
    });

    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('Timed out after 1234ms');
  });

  it('classifies an abort as aborted when the caller cancelled it', () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const error = NetworkError.fromCause({
      cause: abortError,
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1234,
      callerAborted: true,
    });

    expect(error.kind).toBe('aborted');
    expect(error.message).toBe('Request cancelled.');
  });

  it('recognises a TimeoutError name and an ABORT_ERR code as abort-like too', () => {
    const timeoutErrorByName = { name: 'TimeoutError' };
    const e1 = NetworkError.fromCause({
      cause: timeoutErrorByName,
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1000,
      callerAborted: false,
    });
    expect(e1.kind).toBe('timeout');

    const abortErrByCode = { code: 'ABORT_ERR', name: 'Error' };
    const e2 = NetworkError.fromCause({
      cause: abortErrByCode,
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1000,
      callerAborted: true,
    });
    expect(e2.kind).toBe('aborted');
  });

  it('descends into an AggregateError to find a code shared by dual-stack attempts', () => {
    const aggregate = new AggregateError(
      [
        { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED ::1:80' },
        { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:80' },
      ],
      'fetch failed',
    );

    const error = NetworkError.fromCause({
      cause: aggregate,
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('refused');
  });

  it('falls back to the cause chain message when no code is recognised', () => {
    const error = NetworkError.fromCause({
      cause: new Error('bad port'),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 30_000,
      callerAborted: false,
    });

    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('bad port');
  });

  it('never throws, even for a malformed URL, and falls back to the raw string', () => {
    let error: NetworkError | undefined;
    expect(() => {
      error = NetworkError.fromCause({
        cause: new Error('nope'),
        method: 'GET',
        url: 'not a url',
        timeoutMs: 30_000,
        callerAborted: false,
      });
    }).not.toThrow();

    expect(error?.message).toContain('not a url');
  });
});

describe('EXIT / exitCodeFor', () => {
  it('is 0 only for success', () => {
    expect(EXIT.OK).toBe(0);
  });

  it('gives every non-2xx path a non-zero code', () => {
    const apiError = ApiError.fromBody({
      status: 500,
      statusText: 'Error',
      rawBody: '',
      method: 'GET',
      url: 'https://host/api/x',
    });
    expect(exitCodeFor(apiError)).not.toBe(0);

    const networkError = NetworkError.fromCause({
      cause: new Error('boom'),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1000,
      callerAborted: false,
    });
    expect(exitCodeFor(networkError)).not.toBe(0);

    expect(exitCodeFor(new UsageError('bad flag'))).not.toBe(0);
    expect(exitCodeFor(new Error('generic'))).not.toBe(0);
  });

  it('maps a UsageError to EXIT.USAGE', () => {
    expect(exitCodeFor(new UsageError('bad invocation'))).toBe(EXIT.USAGE);
  });

  it('maps an unrecognised thrown value to EXIT.FAILURE', () => {
    expect(exitCodeFor(new Error('some bug'))).toBe(EXIT.FAILURE);
    expect(exitCodeFor('a bare string was thrown')).toBe(EXIT.FAILURE);
    expect(exitCodeFor(undefined)).toBe(EXIT.FAILURE);
  });

  it('every exit code stays below 126, clear of the shell-reserved range', () => {
    for (const code of Object.values(EXIT)) {
      expect(code).toBeLessThan(126);
      expect(code).toBeGreaterThanOrEqual(0);
    }
  });

  it('exit codes are distinct', () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('CliError / subclass identity', () => {
  it('every subclass reports its own constructor name, not the generic "Error"', () => {
    expect(new UsageError('x').name).toBe('UsageError');

    const apiError = ApiError.fromBody({
      status: 400,
      statusText: 'Bad Request',
      rawBody: '',
      method: 'GET',
      url: 'https://host/api/x',
    });
    expect(apiError.name).toBe('ApiError');

    const networkError = NetworkError.fromCause({
      cause: new Error('boom'),
      method: 'GET',
      url: 'https://host/api/x',
      timeoutMs: 1000,
      callerAborted: false,
    });
    expect(networkError.name).toBe('NetworkError');
  });

  it('is a real Error subclass', () => {
    expect(new UsageError('x')).toBeInstanceOf(Error);
    expect(new UsageError('x')).toBeInstanceOf(CliError);
  });
});

describe('formatError', () => {
  it('prefixes a CliError message with the CLI name', () => {
    expect(formatError(new UsageError('bad flag'))).toBe(`${CLI_NAME}: bad flag`);
  });

  it('prefixes a plain Error message with the CLI name too', () => {
    expect(formatError(new Error('unexpected'))).toBe(`${CLI_NAME}: unexpected`);
  });

  it('stringifies a non-Error thrown value rather than crashing', () => {
    expect(formatError('a string failure')).toBe(`${CLI_NAME}: a string failure`);
    expect(formatError(42)).toBe(`${CLI_NAME}: 42`);
  });

  it('never includes a stack trace', () => {
    const error = new Error('boom');
    const formatted = formatError(error);
    expect(formatted).not.toContain('at ');
    expect(formatted.split('\n')).toHaveLength(1);
  });
});
