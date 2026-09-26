// =============================================================================
// `kg.purge` (#357, epic #344; docs/specs/ontology.md §11, §15)
// =============================================================================
//
// Two scopes, one handler:
//
//   scope: 'person' — "Forget this person", queued by
//     `POST /api/graph/entities/:id/forget`. Subject `kg_entity`/entityId, so
//     forgetting the same person twice while the first is pending is ONE job
//     (the queue's ordinary active dedup).
//   scope: 'all' — the Danger Zone's `graph` category, queued by
//     `user.data.purge` for `content`/`everything`. Subject `user`/userId.
//
// The deletion itself is `KgPurgeService`; this file owns the envelope around
// it: parse the payload, log at `warn` (the level `user.data.purge` uses for
// destructive work), write the completion audit row. Ids and counts only —
// never a label, alias or quote, because those are exactly the facts about a
// person the user just asked this deployment to forget.
//
// -----------------------------------------------------------------------------
// ⚠ SERVER-ONLY PERMANENTLY — NO `nodeResultSchema`, NO `persistNodeResult`
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 2 makes node-eligibility the default, so opting out owes an
// argument: the work IS a sequence of batched writes across a dozen tables,
// each batch's selection depending on the previous one's deletes — there is
// no computed result a remote machine could post back. And the authority to
// delete a user's graph has no narrow credential a `nodeSecretBroker` could
// mint (rule 3): "may delete exactly this user's graph rows" is not a
// PostgreSQL grant. The same reasoning as `user.data.purge`.
//
// -----------------------------------------------------------------------------
// ⚠ `profile: { maxAttempts: 1 }` — NEVER AUTOMATICALLY RETRIED
// -----------------------------------------------------------------------------
//
// A destructive fan-out that fails part-way must surface as a `failed` job a
// person looks at, never resume silently minutes later — the
// `user.data.purge` reasoning, and the reason this issue corrects spec §11's
// `maxAttempts: 3`. The service is re-entrant, so the person-initiated retry
// (forget again, or re-run the Danger Zone deletion) finishes the job.
// Thirty minutes is generously more than batched row deletes need.
//
// An unreadable payload RETURNS (logging `warn`) rather than throwing: no
// retry can make it readable, and a destructive job must never guess.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job, Prisma } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { GRAPH_CHANGED_EVENT, type GraphChangedEvent } from '../graph-events';
import { KG_PURGE_JOB_TYPE, KG_SUBJECT_ENTITY, KG_SUBJECT_USER } from '../job-types';
import { readKgPurgePayload } from '../purge/kg-purge.payload';
import { KgPurgeService, type KgPurgeCounts } from '../purge/kg-purge.service';

export const GRAPH_PERSON_FORGOTTEN_ACTION = 'graph.person_forgotten';
export const GRAPH_PURGED_ACTION = 'graph.purged';

export const KG_PURGE_PROFILE: JobExecutionProfile = {
  maxRuntimeMs: 30 * 60_000,
  maxAttempts: 1,
};

/** The counts a person-forget audit row carries — §15's list of what goes. */
export function personForgottenMeta(counts: KgPurgeCounts): Record<string, number> {
  return {
    entities: counts.entities,
    aliases: counts.aliases,
    relations: counts.relations,
    items: counts.items,
    evidence: counts.evidence,
    mentions: counts.mentions,
    proposalItems: counts.proposalItems,
  };
}

@Injectable()
export class KgPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgPurgeHandler.name);

  readonly type = KG_PURGE_JOB_TYPE;

  readonly profile: JobExecutionProfile = KG_PURGE_PROFILE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly purge: KgPurgeService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgPurgePayload(job.payload);

    if (!payload) {
      this.logger.warn(`kg.purge job ${job.id} carries no readable payload; nothing to do`);
      return;
    }

    if (payload.scope === 'person') {
      const { userId, entityId } = payload;
      this.logger.warn(`Forgetting person ${entityId} for user ${userId} (job ${job.id})`);

      const result = await this.purge.purgePerson(userId, entityId);
      if (!result) {
        this.logger.warn(
          `kg.purge job ${job.id}: entity ${entityId} is not a Person owned by user ${userId} ` +
            '(already forgotten, deleted, or never theirs); nothing to do',
        );
        return;
      }

      const meta = personForgottenMeta(result.counts);
      await this.audit(userId, GRAPH_PERSON_FORGOTTEN_ACTION, KG_SUBJECT_ENTITY, entityId, {
        ...meta,
        entityIds: result.entityIds,
      });
      this.logger.warn(
        `Forgot person ${entityId} for user ${userId} (job ${job.id}): ${JSON.stringify(meta)}`,
      );
      this.emitChanged(userId);
      return;
    }

    const { userId } = payload;
    this.logger.warn(`Purging the knowledge graph of user ${userId} (job ${job.id})`);

    const counts = await this.purge.purgeAll(userId);

    await this.audit(userId, GRAPH_PURGED_ACTION, KG_SUBJECT_USER, userId, { ...counts });
    this.logger.warn(
      `Purged the knowledge graph of user ${userId} (job ${job.id}): ${JSON.stringify(counts)}`,
    );
    this.emitChanged(userId);
  }

  /**
   * `graph.changed` (#371), after every purge transaction has committed. The
   * layout listener only counts and, at most, enqueues; a listener failure
   * must never fail a purge that already happened, hence the catch.
   */
  private emitChanged(userId: string): void {
    try {
      this.events.emit(GRAPH_CHANGED_EVENT, { ownerId: userId, reason: 'purge' } satisfies GraphChangedEvent);
    } catch (err) {
      this.logger.warn(`Could not emit graph.changed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async audit(
    userId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType,
        targetId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
