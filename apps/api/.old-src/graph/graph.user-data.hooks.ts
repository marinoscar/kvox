// =============================================================================
// The knowledge graph's user-data hooks (issue #357, epic #344; split out by
// issue #460)
// =============================================================================
//
// The count and the `kg.purge` fan-out for the `graph` category. The category's
// declaration is `graph.user-data.ts`, which is kept light for the manifest;
// this class is provided by `GraphModule` under `GRAPH_USER_DATA_HOOKS`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { auditUserData } from '../user-data/user-data.support';
import { KG_PURGE_JOB_TYPE, KG_SUBJECT_USER } from './job-types';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import { JobsService } from '@marinoscar/platform-api/jobs';

@Injectable()
export class GraphUserDataHooks {
  private readonly logger = new Logger(GraphUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /** `graph` in `GET /api/user-data/summary`. */
  async summarize(userId: string): Promise<{ entities: number; items: number }> {
    const [entities, items] = await Promise.all([
      // #357: merge tombstones are the same human as their survivor, so
      // counting them would show one person twice.
      this.prisma.kgEntity.count({ where: { ownerId: userId, reviewStatus: { not: 'merged' } } }),
      this.prisma.kgItem.count({ where: { ownerId: userId } }),
    ]);

    return { entities, items };
  }

  /**
   * Hand the user's whole knowledge graph to `kg.purge { scope: 'all' }`
   * (#357, epic #344).
   *
   * ⚠ IT ENQUEUES AND DELETES NOTHING ITSELF — the fan-out-to-existing-handlers
   * rule this handler already follows for `transcript.purge`/`note.purge`.
   * `kg.purge` owns the plan (a dozen tables, evidence with no FK to its
   * subject, entity ids inside draft proposal JSON); a second copy of it here
   * is how the two would come to disagree about what "the graph" is.
   *
   * Subject `user`/userId with ORDINARY dedup: a re-run of this deletion while
   * an earlier graph purge is still pending or running gets that job back
   * rather than a second one. The type string comes from the constants-only
   * `graph/job-types.ts`.
   */
  async purge(userId: string): Promise<void> {
    // #357: the knowledge graph goes next, so graph rows citing
    // about-to-be-deleted notes and transcripts go away with them. Correctness
    // does not depend on the order — every evidence anchor FK is SetNull.
    const job = await this.jobs.enqueue({
      type: KG_PURGE_JOB_TYPE,
      reason: 'rerun',
      // The purge deletes the graph's export and import `storage_objects`, so it runs in an organization.
      orgId: await resolveOrgId(this.prisma, null, `kg.purge enqueue for user ${userId}`),
      subjectType: KG_SUBJECT_USER,
      subjectId: userId,
      payload: { userId, scope: 'all' },
    });

    await auditUserData(this.prisma, userId, 'user_data:graph_purge_queued', { jobId: job.id });

    this.logger.warn(`User ${userId}: knowledge graph queued for deletion (kg.purge job ${job.id})`);
  }
}
