import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../api-client.js';
import { SERVER_URL_ENV_VAR, TOKEN_ENV_VAR, type ConfigContext } from '../config.js';
import { ApiError, EXIT, NetworkError, UsageError, exitCodeFor } from '../errors.js';
import type { BodyResolutionContext } from '../request-body.js';
import { parseQueryPair, parseRequestPath, registerApiCommand } from './api.js';

// =============================================================================
// `appctl api <method> <path>`  (issue #144, epic #110)
// =============================================================================
//
// NO REAL SOCKET IS EVER OPENED. `ApiClient` (constructed inside
// `runApiCommand`) has no seam of its own for a fetch replacement — unlike
// `ApiClientOptions.fetch`, which api-client.test.ts uses directly — so every
// test here installs its stub as `globalThis.fetch` via `vi.stubGlobal`, which
// is exactly what `new ApiClient({...})` falls back to when no override is
// given. `vi.unstubAllGlobals()` in `afterEach` guarantees no stub survives
// into the next test.
//
// Credentials are supplied through `ConfigContext.env` (never the real
// process environment, never a real `~/.appctl` file) so `requireCredentials`
// always succeeds without touching the filesystem or this machine's actual
// login state.
//
// THE CENTRAL REGRESSION TARGET: hand-testing found that a resolved `--data`
// value never reached `client.send` — every POST silently sent no body — and
// both typecheck and the full suite were green with it. The fix in the
// codebase this is testing against is `{ ...(body === undefined ? {} :
// { body: body.value }) }` inside `runApiCommand`. The tests below assert on
// the CAPTURED fetch call's `init.body`, not on the exit code or on whether
// the command merely "succeeded" — a dropped body still produces a 2xx from a
// stubbed server, which is exactly how the original bug slipped through.
// =============================================================================

interface RecordedCall {
  url: string;
  init: RequestInit;
}

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

function baseCtx(
  overrides: Partial<ConfigContext & BodyResolutionContext> = {},
): ConfigContext & BodyResolutionContext {
  return {
    // A path that cannot exist, so `readConfigFile` always sees ENOENT and
    // credentials come from `env` alone — no dependency on this machine's
    // real home directory or a real `~/.appctl/config.json`.
    home: '/nonexistent-appctl-test-home-144',
    env: {
      [SERVER_URL_ENV_VAR]: 'http://test.local',
      [TOKEN_ENV_VAR]: 'pat_test_token',
    },
    ...overrides,
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  error: unknown;
}

/**
 * Build a fresh `Command`, register `api` on it with the given ctx, and
 * invoke `appctl api <args...>`. Mirrors config.test.ts's
 * `registerConfigCommand(program, ctx)` + `parseAsync(..., { from: 'user' })`
 * pattern.
 *
 * Every thrown error from the action is caught here rather than propagated,
 * so a single helper covers both the success and the failure paths and
 * callers can assert on `error` with `exitCodeFor` exactly as `program.ts`
 * itself does.
 */
async function runApi(
  args: string[],
  ctx: ConfigContext & BodyResolutionContext = baseCtx(),
): Promise<RunResult> {
  const program = new Command();
  registerApiCommand(program, ctx);

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  let error: unknown;
  try {
    await program.parseAsync(['api', ...args], { from: 'user' });
  } catch (caught) {
    error = caught;
  }

  const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
  const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();

  return { stdout, stderr, error };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// -----------------------------------------------------------------------------
// Output discipline — the contract with a shell
// -----------------------------------------------------------------------------

describe('output discipline', () => {
  const paginated = { data: [{ id: 1 }, { id: 2 }], pagination: { page: 1, total: 2 } };

  it('--raw puts valid JSON and nothing else on stdout: no ESC byte even with colour forced on', async () => {
    const { fetch } = stubFetch(() => jsonResponse(paginated));
    vi.stubGlobal('fetch', fetch);
    // Everything a naive implementation might use to decide "colour this" is
    // deliberately turned on, to prove --raw does not even ask the question.
    vi.stubEnv('FORCE_COLOR', '1');
    vi.stubEnv('NO_COLOR', '');
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      const result = await runApi(['GET', '/api/users', '--raw']);

      expect(result.error).toBeUndefined();
      expect(result.stdout).not.toMatch(/\x1b/);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toEqual(paginated);
    } finally {
      if (isTTYDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', isTTYDescriptor);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it('default mode is pretty-printed and byte-identical to JSON.stringify(body, null, 2) when uncoloured', async () => {
    const body = { id: 1, name: 'thing', tags: ['a', 'b'] };
    const { fetch } = stubFetch(() => jsonResponse(body));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/things/1', '--no-color']);

    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('both modes print response.body, never the unwrapped data — pagination survives (default mode)', async () => {
    const { fetch } = stubFetch(() => jsonResponse(paginated));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--no-color']);

    const printed: unknown = JSON.parse(result.stdout);
    expect(printed).toEqual(paginated);
    expect(printed).toHaveProperty('pagination');
    // Unwrapping (printing `response.data` instead of `response.body`) would
    // yield the bare array and silently discard this.
    expect((printed as { pagination: unknown }).pagination).toEqual({ page: 1, total: 2 });
  });

  it('both modes print response.body, never the unwrapped data — pagination survives (--raw)', async () => {
    const { fetch } = stubFetch(() => jsonResponse(paginated));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--raw']);

    const printed: unknown = JSON.parse(result.stdout);
    expect(printed).toEqual(paginated);
    expect((printed as { pagination: unknown }).pagination).toEqual({ page: 1, total: 2 });
  });

  it('everything that is not the body goes to stderr: stdout is exactly the JSON, the status line is on stderr', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/auth/me', '--no-color']);

    expect(result.stdout).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
    expect(result.stderr).toMatch(/GET \/api\/auth\/me.*200/);
  });

  it('--quiet suppresses the stderr status line without touching stdout', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/auth/me', '--no-color', '--quiet']);

    expect(result.stdout).toBe(`${JSON.stringify({ ok: true }, null, 2)}\n`);
    expect(result.stderr).toBe('');
  });

  it('a 204 prints nothing on stdout — not "null", not "" from JSON.stringify(undefined)', async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['DELETE', '/api/allowlist/1', '--no-color']);

    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('(no response body)');
  });

  it('a 204 with --raw also prints nothing on stdout', async () => {
    const { fetch } = stubFetch(() => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['DELETE', '/api/allowlist/1', '--raw']);

    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('');
  });
});

// -----------------------------------------------------------------------------
// Exit codes
// -----------------------------------------------------------------------------

describe('exit codes', () => {
  it('a 2xx produces no error at all (0 only on 2xx)', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/auth/me']);

    expect(result.error).toBeUndefined();
  });

  it('a non-2xx exits non-zero carrying the server’s message, and stdout is empty', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { statusCode: 403, code: 'FORBIDDEN', message: 'Missing permission users:read' },
        { status: 403, statusText: 'Forbidden' },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users']);

    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as Error).message).toBe('403: Missing permission users:read');
    expect(exitCodeFor(result.error)).toBe(EXIT.API);
    expect(exitCodeFor(result.error)).not.toBe(EXIT.OK);
    expect(result.stdout).toBe('');
  });

  it('a 401 maps to the auth exit code, not the generic API one', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { statusCode: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
        { status: 401, statusText: 'Unauthorized' },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/auth/me']);

    expect(result.error).toBeInstanceOf(ApiError);
    expect(exitCodeFor(result.error)).toBe(EXIT.AUTH);
    expect(exitCodeFor(result.error)).not.toBe(EXIT.API);
    expect(result.stdout).toBe('');
  });

  it('a transport failure maps to the network exit code', async () => {
    const fetch: FetchLike = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as FetchLike;
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/auth/me']);

    expect(result.error).toBeInstanceOf(NetworkError);
    expect(exitCodeFor(result.error)).toBe(EXIT.NETWORK);
    expect(result.stdout).toBe('');
  });

  it('a local usage mistake maps to the usage exit code', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['NOTAMETHOD', '/api/users']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect(calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Request construction — where the caught bug lived
// -----------------------------------------------------------------------------

describe('request construction', () => {
  it('--data \'{"a":1}\' actually reaches the request body (the bug this suite exists to catch)', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: { ok: true } }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['POST', '/api/allowlist', '--data', '{"email":"a@b.com"}']);

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    expect(call.init.method).toBe('POST');
    // Asserting on the ACTUAL bytes sent, not merely that the command "worked"
    // — a silently dropped body still gets a 2xx from a stub and would pass a
    // test that only checked the exit code.
    expect(call.init.body).toBe(JSON.stringify({ email: 'a@b.com' }));
    expect(JSON.parse(call.init.body as string)).toEqual({ email: 'a@b.com' });
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('--data @file reads the file and sends its parsed contents as the body', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const ctx = baseCtx({
      readFile: (path: string) => {
        if (path === 'entry.json') return '{"email":"from-file@example.com"}';
        throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });
      },
    });

    const result = await runApi(['POST', '/api/allowlist', '--data', '@entry.json'], ctx);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    expect(call.init.body).toBe(JSON.stringify({ email: 'from-file@example.com' }));
  });

  it('--data - reads stdin and sends its parsed contents as the body', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const ctx = baseCtx({
      readStdin: async () => '{"email":"from-stdin@example.com"}',
    });

    const result = await runApi(['POST', '/api/allowlist', '--data', '-'], ctx);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    expect(call.init.body).toBe(JSON.stringify({ email: 'from-stdin@example.com' }));
  });

  it('--data null sends the four bytes "null" with a Content-Type header', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['POST', '/api/auth/logout', '--data', 'null']);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    expect(call.init.body).toBe('null');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('no --data at all sends no body and no Content-Type header — distinguishable from --data null', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['POST', '/api/auth/logout']);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    expect(call.init.body).toBeUndefined();
    // Fastify answers 400 to a declared JSON content type paired with an
    // empty body, so the header must be genuinely absent, not merely falsy.
    const headers = call.init.headers as Record<string, string>;
    expect('Content-Type' in headers).toBe(false);
  });

  it('repeated --query flags with the same key send both values', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--query', 'tag=a', '--query', 'tag=b']);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    const url = new URL(call.url);
    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
  });

  it('--query splits only on the first "=", so a base64-ish cursor value survives', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--query', 'cursor=abc=def==']);

    expect(result.error).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('expected one captured call');
    const url = new URL(call.url);
    expect(url.searchParams.get('cursor')).toBe('abc=def==');
  });
});

// -----------------------------------------------------------------------------
// Local validation — each must fail locally, not as a confusing server error
// -----------------------------------------------------------------------------

describe('local validation (no request is ever sent)', () => {
  it('rejects an invalid method', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GTE', '/api/users']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a path without a leading slash', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', 'api/users']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a full URL — accepting it would send the bearer token to an arbitrary host', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', 'https://evil.example.com/api/users']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
    expect((result.error as Error).message).toMatch(/full URL/i);
  });

  it('rejects malformed --data JSON', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['POST', '/api/allowlist', '--data', '{not valid json']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a --query without "="', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--query', 'noequalsign']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-integer --timeout', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--timeout', 'thirty']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('rejects --data on a GET locally, rather than letting fetch throw and be misreported as unreachable', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['GET', '/api/users', '--data', '{}']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(result.error)).toBe(EXIT.USAGE);
    expect(exitCodeFor(result.error)).not.toBe(EXIT.NETWORK);
    // The whole point: fetch is never even called, so this cannot surface as
    // "could not reach the server".
    expect(calls).toHaveLength(0);
    expect((result.error as Error).message).not.toMatch(/reach/i);
  });

  it('rejects --data on a HEAD locally, same as GET', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['HEAD', '/api/users', '--data', '{}']);

    expect(result.error).toBeInstanceOf(UsageError);
    expect(calls).toHaveLength(0);
  });

  it('allows --data on a DELETE (legal, unlike GET/HEAD)', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const result = await runApi(['DELETE', '/api/allowlist/1', '--data', '{"reason":"cleanup"}']);

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// `/api` prefix handling — parseRequestPath (exported for exactly this)
// -----------------------------------------------------------------------------

describe('parseRequestPath', () => {
  it('strips the /api prefix when present', () => {
    expect(parseRequestPath('/api/auth/me').path).toBe('/auth/me');
  });

  it('leaves a path with no /api prefix untouched', () => {
    expect(parseRequestPath('/auth/me').path).toBe('/auth/me');
  });

  it('strips a bare /api to the root', () => {
    expect(parseRequestPath('/api').path).toBe('/');
  });

  it('does NOT strip /apikeys — the match requires a segment boundary', () => {
    expect(parseRequestPath('/apikeys').path).toBe('/apikeys');
  });

  it('does NOT strip /apikeys/123 either', () => {
    expect(parseRequestPath('/apikeys/123').path).toBe('/apikeys/123');
  });

  it('rejects a path with no leading slash', () => {
    expect(() => parseRequestPath('users')).toThrow(UsageError);
  });

  it('rejects a full URL', () => {
    expect(() => parseRequestPath('http://host/api/users')).toThrow(UsageError);
  });

  it('rejects an empty path', () => {
    expect(() => parseRequestPath('   ')).toThrow(UsageError);
  });

  it('rejects a path containing "#"', () => {
    expect(() => parseRequestPath('/api/users#frag')).toThrow(UsageError);
  });

  it('splits an inline query string off the path', () => {
    const { path, query } = parseRequestPath('/api/users?page=2&pageSize=50');
    expect(path).toBe('/users');
    expect(query.get('page')).toBe('2');
    expect(query.get('pageSize')).toBe('50');
  });

  it('collapses a doubled leading slash', () => {
    expect(parseRequestPath('//users').path).toBe('/users');
  });
});

describe('parseQueryPair', () => {
  it('splits on the first "=" only, preserving a value containing one', () => {
    expect(parseQueryPair('cursor=abc=def==')).toEqual({ key: 'cursor', value: 'abc=def==' });
  });

  it('does not trim the value (a trailing space can be meaningful)', () => {
    expect(parseQueryPair('q=hello ')).toEqual({ key: 'q', value: 'hello ' });
  });

  it('rejects a pair with no "="', () => {
    expect(() => parseQueryPair('noequals')).toThrow(UsageError);
  });

  it('rejects an empty key', () => {
    expect(() => parseQueryPair('=value')).toThrow(UsageError);
  });

  it('allows an explicitly empty value', () => {
    expect(parseQueryPair('key=')).toEqual({ key: 'key', value: '' });
  });
});
