import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { CLI_NAME } from '../branding.js';
import { PreconditionError } from '../errors.js';
import { connectToDaemon, DaemonNotRunningError } from './daemon.js';
import type { DaemonMessage } from './ipc-protocol.js';
import type { NodeSnapshot } from './node-events.js';
import { isProcessAlive, readPidfile } from './pidfile.js';

// =============================================================================
// Lifecycle commands: stop, status, set-concurrency  (issue #275, epic #254)
// =============================================================================
//
// All UI-free and dependency-injected, so the TUI (#279) renders the same
// functions the commands call rather than reimplementing them.
// =============================================================================

/** Each rung of the `stop` ladder, in the order attempted. */
export type StopRung = 'ipc' | 'signal' | 'deregister';

export interface StopOutcome {
  /** The rungs actually attempted, in order. */
  attempted: StopRung[];
  /** The rung that succeeded, if any. */
  stoppedBy: StopRung | undefined;
  /** True when nothing was running to begin with — not a failure. */
  wasRunning: boolean;
  detail: string;
}

export interface StopNodeOptions {
  socketPath: string;
  pidPath: string;
  /** Bound on each rung. A `stop` that hangs is a `stop` nobody trusts. */
  timeoutMs?: number | undefined;
  /** Test seams. */
  connect?: typeof connectToDaemon | undefined;
  kill?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  isAlive?: ((pid: number) => boolean) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Rung three: tell the SERVER this node is gone. */
  deregister?: (() => Promise<void>) | undefined;
}

/**
 * The three-rung ladder.
 *
 *   1. IPC `stop` — a clean drain AND a deregister, decided by the daemon.
 *   2. SIGTERM to the pidfile's pid — the start handler drains.
 *   3. A server-side deregister — so no further work is dispatched to a
 *      process that is already gone.
 *
 * Rung three matters more than it looks. Without it, a worker killed with
 * SIGKILL keeps its `online` node row until the liveness cron notices, and the
 * server keeps handing it leases in the meantime — every one of which has to
 * expire before the work is retried elsewhere.
 */
export async function stopNode(options: StopNodeOptions): Promise<StopOutcome> {
  const attempted: StopRung[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const connectFn = options.connect ?? connectToDaemon;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? ((pid) => isProcessAlive(pid));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // ---- Rung 1: IPC -----------------------------------------------------------
  attempted.push('ipc');
  try {
    const acked = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);

      connectFn({
        socketPath: options.socketPath,
        timeoutMs,
        onMessage: (message: DaemonMessage) => {
          if (message.type === 'ack' && message.command === 'stop' && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        },
      })
        .then((client) => client.send({ type: 'stop' }))
        .catch((error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    });

    if (acked) {
      return {
        attempted,
        stoppedBy: 'ipc',
        wasRunning: true,
        detail: 'The worker acknowledged the stop and is draining.',
      };
    }
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) {
      // A socket that exists but misbehaves still falls through to the signal
      // rung — the point of a ladder is that a broken rung is not the end.
    }
  }

  // ---- Rung 2: SIGTERM -------------------------------------------------------
  const pid = readPidfile(options.pidPath);
  if (pid !== undefined && isAlive(pid)) {
    attempted.push('signal');
    try {
      kill(pid, 'SIGTERM');
    } catch (error) {
      throw new PreconditionError(
        `Could not signal the worker (pid ${pid}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Give it a bounded moment to actually go, so the caller's message is true.
    const deadline = timeoutMs;
    const step = Math.max(50, Math.floor(deadline / 20));
    for (let waited = 0; waited < deadline; waited += step) {
      if (!isAlive(pid)) break;
      await sleep(step);
    }

    return {
      attempted,
      stoppedBy: 'signal',
      wasRunning: true,
      detail: isAlive(pid)
        ? `Sent SIGTERM to pid ${pid}; it is still draining.`
        : `Sent SIGTERM to pid ${pid}; it has exited.`,
    };
  }

  // ---- Rung 3: server-side deregister ---------------------------------------
  if (options.deregister !== undefined) {
    attempted.push('deregister');
    try {
      await options.deregister();
      return {
        attempted,
        stoppedBy: 'deregister',
        wasRunning: false,
        detail:
          'No local worker was running. Deregistered the node so the server stops dispatching work to it.',
      };
    } catch (error) {
      return {
        attempted,
        stoppedBy: undefined,
        wasRunning: false,
        detail: `No local worker was running, and the deregister failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return { attempted, stoppedBy: undefined, wasRunning: false, detail: 'No worker is running here.' };
}

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

export interface StatusResult {
  /** True when a live daemon answered. */
  live: boolean;
  snapshot: NodeSnapshot | undefined;
  /** The daemon's pid, when a pidfile named a live one. */
  pid: number | undefined;
}

/**
 * Ask the live daemon, or say plainly that there is none.
 *
 * NEVER SIMPLY UNAVAILABLE: the caller falls back to stored config plus a
 * capability probe (#276), so `status` answers something useful whether or not
 * a worker is up. A status command that says "cannot connect" and stops is a
 * status command people replace with `ps`.
 */
export async function readLiveStatus(options: {
  socketPath: string;
  pidPath: string;
  timeoutMs?: number | undefined;
  connect?: typeof connectToDaemon | undefined;
}): Promise<StatusResult> {
  const pid = readPidfile(options.pidPath);
  const livePid = pid !== undefined && isProcessAlive(pid) ? pid : undefined;
  const connectFn = options.connect ?? connectToDaemon;
  const timeoutMs = options.timeoutMs ?? 2_000;

  try {
    const snapshot = await new Promise<NodeSnapshot>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new DaemonNotRunningError(options.socketPath));
      }, timeoutMs);

      connectFn({
        socketPath: options.socketPath,
        timeoutMs,
        onMessage: (message: DaemonMessage) => {
          if (message.type === 'snapshot' && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(message.snapshot);
          }
        },
      })
        .then((client) => {
          // The daemon sends a snapshot on connect anyway; asking explicitly
          // covers a client that attached after that first push.
          client.send({ type: 'status' });
        })
        .catch((error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    });

    return { live: true, snapshot, pid: livePid };
  } catch {
    return { live: false, snapshot: undefined, pid: livePid };
  }
}

// -----------------------------------------------------------------------------
// set-concurrency
// -----------------------------------------------------------------------------

export interface SetConcurrencyOutcome {
  /** True when a running daemon applied it; false when it was only persisted. */
  applied: boolean;
  value: number;
}

/**
 * Apply live over IPC when a daemon is running; persist to config when not.
 *
 * The SAME command working in both states is the point. The alternative —
 * "start the worker first" — makes an operator choose between changing the
 * setting and having it take effect, which is not a choice.
 */
export async function applyConcurrency(options: {
  value: number;
  socketPath: string;
  persist: (value: number) => void;
  timeoutMs?: number | undefined;
  connect?: typeof connectToDaemon | undefined;
}): Promise<SetConcurrencyOutcome> {
  const connectFn = options.connect ?? connectToDaemon;
  const timeoutMs = options.timeoutMs ?? 2_000;

  try {
    const applied = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);

      connectFn({
        socketPath: options.socketPath,
        timeoutMs,
        onMessage: (message: DaemonMessage) => {
          if (settled) return;
          if (message.type === 'ack' && message.command === 'set-concurrency') {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          } else if (message.type === 'error') {
            settled = true;
            clearTimeout(timer);
            reject(new PreconditionError(message.message));
          }
        },
      })
        .then((client) => client.send({ type: 'set-concurrency', value: options.value }))
        .catch((error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            if (error instanceof DaemonNotRunningError) resolve(false);
            else reject(error);
          }
        });
    });

    // Persisted EITHER WAY, so a restart keeps the operator's decision. A live
    // change that vanished on the next reboot would be a trap.
    options.persist(options.value);
    return { applied, value: options.value };
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    options.persist(options.value);
    return { applied: false, value: options.value };
  }
}

// -----------------------------------------------------------------------------
// --daemon: re-spawn detached
// -----------------------------------------------------------------------------

export interface SpawnDaemonOptions {
  /** Where stdout/stderr of the detached child go. */
  logPath: string;
  /** Arguments after the script path, e.g. `['node', 'start']`. */
  args: string[];
  execPath?: string | undefined;
  scriptPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  spawnFn?: typeof spawn | undefined;
  openFile?: ((path: string) => number) | undefined;
}

/**
 * Re-spawn this CLI detached, with stdio to a file, and `unref` it.
 *
 * `unref` is what lets the PARENT exit immediately; without it, `node start
 * --daemon` would sit in the foreground holding a handle to a child it just
 * detached, which is the opposite of what was asked.
 */
export function spawnDetachedDaemon(options: SpawnDaemonOptions): number | undefined {
  const spawnImpl = options.spawnFn ?? spawn;
  const open = options.openFile ?? ((path: string) => openSync(path, 'a'));
  const out = open(options.logPath);

  const child = spawnImpl(options.execPath ?? process.execPath, [options.scriptPath ?? process.argv[1] ?? '', ...options.args], {
    detached: true,
    stdio: ['ignore', out, out],
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  child.unref();
  return child.pid;
}

/** The message `stop`/`status` print when there is nothing to talk to. */
export function noDaemonHint(socketPath: string): string {
  return `No worker is running here (nothing is listening on ${socketPath}). Start one with \`${CLI_NAME} node start\`.`;
}
