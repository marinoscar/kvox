import { Injectable, Logger } from '@nestjs/common';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import {
  JobHandlerRegistry,
  JobsService,
  ProviderThrottleService,
  RateLimitError,
  buildDedupKey,
  type Job,
  type JobHandler,
  type JobsInputJsonObject,
} from '@marinoscar/platform-api/jobs';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  KvoxRateLimitError,
  type KvoxEnqueueInput,
  type KvoxEnqueueResult,
  type KvoxJob,
  type KvoxJobHandler,
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
        : await this.prisma.job.findFirst({
            where: {
              dedupKey: buildDedupKey(input.type, input.subjectType, input.subjectId),
              status: { in: ['pending', 'running'] },
            },
            select: { id: true },
          });

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
    };

    this.registry.register(adapted);
  }

  isRegistered(type: string): boolean {
    return this.registry.get(type) !== undefined;
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
