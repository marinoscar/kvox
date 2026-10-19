// =============================================================================
// createFakeKvoxWebHost: an in-memory KvoxWebHost for tests
// =============================================================================
//
// No network I/O, ever. HTTP is a router over `routes`, event streams play a
// script, uploaded parts are recorded, and every call is kept in `calls` for
// assertions. A slice's tests render the page under `renderWithKvoxHost` with
// this host instead of mocking `fetch` or the app's API client.
// =============================================================================

import { KvoxApiError } from '../headless/errors.js';
import { buildKvoxUrl } from '../headless/http.js';
import type {
  KvoxBlobResponse,
  KvoxFeatures,
  KvoxHttpMethod,
  KvoxLinks,
  KvoxPartResult,
  KvoxRequestInit,
  KvoxResponseWithMeta,
  KvoxSseConnectOptions,
  KvoxSseEvent,
  KvoxViewer,
  KvoxWebHost,
} from '../headless/host.js';

/**
 * What a route handler receives.
 *
 * @stability experimental
 */
export interface FakeRouteRequest {
  /** The HTTP verb. */
  method: KvoxHttpMethod;
  /** The path WITHOUT the query string. */
  path: string;
  /** The query string, parsed (from the path and from `init.query`). */
  query: URLSearchParams;
  /** `:name` segments of the matched route pattern. */
  params: Record<string, string>;
  /** The request body: JSON as given, or the `FormData`. */
  body: unknown;
  /** The request headers. */
  headers: Record<string, string>;
  /** How the call was made. */
  kind: 'json' | 'blob' | 'formData' | 'meta';
  /** The caller's abort signal, when it passed one, so a route can observe a superseded request. */
  signal?: AbortSignal;
}

/**
 * A route's answer. A function is called with the request; anything else is the
 * response payload as it is. To fail, throw {@link fakeApiError}.
 *
 * @stability experimental
 */
export type FakeRoute =
  | ((request: FakeRouteRequest) => unknown | Promise<unknown>)
  | string
  | number
  | boolean
  | null
  | undefined
  | object;

/**
 * The answer of a route called through `requestBlob`.
 *
 * @stability experimental
 */
export interface FakeBlobAnswer {
  /** The bytes. */
  blob: Blob;
  /** Response headers by lower-case name. */
  headers?: Record<string, string>;
}

/**
 * The answer of a route called through `requestWithMeta`.
 *
 * @stability experimental
 */
export interface FakeMetaAnswer {
  /** 200 by default; `304` resolves with no data. */
  status?: number;
  /** Response headers by lower-case name. */
  headers?: Record<string, string>;
  /** The payload. */
  data?: unknown;
}

/**
 * What a streaming script receives for one connection.
 *
 * @stability experimental
 */
export interface FakeSseContext {
  /** The `Last-Event-ID` the caller sent. */
  lastEventId: string | undefined;
  /** Closes when the caller closes the connection. */
  signal: AbortSignal;
  /** Dispatches one event. */
  emit(event: KvoxSseEvent): void;
}

/**
 * A script for a `GET` event stream: events dispatched in order and then the
 * stream ends, or a function that drives the connection (return a promise that
 * stays pending to hold it open until the signal aborts).
 *
 * @stability experimental
 */
export type FakeSseScript = KvoxSseEvent[] | ((context: FakeSseContext) => void | Promise<void>);

/**
 * A script for a `POST` event stream: `[eventName, data]` frames in order.
 *
 * @stability experimental
 */
export type FakeSsePostScript = Array<[event: string, data: unknown]> | ((frame: (event: string, data: unknown) => void, body: unknown, signal?: AbortSignal) => void | Promise<void>);

/**
 * One call the host received, in order.
 *
 * @stability experimental
 */
export interface FakeHostCall {
  /** Which port. */
  port: 'http' | 'sse.connect' | 'sse.post' | 'upload';
  /** `GET /path` for HTTP, the path for streams, the URL for uploads. */
  key: string;
  /** The verb for HTTP calls. */
  method?: KvoxHttpMethod;
  /** The path as called, with its query string. */
  path: string;
  /** The body, for calls that carry one. */
  body?: unknown;
  /** The request headers. */
  headers?: Record<string, string>;
  /** The `Last-Event-ID`, for stream connections. */
  lastEventId?: string;
}

/**
 * A signed-in user for the fake host.
 *
 * @stability experimental
 */
export interface FakeViewerInit {
  /** The user id. Default `user-1`. */
  userId?: string;
  /** The permission strings the user holds. Default none. */
  permissions?: Iterable<string>;
  /** The name Home greets the user by. Default none. */
  displayName?: string | null;
}

/**
 * A part the fake upload port received.
 *
 * @stability experimental
 */
export interface FakeUploadedPart {
  /** The URL it was sent to. */
  url: string;
  /** Its size in bytes. */
  size: number;
}

/**
 * Options of {@link createFakeKvoxWebHost}.
 *
 * @stability experimental
 */
export interface FakeKvoxWebHostOptions {
  /**
   * HTTP routes keyed `"METHOD /path"`. A segment `:name` matches anything
   * (`"GET /transcripts/:id"`), a trailing `/*` matches the rest. An exact key
   * that includes the query string wins over the pattern.
   */
  routes?: Record<string, FakeRoute>;
  /** Scripts of `GET` event streams, keyed by path (the query string is ignored). */
  sse?: Record<string, FakeSseScript>;
  /** Scripts of `POST` event streams, keyed by path. */
  ssePost?: Record<string, FakeSsePostScript>;
  /**
   * The signed-in user. Default: user `user-1` holding no permission. `null` is
   * signed out. Change it later with `host.setViewer`.
   */
  viewer?: FakeViewerInit | null;
  /** Deployment switches. Default: `graphEnabled: true`. */
  features?: Partial<KvoxFeatures>;
  /** Link builders. Default: `/transcripts/:id`, `/notes/:id`, `/graph/entities/:id`, `/ask/:id`. */
  links?: Partial<KvoxLinks>;
  /**
   * The host's notification-stream hook (`KvoxWebHost.useLatestEventId`). Default:
   * the host has none. A test passes a hook that reads a variable it controls.
   */
  useLatestEventId?: (prefix: string) => string | null;
  /**
   * Include the host's own `upload.putPart` port, recording each part. Default
   * `true`. Pass `false` to leave it out so the engine uses `XMLHttpRequest`
   * (and a test drives it with `createFakeXhrFactory`).
   */
  upload?: boolean | ((url: string, body: Blob) => KvoxPartResult | Promise<KvoxPartResult>);
}

/**
 * The fake host, with its recordings.
 *
 * @stability experimental
 */
export interface FakeKvoxWebHost extends KvoxWebHost {
  /** Every call, in order. */
  readonly calls: FakeHostCall[];
  /** Calls whose `key` equals `key`, for example `"PUT /transcription-settings"`. */
  callsTo(key: string): FakeHostCall[];
  /** Parts the upload port received. */
  readonly uploads: FakeUploadedPart[];
  /** Add or replace a route. */
  setRoute(key: string, route: FakeRoute): void;
  /** Add or replace an event-stream script. */
  setSse(path: string, script: FakeSseScript): void;
  /** Replace the signed-in user (`null` signs out). */
  setViewer(viewer: FakeViewerInit | null): void;
  /** Replace the deployment switches. */
  setFeatures(features: Partial<KvoxFeatures>): void;
  /** Forget the recorded calls and uploads. */
  reset(): void;
}

/**
 * An error a route handler throws to fail the call, as a host would.
 *
 * @param status - The HTTP status.
 * @param message - The API's message.
 * @param details - The error envelope's `details`, for example `{ reason: 'version_conflict' }`.
 * @returns A `KvoxApiError`.
 *
 * @stability experimental
 */
export function fakeApiError(status: number, message: string, details?: unknown): KvoxApiError {
  return new KvoxApiError(message, status, undefined, details);
}

function splitPath(path: string): { pathname: string; search: string } {
  const at = path.indexOf('?');
  return at < 0 ? { pathname: path, search: '' } : { pathname: path.slice(0, at), search: path.slice(at + 1) };
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const have = pathname.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const w = want[i]!;
    if (w === '*' && i === want.length - 1) return params;
    const h = have[i];
    if (h === undefined) return null;
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(h);
    else if (w !== h) return null;
  }
  return want.length === have.length ? params : null;
}

function headersOf(map: Record<string, string> | undefined) {
  const lower = new Map(Object.entries(map ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * Builds an in-memory `KvoxWebHost`.
 *
 * @param options - Routes, stream scripts, the viewer and switches.
 * @returns The host, with `calls`, `uploads` and setters for tests.
 *
 * @stability experimental
 */
export function createFakeKvoxWebHost(options: FakeKvoxWebHostOptions = {}): FakeKvoxWebHost {
  const routes = new Map<string, FakeRoute>(Object.entries(options.routes ?? {}));
  const sseScripts = new Map<string, FakeSseScript>(Object.entries(options.sse ?? {}));
  const ssePostScripts = new Map<string, FakeSsePostScript>(Object.entries(options.ssePost ?? {}));
  const calls: FakeHostCall[] = [];
  const uploads: FakeUploadedPart[] = [];
  let viewer: KvoxViewer | null = null;
  let features: KvoxFeatures = { graphEnabled: true, ...options.features };

  const setViewer: FakeKvoxWebHost['setViewer'] = (value) => {
    viewer =
      value === null
        ? null
        : {
            userId: value.userId ?? 'user-1',
            permissions: new Set(value.permissions ?? []),
            ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
          };
  };
  setViewer(options.viewer === undefined ? {} : options.viewer);

  const links: KvoxLinks = {
    transcript: (id) => `/transcripts/${id}`,
    note: (id) => `/notes/${id}`,
    entity: (id) => `/graph/entities/${id}`,
    conversation: (id) => `/ask/${id}`,
    ...options.links,
  };

  async function dispatch(
    kind: FakeRouteRequest['kind'],
    method: KvoxHttpMethod,
    rawPath: string,
    init: KvoxRequestInit | undefined,
    body: unknown,
  ): Promise<unknown> {
    const fullPath = buildKvoxUrl(rawPath, init?.query);
    const { pathname, search } = splitPath(fullPath);
    const headers = init?.headers ?? {};
    calls.push({ port: 'http', key: `${method} ${pathname}`, method, path: fullPath, body, headers });

    let route: FakeRoute | undefined;
    let params: Record<string, string> = {};
    let found = false;
    const exact = `${method} ${fullPath}`;
    if (routes.has(exact)) {
      route = routes.get(exact);
      found = true;
    } else if (routes.has(`${method} ${pathname}`)) {
      route = routes.get(`${method} ${pathname}`);
      found = true;
    } else {
      for (const [key, candidate] of routes) {
        const space = key.indexOf(' ');
        if (key.slice(0, space) !== method) continue;
        const matched = matchPattern(key.slice(space + 1), pathname);
        if (matched) {
          route = candidate;
          params = matched;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      throw new KvoxApiError(`No fake route for ${method} ${pathname}`, 404, 'NOT_FOUND', {
        reason: 'fake_route_missing',
      });
    }
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const request: FakeRouteRequest = {
      method,
      path: pathname,
      query: new URLSearchParams(search),
      params,
      body,
      headers,
      kind,
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    };
    return typeof route === 'function' ? (route as (r: FakeRouteRequest) => unknown)(request) : route;
  }

  const host: FakeKvoxWebHost = {
    calls,
    uploads,
    callsTo: (key) => calls.filter((call) => call.key === key),
    setRoute: (key, route) => void routes.set(key, route),
    setSse: (path, script) => void sseScripts.set(path, script),
    setViewer,
    setFeatures: (next) => {
      features = { ...features, ...next };
    },
    reset: () => {
      calls.length = 0;
      uploads.length = 0;
    },

    http: {
      request: async <T,>(method: KvoxHttpMethod, path: string, init?: KvoxRequestInit) =>
        (await dispatch('json', method, path, init, init?.body)) as T,
      requestBlob: async (method, path, init): Promise<KvoxBlobResponse> => {
        const answer = (await dispatch('blob', method, path, init, init?.body)) as FakeBlobAnswer | Blob;
        if (answer instanceof Blob) return { blob: answer, headers: headersOf({}) };
        return { blob: answer.blob, headers: headersOf(answer.headers) };
      },
      postFormData: async <T,>(path: string, body: FormData, init?: KvoxRequestInit) =>
        (await dispatch('formData', 'POST', path, init, body)) as T,
      requestWithMeta: async <T,>(
        method: 'GET',
        path: string,
        init?: KvoxRequestInit,
      ): Promise<KvoxResponseWithMeta<T>> => {
        const answer = (await dispatch('meta', method, path, init, undefined)) as FakeMetaAnswer;
        const status = answer.status ?? 200;
        return {
          status,
          headers: headersOf(answer.headers),
          data: status === 304 ? undefined : (answer.data as T | undefined),
        };
      },
    },

    sse: {
      async connect(path: string, connectOptions: KvoxSseConnectOptions) {
        const { pathname } = splitPath(path);
        calls.push({
          port: 'sse.connect',
          key: pathname,
          path,
          ...(connectOptions.lastEventId === undefined ? {} : { lastEventId: connectOptions.lastEventId }),
        });
        const script = sseScripts.get(pathname) ?? sseScripts.get(path);
        if (!script) {
          throw new KvoxApiError(`No fake event stream for ${pathname}`, 404, 'NOT_FOUND', {
            reason: 'fake_route_missing',
          });
        }
        connectOptions.onOpen?.();
        const context: FakeSseContext = {
          lastEventId: connectOptions.lastEventId,
          signal: connectOptions.signal,
          emit: (event) => {
            if (!connectOptions.signal.aborted) connectOptions.onEvent(event);
          },
        };
        if (typeof script === 'function') await script(context);
        else for (const event of script) context.emit(event);
      },
      async post<T = unknown>(
        path: string,
        body: unknown,
        postOptions: { onFrame(event: string, data: T): void; signal?: AbortSignal },
      ) {
        const { pathname } = splitPath(path);
        calls.push({ port: 'sse.post', key: pathname, path, body });
        const script = ssePostScripts.get(pathname) ?? ssePostScripts.get(path);
        if (!script) {
          throw new KvoxApiError(`No fake POST event stream for ${pathname}`, 404, 'NOT_FOUND', {
            reason: 'fake_route_missing',
          });
        }
        const frame = (event: string, data: unknown) => {
          if (!postOptions.signal?.aborted) postOptions.onFrame(event, data as T);
        };
        if (typeof script === 'function') await script(frame, body, postOptions.signal);
        else for (const [event, data] of script) frame(event, data);
      },
    },

    viewer: () => viewer,
    links,
    features: () => features,
  };

  if (options.useLatestEventId) host.useLatestEventId = options.useLatestEventId;

  if (options.upload !== false) {
    const answer = typeof options.upload === 'function' ? options.upload : null;
    host.upload = {
      putPart: async (url, body) => {
        uploads.push({ url, size: body.size });
        calls.push({ port: 'upload', key: url, path: url });
        return answer ? answer(url, body) : { etag: `etag-${uploads.length}` };
      },
    };
  }

  return host;
}
