import { describe, expect, it, vi } from 'vitest';

import {
  HEAP_FRACTION_OF_RAM,
  MAX_HEAP_LIMIT_MB,
  MIN_HEAP_LIMIT_MB,
  maybeReexecWithHeapLimit,
  resolveDefaultConcurrency,
  resolveHeapLimitMb,
} from './runtime-tuning.js';
import { WORKER_ENV } from './worker-env.js';

const GB = 1024 * 1024 * 1024;

describe('resolveHeapLimitMb (issue #277)', () => {
  it('is RAM-aware and clamped to a sane band', () => {
    expect(resolveHeapLimitMb({ env: {}, totalMemoryBytes: 16 * GB })).toBe(
      Math.round((16 * GB * HEAP_FRACTION_OF_RAM) / 1024 / 1024),
    );
    // A fixed limit is wrong on both a 2 GB VPS and a 64 GB box, so both ends
    // are clamped rather than trusted.
    expect(resolveHeapLimitMb({ env: {}, totalMemoryBytes: 512 * 1024 * 1024 })).toBe(MIN_HEAP_LIMIT_MB);
    expect(resolveHeapLimitMb({ env: {}, totalMemoryBytes: 256 * GB })).toBe(MAX_HEAP_LIMIT_MB);
  });

  it('honours an explicit override', () => {
    expect(resolveHeapLimitMb({ env: { [WORKER_ENV.heapLimitMb]: '2048' }, totalMemoryBytes: 16 * GB })).toBe(2048);
  });

  it('treats 0 as "do not re-tune at all"', () => {
    // The escape hatch for a platform that manages memory itself.
    expect(resolveHeapLimitMb({ env: { [WORKER_ENV.heapLimitMb]: '0' }, totalMemoryBytes: 16 * GB })).toBe(0);
  });

  it('refuses a non-numeric override by naming the variable', () => {
    expect(() => resolveHeapLimitMb({ env: { [WORKER_ENV.heapLimitMb]: 'lots' } })).toThrow(
      new RegExp(WORKER_ENV.heapLimitMb),
    );
  });
});

describe('resolveDefaultConcurrency', () => {
  it('uses cores and RAM rather than a flat 1', () => {
    // A flat 1 leaves a 16-core box almost entirely idle.
    expect(resolveDefaultConcurrency({ cpuCount: 16, totalMemoryBytes: 32 * GB })).toBe(15);
  });

  it('is bounded by memory, not only by cores', () => {
    // A 1 GB VPS with 8 cores must not try to run eight jobs.
    expect(resolveDefaultConcurrency({ cpuCount: 8, totalMemoryBytes: 1 * GB })).toBe(1);
  });

  it('never returns less than 1', () => {
    expect(resolveDefaultConcurrency({ cpuCount: 1, totalMemoryBytes: 256 * 1024 * 1024 })).toBe(1);
  });

  it('stays within the server’s own cap', () => {
    expect(resolveDefaultConcurrency({ cpuCount: 512, totalMemoryBytes: 1024 * GB })).toBe(64);
  });
});

describe('maybeReexecWithHeapLimit', () => {
  const baseEnv = { [WORKER_ENV.heapLimitMb]: '4096' };

  function fakeChild() {
    const handlers = new Map<string, (code: number | null, signal: string | null) => void>();
    return {
      kills: [] as string[],
      child: {
        kill(signal: string) {
          this.kills.push(signal);
          return true;
        },
        on(event: string, handler: (code: number | null, signal: string | null) => void) {
          handlers.set(event, handler);
          return this;
        },
        emitExit(code: number | null, signal: string | null) {
          handlers.get('exit')?.(code, signal);
        },
        kills: [] as string[],
      },
    };
  }

  it('is skipped under a test runner without any suite opting out', () => {
    // A re-exec here would spawn a second copy of the RUNNER, not of the worker.
    const spawnFn = vi.fn();
    const result = maybeReexecWithHeapLimit({ env: { ...baseEnv, VITEST: '1' }, spawnFn: spawnFn as never });
    expect(result.reexeced).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does nothing when re-tuning is disabled', () => {
    const spawnFn = vi.fn();
    const result = maybeReexecWithHeapLimit({
      env: { [WORKER_ENV.heapLimitMb]: '0' },
      skip: false,
      spawnFn: spawnFn as never,
    });
    expect(result.reason).toBe('disabled');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not re-exec when the LATCH is set', () => {
    const spawnFn = vi.fn();
    const result = maybeReexecWithHeapLimit({
      env: { ...baseEnv, [WORKER_ENV.heapTuned]: '1' },
      skip: false,
      currentLimitMb: 100,
      spawnFn: spawnFn as never,
    });
    expect(result.reason).toContain('latch');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not re-exec when the limit is ALREADY in force — the second guard', () => {
    // The latch alone is not enough: an operator can set it by hand or it can
    // leak from a parent shell. The actual-limit check alone is not enough
    // either: a platform that ignores the flag would re-exec forever.
    const spawnFn = vi.fn();
    const result = maybeReexecWithHeapLimit({
      env: baseEnv,
      skip: false,
      currentLimitMb: 4096,
      spawnFn: spawnFn as never,
    });
    expect(result.reason).toContain('limit in force');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns a tuned child, setting the latch on it', () => {
    const { child } = fakeChild();
    let seen: { command: string; args: string[]; options: { env: NodeJS.ProcessEnv } } | undefined;

    const result = maybeReexecWithHeapLimit({
      env: baseEnv,
      skip: false,
      currentLimitMb: 100,
      argv: ['/app/cli.js', 'node', 'start'],
      execPath: '/usr/bin/node',
      spawnFn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        seen = { command, args, options };
        return child;
      }) as never,
    });

    expect(result.reexeced).toBe(true);
    expect(seen?.args[0]).toBe('--max-old-space-size=4096');
    expect(seen?.args.slice(1)).toEqual(['/app/cli.js', 'node', 'start']);
    expect(seen?.options.env[WORKER_ENV.heapTuned]).toBe('1');
  });

  it('forwards SIGINT/SIGTERM/SIGHUP to the child', () => {
    const { child } = fakeChild();
    let handler: ((signal: NodeJS.Signals) => void) | undefined;

    maybeReexecWithHeapLimit({
      env: baseEnv,
      skip: false,
      currentLimitMb: 100,
      spawnFn: (() => child) as never,
      onSignal: (fn) => {
        handler = fn;
      },
      exit: () => {},
      raise: () => {},
    });

    // Without forwarding, a container SIGTERM kills the shim and ORPHANS the
    // worker: no drain, in-flight jobs abandoned.
    handler?.('SIGTERM');
    handler?.('SIGINT');
    handler?.('SIGHUP');
    expect(child.kills).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
  });

  it('re-raises the child’s signal rather than exiting 0', () => {
    const { child } = fakeChild();
    const raised: string[] = [];
    const exited: number[] = [];

    maybeReexecWithHeapLimit({
      env: baseEnv,
      skip: false,
      currentLimitMb: 100,
      spawnFn: (() => child) as never,
      onSignal: () => {},
      exit: (code) => exited.push(code),
      raise: (signal) => raised.push(signal),
    });

    child.emitExit(null, 'SIGKILL');
    // A supervisor reads the exit REASON: a shim that exits 0 after its child
    // was OOM-killed reports a clean shutdown, and the restart policy that
    // should have fired does not.
    expect(raised).toEqual(['SIGKILL']);
    expect(exited).toEqual([]);
  });

  it('passes an ordinary exit code straight through', () => {
    const { child } = fakeChild();
    const exited: number[] = [];

    maybeReexecWithHeapLimit({
      env: baseEnv,
      skip: false,
      currentLimitMb: 100,
      spawnFn: (() => child) as never,
      onSignal: () => {},
      exit: (code) => exited.push(code),
      raise: () => {},
    });

    child.emitExit(71, null);
    expect(exited).toEqual([71]);
  });
});
