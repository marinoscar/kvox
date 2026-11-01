// =============================================================================
// `kvox.webhook_emit` (marinoscar/kvox#795)
// =============================================================================
//
// Publishes one catalog event through `KVOX_WEBHOOKS`. The listener
// (`WebhookEventsListener`) only enqueues; this handler is where the counts that
// need a database read are gathered and the one port call is made.
//
// ⚠ SERVER-ONLY PERMANENTLY: NO `nodeResultSchema`, NO `persistNodeResult`. The
// work is one small read and a call into the host's own webhook registry, which
// a remote worker node has no business doing.
//
// Ids and counts only: the payload is parsed with the event's strict schema, so
// a field that is not in the catalog fails the job instead of leaving the
// deployment. An unreadable payload or an unknown event key RETURNS (a retry
// cannot repair it).
// =============================================================================

import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';

import {
  KVOX_JOBS,
  KVOX_PRISMA,
  KVOX_WEBHOOKS,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
  type KvoxPrismaClientLike,
  type KvoxWebhooksPort,
} from '../ports/index.js';
import { KVOX_WEBHOOK_EMIT_JOB_TYPE } from './job-types.js';
import { webhookEmitPayloadSchema } from './webhook-emit.payload.js';
import {
  KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
  KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED,
  findKvoxWebhookEvent,
} from './webhook-events.js';

/** The two reads the handler makes, narrowed from the host's Prisma client. */
interface WebhookCountsDb {
  kgProposalItem: { count(args: { where: { proposalId: string } }): Promise<number> };
  noteImportBatchItem: {
    groupBy(args: {
      by: ['status'];
      where: { batchId: string };
      _count: { _all: true };
    }): Promise<Array<{ status: string; _count: { _all: number } }>>;
  };
}

/**
 * The execution profile of `kvox.webhook_emit`.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_EMIT_PROFILE: KvoxJobProfile = { maxRuntimeMs: 30_000, maxAttempts: 3 };

/**
 * The handler of `kvox.webhook_emit`.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class WebhookEmitHandler implements KvoxJobHandler, OnModuleInit {
  readonly type = KVOX_WEBHOOK_EMIT_JOB_TYPE;
  readonly label = 'Publish webhook event';
  readonly profile = KVOX_WEBHOOK_EMIT_PROFILE;

  private readonly logger = new Logger(WebhookEmitHandler.name);

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxPrismaClientLike,
    @Optional() @Inject(KVOX_WEBHOOKS) private readonly webhooks?: KvoxWebhooksPort,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    if (!this.webhooks) return; // Unbound (Desktop): nothing to publish.

    const parsed = webhookEmitPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      this.logger.warn(`${KVOX_WEBHOOK_EMIT_JOB_TYPE} job ${job.id} carries no readable payload; nothing to do`);
      return;
    }
    const { eventKey, userId, refs } = parsed.data;
    const def = findKvoxWebhookEvent(eventKey);
    if (!def) {
      this.logger.warn(`${KVOX_WEBHOOK_EMIT_JOB_TYPE} job ${job.id}: unknown event ${eventKey}; nothing to do`);
      return;
    }

    const data = def.payloadSchema.parse(await this.complete(eventKey, refs));
    await this.webhooks.emit(eventKey, data, { orgId: job.orgId ?? null, userId });
  }

  /** Adds the counts that need a read; every other event is complete as enqueued. */
  private async complete(eventKey: string, refs: Record<string, string | number | null>): Promise<Record<string, unknown>> {
    const db = this.prisma as unknown as WebhookCountsDb;

    if (eventKey === KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED) {
      const itemCount = await db.kgProposalItem.count({ where: { proposalId: String(refs.proposalId) } });
      return { ...refs, itemCount };
    }

    if (eventKey === KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED) {
      const rows = await db.noteImportBatchItem.groupBy({
        by: ['status'],
        where: { batchId: String(refs.batchId) },
        _count: { _all: true },
      });
      const counts = { imported: 0, failed: 0, missing: 0, skipped: 0, other: 0 };
      for (const row of rows) {
        const n = row._count._all;
        if (row.status === 'imported' || row.status === 'failed' || row.status === 'missing' || row.status === 'skipped') {
          counts[row.status] += n;
        } else {
          counts.other += n;
        }
      }
      return { ...refs, counts };
    }

    return refs;
  }
}
