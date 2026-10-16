// =============================================================================
// The telemetry slice's job queue port (issue #471, epic #467)
// =============================================================================
//
// The two telemetry job types, `telemetry.retention.apply` (the store's TTL) and
// `telemetry.stack.deploy` (the managed stack through the stack agent), run on the
// platform queue. Both are SERVER-ONLY: they hold the GreptimeDB admin login and
// the stack-agent token, privileges a worker node must never hold, so neither
// handler declares `nodeResultSchema` or `persistNodeResult`.
//
// The retention CRON only enqueues (root rule 1): `enqueueHousekeepingJob` skips
// the tick when one is already pending or running. Every enqueue passes
// `orgId: null` (system jobs).
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import {
  JobHandlerRegistry,
  JobsService,
  enqueueHousekeepingJob,
} from '@marinoscar/platform-api/jobs';
import type { JobHandler } from '@marinoscar/platform-api/jobs';
import type {
  TelemetryJobHandler,
  TelemetryJobRecord,
  TelemetryJobsPort,
} from '@marinoscar/platform-api/telemetry';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TelemetryJobsAdapter implements TelemetryJobsPort {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueue(input: {
    type: string;
    reason: 'upload' | 'rerun' | 'backfill';
    payload?: Record<string, unknown>;
  }): Promise<{ id: string; status: string }> {
    const job = await this.jobs.enqueue({
      type: input.type,
      reason: input.reason,
      payload: (input.payload ?? null) as never,
      orgId: null,
    });
    return { id: job.id, status: job.status };
  }

  async enqueueHousekeepingJob(options: {
    type: string;
    what: string;
    logger: Logger;
  }): Promise<void> {
    await enqueueHousekeepingJob({
      jobs: this.jobs,
      prisma: this.prisma,
      logger: options.logger,
      type: options.type,
      what: options.what,
    });
  }

  registerHandler(handler: TelemetryJobHandler): void {
    this.registry.register(handler as unknown as JobHandler);
  }

  async findLatest(type: string): Promise<TelemetryJobRecord | null> {
    const job = await this.prisma.job.findFirst({
      where: { type },
      orderBy: { createdAt: 'desc' },
    });
    return job
      ? {
          id: job.id,
          type: job.type,
          status: job.status,
          payload: job.payload,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
          lastError: job.lastError,
        }
      : null;
  }

  async updatePayload(jobId: string, payload: Record<string, unknown>): Promise<void> {
    await this.prisma.job.update({ where: { id: jobId }, data: { payload: payload as never } });
  }
}
