import type { NodeEngineEvent, NodeSnapshot } from './node-events.js';
import type { LogRecord } from './logger.js';

// =============================================================================
// The daemon's IPC protocol  (issue #275, epic #254)
// =============================================================================
//
// NDJSON — one JSON object per line — over a Unix domain socket (a named pipe
// on Windows).
//
// WHY NOT A TCP PORT: a network-reachable control channel for a purely local
// process would need authentication it does not otherwise need, and would be
// reachable from every container on the same host network. A `0600` socket is
// bounded by filesystem permissions, which is exactly the boundary that
// already protects the token in the config file beside it.
//
// WHY NOT A PIDFILE AND SIGNALS ALONE: signals cannot carry a snapshot back,
// and cannot change concurrency. Inspecting a running worker by stopping it
// discards precisely the state somebody wanted to inspect.
//
// FRAMING IS THE THING TO GET RIGHT. A socket delivers bytes, not messages: a
// single `write` can arrive as three `data` events, and three writes can arrive
// as one. `NdjsonParser` below is the only place that is handled, and it is
// tested against split and partial reads directly.
// =============================================================================

/** Server → client. */
export type DaemonMessage =
  | { type: 'snapshot'; snapshot: NodeSnapshot }
  | { type: 'log-tail'; lines: LogRecord[] }
  | { type: 'event'; event: NodeEngineEvent }
  | { type: 'ack'; command: string; detail?: unknown }
  | { type: 'error'; message: string };

/** Client → server. */
export type ClientCommand =
  | { type: 'status' }
  | { type: 'set-concurrency'; value: number }
  | { type: 'drain' }
  | { type: 'stop' }
  | { type: 'heap-snapshot' };

/** Above this backlog a client is dropped. See `daemon.ts` for why it matters. */
export const MAX_CLIENT_BACKLOG_BYTES = 1024 * 1024;

/** Concurrency bounds accepted over IPC, matching the server's own cap. */
export const MIN_IPC_CONCURRENCY = 1;
export const MAX_IPC_CONCURRENCY = 64;

/**
 * Incremental NDJSON framing.
 *
 * Holds a partial trailing line between chunks, which is the whole job. A
 * blank line is skipped rather than parsed (a trailing newline produces one on
 * every flush), and a line that is not JSON is handed to `onError` rather than
 * throwing — a malformed line from a buggy client must not tear down a socket
 * carrying good ones.
 */
export class NdjsonParser {
  private buffer = '';

  constructor(
    private readonly onMessage: (value: unknown) => void,
    private readonly onError?: (line: string, error: unknown) => void,
  ) {}

  push(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handle(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /** Anything still buffered when the peer closed without a final newline. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const line = this.buffer;
    this.buffer = '';
    this.handle(line);
  }

  private handle(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;
    try {
      this.onMessage(JSON.parse(line));
    } catch (error) {
      this.onError?.(line, error);
    }
  }
}

/** Serialise one message as a framed line. The only place `\n` is appended. */
export function frame(message: DaemonMessage | ClientCommand): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Narrow an arbitrary parsed value to a command.
 *
 * Returns `undefined` for anything unrecognised rather than throwing, so the
 * daemon answers with an `error` message and keeps the connection.
 */
export function parseCommand(value: unknown): ClientCommand | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;

  switch (body.type) {
    case 'status':
    case 'drain':
    case 'stop':
    case 'heap-snapshot':
      return { type: body.type };
    case 'set-concurrency': {
      const raw = body.value;
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
      return { type: 'set-concurrency', value: raw };
    }
    default:
      return undefined;
  }
}
