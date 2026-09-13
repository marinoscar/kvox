import { describe, expect, it, vi } from 'vitest';

import type { SnapshotResult } from './heap-snapshot.js';
import {
  DEFAULT_THRESHOLD,
  MIN_TREND_WINDOW_MS,
  MemoryWatchdog,
  memoryWatchdogEnabled,
  resolveThreshold,
  trendMbPerHour,
  type MemorySample,
} from './memory-watchdog.js';
import { EXIT_MEMORY_VALVE } from './runtime-tuning.js';
import { WORKER_ENV } from './worker-env.js';

const MB = 1024 * 1024;

function sample(atMs: number, heapUsedMb: number): MemorySample {
  return {
    at: atMs,
    rss: heapUsedMb * MB * 1.4,
    heapUsed: heapUsedMb * MB,
    heapTotal: heapUsedMb * MB * 1.2,
    external: 0,
    arrayBuffers: 0,
    heapLimit: 4096 * MB,
  };
}

describe('trendMbPerHour (issue #277)', () => {
  it('reports nothing until the samples span the minimum window', () => {
    // A single reading — or two, thirty seconds apart — cannot distinguish a
    // leak from GC sawtooth. A metric that is wrong when it is new is a metric
    // nobody trusts when it is right.
    const short = [sample(0, 100), sample(30_000, 140), sample(60_000, 180)];
    expect(trendMbPerHour(short)).toBeNull();
    expect(trendMbPerHour([sample(0, 100)])).toBeNull();
  });

  it('measures a synthetic linear leak within tolerance', () => {
    // 40 MB/hour, sampled every five minutes for two hours.
    const samples: MemorySample[] = [];
    for (let i = 0; i <= 24; i += 1) {
      samples.push(sample(i * 5 * 60_000, 100 + (40 * (i * 5)) / 60));
    }

    const trend = trendMbPerHour(samples);
    expect(trend).not.toBeNull();
    expect(trend as number).toBeGreaterThan(39);
    expect(trend as number).toBeLessThan(41);
  });

  it('reports ~0 for a flat heap with sawtooth noise', () => {
    const samples: MemorySample[] = [];
    for (let i = 0; i <= 24; i += 1) {
      samples.push(sample(i * 5 * 60_000, 100 + (i % 2 === 0 ? -20 : 20)));
    }

    const trend = trendMbPerHour(samples);
    expect(Math.abs(trend as number)).toBeLessThan(5);
  });
});

describe('configuration', () => {
  it('is enabled by default and disabled only by an explicit negative', () => {
    expect(memoryWatchdogEnabled({})).toBe(true);
    expect(memoryWatchdogEnabled({ [WORKER_ENV.memoryWatchdog]: '' })).toBe(true);
    expect(memoryWatchdogEnabled({ [WORKER_ENV.memoryWatchdog]: 'false' })).toBe(false);
    expect(memoryWatchdogEnabled({ [WORKER_ENV.memoryWatchdog]: 'off' })).toBe(false);
  });

  it('clamps the threshold so a typo cannot disable the valve', () => {
    expect(resolveThreshold({})).toBe(DEFAULT_THRESHOLD);
    expect(resolveThreshold({ [WORKER_ENV.memoryThreshold]: '0.75' })).toBe(0.75);
    expect(resolveThreshold({ [WORKER_ENV.memoryThreshold]: '0.01' })).toBe(0.5);
    expect(resolveThreshold({ [WORKER_ENV.memoryThreshold]: '9' })).toBe(0.99);
    expect(resolveThreshold({ [WORKER_ENV.memoryThreshold]: 'nonsense' })).toBe(DEFAULT_THRESHOLD);
  });
});

describe('the pre-OOM valve', () => {
  function build(heapUsedMb: number, overrides: Partial<ConstructorParameters<typeof MemoryWatchdog>[0]> = {}) {
    const order: string[] = [];
    const exits: number[] = [];
    const snapshot = vi.fn((): SnapshotResult => {
      order.push('snapshot');
      return { written: true, path: '/snap/heap.heapsnapshot', size: 1234 };
    });

    const watchdog = new MemoryWatchdog({
      snapshotDir: '/snap',
      env: {},
      readMemory: () =>
        ({ rss: heapUsedMb * MB, heapUsed: heapUsedMb * MB, heapTotal: heapUsedMb * MB, external: 0, arrayBuffers: 0 }) as NodeJS.MemoryUsage,
      readHeapLimit: () => 4096 * MB,
      snapshot,
      stop: async () => {
        order.push('drain');
      },
      exit: (code) => {
        order.push('exit');
        exits.push(code);
      },
      log: () => {
        order.push('log');
      },
      ...overrides,
    });

    return { watchdog, order, exits, snapshot };
  }

  it('does not fire below the threshold', async () => {
    const { watchdog, order } = build(1000); // ~24% of 4096
    await watchdog.tick();
    expect(order).toEqual([]);
    expect(watchdog.getState().fired).toBe(false);
  });

  it('fires in the order snapshot → log → drain → exit', async () => {
    const { watchdog, order, exits } = build(3800); // ~93%
    await watchdog.tick();

    // THE ORDER IS THE POINT. Draining first would let the leaked objects be
    // collected before the snapshot, so the artefact that exists to name the
    // retainer would no longer contain it.
    expect(order).toEqual(['snapshot', 'log', 'drain', 'exit']);
    expect(exits).toEqual([EXIT_MEMORY_VALVE]);
  });

  it('fires AT MOST ONCE', async () => {
    const { watchdog, exits } = build(3800);
    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();
    expect(exits).toEqual([EXIT_MEMORY_VALVE]);
  });

  it('still exits when the snapshot could not be written', async () => {
    const { watchdog, order, exits } = build(3800, {
      snapshot: () => ({ written: false, skipped: 'Not enough free disk' }),
    });
    await watchdog.tick();

    // The exit must be explicable from the log alone even with no snapshot.
    expect(order).toEqual(['log', 'drain', 'exit']);
    expect(exits).toEqual([EXIT_MEMORY_VALVE]);
  });

  it('still exits when the drain itself fails', async () => {
    const { watchdog, exits } = build(3800, {
      stop: async () => {
        throw new Error('drain exploded');
      },
    });
    await watchdog.tick();
    // The whole reason we are here is that staying alive is not an option.
    expect(exits).toEqual([EXIT_MEMORY_VALVE]);
  });

  it('does nothing when the heap limit is unknown', async () => {
    const { watchdog, exits } = build(3800, { readHeapLimit: () => 0 });
    await watchdog.tick();
    expect(exits).toEqual([]);
  });

  it('reports utilisation and sample count in its state', () => {
    const { watchdog } = build(2048);
    watchdog.sample();
    const state = watchdog.getState();
    expect(state.samples).toBe(1);
    expect(state.utilisation).toBeCloseTo(0.5, 2);
    expect(state.trendMbPerHour).toBeNull();
  });

  it('drives itself from an injected scheduler and stops cleanly', async () => {
    let fire: (() => void) | undefined;
    const { watchdog, exits } = build(3800, {
      scheduler: {
        setInterval: (fn: () => void) => {
          fire = fn;
          return 1;
        },
        clearInterval: () => {
          fire = undefined;
        },
      },
    });

    watchdog.start();
    fire?.();
    await vi.waitFor(() => expect(exits).toEqual([EXIT_MEMORY_VALVE]));
    watchdog.stop();
    expect(fire).toBeUndefined();
  });

  it('needs a trend window before reporting one, even while sampling', () => {
    let clock = 0;
    const { watchdog } = build(1000, { now: () => clock });
    for (let i = 0; i < 5; i += 1) {
      watchdog.sample();
      clock += 60_000;
    }
    expect(watchdog.getState().trendMbPerHour).toBeNull();

    clock += MIN_TREND_WINDOW_MS;
    watchdog.sample();
    expect(watchdog.getState().trendMbPerHour).not.toBeNull();
  });
});
