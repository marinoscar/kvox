/**
 * A fetch-based Server-Sent Events client.
 *
 * Issue #127, epic #109.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AT ALL — `EventSource` CANNOT SEND AN AUTHORIZATION HEADER
 * =============================================================================
 *
 * `GET /api/notifications/stream` is guarded by the ordinary bearer `@Auth()`,
 * exactly like every other endpoint. The native `EventSource` constructor takes
 * a URL and `withCredentials`, and NOTHING ELSE — there is no headers argument
 * and no way to add one. So the browser's built-in SSE client cannot
 * authenticate against that route.
 *
 * The two ways out, and why this is the one taken:
 *
 *   1. REJECTED — `?token=…` on the stream URL. The API refused this
 *      deliberately (see the long note on `NotificationsController.stream`), and
 *      the refusal is right: a URL query string is written verbatim into the
 *      nginx access log, kept in browser history, and forwarded in `Referer` to
 *      any third party the page later touches. That turns a live bearer
 *      credential into something replayable out of a log file retained for
 *      months and readable by people who are not supposed to hold sessions.
 *      Cheap transport is not worth credentials in logs.
 *
 *   2. CHOSEN — `fetch()` with a real `Authorization` header, reading
 *      `response.body` as a `ReadableStream` and parsing the SSE framing here.
 *      `fetch` takes arbitrary headers; the cost is that everything
 *      `EventSource` does for free — framing, reconnection, backoff — has to be
 *      written, which is what the rest of this file is.
 *
 * WHY HAND-ROLLED RATHER THAN A DEPENDENCY (`@microsoft/fetch-event-source`).
 * This worktree cannot take a new dependency, and on inspection it does not
 * need one: the whole client is the parser below plus a retry loop, both of
 * which are small, fully testable without a network, and — unlike a
 * dependency — able to reuse this app's own `ApiService` token and refresh
 * machinery directly rather than through a callback shim. A library would also
 * bring its own opinions about 401 handling, which is precisely the part that
 * has to match `services/api.ts` exactly.
 *
 * =============================================================================
 * WHAT THIS CLIENT DOES NOT DO, AND MUST NOT BE MADE TO DO
 * =============================================================================
 *
 * IT DOES NOT GUARANTEE DELIVERY. Anything the server publishes while this
 * connection is down is GONE: the API holds no buffer, honours no
 * `Last-Event-ID`, and has no replay log (`NotificationStreamService`'s header
 * says so in as many words). This client therefore reports every (re)connection
 * through `onOpen`, and ITS CALLER IS REQUIRED TO REFETCH on that signal. Do
 * not add replay here; the `notifications` table is the source of truth and one
 * indexed query after a gap is strictly more reliable than any cursor built on
 * top of a stream.
 *
 * `lastEventId` is parsed and tracked because the SSE grammar has the field and
 * a parser that silently dropped it would be wrong — but it is NOT sent back as
 * `Last-Event-ID` on reconnect, because the server does not implement it and a
 * header that looks like resumption but resumes nothing is worse than no header
 * at all.
 */

// =============================================================================
// The parser — pure, synchronous, and free of both DOM and network
// =============================================================================

/** One dispatched SSE event. */
export interface SseFrame {
  /**
   * The `event:` name, or `'message'` when the frame declared none.
   *
   * Defaulted here rather than left `undefined` so a consumer switching on the
   * name never has to spell the default itself. The API always names its
   * frames (`notification`), so a `'message'` arriving is a signal that
   * something upstream changed.
   */
  event: string;
  /**
   * The `data:` payload, with multiple `data:` lines joined by `\n` and the
   * trailing newline removed, per the SSE grammar.
   */
  data: string;
  /** The `id:` field of this frame, or `null`. Tracked, never sent back. */
  id: string | null;
}

/**
 * An incremental SSE stream parser.
 *
 * Fed decoded text in arbitrary chunks — a network read boundary can land
 * anywhere, including in the middle of a UTF-8 sequence, in the middle of a
 * field name, or between the CR and LF of one line terminator — and emits whole
 * frames only. Every one of those splits is a real thing that happens under
 * load and each has its own comment below.
 *
 * Deliberately a plain class with no I/O so the framing rules can be tested by
 * calling a method with a string.
 */
export class SseParser {
  /** Bytes seen but not yet terminated by a line ending. */
  private buffer = '';

  /** The event-type buffer, per spec: reset to '' after every dispatch. */
  private eventType = '';

  /** The data buffer, per spec: accumulated across `data:` lines. */
  private data = '';

  /** This frame's `id:`, distinct from `lastEventId` below. */
  private frameId: string | null = null;

  /**
   * The last non-null `id:` seen on the stream.
   *
   * Public because it is genuinely part of the stream's state, and read by
   * nothing today — see the header on why it is not sent back.
   */
  lastEventId: string | null = null;

  /**
   * The server's most recent `retry:` directive, in milliseconds, or `null`.
   *
   * A STREAM-LEVEL directive, not a per-frame one: it sets the reconnection
   * delay for every subsequent reconnect until the server says otherwise, which
   * is why it lives on the parser rather than on `SseFrame`. This API never
   * sends one; it is honoured anyway because ignoring a server that asks to be
   * reconnected to more slowly is how a client turns a struggling backend into
   * a hammered one.
   */
  retryMs: number | null = null;

  /**
   * Feed one decoded chunk; get back every frame it completed.
   *
   * @param chunk decoded text. MUST come from a streaming decoder — see
   *        `TextDecoder({ stream: true })` at the call site. Decoding each
   *        network chunk independently corrupts any multi-byte character that
   *        straddles a chunk boundary, which for this API means a notification
   *        body with an accent or an emoji in it arrives mangled roughly
   *        whenever it is unlucky about packet size.
   */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;

    const frames: SseFrame[] = [];
    let start = 0;
    let i = 0;

    // Line terminators in SSE are CRLF, LF **or** bare CR — all three, which is
    // why this is a hand-written scan rather than `split('\n')`.
    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (ch === '\n') {
        this.handleLine(this.buffer.slice(start, i), frames);
        i += 1;
        start = i;
      } else if (ch === '\r') {
        // A CR AT THE VERY END OF WHAT WE HOLD IS AMBIGUOUS: it is either a
        // bare-CR terminator, or the first half of a CRLF whose LF is in the
        // next network chunk. Treating it as a terminator now would emit the
        // line and then treat the stray LF as an EMPTY line, dispatching a
        // half-built frame. So stop, leave the CR in the buffer, and decide
        // when more bytes arrive.
        if (i === this.buffer.length - 1) break;

        this.handleLine(this.buffer.slice(start, i), frames);
        i += this.buffer[i + 1] === '\n' ? 2 : 1;
        start = i;
      } else {
        i += 1;
      }
    }

    // Keep the unterminated remainder (including a trailing CR we stopped on).
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  private handleLine(line: string, frames: SseFrame[]): void {
    // A BLANK LINE IS THE DISPATCH SIGNAL. Not a separator to skip.
    if (line === '') {
      const frame = this.dispatch();
      if (frame) frames.push(frame);
      return;
    }

    // A COMMENT. `: heartbeat` and the opening `: connected` both land here and
    // are discarded, which is exactly what they are for: they are bytes on the
    // wire that keep nginx and every NAT table in the path from reaping an idle
    // connection, and they must NEVER surface to the page as a message. See
    // `HEARTBEAT_INTERVAL_MS` in `notification-stream.service.ts`.
    //
    // They are not entirely inert to this client either — a comment arriving is
    // a read completing, so it is what keeps the reconnect loop below from ever
    // seeing an idle stream as a dead one.
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    let field: string;
    let value: string;

    if (colon === -1) {
      // A field name with no value, e.g. a bare `data`. Legal, and means an
      // empty value — NOT a line to ignore.
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // EXACTLY ONE leading space is stripped, per spec. `data:  x` carries a
      // value of ` x`, and trimming would corrupt payloads whose JSON was
      // pretty-printed or whose text legitimately begins with whitespace.
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        this.eventType = value;
        break;

      case 'data':
        // Multiple `data:` lines concatenate with `\n` between them. This is
        // what makes a JSON payload containing a newline transmissible, and
        // getting it wrong turns a multi-line frame into unparseable JSON.
        this.data += value + '\n';
        break;

      case 'id':
        // Per spec, an id containing a NUL is ignored rather than honoured.
        if (!value.includes('\0')) {
          this.frameId = value;
          this.lastEventId = value;
        }
        break;

      case 'retry':
        // Digits only. `retry: soon` is ignored rather than becoming `NaN` and
        // poisoning the backoff arithmetic into scheduling a reconnect that
        // never fires.
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;

      default:
        // Unknown field. Ignored, per spec — that is what makes it safe for the
        // server to add fields later.
        break;
    }
  }

  private dispatch(): SseFrame | null {
    // AN EMPTY DATA BUFFER DISPATCHES NOTHING. Per spec, and load-bearing here:
    // a run of blank lines, or a blank line following a comment-only exchange,
    // must not manufacture an empty `message` event that a consumer then tries
    // to `JSON.parse`.
    if (this.data === '') {
      this.eventType = '';
      this.frameId = null;
      return null;
    }

    const frame: SseFrame = {
      event: this.eventType === '' ? 'message' : this.eventType,
      // Strip the ONE trailing newline the accumulation above always adds.
      // `trimEnd()` would be wrong: a payload legitimately ending in a blank
      // line would lose it.
      data: this.data.slice(0, -1),
      id: this.frameId,
    };

    this.eventType = '';
    this.data = '';
    this.frameId = null;

    return frame;
  }
}

// =============================================================================
// The connection — one long-lived fetch, retried forever
// =============================================================================

/**
 * What the connection is doing right now, for the UI to render honestly.
 *
 * `'reconnecting'` is deliberately distinct from `'connecting'`: the first
 * connection attempt and a recovery after a drop look identical to the network
 * stack but not to a user, who has already seen the feature working once.
 */
export type SseState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseOptions {
  /** Absolute or root-relative URL of the event stream. */
  url: string;
  /**
   * The `Authorization` header value for the NEXT attempt, or `null` for none.
   *
   * A FUNCTION, called fresh on every attempt, not a captured string. Access
   * tokens are 15 minutes and this connection is meant to outlive many of them;
   * a value read once at setup would be stale on exactly the reconnect that
   * follows a long sleep — the moment reconnection matters most.
   */
  authorization: () => string | null;
  /**
   * The stream returned 401. Renew credentials and return whether it worked.
   *
   * Returning `false` STOPS the loop permanently — the session is gone, and a
   * client that kept retrying would spend the rest of the tab's life issuing
   * 401s at a logged-out backend.
   */
  reauthenticate: () => Promise<boolean>;
  /**
   * The stream is open and its headers have arrived.
   *
   * ⚠️ FIRES ON EVERY CONNECTION, INCLUDING EVERY RECONNECT, AND THE CALLER MUST
   * REFETCH ON IT. See this file's header: nothing published during the gap is
   * replayed, so this callback is the only thing standing between a dropped
   * connection and a permanently stale unread count.
   */
  onOpen: () => void;
  /** One dispatched frame. Heartbeat comments never reach here. */
  onFrame: (frame: SseFrame) => void;
  /** Connection state transitions, for rendering. Optional. */
  onStateChange?: (state: SseState) => void;
}

/** A live connection. Idempotent `close()`. */
export interface SseConnection {
  close: () => void;
}

/**
 * First reconnect delay. Doubles per consecutive failure up to the cap.
 *
 * The server may override it with a `retry:` directive; it sends none today.
 */
const RECONNECT_BASE_MS = 1_000;

/**
 * The backoff ceiling.
 *
 * 30 seconds, chosen against the heartbeat rather than plucked: the server
 * proves liveness every 25s (`HEARTBEAT_INTERVAL_MS`), so a ceiling in the same
 * order of magnitude means a tab recovers from a backend restart within about
 * one heartbeat period of it coming back, while a hundred idle tabs still cost
 * the backend only a handful of connection attempts per second between them.
 */
const RECONNECT_MAX_MS = 30_000;

/**
 * How long a connection must survive before its success is believed.
 *
 * A connection is judged by how long it LASTED, not by whether it connected —
 * see `registerOutcome`, which is the only thing that reads this. Ten seconds
 * is comfortably longer than an accept-then-drop cycle and comfortably shorter
 * than the 25-second heartbeat, so any stream that has received even one
 * heartbeat is well past it.
 */
const STABLE_CONNECTION_MS = 10_000;

/**
 * Open an SSE connection and keep it open, reconnecting with backoff until
 * `close()` is called.
 *
 * Returns synchronously; the connection is established in the background. The
 * returned `close()` aborts an in-flight request, cancels a pending retry, and
 * detaches every listener — it is what an effect cleanup calls, and it must
 * remain safe to call at any point in the lifecycle, including before the first
 * fetch has resolved.
 */
export function connectSse(options: SseOptions): SseConnection {
  const { url, authorization, reauthenticate, onOpen, onFrame, onStateChange } = options;

  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;

  // Resolver for an in-progress backoff sleep, so `close()` and the `online`
  // event can cut a 30-second wait short instead of leaving the app
  // disconnected long after the reason to be disconnected has gone.
  let wake: (() => void) | null = null;

  const setState = (state: SseState) => {
    if (!closed || state === 'closed') onStateChange?.(state);
  };

  /**
   * The network came back.
   *
   * Reconnect IMMEDIATELY and from a clean slate: a laptop that slept for an
   * hour wakes deep in the backoff ceiling, and without this the user stares at
   * a stale bell for up to 30 seconds after their connection is demonstrably
   * fine. The attempt counter is reset too, because the failures that produced
   * it were all the same failure — no network — and it has just been fixed.
   */
  const onOnline = () => {
    attempt = 0;
    wake?.();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }

  /** A backoff wait that `close()` or `online` can interrupt. */
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

  /**
   * How long to wait before attempt number `attempt`.
   *
   * Exponential, capped, and JITTERED. The jitter is not decoration: every tab
   * of every user disconnects at the same instant when the API restarts, so an
   * un-jittered backoff reconnects them all in the same millisecond and turns
   * one restart into a thundering herd against a process that has just started.
   * Spreading each delay across the upper half of its window keeps the average
   * wait honest while smearing the arrivals.
   */
  const backoffMs = (): number => {
    const base = parser.retryMs ?? RECONNECT_BASE_MS;
    const capped = Math.min(RECONNECT_MAX_MS, base * 2 ** attempt);
    return capped * (0.5 + Math.random() * 0.5);
  };

  // Hoisted so `backoffMs` can read a `retry:` directive from the connection
  // that just dropped. Replaced per attempt — a parser holding half a frame
  // from a dead connection must never prepend it to the next one's first frame.
  let parser = new SseParser();

  /**
   * When the current attempt's stream opened, or `null` if it never did.
   *
   * At `connectSse` scope rather than inside `attemptOnce` because BOTH exit
   * paths have to consult it and only one of them is inside that function: a
   * stream can end cleanly (the server completing every subscriber during a
   * rolling deploy) or blow up mid-read (a socket reset), and the second lands
   * in `run`'s catch.
   */
  let openedAt: number | null = null;

  /**
   * Record how the attempt that just ended went, for the backoff.
   *
   * THE ONE PLACE `attempt` MOVES, and the reason it is a function rather than
   * an `attempt = 0` at the moment of connection: resetting on OPEN would
   * defeat the backoff against the worst failure mode there is. A server that
   * accepts the connection and then immediately drops it — a proxy still
   * buffering the stream, an API mid-restart, a load balancer with a dead
   * upstream — would reset the counter on every accept, and the client would
   * hammer a struggling backend once a second forever while every log said the
   * connection was succeeding.
   *
   * So success is measured by DURATION, not by having connected at all: only a
   * stream that actually held open for `STABLE_CONNECTION_MS` earns a reset.
   */
  const registerOutcome = () => {
    const stable = openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_MS;
    attempt = stable ? 0 : attempt + 1;
  };

  /**
   * One connection attempt, from fetch to end-of-stream.
   *
   * @returns `'retry'` to reconnect after a backoff, `'immediate'` to reconnect
   *          without one (credentials were just renewed, so the failure is
   *          already understood and fixed), or `'stop'` to end the loop.
   */
  const attemptOnce = async (): Promise<'retry' | 'immediate' | 'stop'> => {
    controller = new AbortController();
    parser = new SseParser();
    // Cleared per attempt: a stale `openedAt` from the previous connection
    // would make a fetch that never connected look like a stable one.
    openedAt = null;

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const auth = authorization();
    if (auth) headers.Authorization = auth;

    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      // The refresh cookie, matching `ApiService.request`. The bearer header
      // above is what actually authenticates this route; the cookie is here so
      // the two code paths cannot diverge in what they present.
      credentials: 'include',
      // A stream must never be served from cache. Without this a proxy or the
      // browser can hand back a completed copy of a previous response, and the
      // client sits "connected" to a body that ended long ago.
      cache: 'no-store',
    });

    if (response.status === 401) {
      // THE EXPECTED FAILURE, not an exceptional one: this connection is
      // designed to outlive a 15-minute access token, so every long-lived tab
      // lands here eventually. Renew once and reconnect without a backoff — the
      // cause is known and already fixed, so making the user wait would be
      // arbitrary. If renewal fails the session is genuinely over and the loop
      // stops rather than hammering a logged-out backend forever.
      //
      // The body is explicitly discarded: an unread body holds the connection
      // in the pool until GC, and this path can run many times per session.
      await response.body?.cancel().catch(() => {});
      const renewed = await reauthenticate();
      return renewed ? 'immediate' : 'stop';
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      // Everything else — 502 from a restarting API, 404 from a bad deploy, a
      // response with no body at all — is a plain retry. No status is treated
      // as permanent except the 401 above, because a client that gives up on a
      // 502 stays dead after the backend recovers.
      throw new Error(`Stream responded ${response.status}`);
    }

    // HEADERS HAVE ARRIVED, so the path is proven end to end — through nginx,
    // through the guard, into the handler. The API forces this moment by
    // sending `: connected` immediately (Nest's `SseStream` defers headers
    // until the first message, so a silent server would leave this `await`
    // pending indefinitely and no `onOpen` would ever fire).
    openedAt = Date.now();
    setState('open');
    onOpen();

    const reader = response.body.getReader();
    // `{ stream: true }` on every decode — see `SseParser.push`.
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          onFrame(frame);
        }
      }
    } finally {
      // Releasing the lock lets the body be collected even when the loop exits
      // by abort rather than by end-of-stream.
      reader.releaseLock();
    }

    // The server ended the stream — a rolling deploy calling `complete()` on
    // every subscriber (`onModuleDestroy`), or an idle proxy giving up.
    // Reconnect, forgiving the backoff only if the connection actually held.
    registerOutcome();
    return 'retry';
  };

  const run = async () => {
    setState('connecting');

    while (!closed) {
      let outcome: 'retry' | 'immediate' | 'stop' = 'retry';

      try {
        outcome = await attemptOnce();
      } catch {
        // EVERY failure lands here and is treated identically: an abort from
        // `close()`, a DNS failure, a TLS error, a mid-stream socket reset. The
        // `closed` check immediately below is what separates "we tore this
        // down" from "the network did", and it is the only distinction that
        // matters — nothing else changes what happens next, which is to wait
        // and try again.
        //
        // Scored the same way a clean end is, so a connection that held for an
        // hour and then had its socket reset retries promptly, while one that
        // opens and explodes within a second backs off like any other failure.
        registerOutcome();
      }

      if (closed) break;
      if (outcome === 'stop') break;

      setState('reconnecting');
      if (outcome === 'retry') await sleep(backoffMs());
    }

    setState('closed');
  };

  void run();

  return {
    close: () => {
      // Idempotent: `closed` short-circuits, and abort/clearTimeout are both
      // safe twice. React 18+ mounts effects twice in StrictMode, so a cleanup
      // that could only run once would leave a second connection open in
      // development and nowhere else — the worst possible place for a bug to
      // hide.
      if (closed) return;
      closed = true;

      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }

      // Cancel a pending backoff first so the loop wakes, observes `closed` and
      // exits, rather than sitting on a timer for up to 30 seconds after the
      // component that owned it has gone.
      wake?.();
      controller?.abort();
    },
  };
}
