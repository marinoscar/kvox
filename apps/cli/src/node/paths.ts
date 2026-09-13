import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { configDirPath, type ConfigContext } from '../config.js';
import { WORKER_ENV } from './worker-env.js';

// =============================================================================
// Where a worker keeps its runtime state  (issue #272, epic #254)
// =============================================================================
//
// One derivation, from `configDirPath()` — i.e. `~/.appctl/`, which is itself
// derived from `CONFIG_DIR_NAME` and therefore from `CLI_NAME`. There is no
// second hard-coded path anywhere in the node subsystem, and no
// `~/.appctl-node/`: a second directory is a second identity to rename, a
// second thing to mount into a container, and a second place for a token to
// end up.
//
// `WORKER_ENV.stateDir` overrides it wholesale. That is the container path:
// an image mounts one volume, points the variable at it, and the pidfile, the
// socket, the logs and the heap snapshots all land inside it together.
//
// -----------------------------------------------------------------------------
// THE SOCKET ON WINDOWS
// -----------------------------------------------------------------------------
//
// Windows has no Unix domain sockets in the filesystem; `net.createServer` on
// that platform takes a NAMED PIPE path under the magic `\\.\pipe\` prefix,
// which is not a real path and cannot live under the state directory. So the
// socket is the one derived value whose shape is platform-dependent — and the
// name is still built from `CLI_NAME`, so a fork's two workers cannot collide
// on a shared machine.
// =============================================================================

/** Injection seam. `platform` is here so the pipe branch is testable off Windows. */
export interface NodePathsContext extends ConfigContext {
  platform?: NodeJS.Platform | undefined;
}

/** Subdirectory of the state dir holding JSONL logs and rollovers. */
export const LOGS_DIR_NAME = 'logs';

/** Subdirectory holding heap snapshots (#277). */
export const SNAPSHOTS_DIR_NAME = 'heap-snapshots';

/** Subdirectory holding per-job scratch files, cleaned in a `finally` (#274). */
export const TMP_DIR_NAME = 'tmp';

/**
 * The worker's state directory.
 *
 * Defaults under the CLI's own config directory rather than beside it, so
 * `~/.appctl/` remains the single thing a user backs up, deletes or mounts.
 */
export function nodeStateDir(ctx?: NodePathsContext): string {
  const override = (ctx?.env ?? process.env)[WORKER_ENV.stateDir];
  const trimmed = override?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  return join(configDirPath(ctx), 'node');
}

/** `<state>/node.pid`. Holds the daemon's pid; `0600` (#275). */
export function nodePidPath(ctx?: NodePathsContext): string {
  return join(nodeStateDir(ctx), 'node.pid');
}

/**
 * The IPC endpoint: a Unix socket under the state dir, or a named pipe on
 * Windows.
 *
 * The pipe name carries `CLI_NAME` because the pipe namespace is machine-wide
 * and flat — two forks of this template on one box would otherwise fight over
 * the same name, and the loser's daemon would refuse to start with a message
 * about a stale socket that is not stale at all.
 */
export function nodeSocketPath(ctx?: NodePathsContext): string {
  const platform = ctx?.platform ?? process.platform;
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${CLI_NAME}-node`;
  }
  return join(nodeStateDir(ctx), 'node.sock');
}

/** `<state>/logs` — JSONL with one rollover generation (#275). */
export function logsDir(ctx?: NodePathsContext): string {
  return join(nodeStateDir(ctx), LOGS_DIR_NAME);
}

/** `<state>/logs/node.log`, the file `node logs` tails. */
export function nodeLogPath(ctx?: NodePathsContext): string {
  return join(logsDir(ctx), 'node.log');
}

/** `<state>/heap-snapshots` (#277). */
export function snapshotsDir(ctx?: NodePathsContext): string {
  return join(nodeStateDir(ctx), SNAPSHOTS_DIR_NAME);
}

/** `<state>/tmp` — per-job inputs, removed in a `finally` (#274). */
export function nodeTmpDir(ctx?: NodePathsContext): string {
  return join(nodeStateDir(ctx), TMP_DIR_NAME);
}
