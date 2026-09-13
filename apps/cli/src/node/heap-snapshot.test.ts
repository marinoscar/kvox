import { mkdtempSync, rmSync, statSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISK_HEADROOM_FACTOR,
  heapSnapshotsEnabled,
  pruneSnapshots,
  writeHeapSnapshot,
} from './heap-snapshot.js';
import { WORKER_ENV } from './worker-env.js';

const MB = 1024 * 1024;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appctl-snap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `v8.writeHeapSnapshot` that produces a real file of a known size. */
function fakeWriter(bytes = 1024) {
  return (path: string): string => {
    writeFileSync(path, 'x'.repeat(bytes));
    return path;
  };
}

describe('the master toggle (issue #277)', () => {
  it('is on by default and off only for an explicit negative', () => {
    // A diagnostic somebody has to remember to enable in advance is never on
    // when it matters.
    expect(heapSnapshotsEnabled({})).toBe(true);
    expect(heapSnapshotsEnabled({ [WORKER_ENV.heapSnapshots]: 'false' })).toBe(false);
  });

  it('suppresses the write path, naming the variable', () => {
    const result = writeHeapSnapshot({
      dir,
      reason: 'manual',
      env: { [WORKER_ENV.heapSnapshots]: 'false' },
      write: () => {
        throw new Error('must not be called');
      },
    });

    expect(result.written).toBe(false);
    expect(result.skipped).toContain(WORKER_ENV.heapSnapshots);
  });
});

describe('writeHeapSnapshot', () => {
  it('writes a file whose name carries the reason and the pid', () => {
    const result = writeHeapSnapshot({ dir, reason: 'valve', env: {}, write: fakeWriter(), heapUsedBytes: 10 * MB });

    expect(result.written).toBe(true);
    expect(result.path).toContain(`heap-valve-${process.pid}-`);
    expect(result.size).toBe(1024);
    expect(statSync(result.path as string).size).toBe(1024);
  });

  it('skips with a CLEAR reason when free disk is short', () => {
    const heapUsed = 100 * MB;
    const result = writeHeapSnapshot({
      dir,
      reason: 'valve',
      env: {},
      heapUsedBytes: heapUsed,
      // Less than 1.5× the live heap.
      freeBytes: () => 100 * MB,
      write: () => {
        throw new Error('must not be called');
      },
    });

    expect(result.written).toBe(false);
    // A snapshot must never be the thing that fills the volume — that turns a
    // recoverable incident into two.
    expect(result.skipped).toContain('Not enough free disk');
    expect(result.skipped).toContain(String(Math.round((heapUsed * DISK_HEADROOM_FACTOR) / MB)));
  });

  it('writes when free disk is unknown — the check is a safeguard, not a gate', () => {
    const result = writeHeapSnapshot({
      dir,
      reason: 'manual',
      env: {},
      heapUsedBytes: 10 * MB,
      freeBytes: () => undefined,
      write: fakeWriter(),
    });
    expect(result.written).toBe(true);
  });

  it('reports a failing writer rather than throwing', () => {
    const result = writeHeapSnapshot({
      dir,
      reason: 'manual',
      env: {},
      heapUsedBytes: 1 * MB,
      freeBytes: () => 100 * MB,
      write: () => {
        throw new Error('v8 said no');
      },
    });

    expect(result.written).toBe(false);
    expect(result.skipped).toContain('v8 said no');
  });

  it('keeps only the newest N', () => {
    const write = fakeWriter(64);
    let clock = Date.UTC(2026, 0, 1);

    for (let i = 0; i < 8; i += 1) {
      writeHeapSnapshot({
        dir,
        reason: 'manual',
        env: {},
        keep: 3,
        heapUsedBytes: 1 * MB,
        freeBytes: () => 100 * MB,
        now: () => clock,
        write,
      });
      clock += 60_000;
      // Real mtimes, since retention sorts by them.
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const seconds = clock / 1000;
        utimesSync(path, seconds, seconds);
      }
    }

    expect(readdirSync(dir).filter((name) => name.endsWith('.heapsnapshot'))).toHaveLength(3);
  });
});

describe('pruneSnapshots', () => {
  it('is a no-op for a missing directory', () => {
    expect(pruneSnapshots(join(dir, 'absent'), 3)).toEqual([]);
  });

  it('keeps everything when keep is 0 or less', () => {
    writeFileSync(join(dir, 'a.heapsnapshot'), 'x');
    expect(pruneSnapshots(dir, 0)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('ignores files that are not snapshots', () => {
    writeFileSync(join(dir, 'node.log'), 'x');
    writeFileSync(join(dir, 'a.heapsnapshot'), 'x');
    writeFileSync(join(dir, 'b.heapsnapshot'), 'x');
    pruneSnapshots(dir, 1);
    expect(readdirSync(dir)).toContain('node.log');
  });
});

describe('the disable toggle suppresses ALL THREE paths', () => {
  it('covers the valve, the command, and a direct call', () => {
    const env = { [WORKER_ENV.heapSnapshots]: 'false' };
    const write = vi.fn();

    for (const reason of ['valve', 'manual', 'signal'] as const) {
      const result = writeHeapSnapshot({ dir, reason, env, write: write as never });
      expect(result.written).toBe(false);
    }
    // A half-disabled diagnostic is worse than none — it fills a volume
    // nobody is watching.
    expect(write).not.toHaveBeenCalled();
  });
});
