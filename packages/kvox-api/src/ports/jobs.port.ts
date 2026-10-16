import type { z } from 'zod';

// =============================================================================
// KVOX_JOBS: the background-job port (issue 5.4, epic 486)
// =============================================================================
//
// Anything that outlives the request that started it is a registered handler run
// through this port. The web edition binds it over the platform queue (leases,
// dedup, worker nodes); Desktop binds it to an in-process queue.
//
// A JOB `type` STRING IS PERMANENT once a job of that type exists: a queued row
// names its handler by that string. `KvoxJobHandler` deliberately has no field
// the platform handler lacks; `profile` carries exactly `maxRuntimeMs` and
// `maxAttempts`.
// =============================================================================

/**
 * Injection token of {@link KvoxJobsPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_JOBS = Symbol.for('@marinoscar/kvox/KVOX_JOBS');

/**
 * The job a handler is given.
 *
 * @stability experimental
 */
export interface KvoxJob<P = unknown> {
  /** The job id. */
  id: string;
  /** The handler type. */
  type: string;
  /** The kind of thing the job is about, or `null`. */
  subjectType: string | null;
  /** Which one, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: P;
  /** Attempts so far, this one included. */
  attempts: number;
  /** The organization the job belongs to, or `null` for a system job. */
  orgId: string | null;
}

/**
 * How long a handler may run and how often it is tried.
 *
 * @stability experimental
 */
export interface KvoxJobProfile {
  /** The longest one attempt may run, in milliseconds. Lease and renewal derive from it. */
  maxRuntimeMs: number;
  /** How many attempts a job gets in total. */
  maxAttempts: number;
}

/**
 * A handler for one job type.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxJobHandler<P = unknown> {
  /** The job type this handler runs. Permanent once jobs of it exist. */
  readonly type: string;
  /** A human label for the admin job list. */
  readonly label?: string;
  /** The execution profile, or the host default when absent. */
  readonly profile?: KvoxJobProfile;
  /**
   * True when the handler calls a model. The web adapter refuses to register an
   * AI handler that is also eligible for a worker node: AI work spends the
   * user's own key and stays on the server.
   */
  readonly usesAi?: boolean;
  /**
   * Runs one attempt. Throwing fails the attempt; throwing
   * {@link KvoxRateLimitError} defers it.
   *
   * @param job - the job.
   */
  process(job: KvoxJob<P>): Promise<void>;
  /** The schema of the result a worker node returns; present with `persistNodeResult`. */
  nodeResultSchema?: z.ZodType;
  /**
   * Stores the result a worker node computed. A handler with both this and
   * `nodeResultSchema` may run on a node.
   *
   * @param job - the job.
   * @param result - the validated node result.
   */
  persistNodeResult?(job: KvoxJob<P>, result: unknown): Promise<void>;
}

/**
 * What to enqueue.
 *
 * @stability experimental
 */
export interface KvoxEnqueueInput {
  /** The handler type. */
  type: string;
  /** Why the job exists (`upload`, `rerun`, `backfill`); the host default when absent. */
  reason?: string;
  /** The kind of thing the job is about. */
  subjectType?: string;
  /** Which one. Two pending jobs with the same type and subject collapse into one. */
  subjectId?: string;
  /** The handler input. Carry identifiers, not copies of data. */
  payload: Record<string, unknown>;
  /** Ascending is more urgent. */
  priority?: number;
  /** Earliest time the job may run. */
  scheduledFor?: Date;
  /** Opt out of dedup: the job is distinct work. */
  skipDedup?: boolean;
  /** The provider throttle bucket the work draws on (`aiProviderThrottleKey(userId)`). */
  throttleKey?: string;
}

/**
 * What `enqueue` returns.
 *
 * @stability experimental
 */
export interface KvoxEnqueueResult {
  /** The job's id: the new one, or the existing one the call collapsed into. */
  id: string;
  /** True when the call collapsed into a job already in flight. */
  deduplicated: boolean;
}

/**
 * The job port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxJobsPort {
  /**
   * Queues a job, collapsing into the pending or running one of the same type
   * and subject unless `skipDedup` is set.
   *
   * @param input - what to run.
   * @returns the job id, and whether this call collapsed into an existing job.
   */
  enqueue(input: KvoxEnqueueInput): Promise<KvoxEnqueueResult>;

  /**
   * Registers the handler for a type. Call once per type, at start-up.
   *
   * @param handler - the handler.
   * @throws Error when the host refuses it (for example an AI handler declared node-eligible).
   */
  registerHandler(handler: KvoxJobHandler): void;

  /**
   * Whether a handler is registered for the type.
   *
   * @param type - the job type.
   */
  isRegistered(type: string): boolean;
}

/**
 * Thrown by a handler when the provider's rate limit was hit. The queue defers
 * the job instead of failing it. The bucket is per user for AI work, never a
 * shared one.
 * @stability experimental
 */
export class KvoxRateLimitError extends Error {
  /** The throttle bucket that was limited. */
  readonly throttleKey: string;

  /** The provider's retry hint, in milliseconds, when it gave one. */
  readonly retryAfterMs?: number;

  /**
   * @param throttleKey - the bucket that was limited.
   * @param retryAfterMs - the provider's retry hint.
   */
  constructor(throttleKey: string, retryAfterMs?: number) {
    super(`Rate limited on ${throttleKey}`);
    this.name = 'KvoxRateLimitError';
    this.throttleKey = throttleKey;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
