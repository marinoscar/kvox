import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics, writeHeapSnapshot as v8WriteHeapSnapshot } from 'node:v8';

import { envFlagOff } from './env-flags.js';
import { WORKER_ENV } from './worker-env.js';

// =============================================================================
// Heap snapshots  (issue #277, epic #254)
// =============================================================================
//
// A worker is a long-lived process doing repetitive work — exactly the shape
// that turns a small per-job leak into an OOM kill hours later. Two things then
// go wrong, and the second is the expensive one: the process dies abruptly
// mid-job, AND it dies in the one state that could have explained why. The next
// occurrence is then diagnosed no better than the first.
//
// A snapshot is the artefact that names the retainer. Three paths write one —
// the pre-OOM valve, the `heap-snapshot` command, and a fork's own call — and
// ONE toggle disables all three, because a half-disabled diagnostic is worse
// than none (it fills a volume nobody is watching).
//
// -----------------------------------------------------------------------------
// THE DISK PRE-FLIGHT IS NOT OPTIONAL
// -----------------------------------------------------------------------------
//
// A snapshot is roughly the size of the live heap, and it is written by a
// process that is, by construction, near its memory ceiling — which is exactly
// when a worker is under load and its volume is fullest. Filling the volume
// while trying to diagnose a memory problem converts a recoverable incident
// into two.
// =============================================================================

/** Multiple of the current heap to require free before writing. */
export const DISK_HEADROOM_FACTOR = 1.5;

/** How many snapshots to keep. Newest wins. */
export const DEFAULT_KEEP = 5;

/** Why a snapshot was taken. Appears in the filename. */
export type SnapshotReason = 'valve' | 'manual' | 'signal';

export interface WriteSnapshotOptions {
  dir: string;
  reason: SnapshotReason;
  keep?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Test seams. */
  now?: (() => number) | undefined;
  write?: ((path: string) => string) | undefined;
  heapUsedBytes?: number | undefined;
  freeBytes?: ((path: string) => number | undefined) | undefined;
}

export interface SnapshotResult {
  written: boolean;
  path?: string | undefined;
  size?: number | undefined;
  /** Present when `written` is false. Always a reason a human can act on. */
  skipped?: string | undefined;
}

/**
 * The master toggle. One switch for all three snapshot paths.
 *
 * Enabled by default: the whole point is to have the artefact when the rare
 * thing happens, and a diagnostic somebody has to remember to enable in
 * advance is a diagnostic that is never on when it matters.
 */
export function heapSnapshotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !envFlagOff(env[WORKER_ENV.heapSnapshots]);
}

/** Write a heap snapshot, or explain precisely why one was not written. */
export function writeHeapSnapshot(options: WriteSnapshotOptions): SnapshotResult {
  const env = options.env ?? process.env;
  if (!heapSnapshotsEnabled(env)) {
    return { written: false, skipped: `Heap snapshots are disabled (${WORKER_ENV.heapSnapshots}).` };
  }

  const heapUsed = options.heapUsedBytes ?? safeHeapUsed();
  const required = Math.ceil(heapUsed * DISK_HEADROOM_FACTOR);

  try {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { written: false, skipped: `Could not create ${options.dir}: ${messageOf(error)}` };
  }

  const free = (options.freeBytes ?? freeDiskBytes)(options.dir);
  if (free !== undefined && free < required) {
    // A CLEAR REASON, not a silent skip. "The snapshot you were counting on
    // does not exist" is only tolerable if it says why.
    return {
      written: false,
      skipped:
        `Not enough free disk for a heap snapshot: ${mb(free)} MB free, ` +
        `${mb(required)} MB needed (${DISK_HEADROOM_FACTOR}× the ${mb(heapUsed)} MB live heap).`,
    };
  }

  const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  // Reason AND pid in the name: a supervised worker restarts, so several
  // snapshots from different lives of the same node land side by side, and
  // "which run was this?" is the first question anybody asks.
  const path = join(options.dir, `heap-${options.reason}-${process.pid}-${stamp}.heapsnapshot`);

  let written: string;
  try {
    written = (options.write ?? v8WriteHeapSnapshot)(path);
  } catch (error) {
    return { written: false, skipped: `Writing the snapshot failed: ${messageOf(error)}` };
  }

  const size = sizeOf(written);
  pruneSnapshots(options.dir, options.keep ?? DEFAULT_KEEP);
  return { written: true, path: written, size };
}

/** Keep only the newest `keep` snapshots. Best effort. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  if (keep <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.heapsnapshot'));
  } catch {
    return [];
  }

  const withTimes = entries
    .map((name) => {
      const full = join(dir, name);
      try {
        return { full, mtime: statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  const removed: string[] = [];
  for (const entry of withTimes.slice(keep)) {
    try {
      rmSync(entry.full, { force: true });
      removed.push(entry.full);
    } catch {
      // A file we cannot remove is a disk-space note, never a failure of the
      // snapshot that was just written.
    }
  }
  return removed;
}

function freeDiskBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    // `statfs` is unavailable on some platforms and filesystems. An unknown
    // free figure must not block the snapshot — the check is a safeguard, not
    // a gate.
    return undefined;
  }
}

function safeHeapUsed(): number {
  try {
    return process.memoryUsage().heapUsed;
  } catch {
    try {
      return getHeapStatistics().used_heap_size;
    } catch {
      return 0;
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
