// =============================================================================
// Server-sent events: the reconnect loop, and a fetch-based single attempt
// =============================================================================
//
// WHY `fetch` AND NOT `EventSource`. `EventSource` cannot send an
// `Authorization` header, and the API refuses a token in the URL (a query
// string lands in access logs, history and `Referer`). So every stream is read
// with `fetch()` and framed by `SseParser`.
//
// TWO LAYERS, so a host with another transport reuses the half that is hard:
//
//   * `host.sse.connect(path, ...)` is ONE attempt (the host owns auth and the
//     wire). `createFetchSseConnect` builds that function over `fetch` for a
//     host that has a base URL and a bearer token.
//   * `connectKvoxSse(host, path, ...)` is the LOOP around attempts: backoff
//     with jitter, a reset only after a stream held long enough, an immediate
//     retry when the network comes back, and resume with `Last-Event-ID`.
//
// RESUME. The loop remembers the `id:` of the last frame and passes it to the
// next attempt as `lastEventId`; the fetch attempt sends it as `Last-Event-ID`.
// A server that does not implement resume ignores the header and replays from
// where it likes, so a consumer that needs idempotence (the note and Ask
// streams write each delta AT its offset) must keep it either way.
// =============================================================================

import { KvoxApiError } from './errors.js';
import type { KvoxSseConnectOptions, KvoxSseEvent, KvoxWebHost } from './host.js';
import { SseParser } from './sse-parser.js';
import type { SseFrame } from './sse-parser.js';

/**
 * What a connection is doing right now, for the UI to render honestly.
 *
 * @remarks
 * `reconnecting` is distinct from `connecting`: the first attempt and a
 * recovery after a drop look identical to the network stack but not to a user,
 * who has already seen the feature working once.
 *
 * @stability experimental
 */
export type SseState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Options of {@link connectKvoxSse}.
 *
 * @stability experimental
 */
export interface KvoxSseOptions {
  /** Where to resume the first attempt, as `Last-Event-ID`. */
  lastEventId?: string;
  /** Closes the connection and ends the loop. */
  signal?: AbortSignal;
  /**
   * The stream is open and its headers have arrived. Fires on EVERY connection,
   * including every reconnect: a caller whose stream is not replayable must
   * refetch its state on it.
   */
  onOpen?(): void;
  /** One dispatched event. Heartbeat comments never reach here. */
  onEvent(event: KvoxSseEvent): void;
  /** Connection state transitions. */
  onStateChange?(state: SseState): void;
}

/** First reconnect delay; doubles per consecutive failure up to {@link SSE_RECONNECT_MAX_MS}. */
const RECONNECT_BASE_MS = 1_000;
/** The backoff ceiling. Chosen against a 25 s server heartbeat, not plucked. */
const RECONNECT_MAX_MS = 30_000;
/** How long a connection must survive before its success is believed. */
const STABLE_CONNECTION_MS = 10_000;

/**
 * One connection attempt, as the loop sees it: resolves when the stream ends,
 * rejects when it fails.
 */
interface SseAttempt {
  (context: {
    signal: AbortSignal;
    lastEventId: string | undefined;
    onOpen: () => void;
    onEvent: (event: KvoxSseEvent) => void;
  }): Promise<void>;
}

/** A rejection that ends the loop for good: the session is gone. */
function isFatal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * The loop shared by {@link connectKvoxSse} and {@link connectSse}: run
 * `attempt`, wait, run it again, until `signal` aborts or the session ends.
 */
async function runSseLoop(
  attempt: SseAttempt,
  options: KvoxSseOptions,
  retryHintMs: () => number | null,
): Promise<void> {
  const { signal, onOpen, onEvent, onStateChange } = options;
  let closed = signal?.aborted ?? false;
  let attempts = 0;
  let lastEventId = options.lastEventId;
  let controller: AbortController | null = null;
  // Cuts a backoff sleep short: `close()` and the `online` event.
  let wake: (() => void) | null = null;

  const setState = (state: SseState) => {
    if (!closed || state === 'closed') onStateChange?.(state);
  };

  const onOnline = () => {
    // The failures that produced the backoff were all the same failure, no
    // network, and it has just been fixed.
    attempts = 0;
    wake?.();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    wake?.();
    controller?.abort();
  };

  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  signal?.addEventListener('abort', close);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });

  // Exponential, capped and JITTERED: every tab disconnects at the same
  // instant when the API restarts, and an un-jittered backoff reconnects them
  // all in the same millisecond.
  const backoffMs = (): number => {
    const base = retryHintMs() ?? RECONNECT_BASE_MS;
    const capped = Math.min(RECONNECT_MAX_MS, base * 2 ** attempts);
    return capped * (0.5 + Math.random() * 0.5);
  };

  let fatal: unknown = null;
  try {
    setState('connecting');
    while (!closed) {
      controller = new AbortController();
      let openedAt: number | null = null;
      try {
        await attempt({
          signal: controller.signal,
          lastEventId,
          onOpen: () => {
            openedAt = Date.now();
            setState('open');
            onOpen?.();
          },
          onEvent: (event) => {
            if (event.id !== undefined) lastEventId = event.id;
            onEvent(event);
          },
        });
      } catch (error) {
        if (!closed && isFatal(error)) {
          // The session is over. A client that kept retrying would spend the
          // rest of the tab's life issuing 401s at a logged-out backend.
          fatal = error;
          break;
        }
      }
      if (closed) break;
      // Success is measured by DURATION, not by having connected: a server that
      // accepts and immediately drops must not reset the counter on every
      // accept, or the client hammers a struggling backend forever.
      const stable = openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_MS;
      attempts = stable ? 0 : attempts + 1;
      setState('reconnecting');
      await sleep(backoffMs());
    }
  } finally {
    closed = true;
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    signal?.removeEventListener('abort', close);
    onStateChange?.('closed');
  }
  if (fatal !== null) throw fatal;
}

/**
 * Opens an event stream through the host and keeps it open, reconnecting with
 * backoff, until `opts.signal` aborts.
 *
 * @param host - The host whose `sse.connect` makes each attempt.
 * @param path - The stream path below the API base.
 * @param opts - Callbacks, the resume point and the abort signal.
 * @returns Resolves when the loop ends because the signal aborted; rejects with
 *   the host's error when the session is over (401 or 403 after the host's own
 *   renewal attempt).
 *
 * @stability experimental
 */
export function connectKvoxSse(host: KvoxWebHost, path: string, opts: KvoxSseOptions): Promise<void> {
  return runSseLoop(
    ({ signal, lastEventId, onOpen, onEvent }) =>
      host.sse.connect(path, {
        ...(lastEventId === undefined ? {} : { lastEventId }),
        signal,
        onOpen,
        onEvent,
      }),
    opts,
    () => null,
  );
}

/**
 * What {@link createFetchSseConnect} needs from its host.
 *
 * @stability experimental
 */
export interface FetchSseConnectOptions {
  /** The API base, for example `/api`. Prepended to every path. */
  baseUrl: string;
  /**
   * The `Authorization` header value for the NEXT attempt, or `null`. A function
   * because access tokens are short and a stream outlives many of them.
   */
  authorization: () => string | null;
  /**
   * The stream answered 401: renew credentials and say whether it worked. `false`
   * ends the loop for good.
   */
  reauthenticate: () => Promise<boolean>;
}

/**
 * One `fetch`-based connection attempt: the `connect` function of a host's
 * `sse` port, for a host with a base URL and a bearer token.
 *
 * @remarks
 * Sends `Last-Event-ID` when the loop has one, renews credentials once on a 401
 * and retries the request, reads the body with a streaming decoder, and
 * resolves when the server ends the stream.
 *
 * @param options - Base URL, token source and renewal.
 * @returns A function with the signature of `KvoxSsePort.connect`.
 *
 * @stability experimental
 */
export function createFetchSseConnect(options: FetchSseConnectOptions) {
  return (path: string, connectOptions: KvoxSseConnectOptions): Promise<void> =>
    fetchAttempt(
      `${options.baseUrl}${path}`,
      options.authorization,
      options.reauthenticate,
      connectOptions,
      () => undefined,
    );
}

async function fetchAttempt(
  url: string,
  authorization: () => string | null,
  reauthenticate: () => Promise<boolean>,
  context: {
    signal: AbortSignal;
    lastEventId?: string | undefined;
    onOpen?: (() => void) | undefined;
    onEvent: (event: KvoxSseEvent) => void;
  },
  onRetryHint: (ms: number | null) => void,
): Promise<void> {
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const auth = authorization();
    if (auth) headers.Authorization = auth;
    if (context.lastEventId !== undefined) headers['Last-Event-ID'] = context.lastEventId;
    return fetch(url, {
      headers,
      signal: context.signal,
      // The refresh cookie; the bearer header is what authenticates the route.
      credentials: 'include',
      // A stream must never be served from cache.
      cache: 'no-store',
    });
  };

  let response = await send();
  if (response.status === 401) {
    // The expected failure: a stream outlives a 15-minute access token. The
    // body is discarded explicitly; an unread body pins the connection.
    await response.body?.cancel().catch(() => {});
    if (!(await reauthenticate())) throw new KvoxApiError('Unauthorized', 401);
    response = await send();
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new KvoxApiError('Unauthorized', 401);
    }
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    // Everything but 401 is a plain retry: a client that gives up on a 502
    // stays dead after the backend recovers.
    throw new Error(`Stream responded ${response.status}`);
  }

  // Headers have arrived, so the path is proven end to end.
  context.onOpen?.();

  const parser = new SseParser();
  const reader = response.body.getReader();
  // `{ stream: true }` on every decode: a multi-byte character split across two
  // network chunks must not be mangled.
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        context.onEvent(frameToEvent(frame));
      }
    }
  } finally {
    onRetryHint(parser.retryMs);
    reader.releaseLock();
  }
}

function frameToEvent(frame: SseFrame): KvoxSseEvent {
  return {
    event: frame.event,
    data: frame.data,
    ...(frame.id === null ? {} : { id: frame.id }),
  };
}

/**
 * Options of {@link connectSse}: a URL-based connection that needs no host.
 *
 * @stability experimental
 */
export interface SseOptions {
  /** Absolute or root-relative URL of the event stream. */
  url: string;
  /** The `Authorization` header value for the NEXT attempt, or `null` for none. */
  authorization: () => string | null;
  /** The stream returned 401. Renew credentials and return whether it worked. */
  reauthenticate: () => Promise<boolean>;
  /** The stream is open. Fires on every connection, including every reconnect. */
  onOpen: () => void;
  /** One dispatched frame. Heartbeat comments never reach here. */
  onFrame: (frame: SseFrame) => void;
  /** Connection state transitions. Optional. */
  onStateChange?: (state: SseState) => void;
}

/**
 * A live {@link connectSse} connection.
 *
 * @stability experimental
 */
export interface SseConnection {
  /** Closes the connection. Idempotent, and safe at any point of its life. */
  close: () => void;
}

/**
 * Opens a stream from a URL and keeps it open, reconnecting with backoff until
 * `close()` is called. Returns synchronously.
 *
 * @remarks
 * The URL-based form of the loop, for a stream service that is not yet written
 * against `KvoxWebHost`. It honours a server `retry:` directive and, unlike
 * {@link connectKvoxSse}, sends no `Last-Event-ID` (its callers resume with a
 * query parameter).
 *
 * @param options - URL, token source, renewal and callbacks.
 * @returns A handle whose `close()` ends the connection.
 *
 * @stability experimental
 */
export function connectSse(options: SseOptions): SseConnection {
  const controller = new AbortController();
  let retryMs: number | null = null;
  void runSseLoop(
    (context) =>
      fetchAttempt(
        options.url,
        options.authorization,
        options.reauthenticate,
        // No `Last-Event-ID`: the callers of this form resume with their own
        // query parameter (`?lastEventId=`) and seed their buffer to match.
        { ...context, lastEventId: undefined },
        (ms) => {
          retryMs = ms;
        },
      ),
    {
      signal: controller.signal,
      onOpen: options.onOpen,
      onEvent: (event) =>
        options.onFrame({ event: event.event, data: event.data, id: event.id ?? null }),
      ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }),
    },
    () => retryMs,
  ).catch(() => {
    // A fatal rejection (the session ended) is reported through
    // `onStateChange('closed')`; nothing else listens.
  });
  return { close: () => controller.abort() };
}
