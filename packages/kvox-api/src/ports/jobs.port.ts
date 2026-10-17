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
   * The provider throttle bucket every job of this type draws on (for example
   * the transcription provider's deployment-wide key). Registered with the host's
   * throttle when the handler is registered, so the queue holds back claims while
   * the bucket is cooling down. Per-user buckets are given at `enqueue` instead.
   */
  readonly throttleKey?: string;
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
  /**
   * Where a worker node's output upload lands (the object-store key). Present on a
   * node-eligible type whose node uploads a file.
   *
   * @param job - the job.
   */
  deriveOutputKey?(job: KvoxJob<P>): Promise<string>;
  /**
   * A deployment's runtime switch for offering this type to worker nodes. Absent
   * means yes; a rejection is treated as no.
   */
  nodeOffloadEnabled?(): Promise<boolean>;
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
 * What a settled job reports to {@link KvoxJobsPort.onSettled} listeners.
 *
 * @stability experimental
 */
export interface KvoxJobSettledEvent {
  /** The job id. */
  jobId: string;
  /** The handler type. */
  type: string;
  /** How it ended: `failed` is terminal (attempts exhausted), not a retry. */
  status: 'succeeded' | 'failed';
  /** The kind of thing the job was about, or `null`. */
  subjectType: string | null;
  /** Which one, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: unknown;
  /** The last error message of a failed job, or `null`. */
  lastError: string | null;
}

/**
 * Which not-yet-settled jobs {@link KvoxJobsPort.findActive} looks for. A job
 * matches when its type is listed and it is about one of the named subjects OR
 * carries one of the named payload values.
 *
 * @stability experimental
 */
export interface KvoxActiveJobQuery {
  /** The handler types to look at. */
  types: readonly string[];
  /** The subject kind to match, together with `subjectIds`. */
  subjectType?: string;
  /** The subject ids to match. */
  subjectIds?: readonly string[];
  /** A top-level payload key to match, together with `payloadValues`. */
  payloadKey?: string;
  /** The payload values to match. */
  payloadValues?: readonly string[];
  /** A job to leave out (the one asking). */
  excludeJobId?: string;
}

/**
 * A pending or running job, as {@link KvoxJobsPort.findActive} reports it.
 *
 * @stability experimental
 */
export interface KvoxActiveJob {
  /** The job id. */
  id: string;
  /** The handler type. */
  type: string;
  /** The subject kind, or `null`. */
  subjectType: string | null;
  /** The subject id, or `null`. */
  subjectId: string | null;
  /** The input the enqueuer gave. */
  payload: unknown;
}

/**
 * The newest job of a type and subject, whatever its state, as
 * {@link KvoxJobsPort.findLatest} reports it.
 *
 * @stability experimental
 */
export interface KvoxJobSnapshot {
  /** The job id. */
  id: string;
  /** The handler type. */
  type: string;
  /** Where the job stands. `succeeded` and `failed` are terminal. */
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  /** The earliest time the job may run, or `null` when it may run now. */
  scheduledFor: Date | null;
  /** When the job was queued. */
  createdAt: Date;
  /** When the job settled, or `null` while it has not. */
  finishedAt: Date | null;
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
   * Queues a job INSIDE a database transaction the caller has open, so the row the
   * job is about and the job commit together or not at all. `tx` is the client a
   * `KVOX_PRISMA.$transaction(async (tx) => ...)` callback was given; the job exists
   * for the queue only once that transaction commits. A host whose queue cannot join
   * the caller's transaction may enqueue after the callback returns instead.
   *
   * @param tx - the transaction client of the open transaction.
   * @param input - what to run.
   * @returns the job id, and whether this call collapsed into an existing job.
   */
  enqueueWithin(tx: unknown, input: KvoxEnqueueInput): Promise<KvoxEnqueueResult>;

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

  /**
   * Listens for jobs that reached a terminal state. The listener is a
   * bystander: it must not do work inline (enqueue, or detach), and a throw is
   * logged, never propagated.
   *
   * @param listener - called once for each settled job.
   */
  onSettled(listener: (event: KvoxJobSettledEvent) => void): void;

  /**
   * The pending or running jobs that match a query: the answer to "is anything
   * still about to touch this subject?".
   *
   * @param query - the types, and the subjects or payload values to look for.
   */
  findActive(query: KvoxActiveJobQuery): Promise<KvoxActiveJob[]>;

  /**
   * The newest job of a type about one subject, in any state: the answer to "did the
   * last one fail, and when?" and to "is a delayed one still waiting?".
   *
   * @param query - the handler type and the subject.
   * @returns the job, or `null` when none was ever queued.
   */
  findLatest(query: { type: string; subjectType: string; subjectId?: string }): Promise<KvoxJobSnapshot | null>;

  /**
   * Makes a pending job runnable now by clearing a `scheduledFor` that lies in the
   * future. A job that is running, finished or already due is left alone.
   *
   * @param jobId - the job.
   * @returns true when a delayed job was pulled forward.
   */
  runNow(jobId: string): Promise<boolean>;

  /**
   * A fresh path for a scratch file the host sweeps if the process dies before
   * the handler removes it. The caller creates and deletes the file.
   *
   * @param suffix - a file extension such as `.m4a`.
   */
  tempPath(suffix?: string): string;
}

/**
 * The well-known key under which an error answers "am I a provider rate limit?"
 * for a queue that classifies thrown values. A string registered with
 * `Symbol.for`, so a host recognises it without importing this package; it is
 * the same key the web edition's platform queue reads.
 *
 * @stability experimental
 */
export const KVOX_CLASSIFY_RATE_LIMIT: unique symbol = Symbol.for('jobs.classifyRateLimit');

/**
 * What a rate-limit error says about itself to a queue that asks.
 *
 * @stability experimental
 */
export interface KvoxRateLimitClassification {
  /** Always true: this error is a provider rate limit. */
  rateLimited: true;
  /** The provider's retry hint in milliseconds, or `null` when it gave none. */
  retryAfterMs: number | null;
}

/**
 * Thrown by a handler when the provider's rate limit was hit. The queue defers
 * the job instead of failing it. The bucket is per user for AI work, except the
 * transcription provider, whose key is the deployment's.
 *
 * The error classifies itself through {@link KVOX_CLASSIFY_RATE_LIMIT}, so a
 * handler a host registers without the jobs port (the web edition's transcript
 * handlers until they move into this package) still defers on it.
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
   * @param message - what to say in the job's last error; defaults to naming the bucket.
   */
  constructor(throttleKey: string, retryAfterMs?: number, message?: string) {
    super(message ?? `Rate limited on ${throttleKey}`);
    this.name = 'KvoxRateLimitError';
    this.throttleKey = throttleKey;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Answers a queue's self-classification question: this is a rate limit, with
   * the provider's retry hint.
   *
   * @returns the verdict.
   */
  [KVOX_CLASSIFY_RATE_LIMIT](): KvoxRateLimitClassification {
    return { rateLimited: true, retryAfterMs: this.retryAfterMs ?? null };
  }
}
