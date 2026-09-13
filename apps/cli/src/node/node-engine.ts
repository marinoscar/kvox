import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { NodeApi, NodeJobAssignment } from './node-api.js';
import type { ActiveJob, HistoryEntry, NodeCounters, NodeEngineEvent, NodeSnapshot } from './node-events.js';
import { ExecutorRegistry } from './executors/index.js';
import { defaultExecutors } from './executors/example-checksum.js';
import { MissingJobInputError, ProviderRateLimitError } from './node-errors.js';

// =============================================================================
// NodeEngine — the claim, execute, submit loop  (issue #274, epic #254)
// =============================================================================
//
// This is the worker itself. UI-free, dependency-injected and entirely
// event-driven, mirroring how the deploy engine is structured, so it is
// testable with no network and renderable by a plain printer, the daemon's
// IPC and the TUI alike.
//
// -----------------------------------------------------------------------------
// THE LOOP IS A CONTINUOUS TOP-UP POOL, NOT A BATCH DRAIN
// -----------------------------------------------------------------------------
//
// The obvious implementation — claim N, await all N, repeat — is a BARRIER,
// and a barrier collapses effective concurrency toward 1 the moment job
// durations are mixed: every slot sits idle waiting for the batch's slowest
// member. With one 10-minute job among three 5-second ones, a four-slot worker
// does four jobs in ten minutes instead of dozens. The source application
// shipped that first and had to replace it; the shape below is the replacement,
// ported almost verbatim because it encodes a bug that has already been paid
// for once.
//
// Two details in it are load-bearing and easy to lose in a refactor:
//
//   1. THE CAP IS RE-READ EACH PASS (`this.concurrency`, not a captured
//      local). That is what makes a live `set-concurrency` over IPC take
//      effect on the next iteration rather than at the next restart.
//
//   2. CLAIMED JOBS ARE DISPATCHED WITHOUT AWAITING THE BATCH, and the loop
//      `continue`s immediately to refill whatever slots are still free.
//
// -----------------------------------------------------------------------------
// FAILURE REPORTING IS THE ONE PLACE CLASSIFICATION HAPPENS
// -----------------------------------------------------------------------------
//
// A `ProviderRateLimitError` — and ONLY that, by `instanceof`, never by
// sniffing a message — is reported as `rateLimited` with a `retryAfterMs`, so
// a throttle hit on this node routes through the server's deferral path
// instead of burning an attempt, and backs off sibling jobs on the server too.
// Everything else is an ordinary failure. Letting the server infer this from
// the error text would mean string-matching provider errors on the far side of
// an HTTP boundary, when the node already holds the typed error.
//
// -----------------------------------------------------------------------------
// THE HEARTBEAT TIMER IS DELIBERATELY NOT `unref`'d
// -----------------------------------------------------------------------------
//
// It is what keeps an idle worker process alive. `unref`ing it would let a
// worker with nothing to do exit silently — looking, to every supervisor,
// exactly like a clean shutdown.
// =============================================================================

/** A cancellable repeating timer. Injected so tests need no real clock. */
export interface EngineScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realScheduler: EngineScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface NodeEngineOptions {
  api: NodeApi;
  nodeId: string;
  concurrency: number;
  /** Empty means "everything this node has an executor for". */
  eligibleTypes?: string[] | undefined;
  pollIntervalMs?: number | undefined;
  /** Defaults to the executors this template ships. */
  executors?: ExecutorRegistry | undefined;
  /** Where per-job input files are written. Cleaned in a `finally`, always. */
  tmpDir?: string | undefined;
  /** How often to renew a lease. Must sit well inside the server's window. */
  leaseRenewIntervalMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  capabilities?: Record<string, unknown> | undefined;
  /** Test seams. */
  fetch?: typeof globalThis.fetch | undefined;
  scheduler?: EngineScheduler | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  onEvent?: ((event: NodeEngineEvent) => void) | undefined;
  /** Best-effort persistence of a live concurrency change (#275). */
  persistConcurrency?: ((value: number) => void) | undefined;
}

/** How many settled jobs the snapshot remembers. A daemon runs for months. */
export const HISTORY_LIMIT = 50;

/**
 * Default lease-renew cadence: comfortably inside any sane lease window.
 *
 * ⚠ A FALLBACK, NOT THE ANSWER, since the server started sending
 * `renewIntervalMs` on every assignment. It is a fixed number chosen to be
 * safe against the shortest lease a server might grant, which necessarily
 * makes it wasteful against the longest: a job type declaring a six-hour
 * runtime ceiling takes a six-hour lease, and renewing that every 30 seconds
 * is 720 round trips to tell the server something it derived itself. The
 * server's per-job number wins wherever it is present; this covers an older
 * control plane, and the `--lease-renew-ms` operator override still outranks
 * both (see `processJob`).
 */
export const DEFAULT_LEASE_RENEW_MS = 30_000;

/** Default heartbeat cadence. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

const DEFAULT_POLL_MS = 5_000;

interface JobRecord extends ActiveJob {
  controller: AbortController;
  startedMs: number;
  renewHandle: unknown;
}

export class NodeEngine {
  private readonly api: NodeApi;
  private readonly executors: ExecutorRegistry;
  private readonly scheduler: EngineScheduler;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onEvent: ((event: NodeEngineEvent) => void) | undefined;
  private readonly persistConcurrency: ((value: number) => void) | undefined;
  private readonly leaseRenewIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly tmpDir: string;
  private readonly capabilities: Record<string, unknown> | undefined;
  private readonly requestedTypes: string[];

  readonly nodeId: string;

  private concurrency: number;
  private draining = false;
  private stopped = false;
  private running = false;
  private heartbeatHandle: unknown;
  private lastHeartbeatMs: number | undefined;
  private readonly startedAtMs: number;

  /**
   * Resolved to wake the loop out of a `Promise.race` it would otherwise sit
   * in until a job finished.
   *
   * Needed because the two blocking waits in `run()` are on IN-FLIGHT WORK,
   * and both `setConcurrency` (raising the cap) and `drain()` are decisions
   * made from OUTSIDE that work. Without this, raising the cap on a saturated
   * worker would take effect only when the next job happened to finish —
   * which, for a worker running one long job, is not "the next iteration" in
   * any useful sense.
   */
  private wake: { promise: Promise<void>; resolve: () => void } | undefined;

  private readonly inFlight = new Set<Promise<void>>();
  private readonly activeJobs = new Map<string, JobRecord>();
  private readonly history: HistoryEntry[] = [];
  private readonly counters: NodeCounters = { claimed: 0, succeeded: 0, failed: 0, rateLimited: 0 };

  constructor(options: NodeEngineOptions) {
    this.api = options.api;
    this.nodeId = options.nodeId;
    this.concurrency = options.concurrency;
    this.executors = options.executors ?? defaultExecutors().reduce((registry, executor) => registry.register(executor), new ExecutorRegistry());
    this.requestedTypes = options.eligibleTypes ?? [];
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.scheduler = options.scheduler ?? realScheduler;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onEvent = options.onEvent;
    this.persistConcurrency = options.persistConcurrency;
    this.tmpDir = options.tmpDir ?? join(process.cwd(), '.node-tmp');
    this.capabilities = options.capabilities;
    this.startedAtMs = this.now();
  }

  // ---------------------------------------------------------------------------
  // Public control surface — what the daemon's IPC and the TUI drive
  // ---------------------------------------------------------------------------

  /**
   * The types this node advertises: the operator's list intersected with what
   * it can actually run, or everything it can run when they named nothing.
   *
   * The intersection is not pedantry. Claiming a type with no executor means
   * accepting a lease and immediately failing it — the worst outcome, because
   * the job is charged an attempt for a decision this node could have made
   * before asking.
   */
  claimableTypes(): string[] {
    if (this.requestedTypes.length === 0) return this.executors.types();
    return this.requestedTypes.filter((type) => this.executors.has(type));
  }

  /**
   * Change the cap live.
   *
   * Fires an IMMEDIATE heartbeat rather than waiting for the next one, so the
   * server's own claim cap for this node updates within a second. Without
   * that, a scale-down would keep receiving work at the old rate for a full
   * heartbeat interval.
   */
  setConcurrency(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 64) {
      throw new RangeError(`Concurrency must be a whole number between 1 and 64 (got ${value}).`);
    }
    if (value === this.concurrency) return;
    this.concurrency = value;
    this.emit({ kind: 'concurrency-changed', at: this.iso(), concurrency: value });
    this.persistConcurrency?.(value);
    this.signalWake();
    void this.beat();
  }

  /** Finish in-flight work and stop claiming. Does NOT deregister. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.signalWake();
    this.emit({ kind: 'draining', at: this.iso(), inFlight: this.inFlight.size });
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Drain, then tear down.
   *
   * `deregister: false` is the headless/container contract: a restarting
   * replica must RE-ATTACH to its existing node row, not leak a new one on
   * every restart. #277's memory valve relies on the same thing.
   */
  async stop(options?: { deregister?: boolean }): Promise<void> {
    await this.drain();

    if (this.heartbeatHandle !== undefined) {
      this.scheduler.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }

    const deregister = options?.deregister !== false;
    if (deregister) {
      try {
        await this.api.deregister(this.nodeId);
      } catch {
        // A deregister that fails is not worth failing a shutdown over: the
        // server's own liveness cron marks a silent node offline anyway (#270).
      }
    }

    this.stopped = true;
    this.emit({ kind: 'stopped', at: this.iso(), deregistered: deregister });
  }

  /** One shape, consumed by `node status`, the daemon IPC and the TUI alike. */
  getSnapshot(): NodeSnapshot {
    const heartbeatAgeMs = this.lastHeartbeatMs === undefined ? null : this.now() - this.lastHeartbeatMs;
    return {
      nodeId: this.nodeId,
      status: this.stopped
        ? 'stopped'
        : this.draining
          ? 'draining'
          : !this.running
            ? 'starting'
            : this.activeJobs.size > 0
              ? 'working'
              : 'idle',
      concurrency: this.concurrency,
      eligibleTypes: this.claimableTypes(),
      activeJobs: [...this.activeJobs.values()].map(({ jobId, type, startedAt, attempts, leaseExpiresAt }) => ({
        jobId,
        type,
        startedAt,
        attempts,
        leaseExpiresAt,
      })),
      // A COPY, so a consumer holding a snapshot cannot see it mutate under
      // them — the TUI renders asynchronously and would otherwise show a list
      // that changed between two reads of the same object.
      history: [...this.history],
      counters: { ...this.counters },
      startedAt: new Date(this.startedAtMs).toISOString(),
      lastHeartbeatAt: this.lastHeartbeatMs === undefined ? null : new Date(this.lastHeartbeatMs).toISOString(),
      heartbeatAgeMs,
    };
  }

  // ---------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------

  /**
   * Run until drained. Resolves only once every in-flight job has settled.
   *
   * NOTE THE `Promise.race` GUARD: `processJob` never rejects (it reports the
   * failure to the server and resolves), because a rejected member would make
   * every `race` in this loop throw and take the worker down on the first
   * failed job.
   */
  async run(): Promise<void> {
    this.running = true;
    this.startHeartbeat();
    this.emit({ kind: 'started', at: this.iso(), nodeId: this.nodeId, concurrency: this.concurrency });

    while (!this.draining) {
      const free = this.concurrency - this.inFlight.size; // re-read each pass
      if (free <= 0) {
        // `waitForWake()` is in the race so a cap RAISE or a drain is acted on
        // now rather than whenever a job happens to end.
        await Promise.race([...this.inFlight, this.waitForWake()]);
        continue;
      }

      let claimed: NodeJobAssignment[];
      try {
        claimed = await this.api.claim(this.nodeId, { limit: free, types: this.claimableTypes() });
      } catch (error) {
        // A claim failure is transient by nature — a restarting API, a blip.
        // Back off one poll interval and try again rather than exiting: a
        // worker that dies on a deploy is a worker somebody has to restart.
        this.emit({ kind: 'claim-failed', at: this.iso(), error: messageOf(error) });
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (claimed.length > 0) {
        this.counters.claimed += claimed.length;
        this.emit({ kind: 'claimed', at: this.iso(), jobs: claimed });
        for (const assignment of claimed) {
          const promise: Promise<void> = this.processJob(assignment).finally(() => {
            this.inFlight.delete(promise);
          });
          this.inFlight.add(promise);
        }
        continue; // refill the remaining slots immediately
      }

      if (this.inFlight.size > 0) {
        // Wake on whichever comes first: a slot freeing up, or the poll
        // interval. Waiting only on the sleep would leave a freed slot idle
        // for the rest of the interval; waiting only on the jobs would never
        // re-check a queue that filled up while we were busy.
        await Promise.race([...this.inFlight, this.sleep(this.pollIntervalMs), this.waitForWake()]);
        continue;
      }

      this.emit({ kind: 'idle', at: this.iso() });
      await this.sleep(this.pollIntervalMs);
    }

    await Promise.allSettled([...this.inFlight]);
  }

  // ---------------------------------------------------------------------------
  // One job
  // ---------------------------------------------------------------------------

  /** NEVER REJECTS. See `run()`. */
  private async processJob(assignment: NodeJobAssignment): Promise<void> {
    const { job, params } = assignment;
    const startedMs = this.now();
    const controller = new AbortController();

    const record: JobRecord = {
      jobId: job.id,
      type: job.type,
      startedAt: new Date(startedMs).toISOString(),
      attempts: job.attempts,
      leaseExpiresAt: job.leaseExpiresAt,
      controller,
      startedMs,
      renewHandle: undefined,
    };
    this.activeJobs.set(job.id, record);
    this.emit({ kind: 'job-started', at: this.iso(), jobId: job.id, type: job.type });

    // The renew ticker runs for the WHOLE job, input download included: a
    // multi-gigabyte download can outlive a lease just as easily as the
    // compute can.
    //
    // THE SERVER'S NUMBER WINS WHEN IT SENT ONE. It derived `renewIntervalMs`
    // from the lease it granted THIS job (a third of it, clamped), so it is
    // the only cadence that is correct for a type whose lease is not the
    // deployment default — and it is per job, because a node claims across
    // several types at once and those rows no longer share a lease. The local
    // value stays the fallback for an older control plane that sends nothing.
    // Validated rather than trusted: a non-finite or non-positive number out
    // of a JSON body would become a `setInterval` firing flat out.
    const renewIntervalMs =
      typeof assignment.renewIntervalMs === 'number' &&
      Number.isFinite(assignment.renewIntervalMs) &&
      assignment.renewIntervalMs > 0
        ? assignment.renewIntervalMs
        : this.leaseRenewIntervalMs;

    record.renewHandle = this.scheduler.setInterval(() => {
      void this.renewLease(job.id);
    }, renewIntervalMs);

    let inputPath: string | undefined;

    try {
      const executor = this.executors.require(job.type);

      let input: { objectId: string; size: string; mimeType: string } | undefined;
      if (executor.requiresInput) {
        const resolved = await this.downloadInput(job.id, job.type);
        inputPath = resolved.path;
        input = resolved.meta;
        this.emit({
          kind: 'job-input',
          at: this.iso(),
          jobId: job.id,
          objectId: resolved.meta.objectId,
          bytes: resolved.meta.size,
        });
      }

      const result = await executor.execute({
        job,
        params,
        inputPath,
        input,
        api: this.api,
        nodeId: this.nodeId,
        signal: controller.signal,
        log: (message, fields) => {
          this.emit({
            kind: 'job-log',
            at: this.iso(),
            jobId: job.id,
            type: job.type,
            message,
            ...(fields !== undefined ? { fields } : {}),
          });
        },
      });

      const settlement = await this.api.submitResult(this.nodeId, job.id, job.type, result);

      this.counters.succeeded += 1;
      const durationMs = this.now() - startedMs;
      this.remember({
        jobId: job.id,
        type: job.type,
        outcome: 'succeeded',
        durationMs,
        finishedAt: this.iso(),
      });
      this.emit({
        kind: 'job-succeeded',
        at: this.iso(),
        jobId: job.id,
        type: job.type,
        durationMs,
        outcome: settlement.outcome,
      });
    } catch (error) {
      await this.reportFailure(job.id, job.type, startedMs, error);
    } finally {
      if (record.renewHandle !== undefined) this.scheduler.clearInterval(record.renewHandle);
      this.activeJobs.delete(job.id);
      // ON SUCCESS, ON FAILURE AND ON DRAIN. A worker that leaks one temp file
      // per job fills its volume in a week, and the failure that follows looks
      // like a storage problem rather than a cleanup one.
      if (inputPath !== undefined) await safeUnlink(inputPath);
    }
  }

  /**
   * The one place a failure is classified.
   *
   * A `ProviderRateLimitError` and nothing else sets `rateLimited`. `willRetry`
   * is advisory — the server owns the attempt budget and has the final word.
   */
  private async reportFailure(jobId: string, type: string, startedMs: number, error: unknown): Promise<void> {
    const rateLimit = error instanceof ProviderRateLimitError ? error : null;
    const message = messageOf(error);
    const durationMs = this.now() - startedMs;

    this.counters.failed += 1;
    if (rateLimit !== null) this.counters.rateLimited += 1;

    let willRetry = true;
    try {
      const settlement = await this.api.reportJobFailure(this.nodeId, jobId, {
        error: message,
        willRetry: true,
        ...(rateLimit !== null ? { rateLimited: true, retryAfterMs: rateLimit.retryAfterMs } : {}),
      });
      willRetry = settlement.willRetry;
    } catch {
      // The job is already leased to us and the server's reaper is the
      // backstop; failing to REPORT a failure must not take the worker down.
    }

    this.remember({
      jobId,
      type,
      outcome: 'failed',
      durationMs,
      finishedAt: this.iso(),
      error: message,
      ...(rateLimit !== null ? { rateLimited: true } : {}),
    });
    this.emit({
      kind: 'job-failed',
      at: this.iso(),
      jobId,
      type,
      durationMs,
      error: message,
      rateLimited: rateLimit !== null,
      willRetry,
    });
  }

  /**
   * Stream the job's input to a temp file.
   *
   * A `requiresInput` type with no download URL fails with a NAMED error here
   * — never an empty path handed downstream, which surfaces much later as an
   * opaque `ENOENT … open ''` that names neither the job nor the type.
   */
  private async downloadInput(
    jobId: string,
    type: string,
  ): Promise<{ path: string; meta: { objectId: string; size: string; mimeType: string } }> {
    let signed;
    try {
      signed = await this.api.downloadUrl(this.nodeId, jobId);
    } catch (error) {
      throw new MissingJobInputError(jobId, type, messageOf(error));
    }

    if (signed?.url === undefined || signed.url.length === 0) {
      throw new MissingJobInputError(jobId, type, 'the server returned an empty URL');
    }

    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    // Randomised, not job-id-derived: two attempts of the same job on the same
    // machine must not race on one path.
    const path = join(this.tmpDir, `${jobId}.${randomBytes(6).toString('hex')}.input`);

    const response = await this.fetchImpl(signed.url);
    if (!response.ok || response.body === null) {
      throw new MissingJobInputError(jobId, type, `download failed with HTTP ${response.status}`);
    }

    // Streamed, never buffered. The whole reason this type is worth running on
    // a node is that a 10 GB object costs a file handle, not 10 GB of heap.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path, { mode: 0o600 }));

    return {
      path,
      meta: { objectId: signed.objectId, size: signed.size, mimeType: signed.mimeType },
    };
  }

  /** Renew failure is NON-FATAL: the server's reaper is the backstop. */
  private async renewLease(jobId: string): Promise<void> {
    const record = this.activeJobs.get(jobId);
    if (record === undefined) return;
    try {
      const renewed = await this.api.renewLease(this.nodeId, jobId);
      record.leaseExpiresAt = renewed.leaseExpiresAt;
      this.emit({ kind: 'lease-renewed', at: this.iso(), jobId, leaseExpiresAt: renewed.leaseExpiresAt });
    } catch (error) {
      this.emit({ kind: 'lease-renew-failed', at: this.iso(), jobId, error: messageOf(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeatHandle !== undefined) return;
    // NOT `unref`'d — see the file header. This timer is what keeps an idle
    // worker process alive.
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      void this.beat();
    }, this.heartbeatIntervalMs);
    void this.beat();
  }

  private async beat(): Promise<void> {
    try {
      await this.api.heartbeat(this.nodeId, {
        status: 'online',
        concurrency: this.concurrency,
        ...(this.capabilities !== undefined ? { capabilities: this.capabilities } : {}),
      });
      this.lastHeartbeatMs = this.now();
      this.emit({ kind: 'heartbeat', at: this.iso(), concurrency: this.concurrency });
    } catch (error) {
      this.emit({ kind: 'heartbeat-failed', at: this.iso(), error: messageOf(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // Small internals
  // ---------------------------------------------------------------------------

  /** Bounded at HISTORY_LIMIT: a daemon runs for months. */
  private remember(entry: HistoryEntry): void {
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /** Memoised, so every racer in one pass awaits the SAME promise. */
  private waitForWake(): Promise<void> {
    if (this.wake === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.wake = { promise, resolve };
    }
    return this.wake.promise;
  }

  private signalWake(): void {
    const pending = this.wake;
    this.wake = undefined;
    pending?.resolve();
  }

  private emit(event: NodeEngineEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A consumer that throws — a wedged renderer, a broken IPC client — must
      // never take the worker down. #275's backlog guard is the other half.
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best effort. A file we cannot remove is a disk-space problem to log,
    // never a reason to fail a job that already succeeded.
  }
}
