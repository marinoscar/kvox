import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';

// =============================================================================
// Stale-instance detection  (issue #275, epic #254)
// =============================================================================
//
// Before a daemon may listen, it must answer one question honestly: is there
// ALREADY a worker running here, or only the litter of one that died?
//
// Getting this wrong in either direction is bad in a different way. Refusing on
// a stale pidfile means a worker that crashed can never restart without manual
// cleanup — which, in a container, is a permanent crash-loop. Starting anyway
// on a LIVE one means two workers sharing a socket path and a log file, with
// the second silently unable to be reached.
//
// So both artefacts are probed for LIVENESS, not for existence:
//
//   - the pidfile with `kill(pid, 0)` — sends no signal, only asks whether the
//     process exists and is signalable
//   - the socket with a short-timeout CONNECT — because a socket file outlives
//     the process that made it, every time, and its mere presence says nothing
//
// The socket probe is the one people leave out, and it is the one that matters:
// `listen()` on an existing socket path fails with EADDRINUSE whether or not
// anything is behind it, so a worker killed with SIGKILL can never come back
// without it.
// =============================================================================

/** Signal-free liveness check. `ESRCH` means gone; `EPERM` means alive but not ours. */
export function isProcessAlive(pid: number, kill: (pid: number, signal: number) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process EXISTS but belongs to another user. That is still
    // "something is running", and treating it as dead would unlink a live
    // worker's pidfile.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read a pidfile, returning `undefined` for absent, empty or malformed. */
export function readPidfile(path: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Write this process's pid, `0600`, creating the directory if needed. */
export function writePidfile(path: string, pid: number = process.pid): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Remove the pidfile ONLY IF it still names this process.
 *
 * The guard is the whole point. A daemon that exits slowly — draining for
 * thirty seconds — can be replaced by a new one that has already written its
 * own pid. An unconditional `rm` in the old process's exit handler would then
 * delete the NEW instance's pidfile, and every later `stop`/`status` would
 * report no daemon running while one very much is.
 */
export function removeOwnPidfile(path: string, pid: number = process.pid): boolean {
  if (readPidfile(path) !== pid) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Is something listening on this socket path right now? */
export async function isSocketLive(path: string, timeoutMs = 500): Promise<boolean> {
  // On Windows the path is a named pipe, which does not exist in the
  // filesystem — skip the stat and go straight to the connect probe.
  if (!path.startsWith('\\\\')) {
    try {
      statSync(path);
    } catch {
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = connect(path);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // `unref` so a probe cannot hold the process open past its own answer.
    if (typeof timer.unref === 'function') timer.unref();

    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export interface InstanceCheck {
  /** True when a live daemon already holds this state directory. */
  running: boolean;
  /** The live pid, when there is one. */
  pid?: number | undefined;
  /** What was cleaned up on the way to answering. */
  reclaimed: Array<'pidfile' | 'socket'>;
}

/**
 * Decide whether a daemon may start here, reclaiming stale artefacts.
 *
 * Called by `startDaemonHost` before `listen()`. Returns rather than throws, so
 * the caller controls the message — `node start` refuses, while `node status`
 * uses the same answer to decide whether to attach or fall back.
 */
export async function checkForRunningInstance(paths: {
  pidPath: string;
  socketPath: string;
}): Promise<InstanceCheck> {
  const reclaimed: InstanceCheck['reclaimed'] = [];

  const pid = readPidfile(paths.pidPath);
  if (pid !== undefined && isProcessAlive(pid)) {
    return { running: true, pid, reclaimed };
  }
  if (pid !== undefined) {
    try {
      rmSync(paths.pidPath, { force: true });
      reclaimed.push('pidfile');
    } catch {
      // Leave it; `listen()` is the real gate and it is checked next.
    }
  }

  if (await isSocketLive(paths.socketPath)) {
    // A live socket with no live pidfile: something IS serving. Refuse, and do
    // not unlink — unlinking would leave a running daemon unreachable forever.
    return { running: true, reclaimed };
  }

  if (!paths.socketPath.startsWith('\\\\')) {
    try {
      statSync(paths.socketPath);
      rmSync(paths.socketPath, { force: true });
      reclaimed.push('socket');
    } catch {
      // No socket file at all — the ordinary clean case.
    }
  }

  return { running: false, reclaimed };
}
