// =============================================================================
// GraphEntitiesService (#355, epic #344; docs/specs/ontology.md §8, §12)
// =============================================================================
//
// Orchestrates `PATCH /api/graph/entities/:id` — the manual entity edit, §8's
// second named exception to "nothing enters the graph except through a
// reviewed proposal". The write itself is `GraphWriteService.updateEntity`;
// this service owns the envelope around it:
//
//   1. authorise through `GraphAccessService.require(…, 'edit', …)` — 404 for
//      no access (or a merged entity), 403 for the caller's own entity without
//      `graph:write`;
//   2. ONE transaction for the edit;
//   3. afterwards, OUTSIDE the transaction: the audit row and the guarded
//      enqueues.
//
// GUARDED ENQUEUES. `kg.embed` (#364) and `kg.entity_digest` (#372) are
// registered by later issues. Enqueueing a type nobody handles would leave a
// `pending` row no worker can ever claim — a permanent backlog of one in the
// admin job list — so each is enqueued only while its handler is registered
// (the `transcript-pipeline.service.ts` `registry.get(TRANSCODE_JOB_TYPE)`
// pattern). The payload shapes are the ones those issues define, one shape
// per job type, program-wide. The digest is also gated on `ai.graphEnabled`
// (#360), read defensively: until #360 adds the field, it is absent and
// therefore off — the spec's default.
//
// ⚠ The audit meta carries KEYS AND COUNTS ONLY, never a label or a value:
// props may be personal.
// =============================================================================

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { KgEntity, KgEntityAlias, Prisma } from '@prisma/client';

import { AiSettingsService } from '../ai/ai-settings.service';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { GraphAccessService } from './access/graph-access.service';
import type { GraphEntityResponse, PatchEntityDto } from './dto/graph-entity.dto';
import {
  FORGET_CONFIRMATION_MESSAGE,
  FORGET_NOT_PERSON_MESSAGE,
  forgetEntitySchema,
  type ForgetEntityResponse,
} from './dto/graph-forget.dto';
import {
  KG_EMBED_JOB_TYPE,
  KG_ENTITY_DIGEST_JOB_TYPE,
  KG_PURGE_JOB_TYPE,
  KG_SUBJECT_ENTITY,
  KG_SUBJECT_USER,
} from './job-types';
import { KG_PERSON_TYPE } from './purge/kg-purge.service';
import { GraphOntologyService } from './ontology/graph-ontology.service';
import { toGraphHttpException } from './write/graph-write.errors';
import { GraphWriteService, type EntityUpdateResult } from './write/graph-write.service';

export const GRAPH_ENTITY_EDITED_ACTION = 'graph.entity_edited';
export const GRAPH_PERSON_FORGET_REQUESTED_ACTION = 'graph.person_forget_requested';

/** The entity projection (`GraphEntityDto`). #370 extends it with counts. */
export function toGraphEntityResponse(
  entity: KgEntity,
  aliases: readonly KgEntityAlias[],
): GraphEntityResponse {
  return {
    id: entity.id,
    type: entity.type,
    label: entity.label,
    props: (entity.props ?? {}) as Record<string, unknown>,
    reviewStatus: entity.reviewStatus,
    mergedIntoId: entity.mergedIntoId,
    occurredAt: entity.occurredAt ? entity.occurredAt.toISOString() : null,
    ontologyVersion: entity.ontologyVersion,
    aliases: aliases.map((a) => ({
      id: a.id,
      alias: a.alias,
      normalized: a.normalized,
      source: a.source,
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

@Injectable()
export class GraphEntitiesService {
  private readonly logger = new Logger(GraphEntitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly write: GraphWriteService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly aiSettings: AiSettingsService,
  ) {}

  async patch(id: string, dto: PatchEntityDto, user: RequestUser): Promise<GraphEntityResponse> {
    await this.access.require(user.id, 'entity', id, 'edit', user.permissions);
    const schema = await this.ontology.effectiveSchemaFor(user.id);

    let result: EntityUpdateResult;
    let aliases: KgEntityAlias[];
    try {
      [result, aliases] = await this.prisma.$transaction(async (tx) => {
        const updated = await this.write.updateEntityDetailed(tx, user.id, id, dto, schema);
        const rows = await tx.kgEntityAlias.findMany({
          where: { entityId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return [updated, rows] as const;
      });
    } catch (err) {
      throw toGraphHttpException(err, this.logger) ?? err;
    }

    if (result.changed) {
      await this.audit(user.id, id, {
        changedKeys: result.changedKeys,
        labelChanged: result.labelChanged,
        aliasesAdded: result.aliasesAdded,
        aliasesRemoved: result.aliasesRemoved,
      });
      await this.enqueueFollowUps(user.id, id);
    }

    return toGraphEntityResponse(result.entity, aliases);
  }

  /**
   * `POST /api/graph/entities/:id/forget` (#357, §15) — QUEUE the forgetting
   * of a Person; `kg.purge` does the deleting (a table-spanning sweep is
   * long-running work, CLAUDE.md rule 1).
   *
   * Order: the confirmation first (a 400 that says nothing about the id),
   * then `GraphAccessService` — 404 for no access or a merged entity, 403 for
   * the caller's own entity without `graph:write` — then the Person check.
   *
   * The job's subject is the entity, so the queue's ordinary active dedup
   * makes a second request while the first is pending/running return THAT
   * job. Every request is audited, deduplicated or not: it is the record of
   * somebody asking. The entity stays visible until the job completes; there
   * is deliberately no interim "forgotten" state column.
   */
  async forget(id: string, body: unknown, user: RequestUser): Promise<ForgetEntityResponse> {
    if (!forgetEntitySchema.safeParse(body ?? {}).success) {
      throw new BadRequestException(FORGET_CONFIRMATION_MESSAGE);
    }

    const entity = await this.access.require(user.id, 'entity', id, 'edit', user.permissions);
    if (entity.type !== KG_PERSON_TYPE) {
      throw new BadRequestException(FORGET_NOT_PERSON_MESSAGE);
    }

    const job = await this.jobs.enqueue({
      type: KG_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_ENTITY,
      subjectId: id,
      payload: { userId: user.id, scope: 'person', entityId: id },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: GRAPH_PERSON_FORGET_REQUESTED_ACTION,
        targetType: KG_SUBJECT_ENTITY,
        targetId: id,
        meta: { entityId: id, jobId: job.id },
      },
    });

    this.logger.warn(`User ${user.id} asked to forget person ${id} (job ${job.id})`);

    return {
      jobId: job.id,
      entityId: id,
      // A deduplicated answer is the live job, which is pending or running by
      // definition of the dedup index; a fresh insert is pending.
      status: job.status === 'running' ? 'running' : 'pending',
    };
  }

  /**
   * `kg.embed` and `kg.entity_digest`, each only while its handler is
   * registered. The edit has already committed, so a failed enqueue is logged
   * rather than turned into an error the caller would read as "not saved".
   */
  async enqueueFollowUps(ownerId: string, entityId: string): Promise<void> {
    try {
      if (this.registry.get(KG_EMBED_JOB_TYPE)) {
        await this.jobs.enqueue({
          type: KG_EMBED_JOB_TYPE,
          reason: 'rerun',
          subjectType: KG_SUBJECT_USER,
          subjectId: ownerId,
          skipDedup: true,
          payload: { userId: ownerId, subjectKind: 'entity', ids: [entityId] },
        });
      }
      if (this.registry.get(KG_ENTITY_DIGEST_JOB_TYPE) && (await this.graphEnabled())) {
        await this.jobs.enqueue({
          type: KG_ENTITY_DIGEST_JOB_TYPE,
          reason: 'backfill',
          subjectType: KG_SUBJECT_ENTITY,
          subjectId: entityId,
          payload: { entityId, ownerId },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Follow-up enqueue after editing entity ${entityId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** `ai.graphEnabled` (#360), absent — and therefore off — until #360 adds it. */
  private async graphEnabled(): Promise<boolean> {
    const policy = (await this.aiSettings.get()) as { graphEnabled?: unknown };
    return policy.graphEnabled === true;
  }

  private async audit(userId: string, entityId: string, meta: Record<string, unknown>): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: GRAPH_ENTITY_EDITED_ACTION,
        targetType: KG_SUBJECT_ENTITY,
        targetId: entityId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
