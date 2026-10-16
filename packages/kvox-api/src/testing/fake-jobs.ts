import { randomUUID } from 'node:crypto';

import {
  KvoxRateLimitError,
  type KvoxEnqueueInput,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobsPort,
} from '../ports/index.js';

/** Attempts a job gets when its handler declares no profile. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A job in the fake queue.
 *
 * @stability experimental
 */
export interface FakeKvoxJobRecord {
  /** The job id. */
  id: string;
  /** What was enqueued. */
  input: KvoxEnqueueInput;
  /** Where the job stands. */
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  /** Attempts started so far. */
  attempts: number;
  /** The last failure's message. */
  lastError: string | null;
  /** Rate-limit deferrals so far. */
  rateLimitHits: number;
}

/**
 * An in-memory {@link KvoxJobsPort} that runs jobs when told to.
 *
 * @stability experimental
 */
export interface FakeKvoxJobs extends KvoxJobsPort {
  /** Every job ever enqueued, in order. */
  readonly jobs: readonly FakeKvoxJobRecord[];
  /**
   * Runs pending jobs of registered types until none is runnable. A job that
   * fails is retried until its attempts are used up; one that raises
   * {@link KvoxRateLimitError} is deferred and not retried within this drain.
   *
   * @returns how many attempts ran.
   */
  runAll(): Promise<number>;
}

/**
 * Builds a fake job queue. It dedups on `type` plus subject while a job is
 * pending or running, honours `skipDedup`, counts attempts against the handler's
 * profile and drains with `runAll`.
 *
 * @returns the fake queue.
 * @stability experimental
 */
export function createFakeKvoxJobs(): FakeKvoxJobs {
  const handlers = new Map<string, KvoxJobHandler>();
  const jobs: FakeKvoxJobRecord[] = [];

  const dedupKey = (input: KvoxEnqueueInput): string =>
    `${input.type}:${input.subjectType ?? ''}:${input.subjectId ?? ''}`;

  const active = (job: FakeKvoxJobRecord): boolean => job.status === 'pending' || job.status === 'running';

  return {
    get jobs() {
      return jobs;
    },

    async enqueue(input) {
      if (!input.skipDedup) {
        const key = dedupKey(input);
        const existing = jobs.find((job) => active(job) && !job.input.skipDedup && dedupKey(job.input) === key);
        if (existing) return { id: existing.id, deduplicated: true };
      }
      const record: FakeKvoxJobRecord = {
        id: randomUUID(),
        input,
        status: 'pending',
        attempts: 0,
        lastError: null,
        rateLimitHits: 0,
      };
      jobs.push(record);
      return { id: record.id, deduplicated: false };
    },

    registerHandler(handler) {
      if (handlers.has(handler.type)) {
        throw new Error(`A handler for job type "${handler.type}" is already registered`);
      }
      handlers.set(handler.type, handler);
    },

    isRegistered(type) {
      return handlers.has(type);
    },

    async runAll() {
      let ran = 0;
      const deferred = new Set<string>();
      for (;;) {
        const next = jobs.find(
          (job) => job.status === 'pending' && handlers.has(job.input.type) && !deferred.has(job.id),
        );
        if (!next) return ran;

        const handler = handlers.get(next.input.type) as KvoxJobHandler;
        next.status = 'running';
        next.attempts += 1;
        ran += 1;
        const view: KvoxJob = {
          id: next.id,
          type: next.input.type,
          subjectType: next.input.subjectType ?? null,
          subjectId: next.input.subjectId ?? null,
          payload: next.input.payload,
          attempts: next.attempts,
          orgId: null,
        };

        try {
          await handler.process(view);
          next.status = 'succeeded';
        } catch (error) {
          if (error instanceof KvoxRateLimitError) {
            next.status = 'pending';
            next.attempts -= 1;
            next.rateLimitHits += 1;
            deferred.add(next.id);
            continue;
          }
          next.lastError = error instanceof Error ? error.message : String(error);
          next.status = next.attempts >= (handler.profile?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) ? 'failed' : 'pending';
        }
      }
    },
  };
}
