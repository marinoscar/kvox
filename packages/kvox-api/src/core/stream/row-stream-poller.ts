import { Observable } from 'rxjs';

import type { KvoxStreamMessage } from './sse-stream.js';

// =============================================================================
// KvoxRowStreamPoller: the poll loop behind a durable-row SSE stream (issue #497, epic #491)
// =============================================================================
//
// Two streams in the domain are a VIEW over one durable row a queue job writes as it goes:
// the note generation stream and the Ask answer stream. They share everything except
// what a row means, so the loop lives here and each service supplies three small
// callbacks (`read`, `onRow`, `onGone`/`onCap`).
//
// -----------------------------------------------------------------------------
// ⚠ IT IS A POLL. AN IN-PROCESS `EventEmitter` IS REJECTED — DO NOT "OPTIMISE" THIS INTO A PUSH.
// -----------------------------------------------------------------------------
//
// The job that writes the row may run on ANY API replica, and an emitter lives in one
// process's heap: on a second replica the stream would hang while the job reports a healthy
// turn. An emitter also has no memory (a late attach shows a blank pane) and nothing to
// resume from (no `Last-Event-ID`). Reading durable state buys all three for free, at the
// cost of one indexed single-row read per interval for the seconds-to-minutes one job lasts.
// The full argument is `docs/specs/notes.md` §5.2.
//
// NOTHING HERE WRITES ANYTHING. A bug in this file can cost a reader a live view; it cannot
// cost the job's output.
// =============================================================================

/**
 * Milliseconds between reads of the row. The notes spec (§5.2) asks for roughly 150 to 300 ms.
 *
 * @stability experimental
 */
export const DEFAULT_STREAM_POLL_INTERVAL_MS = 250;

/**
 * How often an idle connection is sent a comment line.
 *
 * 25 s sits comfortably under the shortest idle timeout in common use (30 s) and under
 * nginx's `proxy_read_timeout`, with room for a scheduling delay. It matters more for a
 * model-backed stream than for most, because the gap it has to survive is routine: a model
 * can think for tens of seconds before its first token, and an SSE connection that has sent
 * nothing is indistinguishable, to everything between the browser and this process, from a
 * dead one. A COMMENT (`: ...`), never an event, so a heartbeat can never be mistaken for a
 * delta by a consumer that forgot to check the event name.
 *
 * @stability experimental
 */
export const DEFAULT_STREAM_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Slack on top of the job's own timeout before a connection gives up.
 *
 * The cap has to be LONGER than the job can legitimately run, or a healthy long job would
 * have its stream torn down at the finish line; and FINITE, or one wedged job pins a
 * connection (and a Postgres poll every interval) forever. One minute of margin covers the
 * gap between the job's own deadline and the reaper actually settling the row.
 *
 * @stability experimental
 */
export const STREAM_DURATION_CAP_MARGIN_MS = 60_000;

/**
 * What one connection runs on.
 *
 * @stability experimental
 */
export interface KvoxRowStreamPollerOptions {
  /** Milliseconds between reads of the row. */
  pollIntervalMs: number;
  /** Milliseconds between heartbeat comments. */
  heartbeatMs: number;
  /** The hard ceiling on one connection, in milliseconds. */
  durationCapMs: number;
  /** Reads the wall clock. Injected so a test drives the cap exactly. */
  now?: () => number;
}

/**
 * Why a connection closed. `gone`, `cap` and `client` are the poller's own; any other string
 * is whatever {@link KvoxRowStreamHandlers.onRow} returned.
 *
 * @stability experimental
 */
export type KvoxRowStreamCloseReason = 'gone' | 'cap' | 'client' | (string & {});

/**
 * The three things a stream says about its row.
 *
 * @stability experimental
 */
export interface KvoxRowStreamHandlers<Row, Message extends KvoxStreamMessage = KvoxStreamMessage> {
  /**
   * One indexed read by primary key, `null` when the row no longer exists. A throw is a
   * transient failure: it is passed to `onReadError` and the next poll runs on schedule.
   */
  read(): Promise<Row | null>;

  /**
   * Emits the frames the row's new state calls for, and decides whether the stream ends.
   *
   * @param row - the row as just read.
   * @param emit - sends one frame.
   * @returns a close reason when the row is settled (the stream completes after this poll's
   *   frames), or `null` to keep tailing.
   */
  onRow(row: Row, emit: (message: Message) => void): string | null;

  /**
   * The row is gone (cascade, sweep): emit the closing frame.
   *
   * @param emit - sends one frame.
   */
  onGone(emit: (message: Message) => void): void;

  /**
   * The duration cap was reached before the row settled: emit the closing frame. The job
   * is untouched; this is a client-facing safety net.
   *
   * @param emit - sends one frame.
   */
  onCap(emit: (message: Message) => void): void;

  /**
   * A transient read failure, for the log. Optional.
   *
   * @param error - what `read` threw.
   */
  onReadError?(error: unknown): void;

  /**
   * The connection closed, for the debug log. Optional.
   *
   * @param reason - why.
   */
  onClose?(reason: KvoxRowStreamCloseReason): void;
}

/**
 * Tails one durable row as an SSE observable.
 *
 * COLD AND PER-SUBSCRIBER: everything is allocated inside the subscribe function, so a
 * connection created and never subscribed starts no timer and holds no resource.
 *
 * @example
 * ```ts
 * const poller = new KvoxRowStreamPoller({ pollIntervalMs: 250, heartbeatMs: 25_000, durationCapMs: 360_000 });
 * return poller.stream({ read, onRow, onGone, onCap });
 * ```
 *
 * @stability experimental
 */
export class KvoxRowStreamPoller {
  private readonly now: () => number;

  /**
   * @param options - the interval, heartbeat and cap one connection runs on.
   */
  constructor(private readonly options: KvoxRowStreamPollerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The observable behind one SSE connection.
   *
   * @param handlers - what to read and what a row means.
   * @returns an observable of frames that completes when the row settles, vanishes, the cap
   *   is reached or the client unsubscribes.
   */
  stream<Row, Message extends KvoxStreamMessage = KvoxStreamMessage>(
    handlers: KvoxRowStreamHandlers<Row, Message>,
  ): Observable<Message> {
    const { pollIntervalMs, heartbeatMs, durationCapMs } = this.options;
    const now = this.now;

    return new Observable<Message>((observer) => {
      const startedAt = now();

      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      const emit = (message: Message): void => {
        observer.next(message);
      };

      // An immediate comment, before anything else. NOT DECORATION: it commits the response
      // headers, which `SseStream` otherwise defers until the first message, so a client
      // attaching to a model that has not produced a token yet can tell "connected and
      // waiting" from "still connecting", and a buffering proxy does not hold a zero-byte
      // response open through its own idle timeout.
      observer.next({ comment: 'connected' } as Message);

      const heartbeat = setInterval(() => {
        observer.next({ comment: 'heartbeat' } as Message);
      }, heartbeatMs);

      // `unref` so an open connection can never be the reason this process refuses to exit.
      // `?.` because a fake-timer environment need not implement it.
      heartbeat.unref?.();

      const finish = (reason: KvoxRowStreamCloseReason): void => {
        closed = true;
        clearInterval(heartbeat);
        handlers.onClose?.(reason);
        observer.complete();
      };

      const schedule = (): void => {
        if (closed) return;

        pollTimer = setTimeout(() => {
          void poll();
        }, pollIntervalMs);
        pollTimer.unref?.();
      };

      const poll = async (): Promise<void> => {
        if (closed) return;

        let row: Row | null;

        try {
          row = await handlers.read();
        } catch (error) {
          // A TRANSIENT READ FAILURE MUST NOT CLOSE THE STREAM. The durable state is
          // untouched and the next poll is one interval away; tearing the connection down
          // would turn one blipped query into a visible failure for a job that is fine.
          // The duration cap still bounds how long this can go on.
          handlers.onReadError?.(error);
          schedule();

          return;
        }

        // The client may have gone away while that read was in flight.
        if (closed) return;

        if (!row) {
          handlers.onGone(emit);
          finish('gone');

          return;
        }

        // Frames first, in this same poll, so the last text written before the job settled
        // is never stranded behind the frame that closes the stream.
        const settled = handlers.onRow(row, emit);

        if (settled !== null) {
          finish(settled);

          return;
        }

        // The hard duration cap: the job is presumably wedged or was reaped. A CLIENT-FACING
        // SAFETY NET layered on top of the queue's own recovery, never a substitute for it.
        if (now() - startedAt >= durationCapMs) {
          handlers.onCap(emit);
          finish('cap');

          return;
        }

        schedule();
      };

      // The first poll is IMMEDIATE, not one interval away: a late attach answers "here is
      // the whole buffer, and it is done" in a single round trip.
      void poll();

      // The client disconnected (tab closed, navigation, network drop). Nest unsubscribes on
      // the raw socket's `close`, which runs this, and NOTHING ABOUT THE JOB IS AFFECTED: it
      // keeps running and keeps flushing. Idempotent by construction.
      return () => {
        if (!closed) {
          closed = true;
          handlers.onClose?.('client');
        }
        clearInterval(heartbeat);
        if (pollTimer) clearTimeout(pollTimer);
      };
    });
  }
}
