// =============================================================================
// TopicsPromoteService (#666, epic #661; docs/specs/ontology.md §11)
// =============================================================================
//
// The two reads/writes behind the "Find topics in past meetings" button:
//
//   - `request()` — `POST /api/graph/topics/promote`: a person asks. Queues
//     `kg.topics_promote` for THEMSELVES (subject `user` / their id, the
//     per-user AI throttle bucket). Never automatic: the run spends their key.
//   - `status()`  — `GET /api/graph/topics/promote`: the latest run's state
//     and how many topic proposals are waiting for review.
//
// Everything is the caller's own, derived from the signed-in user: there is no
// id in the path, so there is nothing to answer 404 about and nothing to leak.
// The deployment's connected-knowledge switch is the only refusal (409).
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { aiProviderThrottleKey } from '../../core/index.js';
import { GraphAiRunResolver, graphDisabledConflict, KG_SUBJECT_USER, KG_TOPICS_PROMOTE_JOB_TYPE } from '../../graph/index.js';
import type { GraphActor, KvoxGraphDb } from '../../graph/index.js';
import { KVOX_JOBS, KVOX_PRISMA, type KvoxJobsPort } from '../../ports/index.js';
import { KG_TOPICS_PROMOTE_SOURCE } from '../handlers/kg-topics-promote.handler.js';
import type { TopicsPromoteRequestResponse, TopicsPromoteStatus } from './topics-promote.dto.js';

/**
 * TopicsPromoteService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class TopicsPromoteService {
  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly resolver: GraphAiRunResolver,
  ) {}

  /** Queue a run for the caller; joins one already pending or running. */
  async request(user: GraphActor): Promise<TopicsPromoteRequestResponse> {
    if (!(await this.resolver.graphEnabled())) throw graphDisabledConflict();
    // The job port passes the organization explicitly on every enqueue (the web binding's adapter).
    const queued = await this.jobs.enqueue({
      type: KG_TOPICS_PROMOTE_JOB_TYPE,
      reason: 'backfill',
      subjectType: KG_SUBJECT_USER,
      subjectId: user.id,
      payload: { userId: user.id },
      throttleKey: aiProviderThrottleKey(user.id),
    });
    return { jobId: queued.id, deduplicated: queued.deduplicated };
  }

  /** Where the caller's latest run stands, and the topic proposals waiting for review. */
  async status(user: GraphActor): Promise<TopicsPromoteStatus> {
    const [latest, proposedTopics] = await Promise.all([
      this.jobs.findLatest({ type: KG_TOPICS_PROMOTE_JOB_TYPE, subjectType: KG_SUBJECT_USER, subjectId: user.id }),
      this.prisma.kgProposal.count({
        where: { ownerId: user.id, kind: 'import', status: 'draft', stats: { path: ['source'], equals: KG_TOPICS_PROMOTE_SOURCE } },
      }),
    ]);
    return {
      job: latest
        ? {
            id: latest.id,
            status: latest.status,
            createdAt: latest.createdAt.toISOString(),
            finishedAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
          }
        : null,
      proposedTopics,
    };
  }
}
