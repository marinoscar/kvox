import { connectToDaemon, DaemonNotRunningError, type DaemonClient } from './daemon.js';
import type { DaemonMessage } from './ipc-protocol.js';
import type { LogRecord } from './logger.js';
import type { NodeEngineEvent, NodeSnapshot } from './node-events.js';

// =============================================================================
// The TUI's data source  (issue #279, epic #254)
// =============================================================================
//
// The dashboard is mostly a matter of rendering a stream that already exists:
// the daemon pushes a snapshot on connect, then a log tail, then every engine
// event live. So this module is the whole non-visual half of the screen — and
// it lives here rather than in `tui/` so it can be tested without ink, without
// a terminal, and without React.
//
// -----------------------------------------------------------------------------
// ATTACHING IS READ-ONLY, AND THAT IS A DESIGN DECISION
// -----------------------------------------------------------------------------
//
// This source NEVER sends a command. Not `status`, not `set-concurrency`,
// nothing — the daemon volunteers everything on connect. Two consequences,
// both deliberate:
//
//   1. An operator can inspect a HEADLESS worker — a systemd unit, a
//      container running production work — without perturbing it, and
//      detaching leaves it running untouched.
//
//   2. A TUI that can accidentally stop production work is a liability. The
//      useful mutations (`set-concurrency`, `stop`) are already one-line
//      commands; putting them behind a highlighted row in a full-screen app
//      is how somebody stops a fleet member by leaning on the keyboard.
//
// -----------------------------------------------------------------------------
// RECONNECTION
// -----------------------------------------------------------------------------
//
// A worker RESTARTS: the memory valve exits deliberately (#277) and a
// supervisor brings it back. A dashboard that died with it would be useless in
// exactly the situation somebody opened it for, so a closed connection is
// retried until `stop()` — and `stop()` is the only thing that ends the loop,
// so a teardown can never leave a timer behind.
// =============================================================================

/** How many log lines and events the dashboard keeps. */
export const MAX_DASHBOARD_LINES = 200;

export interface DashboardState {
  connected: boolean;
  /** Whether a daemon was ever reached. Distinguishes "starting" from "gone". */
  everConnected: boolean;
  snapshot: NodeSnapshot | undefined;
  logs: LogRecord[];
  events: NodeEngineEvent[];
  /** The last connection failure, for the frame's notice line. */
  error: string | undefined;
  attempts: number;
}

export interface DashboardSourceOptions {
  socketPath: string;
  onChange: (state: DashboardState) => void;
  /** Test seams. */
  connect?: typeof connectToDaemon | undefined;
  reconnectDelayMs?: number | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
  maxLines?: number | undefined;
}

export class NodeDashboardSource {
  private readonly options: DashboardSourceOptions;
  private readonly maxLines: number;
  private client: DaemonClient | undefined;
  private timer: unknown;
  private stopped = false;

  private state: DashboardState = {
    connected: false,
    everConnected: false,
    snapshot: undefined,
    logs: [],
    events: [],
    error: undefined,
    attempts: 0,
  };

  constructor(options: DashboardSourceOptions) {
    this.options = options;
    this.maxLines = options.maxLines ?? MAX_DASHBOARD_LINES;
  }

  getState(): DashboardState {
    return this.state;
  }

  /** Attach, and keep attaching. Resolves once the first attempt has settled. */
  async start(): Promise<void> {
    await this.attach();
  }

  /**
   * Detach. The daemon is NOT told, and is not affected in any way.
   *
   * Idempotent, and it clears the reconnect timer — a source that left one
   * behind would keep a finished ink process alive, which looks like a hang.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      (this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout)))(this.timer);
      this.timer = undefined;
    }
    this.client?.close();
    this.client = undefined;
    this.publish({ connected: false });
  }

  private async attach(): Promise<void> {
    if (this.stopped) return;
    this.publish({ attempts: this.state.attempts + 1 });

    const connect = this.options.connect ?? connectToDaemon;

    try {
      this.client = await connect({
        socketPath: this.options.socketPath,
        onMessage: (message) => this.receive(message),
        onClose: () => {
          this.client = undefined;
          this.publish({ connected: false });
          this.scheduleReconnect();
        },
      });

      this.publish({ connected: true, everConnected: true, error: undefined });
    } catch (error) {
      this.client = undefined;
      this.publish({
        connected: false,
        error:
          error instanceof DaemonNotRunningError
            ? 'No worker is running here.'
            : error instanceof Error
              ? error.message
              : String(error),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) return;
    const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = undefined;
      void this.attach();
    }, this.options.reconnectDelayMs ?? 2_000);
  }

  private receive(message: DaemonMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.publish({ snapshot: message.snapshot });
        return;
      case 'log-tail':
        this.publish({ logs: clip([...this.state.logs, ...message.lines], this.maxLines) });
        return;
      case 'event':
        this.publish({ events: clip([...this.state.events, message.event], this.maxLines) });
        return;
      case 'error':
        this.publish({ error: message.message });
        return;
      case 'ack':
        // This source sends no commands, so an ack can only be the echo of
        // another attached client's request. Not ours to render.
        return;
    }
  }

  private publish(patch: Partial<DashboardState>): void {
    // A NEW OBJECT every time. The consumer is React, which compares by
    // identity; mutating in place would render the first frame and then never
    // update again — the classic "the TUI is frozen" bug.
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }
}

/** Keep the newest `limit`. */
function clip<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}

/** One-line summary of an engine event, shared by the dashboard and the log view. */
export function describeEvent(event: NodeEngineEvent): string {
  switch (event.kind) {
    case 'started':
      return `worker started (${event.nodeId}, concurrency ${event.concurrency})`;
    case 'idle':
      return 'idle';
    case 'claimed':
      return `claimed ${event.jobs.length} job(s)`;
    case 'job-started':
      return `▶ ${event.type} ${event.jobId}`;
    case 'job-input':
      return `  ↓ input ${event.objectId} (${event.bytes} bytes)`;
    case 'job-log':
      return `  · ${event.message}`;
    case 'job-succeeded':
      return `✓ ${event.type} ${event.jobId} in ${event.durationMs}ms`;
    case 'job-failed':
      return `✗ ${event.type} ${event.jobId}${event.rateLimited ? ' (rate limited)' : ''}: ${event.error}`;
    case 'lease-renewed':
      return `  ↻ lease ${event.jobId}`;
    case 'lease-renew-failed':
      return `  ! lease renew failed ${event.jobId}: ${event.error}`;
    case 'heartbeat':
      return `♥ heartbeat (concurrency ${event.concurrency})`;
    case 'heartbeat-failed':
      return `! heartbeat failed: ${event.error}`;
    case 'concurrency-changed':
      return `concurrency now ${event.concurrency}`;
    case 'claim-failed':
      return `! claim failed: ${event.error}`;
    case 'draining':
      return `draining (${event.inFlight} in flight)`;
    case 'stopped':
      return `stopped${event.deregistered ? ' and deregistered' : ''}`;
  }
}

/** Elapsed milliseconds for an active job, for the dashboard's age column. */
export function elapsedMs(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  return Number.isNaN(started) ? 0 : Math.max(0, now - started);
}

/** `1m 04s`, `12s`, `2h 05m`. Short enough for a narrow column. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
