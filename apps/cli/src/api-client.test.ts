import { describe, expect, it } from 'vitest';

import { ApiClient, buildUrl, resolveApiBaseUrl, unwrapEnvelope } from './api-client.js';
import type { FetchLike } from './api-client.js';
import { ApiError, NetworkError, UsageError } from './errors.js';

// =============================================================================
// ApiClient / envelope handling (issue #140)
// =============================================================================
//
// No real network socket is opened anywhere in this file: every test injects
// a `fetch` replacement via `ApiClientOptions.fetch`, which is exactly what
// that option exists for. Responses are built with the real, global `Response`
// so the client sees exactly the object shape `fetch` would hand it.
// =============================================================================

/** A recorded call, captured by a fetch stub. */
interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * Build a fetch stub that returns a fixed Response and records every call it
 * receives, so tests can assert on the request the client actually sent.
 */
function stubFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as FetchLike;
  return { fetch, calls };
}

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

describe('unwrapEnvelope', () => {
  it('returns the payload for a wrapped response', () => {
    expect(unwrapEnvelope({ data: { id: 1 }, meta: { timestamp: 't' } })).toEqual({ id: 1 });
  });

  it('passes through an already-unwrapped object (no data key)', () => {
    const body = { foo: 'bar' };
    expect(unwrapEnvelope(body)).toBe(body);
  });

  it('does NOT unwrap a paginated envelope into just the array — it extracts body.data, dropping pagination', () => {
    // TransformInterceptor passes through anything already carrying a `data`
    // key, so a paginated `{ data: [...], pagination }` response looks like
    // an envelope and IS unwrapped — which silently drops `pagination`. This
    // is the documented gotcha `ApiResponse.body` exists to route around; see
    // the ApiClient.send test below for the body/data split.
    const paginated = { data: [1, 2, 3], pagination: { page: 1, total: 3 } };
    const unwrapped = unwrapEnvelope(paginated);

    expect(unwrapped).toEqual([1, 2, 3]);
    expect(unwrapped).not.toHaveProperty('pagination');
  });

  it('passes an array body through untouched (no data-key check applies)', () => {
    const body = [1, 2, 3];
    expect(unwrapEnvelope(body)).toBe(body);
  });

  it('passes a primitive body through untouched', () => {
    expect(unwrapEnvelope('hello')).toBe('hello');
    expect(unwrapEnvelope(42)).toBe(42);
    expect(unwrapEnvelope(null)).toBe(null);
  });
});

describe('ApiClient.send — envelope vs body', () => {
  it('unwraps a normal envelope into `data`, and keeps `meta`', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: { id: 1, name: 'thing' }, meta: { timestamp: 't' } }),
    );
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    const response = await client.send<{ id: number; name: string }>('GET', '/things/1');

    expect(response.data).toEqual({ id: 1, name: 'thing' });
    expect(response.meta).toEqual({ timestamp: 't' });
    expect(response.body).toEqual({ data: { id: 1, name: 'thing' }, meta: { timestamp: 't' } });
  });

  it('keeps `pagination` in `body` even though `data` only has the array', async () => {
    const envelope = { data: [{ id: 1 }, { id: 2 }], pagination: { page: 1, total: 2 } };
    const { fetch } = stubFetch(() => jsonResponse(envelope));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    const response = await client.send<Array<{ id: number }>>('GET', '/things');

    expect(response.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(response.body).toEqual(envelope);
    expect((response.body as { pagination: unknown }).pagination).toEqual({ page: 1, total: 2 });
  });

  it('does not throw on a 204 with no body', async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    const response = await client.send('DELETE', '/things/1');

    expect(response.status).toBe(204);
    expect(response.data).toBeUndefined();
    expect(response.body).toBeUndefined();
  });

  it('treats any empty body on a 2xx as an empty success, not a parse failure', async () => {
    const { fetch } = stubFetch(() => new Response('', { status: 200 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await expect(client.send('GET', '/x')).resolves.toMatchObject({ data: undefined });
  });
});

describe('ApiClient — a 2xx that is not JSON is still surfaced as an error', () => {
  it('rejects with a structured:false ApiError rather than returning success', async () => {
    // Worse than an error status: everything downstream assumes success on
    // a 2xx. An auth portal or proxy answering a login page with `200` must
    // not be treated as "the request worked".
    const { fetch } = stubFetch(
      () => new Response('<html>login required</html>', { status: 200, statusText: 'OK' }),
    );
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await expect(client.get('/x')).rejects.toBeInstanceOf(ApiError);

    const { fetch: fetch2 } = stubFetch(
      () => new Response('<html>login required</html>', { status: 200, statusText: 'OK' }),
    );
    const client2 = new ApiClient({ baseUrl: 'http://h/api', fetch: fetch2 });
    try {
      await client2.get('/x');
      expect.unreachable('expected ApiError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.structured).toBe(false);
      expect(apiError.status).toBe(200);
      expect(apiError.message).not.toContain('Unexpected token');
    }
  });
});

describe('ApiClient — non-2xx becomes ApiError with the server message', () => {
  it('surfaces the structured envelope message', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { statusCode: 403, code: 'FORBIDDEN', message: 'Missing permission users:read' },
        { status: 403, statusText: 'Forbidden' },
      ),
    );
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await expect(client.get('/users')).rejects.toMatchObject({
      status: 403,
      message: '403: Missing permission users:read',
    });
  });
});

describe('ApiClient — request headers', () => {
  it('sends the bearer token and Accept: application/json', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', token: 'secret-token', fetch });

    await client.get('/x');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['Accept']).toBe('application/json');
  });

  it('omits Authorization when no token is configured', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await client.get('/x');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/json');
  });

  it('sets Content-Type only when a body is present', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await client.get('/x');
    await client.post('/x', { a: 1 });

    const getHeaders = calls[0]?.init.headers as Record<string, string>;
    const postHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(getHeaders['Content-Type']).toBeUndefined();
    expect(postHeaders['Content-Type']).toBe('application/json');
    expect(calls[1]?.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('cannot have Authorization or Accept clobbered by caller-supplied headers', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', token: 'secret-token', fetch });

    await client.get('/x', { headers: { Authorization: 'Bearer forged', Accept: 'text/plain' } });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['Accept']).toBe('application/json');
  });
});

describe('ApiClient — method dispatch', () => {
  it.each([
    ['get', 'GET'],
    ['delete', 'DELETE'],
  ] as const)('%s() sends %s', async (methodName, httpMethod) => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await client[methodName]('/x');

    expect(calls[0]?.init.method).toBe(httpMethod);
  });

  it.each([
    ['post', 'POST'],
    ['patch', 'PATCH'],
    ['put', 'PUT'],
  ] as const)('%s() sends %s with a JSON body', async (methodName, httpMethod) => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await client[methodName]('/x', { a: 1 });

    expect(calls[0]?.init.method).toBe(httpMethod);
    expect(calls[0]?.init.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe('ApiClient — network failures', () => {
  it('wraps a fetch rejection as a NetworkError, not a raw TypeError', async () => {
    const fetch: FetchLike = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as FetchLike;
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await expect(client.get('/x')).rejects.toBeInstanceOf(NetworkError);
    await expect(client.get('/x')).rejects.not.toBeInstanceOf(ApiError);
  });

  it('reading the body can itself fail after headers arrive, and still yields NetworkError', async () => {
    const brokenResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated', { cause: { code: 'ECONNRESET' } }));
        },
      }),
      { status: 200 },
    );
    const fetch: FetchLike = (async () => brokenResponse) as FetchLike;
    const client = new ApiClient({ baseUrl: 'http://h/api', fetch });

    await expect(client.get('/x')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('ApiClient constructor', () => {
  it('rejects an empty base URL', () => {
    expect(() => new ApiClient({ baseUrl: '' })).toThrow(UsageError);
  });

  it('strips trailing slashes from the base URL once', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: 'http://h/api///', fetch });

    await client.get('/auth/me');

    expect(calls[0]?.url).toBe('http://h/api/auth/me');
  });
});

describe('buildUrl', () => {
  it('joins base and path without a double slash regardless of leading/trailing slashes', () => {
    expect(buildUrl('http://h/api/', '/auth/me')).toBe('http://h/api/auth/me');
    expect(buildUrl('http://h/api', 'auth/me')).toBe('http://h/api/auth/me');
    expect(buildUrl('http://h/api', '/auth/me')).toBe('http://h/api/auth/me');
  });

  it('appends a query string, dropping undefined and null values', () => {
    const url = buildUrl('http://h/api', '/things', { a: 1, b: undefined, c: null, d: 'x' });
    expect(url).toBe('http://h/api/things?a=1&d=x');
  });

  it('omits the query string entirely when no query is given', () => {
    expect(buildUrl('http://h/api', '/things')).toBe('http://h/api/things');
  });

  it('omits the query string when every value is undefined/null', () => {
    expect(buildUrl('http://h/api', '/things', { a: undefined, b: null })).toBe(
      'http://h/api/things',
    );
  });
});

describe('resolveApiBaseUrl', () => {
  it('defaults loopback hosts to http', () => {
    expect(resolveApiBaseUrl('localhost:3535')).toBe('http://localhost:3535/api');
    expect(resolveApiBaseUrl('127.0.0.1:3535')).toBe('http://127.0.0.1:3535/api');
  });

  it('defaults a public hostname to https', () => {
    expect(resolveApiBaseUrl('app.example.com')).toBe('https://app.example.com/api');
  });

  it('is idempotent when the caller already includes /api', () => {
    expect(resolveApiBaseUrl('https://app.example.com/api')).toBe(
      'https://app.example.com/api',
    );
    expect(resolveApiBaseUrl('https://app.example.com/api/')).toBe(
      'https://app.example.com/api',
    );
  });

  it('rejects an empty server URL', () => {
    expect(() => resolveApiBaseUrl('')).toThrow(UsageError);
    expect(() => resolveApiBaseUrl('   ')).toThrow(UsageError);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => resolveApiBaseUrl('ftp://host')).toThrow(UsageError);
  });
});
