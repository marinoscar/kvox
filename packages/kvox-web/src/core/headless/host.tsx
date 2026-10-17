// =============================================================================
// KvoxWebHost: the one thing a web slice reads from the app that mounts it
// =============================================================================
//
// A slice never imports the app's HTTP client, its auth context or its router
// helpers. It reads this port through `useKvoxHost()`, and the app (the web
// edition, KVox Desktop) provides it once with `KvoxWebHostProvider`. That is
// what lets the same pages and hooks run in a host that is not the KVox web
// edition. A packaged page that renders without a host refuses loudly
// (`KvoxHostMissingError`) instead of failing later on an undefined transport.
// =============================================================================

import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * The HTTP verbs the host transport carries.
 *
 * @stability experimental
 */
export type KvoxHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Per-request options of the host HTTP transport.
 *
 * @stability experimental
 */
export interface KvoxRequestInit {
  /** A JSON body (or a `FormData` through `postFormData`). Serialised by the host. */
  body?: unknown;
  /**
   * Query parameters. A host appends them to the path with `buildKvoxUrl`;
   * `undefined` and `null` values are skipped.
   */
  query?: Record<string, unknown>;
  /** Extra request headers, for example `If-Match`. */
  headers?: Record<string, string>;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * The part of a response's headers a slice reads.
 *
 * @stability experimental
 */
export interface KvoxResponseHeaders {
  /** The value of a header by case-insensitive name, `null` when absent. */
  get(name: string): string | null;
}

/**
 * A binary response with the headers a download needs (`Content-Disposition`).
 *
 * @stability experimental
 */
export interface KvoxBlobResponse {
  /** The response body. */
  blob: Blob;
  /** The response headers. */
  headers: KvoxResponseHeaders;
}

/**
 * A JSON response with its status and headers, for the few calls that read an
 * `ETag` or a `304` (a conditional poll).
 *
 * @stability experimental
 */
export interface KvoxResponseWithMeta<T> {
  /** The HTTP status: a 2xx, or `304`. Any other status is thrown as an error. */
  status: number;
  /** The response headers. */
  headers: KvoxResponseHeaders;
  /** The decoded payload, `undefined` for a `304` or an empty body. */
  data: T | undefined;
}

/**
 * The HTTP transport of a host.
 *
 * @remarks
 * Every method resolves with the response payload with the API's `{ data }`
 * envelope already removed, and rejects with an error carrying `status`,
 * `message` and, when the server sent them, `code` and `details`
 * (`KvoxApiError`, or anything with that shape: the core helpers normalise it).
 * Authentication, token refresh and any app-wide error hook belong to the host.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface KvoxHttpPort {
  /** A JSON request. */
  request<T>(method: KvoxHttpMethod, path: string, init?: KvoxRequestInit): Promise<T>;
  /** A request whose response is binary (an export, an image). `GET` or `POST`. */
  requestBlob(method: 'GET' | 'POST', path: string, init?: KvoxRequestInit): Promise<KvoxBlobResponse>;
  /** A `multipart/form-data` POST. The host must not set `Content-Type` itself. */
  postFormData<T>(path: string, body: FormData, init?: KvoxRequestInit): Promise<T>;
  /** A JSON request that also reports the status and headers, and resolves on `304`. */
  requestWithMeta<T>(
    method: 'GET',
    path: string,
    init?: KvoxRequestInit,
  ): Promise<KvoxResponseWithMeta<T>>;
}

/**
 * One server-sent event.
 *
 * @stability experimental
 */
export interface KvoxSseEvent {
  /** The `event:` name, `message` when the frame declared none. */
  event: string;
  /** The `id:` of the frame, when it had one. */
  id?: string;
  /** The `data:` payload, multi-line data joined with a newline. */
  data: string;
}

/**
 * Options of one connection attempt of the host SSE transport.
 *
 * @stability experimental
 */
export interface KvoxSseConnectOptions {
  /** The last event id the caller saw. The host sends it as `Last-Event-ID`. */
  lastEventId?: string;
  /** Closes the connection. */
  signal: AbortSignal;
  /** Called once the response headers have arrived (the stream is open). */
  onOpen?(): void;
  /** Called for every dispatched event. Comments and heartbeats never reach it. */
  onEvent(event: KvoxSseEvent): void;
}

/**
 * Options of a POST event stream.
 *
 * @stability experimental
 */
export interface KvoxSsePostOptions<T> {
  /** Called for every frame, with the `event:` name and the JSON-decoded data. */
  onFrame(event: string, data: T): void;
  /** Aborts the stream. */
  signal?: AbortSignal;
}

/**
 * The server-sent-events transport of a host.
 *
 * @remarks
 * `connect` is ONE attempt: it resolves when the stream ends and rejects when
 * it fails. Reconnection with backoff is `connectKvoxSse`'s job, not the
 * host's. A rejection with `status` 401 or 403 (after the host has tried to
 * renew its credentials) stops the loop; any other rejection is retried.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface KvoxSsePort {
  /** One attempt at a `GET` event stream. */
  connect(path: string, options: KvoxSseConnectOptions): Promise<void>;
  /** A `POST` that answers with an event stream (a generation that streams its tokens). */
  post<T = unknown>(path: string, body: unknown, options: KvoxSsePostOptions<T>): Promise<void>;
}

/**
 * What a part upload answers with.
 *
 * @stability experimental
 */
export interface KvoxPartResult {
  /** The storage provider's ETag of the part. */
  etag: string;
}

/**
 * The upload data plane of a host: how one part reaches its presigned URL.
 *
 * @remarks
 * Optional. Without it the upload engine sends each part with an
 * `XMLHttpRequest` (the browser transport that reports byte-level progress). A
 * host without XHR, or one that stores parts locally, implements it; progress
 * then moves per part instead of per byte.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface KvoxUploadPort {
  /** PUT one part to `url`. Rejects with a `status` on a refusal. */
  putPart(url: string, body: Blob, signal?: AbortSignal): Promise<KvoxPartResult>;
}

/**
 * The signed-in user as a slice sees them.
 *
 * @stability experimental
 */
export interface KvoxViewer {
  /** The user's id. */
  userId: string;
  /** The permission strings the user holds. */
  permissions: ReadonlySet<string>;
}

/**
 * App routes a slice links to. Each returns a path the host's router serves.
 *
 * @stability experimental
 */
export interface KvoxLinks {
  /** The page of one transcript. */
  transcript(id: string): string;
  /** The page of one note. */
  note(id: string): string;
  /** The page of one knowledge-graph entity. */
  entity(id: string): string;
  /** The page of one Ask conversation. */
  conversation(id: string): string;
}

/**
 * Deployment switches a slice reads.
 *
 * @stability experimental
 */
export interface KvoxFeatures {
  /** Connected knowledge is on. `undefined` while the host does not know yet. */
  graphEnabled: boolean | undefined;
}

/**
 * Everything a web slice reads from its host. The only coupling between the
 * domain UI and the app that mounts it.
 *
 * @remarks
 * The web edition builds it once in `apps/web/src/platform-kvox/KvoxHostBinding.tsx`
 * over its single API client; Desktop builds it over its local server. Build
 * the object with `useMemo` (or at module scope): hooks key on its identity.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface KvoxWebHost {
  /** The HTTP transport. */
  http: KvoxHttpPort;
  /** The event-stream transport. */
  sse: KvoxSsePort;
  /** The part transport of the upload engine, when the host has its own. */
  upload?: KvoxUploadPort;
  /** The signed-in user, `null` while nobody is signed in. Read per render. */
  viewer: () => KvoxViewer | null;
  /** Path builders for the pages a slice links to. */
  links: KvoxLinks;
  /** Deployment switches. Read per render. */
  features: () => KvoxFeatures;
  /**
   * A React hook that returns the id of the most recent notification whose
   * event key starts with `prefix`, or `null` when there is none.
   *
   * Optional. A page that lists records the user's own actions can change in
   * the background (a transcript that finished processing) re-reads itself when
   * the id changes, which makes the notification stream the fast path of its
   * polling. It is a hook, so it must be the SAME function for the life of the
   * host and follow the rules of hooks; a host without a notification stream
   * leaves it out and the pages poll alone. Read it through
   * {@link useKvoxLatestEventId}.
   */
  useLatestEventId?: (prefix: string) => string | null;
}

/**
 * Thrown when a packaged page or hook runs without a `KvoxWebHostProvider`.
 *
 * @stability experimental
 */
export class KvoxHostMissingError extends Error {
  /** Names the missing provider so a stack trace is self-explanatory. */
  constructor() {
    super(
      'No KvoxWebHost: a @marinoscar/kvox-web page or hook needs a <KvoxWebHostProvider host={...}> above it. ' +
        'The app binds the host once (the web edition does it in apps/web/src/platform-kvox/KvoxHostBinding.tsx).',
    );
    this.name = 'KvoxHostMissingError';
  }
}

const KvoxHostContext = createContext<KvoxWebHost | null>(null);

/**
 * Provides the host to every slice below it.
 *
 * @param props - The host and the subtree.
 * @returns The subtree inside the host context.
 *
 * @stability experimental
 */
export function KvoxWebHostProvider(props: { host: KvoxWebHost; children?: ReactNode }) {
  return createElement(KvoxHostContext.Provider, { value: props.host }, props.children);
}

/**
 * The host of the nearest provider.
 *
 * @returns The host.
 * @throws {@link KvoxHostMissingError} when there is no provider above.
 *
 * @stability experimental
 */
export function useKvoxHost(): KvoxWebHost {
  const host = useContext(KvoxHostContext);
  if (host === null) throw new KvoxHostMissingError();
  return host;
}

/**
 * The id of the most recent notification whose event key starts with `prefix`,
 * from the host's {@link KvoxWebHost.useLatestEventId}; `null` when the host
 * has none or there is no such notification.
 *
 * @param prefix - The event-key prefix, for example `transcripts.`.
 * @returns The notification id, which changes exactly when a NEW matching event arrives.
 *
 * @stability experimental
 */
export function useKvoxLatestEventId(prefix: string): string | null {
  const host = useKvoxHost();
  const hook = host.useLatestEventId;
  // A host's hook is fixed for its lifetime, so the hook order is stable.
  return hook ? hook(prefix) : null;
}

/**
 * The signed-in user, read from the host on every render.
 *
 * @returns The viewer, or `null` when nobody is signed in.
 *
 * @stability experimental
 */
export function useKvoxViewer(): KvoxViewer | null {
  return useKvoxHost().viewer();
}

/**
 * Whether the signed-in user holds a permission. `false` when nobody is signed in.
 *
 * @param permission - The exact permission string the API enforces.
 * @returns `true` when the viewer holds it.
 *
 * @stability experimental
 */
export function useHasPermission(permission: string): boolean {
  return useKvoxViewer()?.permissions.has(permission) ?? false;
}

/**
 * A predicate form of {@link useHasPermission}, for a component that checks
 * several permissions (including inside a callback).
 *
 * @returns A function answering whether the viewer holds a permission.
 *
 * @stability experimental
 */
export function useKvoxPermissionCheck(): (permission: string) => boolean {
  const viewer = useKvoxViewer();
  return (permission) => viewer?.permissions.has(permission) ?? false;
}
