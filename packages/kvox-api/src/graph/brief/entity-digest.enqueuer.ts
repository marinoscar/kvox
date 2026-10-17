// =============================================================================
// EntityDigestEnqueuer (#372; spec §9.2, §11)
// =============================================================================
//
// THE ONE SHAPE every caller enqueues `kg.entity_digest` with:
//
//   { type: 'kg.entity_digest', reason: 'backfill', subjectType: 'kg_entity',
//     subjectId: entityId, payload: { entityId, ownerId } }
//
// Ordinary per-entity dedup — never `skipDedup` — so concurrent brief views,
// a commit and a manual edit touching the same entity collapse onto one
// pending job.
//
// Two entry points:
//   - `enqueue()` — unconditional (still guarded on the handler being
//     registered). The brief GET uses it after its own resolver check.
//   - `enqueueIfEnabled()` — for every OTHER caller (#366's commit and revert,
//     #355's manual edit, #364's merge): only while `ai.graphEnabled` is true.
//     Never throws: the triggering write has already committed, so a failed
//     enqueue is logged, not reported as "not saved".
// =============================================================================

import { Injectable, Logger, Inject } from '@nestjs/common';

import { GraphAiRunResolver } from '../graph-ai-run.service.js';
import { KG_ENTITY_DIGEST_JOB_TYPE, KG_SUBJECT_ENTITY } from '../job-types.js';
import { KVOX_JOBS, type KvoxJobsPort } from '../../ports/index.js';

export interface EntityDigestPayload {
  entityId: string;
  ownerId: string;
}

/**
 * EntityDigestEnqueuer: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class EntityDigestEnqueuer {
  private readonly logger = new Logger(EntityDigestEnqueuer.name);

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    private readonly aiRuns: GraphAiRunResolver,
  ) {}

  /** Enqueue (deduplicated per entity). `null` when no handler is registered. */
  async enqueue(ownerId: string, entityId: string): Promise<{ id: string } | null> {
    if (!this.jobs.isRegistered(KG_ENTITY_DIGEST_JOB_TYPE)) return null;
    const payload: EntityDigestPayload = { entityId, ownerId };
    return this.jobs.enqueue({
      type: KG_ENTITY_DIGEST_JOB_TYPE,
      reason: 'backfill',
      subjectType: KG_SUBJECT_ENTITY,
      subjectId: entityId,
      payload: { ...payload },
    });
  }

  /** For write paths: only while connected knowledge is on. Never throws. */
  async enqueueIfEnabled(ownerId: string, entityIds: readonly string[]): Promise<void> {
    if (entityIds.length === 0 || !this.jobs.isRegistered(KG_ENTITY_DIGEST_JOB_TYPE)) return;
    try {
      if (!(await this.aiRuns.graphEnabled())) return;
      for (const entityId of new Set(entityIds)) {
        await this.enqueue(ownerId, entityId);
      }
    } catch (err) {
      this.logger.warn(
        `Entity digest enqueue for ${entityIds.length} entit${entityIds.length === 1 ? 'y' : 'ies'} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
