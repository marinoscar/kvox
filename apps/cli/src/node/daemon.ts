import { chmodSync, rmSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';

import type { NodeEngine } from './node-engine.js';
import type { NodeEngineEvent } from './node-events.js';
import type { LogRecord, NodeLogger } from './logger.js';
import {
  MAX_CLIENT_BACKLOG_BYTES,
  MAX_IPC_CONCURRENCY,
  MIN_IPC_CONCURRENCY,
  NdjsonParser,
  frame,
  parseCommand,
  type ClientCommand,
  type DaemonMessage,
} from './ipc-protocol.js';
import { checkForRunningInstance, removeOwnPidfile, writePidfile } from './pidfile.js';

// =============================================================================
// The daemon host  (issue #275, epic #254)
// =============================================================================
//
// Hosted by EVERY `node start`, foreground or detached, so any run is
// attachable. A worker you can only inspect if you remembered to start it a
// particular way is a worker nobody inspects.
//
// -----------------------------------------------------------------------------
// THE WRITE-BACKLOG GUARD — the detail most worth porting exactly
// -----------------------------------------------------------------------------
//
// A client that stops READING does not make `write()` fail. Node buffers the
// unwritten bytes on the heap, indefinitely, and `writableLength` grows. So a
// `node logs --follow` in a terminal that has been scrolled, suspended with
// Ctrl-Z, or left inside a stopped tmux pane, slowly consumes the WORKER's
// memory until it OOMs — killing production work because of a stuck terminal
// nobody is even looking at.
//
// This is not defensive padding; it is a real and easy way to kill a worker.
// One megabyte of backlog is far more than any legitimate consumer accumulates,
// so crossing it is a diagnosis, and the client is dropped.
// =============================================================================

export interface DaemonHostOptions {
  pidPath: string;
  socketPath: string;
  /** Recent log lines replayed to each new client on connect. */
  logTail?: (() => LogRecord[]) | undefined;
  /** Wired to #277. `undefined` means the command answers "not supported". */
  writeHeapSnapshot?: (() => Promise<{ path: string; size: number }>) | undefined;
  /** Test seam for the socket permission call, which is a no-op on Windows. */
  chmod?: ((path: string, mode: number) => void) | undefined;
}

export interface DaemonHost {
  /** Broadcast an engine event to every attached client. */
  broadcast(event: NodeEngineEvent): void;
  /** Push a log line to every attached client following the log. */
  pushLog(record: LogRecord): void;
  /** Number of attached clients. For tests and for `status`. */
  clientCount(): number;
  /** Close the socket, unlink it and remove OUR pidfile. Idempotent. */
  close(): Promise<void>;
}

/** Thrown when a live daemon already owns this state directory. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number | undefined, socketPath: string) {
    super(
      pid === undefined
        ? `A worker is already listening on ${socketPath}. Stop it first, or use a different state directory.`
        : `A worker is already running here (pid ${pid}). Stop it first, or use a different state directory.`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

/**
 * Start the control socket for a running engine.
 *
 * Order matters: stale-instance detection, then pidfile, then listen. Writing
 * the pidfile before the check would clobber a live daemon's own.
 */
export async function startDaemonHost(
  engine: NodeEngine,
  logger: NodeLogger,
  options: DaemonHostOptions,
): Promise<DaemonHost> {
  const check = await checkForRunningInstance({ pidPath: options.pidPath, socketPath: options.socketPath });
  if (check.running) throw new DaemonAlreadyRunningError(check.pid, options.socketPath);
  if (check.reclaimed.length > 0) {
    logger.warn('reclaimed stale daemon artefacts', { reclaimed: check.reclaimed });
  }

  writePidfile(options.pidPath);

  const clients = new Set<Socket>();
  const chmod = options.chmod ?? ((path: string, mode: number) => chmodSync(path, mode));

  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);

    const parser = new NdjsonParser(
      (value) => {
        const command = parseCommand(value);
        if (command === undefined) {
          send(socket, { type: 'error', message: 'Unrecognised command' });
          return;
        }
        void handleCommand(command, socket);
      },
      (line) => {
        // Never echoed back: a malformed line could be half a credential.
        logger.warn('ignored a malformed IPC line', { bytes: line.length });
        send(socket, { type: 'error', message: 'Malformed NDJSON line' });
      },
    );

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('end', () => parser.flush());
    socket.on('close', () => clients.delete(socket));
    // A client that vanishes mid-write produces EPIPE. Not an error worth
    // logging on every terminal that closes.
    socket.on('error', () => clients.delete(socket));

    // The snapshot goes first, so a client renders something immediately
    // rather than waiting for the next engine event — which, on an idle
    // worker, could be a whole poll interval away.
    send(socket, { type: 'snapshot', snapshot: engine.getSnapshot() });
    const tail = options.logTail?.();
    if (tail !== undefined && tail.length > 0) send(socket, { type: 'log-tail', lines: tail });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // `0600` on the socket, so the control channel is bounded by the same
  // filesystem permission that protects the token file beside it. A no-op on
  // Windows, where the pipe has its own ACL and no filesystem entry.
  if (!options.socketPath.startsWith('\\\\')) {
    try {
      chmod(options.socketPath, 0o600);
    } catch {
      // Best effort: on some filesystems chmod of a socket is refused. The
      // directory is already `0700`, which is the containing control.
    }
  }

  logger.info('daemon listening', { socket: options.socketPath, pid: process.pid });

  /** Drops a client whose backlog says it has stopped reading. See the header. */
  function send(socket: Socket, message: DaemonMessage): void {
    if (socket.destroyed) {
      clients.delete(socket);
      return;
    }
    if (socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      logger.warn('dropping unresponsive ipc client (write backlog exceeded)', {
        backlog: socket.writableLength,
      });
      clients.delete(socket);
      socket.destroy();
      return;
    }
    try {
      socket.write(frame(message));
    } catch {
      clients.delete(socket);
    }
  }

  async function handleCommand(command: ClientCommand, socket: Socket): Promise<void> {
    switch (command.type) {
      case 'status':
        send(socket, { type: 'snapshot', snapshot: engine.getSnapshot() });
        return;

      case 'set-concurrency': {
        if (command.value < MIN_IPC_CONCURRENCY || command.value > MAX_IPC_CONCURRENCY) {
          send(socket, {
            type: 'error',
            message: `Concurrency must be between ${MIN_IPC_CONCURRENCY} and ${MAX_IPC_CONCURRENCY} (got ${command.value}).`,
          });
          return;
        }
        try {
          engine.setConcurrency(command.value);
          send(socket, { type: 'ack', command: 'set-concurrency', detail: { value: command.value } });
        } catch (error) {
          send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      case 'drain':
        send(socket, { type: 'ack', command: 'drain' });
        await engine.drain();
        return;

      case 'stop':
        // Acked BEFORE draining: a clean drain can take minutes, and a client
        // waiting for confirmation that its request was even received should
        // not have to wait that long to find out.
        send(socket, { type: 'ack', command: 'stop' });
        await engine.stop();
        await host.close();
        return;

      case 'heap-snapshot': {
        if (options.writeHeapSnapshot === undefined) {
          send(socket, { type: 'error', message: 'Heap snapshots are disabled on this worker.' });
          return;
        }
        try {
          const written = await options.writeHeapSnapshot();
          send(socket, { type: 'ack', command: 'heap-snapshot', detail: written });
        } catch (error) {
          send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
    }
  }

  let closed = false;

  const host: DaemonHost = {
    broadcast(event) {
      for (const socket of [...clients]) send(socket, { type: 'event', event });
    },
    pushLog(record) {
      for (const socket of [...clients]) send(socket, { type: 'log-tail', lines: [record] });
    },
    clientCount: () => clients.size,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of [...clients]) socket.destroy();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.socketPath.startsWith('\\\\')) {
        try {
          rmSync(options.socketPath, { force: true });
        } catch {
          // Nothing to do; the next start's stale-socket probe reclaims it.
        }
      }
      // Only if it still names US — a slow drain can outlive a replacement.
      removeOwnPidfile(options.pidPath);
      logger.info('daemon stopped');
    },
  };

  return host;
}

// -----------------------------------------------------------------------------
// The client half
// -----------------------------------------------------------------------------

export interface DaemonClient {
  send(command: ClientCommand): void;
  close(): void;
}

export interface ConnectOptions {
  socketPath: string;
  onMessage: (message: DaemonMessage) => void;
  onClose?: (() => void) | undefined;
  timeoutMs?: number | undefined;
}

/** No daemon is listening at that path. */
export class DaemonNotRunningError extends Error {
  constructor(socketPath: string) {
    super(`No worker is running here (nothing is listening on ${socketPath}).`);
    this.name = 'DaemonNotRunningError';
  }
}

/**
 * Attach to a running daemon.
 *
 * READ-MOSTLY BY DESIGN: connecting is passive — the daemon pushes a snapshot,
 * a log tail and then events — and detaching does nothing to it. That is what
 * lets the TUI (#279) inspect a systemd unit or a container without perturbing
 * it.
 */
export function connectToDaemon(options: ConnectOptions): Promise<DaemonClient> {
  return new Promise<DaemonClient>((resolve, reject) => {
    const socket = connect(options.socketPath);
    const parser = new NdjsonParser((value) => options.onMessage(value as DaemonMessage));

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DaemonNotRunningError(options.socketPath));
    }, options.timeoutMs ?? 2_000);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({
        send: (command) => socket.write(frame(command)),
        close: () => socket.destroy(),
      });
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('close', () => options.onClose?.());
    socket.once('error', (error) => {
      clearTimeout(timer);
      // ENOENT/ECONNREFUSED are the ordinary "no daemon" cases and deserve the
      // named error rather than a raw errno the user has to interpret.
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === 'ENOENT' || code === 'ECONNREFUSED' ? new DaemonNotRunningError(options.socketPath) : error);
    });
  });
}
