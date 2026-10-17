import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import {
  JOB_SETTLED_EVENT,
  JobHandlerRegistry,
  JobsService,
  ProviderThrottleService,
  RateLimitError,
  buildDedupKey,
  jobTempPath,
  type Job,
  type JobHandler,
  type JobSettledEvent,
  type JobsInputJsonObject,
  type JobsTx,
} from '@marinoscar/platform-api/jobs';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  KvoxRateLimitError,
  type KvoxActiveJob,
  type KvoxActiveJobQuery,
  type KvoxEnqueueInput,
  type KvoxEnqueueResult,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobSettledEvent,
  type KvoxJobsPort,
} from '@marinoscar/kvox-api/ports';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// PlatformKvoxJobsAdapter: the `KVOX_JOBS` port over the platform queue (issue
// #490, epic #486)
// =============================================================================
//
// `registerHandler` adapts a `KvoxJobHandler` to the platform `JobHandler` with the
// SAME `type`, `profile`, `nodeResultSchema` and `persistNodeResult`, and registers
// it with `JobHandlerRegistry`: the queue, the lease, the worker nodes and the admin
// list see an ordinary handler. A `type` string is permanent once jobs of it exist,
// so the adapter never rewrites one (`test/jobs/job-type-snapshot.spec.ts` pins them).
//
// THREE THINGS THE ADAPTER DOES THAT A HANDLER MUST NOT HAVE TO:
//   * `KvoxRateLimitError` -> the platform's `RateLimitError`, because the queue
//     defers a job on `instanceof RateLimitError` and nothing else. The throttle key
//     the error names is registered first, so the cooldown lands on that bucket.
//   * the throttle key given at `enqueue` is recorded on the job row
//     (`provider_key`) and registered with the provider throttle immediately before
//     the handler runs, per job, as `note.generate` always did for its per-user
//     bucket. It is never a shared key for per-user AI work.
//   * `orgId` is the default organization's (single-organization mode), passed
//     explicitly on every enqueue.
//
// AI JOBS ARE SERVER-ONLY, PERMANENTLY. They spend the user's own key and no vendor
// offers a job-scoped sub-key to broker to a node, so a handler that calls a model
// and also declares `nodeResultSchema` is refused here, at registration (boot).
// =============================================================================

/**
 * The job types that call a model (`AGENTS.md`: "AI jobs ... are server-only
 * permanently"). A handler of one of these may not be node-eligible. The strings are
 * permanent.
 */
export const KVOX_AI_JOB_TYPES: ReadonlySet<string> = new Set([
  'note.generate',
  'note.retitle',
  'transcript.name_check',
  'search.index',
  'ask.respond',
  'kg.extract',
  'kg.resolve',
  'kg.embed',
  'kg.entity_digest',
  'kg.import',
]);

/** The enqueue reason when a caller gives none: new work, as an upload is. */
const DEFAULT_REASON = 'upload';

@Injectable()
export class PlatformKvoxJobsAdapter implements KvoxJobsPort {
  private readonly logger = new Logger(PlatformKvoxJobsAdapter.name);

  private defaultOrg: Promise<string> | null = null;

  constructor(
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Trace()
  async enqueue(input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> {
    const orgId = await this.orgId();

    // The platform returns the row either way and does not say which; look first.
    // A concurrent identical enqueue between this read and the insert is reported as new,
    // which is harmless: the postcondition ("one job for this work is queued") holds.
    const existing =
      input.skipDedup === true
        ? null
        : ((await this.prisma.job.findFirst({
            where: {
              dedupKey: buildDedupKey(input.type, input.subjectType, input.subjectId),
              status: { in: ['pending', 'running'] },
            },
            select: { id: true },
          })) ?? null);

    const job = await this.jobs.enqueue({
      type: input.type,
      reason: input.reason ?? DEFAULT_REASON,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload as JobsInputJsonObject,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      scheduledFor: input.scheduledFor ?? null,
      skipDedup: input.skipDedup === true,
      orgId,
    });

    if (input.throttleKey !== undefined && existing === null) {
      await this.jobs.recordProvider(job.id, input.throttleKey, null);
    }

    return { id: job.id, deduplicated: existing !== null && existing.id === job.id };
  }

  /** Joins the caller's open transaction through the platform queue's `enqueueWithin`. */
  @Trace()
  async enqueueWithin(tx: unknown, input: KvoxEnqueueInput): Promise<KvoxEnqueueResult> {
    const orgId = await this.orgId();

    const job = await this.jobs.enqueueWithin(tx as JobsTx, {
      type: input.type,
      reason: input.reason ?? DEFAULT_REASON,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload as JobsInputJsonObject,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      scheduledFor: input.scheduledFor ?? null,
      skipDedup: input.skipDedup === true,
      orgId,
    });

    // `throttleKey` is not recorded here: the job row exists only once the caller's
    // transaction commits, and a handler that hits a provider limit names its bucket
    // itself (`KvoxRateLimitError`), which `run` registers with the throttle.

    return { id: job.id, deduplicated: false };
  }

  registerHandler(handler: KvoxJobHandler): void {
    if (handler.nodeResultSchema !== undefined && (handler.usesAi === true || KVOX_AI_JOB_TYPES.has(handler.type))) {
      throw new Error(
        `Job type "${handler.type}" calls a model and may not declare nodeResultSchema: AI jobs are server-only because they spend the user's own key.`,
      );
    }
    if ((handler.nodeResultSchema === undefined) !== (handler.persistNodeResult === undefined)) {
      throw new Error(
        `Job type "${handler.type}" must declare nodeResultSchema and persistNodeResult together or neither.`,
      );
    }

    const adapted: JobHandler = {
      type: handler.type,
      ...(handler.label !== undefined ? { label: handler.label } : {}),
      ...(handler.profile !== undefined ? { profile: handler.profile } : {}),
      process: (job) => this.run(handler, job),
      ...(handler.nodeResultSchema !== undefined && handler.persistNodeResult !== undefined
        ? {
            nodeResultSchema: handler.nodeResultSchema,
            persistNodeResult: (job: Job, result: unknown) => handler.persistNodeResult!(toKvoxJob(job), result),
          }
        : {}),
      // The worker-node plane's two hooks: where a node's output upload lands, and the
      // deployment's runtime switch for offering the type to nodes at all.
      ...(handler.deriveOutputKey !== undefined
        ? { deriveOutputKey: (job: Job) => handler.deriveOutputKey!(toKvoxJob(job)) }
        : {}),
      ...(handler.nodeOffloadEnabled !== undefined
        ? { nodeOffloadEnabled: () => handler.nodeOffloadEnabled!() }
        : {}),
    };

    this.registry.register(adapted);

    // A handler whose type draws on ONE deployment-wide provider bucket says so here (a
    // per-user bucket is given at `enqueue`).
    if (handler.throttleKey !== undefined) this.throttle.registerProviderKey(handler.type, handler.throttleKey);
  }

  isRegistered(type: string): boolean {
    return this.registry.get(type) !== undefined;
  }

  onSettled(listener: (event: KvoxJobSettledEvent) => void): void {
    this.events.on(JOB_SETTLED_EVENT, (event: JobSettledEvent) => {
      if (event.status !== 'succeeded' && event.status !== 'failed') return;

      try {
        listener({
          jobId: event.jobId,
          type: event.type,
          status: event.status,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          payload: event.job.payload,
          lastError: event.lastError,
        });
      } catch (error) {
        this.logger.error(
          `A job-settled listener threw for ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  @Trace()
  async findActive(query: KvoxActiveJobQuery): Promise<KvoxActiveJob[]> {
    const matches: Array<Record<string, unknown>> = [];

    if (query.subjectIds !== undefined && query.subjectIds.length > 0) {
      matches.push({
        ...(query.subjectType !== undefined ? { subjectType: query.subjectType } : {}),
        subjectId: { in: [...query.subjectIds] },
      });
    }

    if (query.payloadKey !== undefined) {
      for (const value of query.payloadValues ?? []) {
        matches.push({ payload: { path: [query.payloadKey], equals: value } });
      }
    }

    if (matches.length === 0 && (query.subjectIds !== undefined || query.payloadValues !== undefined)) return [];

    const rows = await this.prisma.job.findMany({
      where: {
        type: { in: [...query.types] },
        status: { in: ['pending', 'running'] },
        ...(query.excludeJobId !== undefined ? { id: { not: query.excludeJobId } } : {}),
        ...(matches.length > 0 ? { OR: matches } : {}),
      },
      select: { id: true, type: true, subjectType: true, subjectId: true, payload: true },
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      payload: row.payload,
    }));
  }

  tempPath(suffix?: string): string {
    return jobTempPath(suffix);
  }

  /** One attempt: register the job's throttle bucket, run, and translate a rate limit. */
  private async run(handler: KvoxJobHandler, job: Job): Promise<void> {
    if (job.providerKey) this.throttle.registerProviderKey(job.type, job.providerKey);

    try {
      await handler.process(toKvoxJob(job));
    } catch (error) {
      if (error instanceof KvoxRateLimitError) {
        this.throttle.registerProviderKey(job.type, error.throttleKey);
        throw new RateLimitError(error.message, error.retryAfterMs);
      }
      throw error;
    }
  }

  /** The default organization, resolved once. */
  private orgId(): Promise<string> {
    if (!this.defaultOrg) {
      this.defaultOrg = resolveOrgId(this.prisma, null, 'PlatformKvoxJobsAdapter').catch((error: unknown) => {
        this.defaultOrg = null;
        this.logger.error('Could not resolve the default organization for a job');
        throw error;
      });
    }
    return this.defaultOrg;
  }
}

/** The handler's view of a platform job row. */
function toKvoxJob(job: Job): KvoxJob {
  return {
    id: job.id,
    type: job.type,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    payload: job.payload,
    attempts: job.attempts,
    orgId: job.orgId,
  };
}
