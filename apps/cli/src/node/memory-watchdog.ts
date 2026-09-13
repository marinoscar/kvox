import { getHeapStatistics } from 'node:v8';

import { envFlagOff } from './env-flags.js';
import { writeHeapSnapshot, type SnapshotResult } from './heap-snapshot.js';
import { EXIT_MEMORY_VALVE } from './runtime-tuning.js';
import { WORKER_ENV } from './worker-env.js';

// =============================================================================
// The memory watchdog and its pre-OOM valve  (issue #277, epic #254)
// =============================================================================
//
// -----------------------------------------------------------------------------
// WHY A TREND, NOT A THRESHOLD ON ONE SAMPLE
// -----------------------------------------------------------------------------
//
// A single `heapUsed` reading cannot distinguish a leak from GC sawtooth — a
// healthy worker's heap climbs and collapses continuously, and any instant
// reading can be near the top of that sawtooth. A least-squares slope over
// samples spanning a real window is what turns "it died" into "it was climbing
// 40 MB/hour for six hours", which is the difference between a diagnosis and
// an anecdote.
//
// -----------------------------------------------------------------------------
// THE VALVE, AND WHY ITS ORDER IS THE WHOLE POINT
// -----------------------------------------------------------------------------
//
//   1. WRITE THE SNAPSHOT FIRST
//   2. log the decision with the sample
//   3. drain (`stop({ deregister: false })`)
//   4. exit with a distinct non-zero code
//
// Step 1 before step 3 is not an ordering preference. Draining first lets the
// leaked objects be COLLECTED before the snapshot is taken, so the artefact
// that exists to name the retainer no longer contains it.
//
// And this must not be left to V8's own `--heapsnapshot-near-heap-limit`.
// That fires only at genuine near-OOM, which is ABOVE this threshold — so on a
// worker hardened with this valve it would never fire at all: the process would
// recycle cleanly forever and the retainer could never be named.
//
// ⚠ THE VALVE REQUIRES A SUPERVISOR. It exits deliberately after a clean
// drain. Without `Restart=on-failure` (#276) or `restart: unless-stopped`
// (#278), a successful drain leaves the worker DOWN — a self-healing mechanism
// turned into an outage.
// =============================================================================

/** Default fraction of the heap limit at which the valve fires. */
export const DEFAULT_THRESHOLD = 0.9;

/** How often to sample. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;

/** No trend is reported until the samples span at least this long. */
export const MIN_TREND_WINDOW_MS = 10 * 60_000;

/** Ring size. At the default cadence this is roughly four hours. */
export const MAX_SAMPLES = 480;

export interface MemorySample {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapLimit: number;
}

export interface WatchdogState {
  samples: number;
  latest: MemorySample | undefined;
  /** Least-squares growth in MB/hour, or `null` before the window is spanned. */
  trendMbPerHour: number | null;
  /** heapUsed / heapLimit for the latest sample. */
  utilisation: number | null;
  fired: boolean;
}

export interface MemoryWatchdogOptions {
  snapshotDir: string;
  /** Drained on the valve; never deregistered. */
  stop: () => Promise<void>;
  env?: NodeJS.ProcessEnv | undefined;
  threshold?: number | undefined;
  sampleIntervalMs?: number | undefined;
  log?: ((message: string, fields?: Record<string, unknown>) => void) | undefined;
  /** Test seams. */
  now?: (() => number) | undefined;
  readMemory?: (() => NodeJS.MemoryUsage) | undefined;
  readHeapLimit?: (() => number) | undefined;
  snapshot?: ((reason: 'valve') => SnapshotResult) | undefined;
  exit?: ((code: number) => void) | undefined;
  scheduler?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void } | undefined;
}

/** Enabled by default; a leak that nobody armed a watchdog for is the usual case. */
export function memoryWatchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !envFlagOff(env[WORKER_ENV.memoryWatchdog]);
}

/** Read the threshold, clamped to a sane band so a typo cannot disable it. */
export function resolveThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKER_ENV.memoryThreshold]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(Math.max(value, 0.5), 0.99);
}

/**
 * Least-squares slope of `heapUsed` over time, in MB/hour.
 *
 * `null` until the samples span `MIN_TREND_WINDOW_MS`. Reporting a slope from
 * two samples thirty seconds apart would produce numbers like "12 GB/hour"
 * from one ordinary GC cycle, and a metric that is wrong when it is new is a
 * metric nobody trusts when it is right.
 */
export function trendMbPerHour(samples: readonly MemorySample[], minWindowMs = MIN_TREND_WINDOW_MS): number | null {
  if (samples.length < 3) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) return null;
  if (last.at - first.at < minWindowMs) return null;

  const n = samples.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const sample of samples) {
    const x = (sample.at - first.at) / 3_600_000; // hours
    const y = sample.heapUsed / 1024 / 1024; // MB
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  return (n * sumXY - sumX * sumY) / denominator;
}

export class MemoryWatchdog {
  private readonly options: MemoryWatchdogOptions;
  private readonly samples: MemorySample[] = [];
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private handle: unknown;
  private fired = false;

  constructor(options: MemoryWatchdogOptions) {
    this.options = options;
    const env = options.env ?? process.env;
    this.threshold = options.threshold ?? resolveThreshold(env);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.handle !== undefined) return;
    const scheduler = this.options.scheduler ?? {
      setInterval: (fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        // UNREF'd, unlike the engine's heartbeat: the watchdog must never be
        // the reason a finished process stays alive.
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
      },
      clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
    };

    this.handle = scheduler.setInterval(() => {
      void this.tick();
    }, this.options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle === undefined) return;
    const scheduler = this.options.scheduler;
    if (scheduler !== undefined) scheduler.clearInterval(this.handle);
    else clearInterval(this.handle as NodeJS.Timeout);
    this.handle = undefined;
  }

  /** Take one sample and act on it. Exposed so a test drives it directly. */
  async tick(): Promise<void> {
    const sample = this.sample();
    if (sample.heapLimit <= 0 || this.fired) return;

    if (sample.heapUsed / sample.heapLimit >= this.threshold) {
      await this.fire(sample);
    }
  }

  sample(): MemorySample {
    const memory = (this.options.readMemory ?? (() => process.memoryUsage()))();
    const heapLimit = (this.options.readHeapLimit ?? safeHeapLimit)();

    const sample: MemorySample = {
      at: this.now(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      heapLimit,
    };

    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return sample;
  }

  getState(): WatchdogState {
    const latest = this.samples[this.samples.length - 1];
    return {
      samples: this.samples.length,
      latest,
      trendMbPerHour: trendMbPerHour(this.samples),
      utilisation: latest !== undefined && latest.heapLimit > 0 ? latest.heapUsed / latest.heapLimit : null,
      fired: this.fired,
    };
  }

  /** THE ORDER IS THE POINT. See the file header. */
  private async fire(sample: MemorySample): Promise<void> {
    // AT MOST ONCE. Set before anything awaits, so a second tick landing during
    // the drain cannot re-enter.
    this.fired = true;

    // 1. Snapshot FIRST — before the drain collects the evidence away.
    const snapshot =
      this.options.snapshot?.('valve') ??
      writeHeapSnapshot({
        dir: this.options.snapshotDir,
        reason: 'valve',
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      });

    // 2. Log the decision WITH the sample, so the exit is explicable from the
    //    log alone even if the snapshot could not be written.
    this.log('memory valve fired — draining and exiting for a supervised restart', {
      heapUsedMb: Math.round(sample.heapUsed / 1024 / 1024),
      heapLimitMb: Math.round(sample.heapLimit / 1024 / 1024),
      rssMb: Math.round(sample.rss / 1024 / 1024),
      utilisation: Number((sample.heapUsed / sample.heapLimit).toFixed(3)),
      threshold: this.threshold,
      trendMbPerHour: trendMbPerHour(this.samples),
      snapshot: snapshot.written ? snapshot.path : `not written: ${snapshot.skipped}`,
    });

    // 3. Drain, keeping the node row: this process is coming back.
    try {
      await this.options.stop();
    } catch {
      // A drain that fails must not prevent the exit — the whole reason we are
      // here is that staying alive is not an option.
    }

    // 4. A DISTINCT code, so a supervisor and a human can both tell this apart
    //    from a crash and from a clean stop.
    (this.options.exit ?? ((code: number) => process.exit(code)))(EXIT_MEMORY_VALVE);
  }
}

function safeHeapLimit(): number {
  try {
    return getHeapStatistics().heap_size_limit;
  } catch {
    return 0;
  }
}
