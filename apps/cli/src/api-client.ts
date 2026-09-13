import { API_PATH_PREFIX, CLI_NAME } from './branding.js';
import { ApiError, NetworkError, UsageError } from './errors.js';
import { CLI_VERSION } from './package-info.js';

// =============================================================================
// HTTP client for the API  (issue #140, epic #110)
// =============================================================================
//
// Built on the runtime's own `fetch`. No axios, no got, no node-fetch: Node 20
// ships a WHATWG fetch, and a dependency here would buy nothing while adding a
// supply-chain surface to a package whose entire job is to carry a bearer
// token around.
//
// This is NOT a port of apps/web/src/services/api.ts. That client is written
// against browser globals and, more importantly, against a browser's auth
// model — `credentials: 'include'`, a refresh-token cookie, a 401-retry loop.
// The CLI has no cookie jar and no refresh token; its credential is a
// long-lived PAT (#141) that either works or has been revoked. A 401 here is
// terminal and must be reported, not retried.
//
// EVERY FAILURE LEAVES THIS MODULE AS AN ApiError OR A NetworkError. Nothing
// else escapes: not a bare `TypeError: fetch failed`, not a `SyntaxError` from
// parsing an HTML error page. The top level maps those two classes to exit
// codes, and an unclassified throw would land on the generic "1" and lose the
// distinction that makes the failure diagnosable.
// =============================================================================

/**
 * The subset of `fetch` this client uses.
 *
 * Injectable so tests can drive the client without a socket — and so #142's
 * device-flow polling can be tested without sleeping through real intervals.
 * Typed as `typeof fetch` rather than a hand-rolled signature so a stub that
 * would not satisfy the real thing fails at compile time.
 */
export type FetchLike = typeof globalThis.fetch;

/** Query values a caller may pass; `undefined`/`null` entries are dropped. */
export type QueryValue = string | number | boolean | null | undefined;

export interface ApiClientOptions {
  /**
   * Root URL for API requests, INCLUDING the `/api` prefix — e.g.
   * `http://localhost:3535/api`. Use `resolveApiBaseUrl()` to turn a
   * server URL a human typed into this.
   */
  baseUrl: string;
  /** Bearer token. Absent is legal: `/api/auth/providers` is public. */
  token?: string | undefined;
  /** Per-request ceiling. See DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** Override for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike | undefined;
}

export interface RequestOptions {
  /** Appended as a query string; `undefined`/`null` values are omitted. */
  query?: Record<string, QueryValue> | undefined;
  /** Serialised as JSON. Use `undefined` for no body — `null` sends `null`. */
  body?: unknown;
  /** Extra headers. Cannot remove Authorization; see `buildHeaders`. */
  headers?: Record<string, string> | undefined;
  /** Caller's cancellation, combined with the timeout. */
  signal?: AbortSignal | undefined;
  /** Override the client's timeout for this one call. */
  timeoutMs?: number | undefined;
}

/** A completed request, before the envelope is discarded. */
export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  /**
   * The payload with the response envelope removed — what callers almost
   * always want.
   */
  data: T;
  /** `meta` from the envelope (it carries `timestamp`), when there was one. */
  meta: Record<string, unknown> | undefined;
  /**
   * Exactly what the server sent, parsed but NOT unwrapped.
   *
   * Exists for #144's `--raw`, which must emit the server's own JSON so the
   * output pipes into `jq` unchanged — and for paginated endpoints, where the
   * envelope is not always what it looks like (see `unwrapEnvelope`).
   */
  body: unknown;
}

/**
 * 30 seconds.
 *
 * A default timeout is not a nicety. Node's `fetch` has NO timeout of its own:
 * a connection to a host that accepts and then says nothing — a hung load
 * balancer, a suspended container, a firewall that blackholes instead of
 * rejecting — hangs forever. In an interactive shell that is annoying; in CI
 * it burns the entire job budget and reports as a timeout of the whole
 * pipeline rather than as an unreachable API.
 *
 * Generous enough for a cold-started server behind a proxy, short enough to
 * fail inside anybody's CI step limit. #142's polling passes its own value.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ApiClientOptions) {
    // Trailing slashes are stripped ONCE, here, rather than defended against
    // at every call site. `http://h/api/` + `/auth/me` naively concatenated is
    // `http://h/api//auth/me`, and a double slash is not cosmetic — Fastify
    // treats it as a distinct path and answers 404, which reads to the user as
    // "that endpoint does not exist" rather than "your base URL had a slash".
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');

    if (this.baseUrl.length === 0) {
      throw new UsageError('A server base URL is required.');
    }

    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Bound to `globalThis`. An unbound `globalThis.fetch` passed around as a
    // value throws "Illegal invocation" when called with the wrong receiver.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** GET. */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  /** POST with a JSON body. */
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  /** PATCH — the API's JSON Merge Patch endpoints. */
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  /**
   * PUT. Not named in #140, included because the settings endpoints are
   * replace-semantics PUTs and a client that cannot express them would force
   * the first caller to reach for `send()` and reinvent the header handling.
   */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  /** DELETE. Most of the API's DELETEs answer 204, so `T` is usually void. */
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /** Any method, returning just the unwrapped payload. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send<T>(method, path, options);
    return response.data;
  }

  /**
   * The real implementation: any method, returning status, headers, the
   * unwrapped payload AND the untouched body.
   */
  async send<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const upperMethod = method.toUpperCase();

    const hasBody = options.body !== undefined;
    const init: RequestInit = {
      method: upperMethod,
      headers: this.buildHeaders(hasBody, options.headers),
      signal: withTimeout(options.signal, timeoutMs),
    };

    if (hasBody) {
      // JSON.stringify can throw on a circular structure or a BigInt. That is
      // the caller's mistake, not the server's, so it surfaces as a usage
      // error rather than escaping as a raw TypeError from inside the client.
      try {
        init.body = JSON.stringify(options.body);
      } catch (cause) {
        throw new UsageError(
          `Request body for ${upperMethod} ${path} could not be serialised as JSON.`,
          { cause },
        );
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      // The one place "could not reach the server" is decided. Everything
      // after this line knows a response exists.
      throw NetworkError.fromCause({
        cause,
        method: upperMethod,
        url,
        timeoutMs,
        callerAborted: options.signal?.aborted === true,
      });
    }

    // `.text()` rather than `.json()`, ALWAYS, for both success and failure.
    // On an error path it is what stops an HTML 502 becoming a SyntaxError
    // (see ApiError.fromBody); on the success path it lets an empty 200 —
    // which some proxies produce — be handled rather than thrown on.
    //
    // Reading the body is itself a network operation and can fail after the
    // headers arrived (a truncated response, a connection dropped mid-stream),
    // so it gets the same NetworkError treatment.
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      throw NetworkError.fromCause({
        cause,
        method: upperMethod,
        url,
        timeoutMs,
        callerAborted: options.signal?.aborted === true,
      });
    }

    if (!response.ok) {
      throw ApiError.fromBody({
        status: response.status,
        statusText: response.statusText,
        rawBody,
        method: upperMethod,
        url,
      });
    }

    // 204 No Content, and an empty body on any status, are legitimate
    // successes. `JSON.parse('')` throws, so this check must come first.
    if (rawBody.trim().length === 0) {
      return {
        status: response.status,
        headers: response.headers,
        data: undefined as T,
        meta: undefined,
        body: undefined,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // A 2xx that is not JSON. Almost always a proxy or an auth portal
      // answering with a login page and a 200, which is worse than an error
      // status because everything downstream assumes success. Reported as an
      // ApiError (the server DID respond) with `structured: false`.
      throw ApiError.fromBody({
        status: response.status,
        statusText: 'Malformed response',
        rawBody,
        method: upperMethod,
        url,
      });
    }

    return {
      status: response.status,
      headers: response.headers,
      data: unwrapEnvelope<T>(parsed),
      meta: extractMeta(parsed),
      body: parsed,
    };
  }

  /**
   * Headers for one request.
   *
   * `Accept: application/json` is unconditional — without it a
   * content-negotiating proxy is free to hand back HTML, and the failure
   * appears as a parse error rather than as the misconfiguration it is.
   *
   * `Content-Type` is set ONLY when there is a body. Fastify 5 is strict here:
   * declaring a JSON content type on a body-less request makes it try to parse
   * nothing and answer 400. apps/web's client carries the same rule and the
   * same comment; it is a property of the server, not of either client.
   *
   * Caller headers are merged FIRST so Authorization and Accept cannot be
   * clobbered by a caller passing `{ Authorization: ... }` — a device-flow
   * poll that accidentally attached a half-issued token would be an
   * authentication bug that only shows up under load.
   */
  private buildHeaders(hasBody: boolean, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...extra,
      Accept: 'application/json',
      // Identifies the client in the API's request logs and, later, in the
      // device-flow `clientInfo.userAgent` (#141) — so a user looking at their
      // Access Tokens page can tell which tool created a token.
      'User-Agent': `${CLI_NAME}/${CLI_VERSION} (node ${process.version})`,
    };

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.token !== undefined && this.token.length > 0) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return headers;
  }
}

/**
 * Remove the response envelope added by
 * apps/api/src/common/interceptors/transform.interceptor.ts, which wraps a
 * handler's return value as `{ data, meta: { timestamp } }`.
 *
 * THE SUBTLETY, and the reason `ApiResponse.body` exists alongside this: the
 * interceptor PASSES THROUGH anything that already has a `data` key. A
 * paginated endpoint returning `{ data: [...], pagination: {...} }` is
 * therefore never wrapped, and unwrapping it here yields the array while
 * silently dropping the page count. That is correct for a typed caller that
 * asked for the items, and wrong for anything that needs the pagination — so
 * the untouched body is always kept, and #144's `--raw` prints that instead.
 *
 * Arrays and primitives are returned untouched: only an object with a `data`
 * key can be an envelope.
 */
export function unwrapEnvelope<T>(body: unknown): T {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/** `meta` from the envelope, when the body is one and `meta` is an object. */
function extractMeta(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const meta = (body as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return meta as Record<string, unknown>;
}

/**
 * Join a base URL and a path, then append the query string.
 *
 * WHY NOT `new URL(path, baseUrl)`: it applies web resolution rules, and an
 * absolute path REPLACES the base's path. `new URL('/auth/me',
 * 'http://h/api')` is `http://h/auth/me` — the `/api` prefix silently gone,
 * and every request 404s while the base URL looks perfectly correct in the
 * error message. String joining is the boring, right answer here.
 *
 * Exported for tests: the slash handling above is exactly the sort of thing
 * that regresses.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  const joined = trimmedPath.length > 0 ? `${trimmedBase}/${trimmedPath}` : trimmedBase;

  if (query === undefined) return joined;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // `undefined` and `null` are DROPPED rather than stringified. Otherwise an
    // unset optional filter becomes `?status=undefined`, which the server
    // dutifully validates and rejects with a 400 that blames the user for a
    // parameter they never set.
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }

  const queryString = params.toString();
  return queryString.length > 0 ? `${joined}?${queryString}` : joined;
}

/**
 * Turn a server URL a human typed into the API root this client wants.
 *
 *   localhost:3535            -> http://localhost:3535/api
 *   https://app.example.com   -> https://app.example.com/api
 *   https://app.example.com/api -> https://app.example.com/api   (idempotent)
 *
 * Exists because #143 stores a SERVER url (what the user knows) while this
 * client needs an API root (what the routing requires), and the `/api` prefix
 * is an implementation detail of apps/api/src/main.ts that a user should never
 * have to know. Idempotent so that a user who pastes the full API URL — which
 * they will, because it is what the docs show — is not punished with
 * `/api/api`.
 *
 * The scheme guess is deliberately asymmetric: a bare `localhost` or loopback
 * address gets `http`, everything else gets `https`. Defaulting a public
 * hostname to http would send a bearer token over the wire in plaintext, and
 * silently downgrading a credential is not an acceptable convenience.
 */
export function resolveApiBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (trimmed.length === 0) {
    throw new UsageError('A server URL is required (for example: https://app.example.com).');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${isLoopbackAuthority(trimmed) ? 'http' : 'https'}://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UsageError(`"${serverUrl}" is not a valid server URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(
      `Server URL must use http or https, not "${parsed.protocol.replace(':', '')}".`,
    );
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const base = `${parsed.origin}${path}`;

  return path.endsWith(API_PATH_PREFIX) ? base : `${base}${API_PATH_PREFIX}`;
}

/** `localhost`, `127.x`, `[::1]` — with or without a port or a path. */
function isLoopbackAuthority(value: string): boolean {
  const authority = value.split('/')[0] ?? '';
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Combine the caller's cancellation with our own deadline.
 *
 * `AbortSignal.any` (Node 20.3+) is what makes both work at once: without it,
 * passing the caller's signal drops the timeout and passing the timeout drops
 * the caller's Ctrl-C. Both matter — #142 polls with its own signal AND still
 * needs each individual poll to time out.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
