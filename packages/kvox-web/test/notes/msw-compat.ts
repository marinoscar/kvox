/**
 * A small MSW-shaped front for the fake host, so the notes suites keep the
 * handler style they were written in (`server.use(http.get(url, resolver))`)
 * while running over `createFakeKvoxWebHost` instead of a network.
 *
 * A handler registered before the host exists is held and applied when the
 * host is built (`applyHandlers`); one registered after is applied at once to
 * the host under test. Handlers reset after every test.
 *
 * The resolver sees what MSW's gave it: `request` (`url`, `method`, `headers`,
 * `json()`, `text()`, `formData()`) and `params`. A response below 400 resolves
 * the call with its `data` member (the API's envelope, which the host strips); a
 * response of 400 or above throws the `KvoxApiError` the host would.
 */

import { afterEach } from 'vitest';

import { fakeApiError } from '../../src/core/testing/index.js';
import type {
  FakeKvoxWebHost,
  FakeRoute,
  FakeRouteRequest,
} from '../../src/core/testing/index.js';

/** The origin the suites build URLs against; stripped before routing. */
export const API_BASE = 'http://localhost:3000/api';

/** The response a resolver returns. */
export class HttpResponse {
  readonly body: unknown;
  readonly status: number;

  constructor(body: unknown = null, init: { status?: number; headers?: Record<string, string> } = {}) {
    this.body = body;
    this.status = init.status ?? 200;
  }

  static json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): HttpResponse {
    return new HttpResponse(body, init);
  }
}

/** What a resolver is called with. */
export interface CompatRequest {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  /** The caller's abort signal; a signal that never aborts when the caller passed none. */
  signal: AbortSignal;
  json(): Promise<unknown>;
  text(): Promise<string>;
  formData(): Promise<FormData>;
}

/** What a resolver receives. */
export interface CompatInfo {
  request: CompatRequest;
  params: Record<string, string>;
}

type Resolver = (info: CompatInfo) => HttpResponse | Promise<HttpResponse> | unknown;

/** One registered handler. */
export interface CompatHandler {
  key: string;
  route: FakeRoute;
}

/** What a `request:start` listener is called with. */
export interface CompatRequestEvent {
  request: CompatRequest;
}

type RequestListener = (event: CompatRequestEvent) => void;

let listeners: RequestListener[] = [];

/** MSW's `delay`: resolves after `ms` milliseconds, or never for `'infinite'`. */
export function delay(ms: number | 'infinite' | 'real' = 0): Promise<void> {
  if (ms === 'infinite') return new Promise(() => undefined);
  return new Promise((resolve) => setTimeout(resolve, ms === 'real' ? 0 : ms));
}

function toRoute(resolver: Resolver): FakeRoute {
  return async (req: FakeRouteRequest) => {
    const query = req.query.toString();
    const request: CompatRequest = {
      url: `${API_BASE}${req.path}${query ? `?${query}` : ''}`,
      method: req.method,
      headers: {
        get: (name: string) =>
          Object.entries(req.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ??
          null,
      },
      signal: req.signal ?? new AbortController().signal,
      // What crosses the wire: JSON drops an `undefined` member, as a transport would.
      json: async () => (req.body === undefined ? undefined : JSON.parse(JSON.stringify(req.body))),
      text: async () =>
        req.body === undefined ? '' : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
      formData: async () => req.body as FormData,
    };
    for (const listener of listeners) listener({ request });
    const result = await resolver({ request, params: req.params });
    if (!(result instanceof HttpResponse)) return result;
    if (result.status >= 400) {
      const body = (result.body ?? {}) as { message?: string; details?: unknown };
      throw fakeApiError(result.status, body.message ?? 'Request failed', body.details);
    }
    const body = result.body as { data?: unknown } | null;
    return body !== null && typeof body === 'object' && 'data' in body ? body.data : body;
  };
}

function handler(method: string, url: string, resolver: Resolver): CompatHandler {
  // `*/api/...` is MSW's any-origin form; the shim routes by path alone.
  const path = url.startsWith(API_BASE)
    ? url.slice(API_BASE.length)
    : url.startsWith('*/api')
      ? url.slice('*/api'.length)
      : url;
  return { key: `${method} ${path}`, route: toRoute(resolver) };
}

/** MSW's `http`, for the verbs the suites use. */
export const http = {
  get: (url: string, resolver: Resolver) => handler('GET', url, resolver),
  post: (url: string, resolver: Resolver) => handler('POST', url, resolver),
  patch: (url: string, resolver: Resolver) => handler('PATCH', url, resolver),
  put: (url: string, resolver: Resolver) => handler('PUT', url, resolver),
  delete: (url: string, resolver: Resolver) => handler('DELETE', url, resolver),
};

let held: CompatHandler[] = [];
let current: FakeKvoxWebHost | null = null;

/** MSW's `server`, as far as the suites use it. */
export const server = {
  /** Registers handlers; the last one registered for a route wins. */
  use(...handlers: CompatHandler[]): void {
    held.push(...handlers);
    for (const entry of handlers) current?.setRoute(entry.key, entry.route);
  },
  /** Forgets every handler. */
  resetHandlers(): void {
    held = [];
  },
  /** MSW's life-cycle events; only `request:start` is emulated, for the handlers registered here. */
  events: {
    on(_type: 'request:start', listener: RequestListener): void {
      listeners.push(listener);
    },
    removeAllListeners(): void {
      listeners = [];
    },
  },
};

/** The held handlers as host routes, in registration order (the last wins). */
export function heldRoutes(): Record<string, FakeRoute> {
  return Object.fromEntries(held.map((entry) => [entry.key, entry.route]));
}

/** Tells the shim which host later `server.use` calls apply to. */
export function bindHost(host: FakeKvoxWebHost | null): void {
  current = host;
}

afterEach(() => {
  held = [];
  current = null;
  listeners = [];
});
