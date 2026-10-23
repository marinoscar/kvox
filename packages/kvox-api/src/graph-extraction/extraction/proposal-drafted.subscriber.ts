import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { GRAPH_PROPOSAL_DRAFTED_EVENT, KG_AUTOCOMMIT_JOB_TYPE, KG_SUBJECT_PROPOSAL } from '../../graph/index.js';
import type { GraphProposalDraftedEvent } from '../../graph/index.js';
import { KVOX_EVENTS, KVOX_JOBS, type KvoxEventsPort, type KvoxJobsPort } from '../../ports/index.js';

/**
 * Answers `kvox.graph.proposal_drafted` by queueing `kg.autocommit` (#718, ADR-0007). IT ONLY
 * ENQUEUES: the library's switch, the permission and the staleness are the job's to check.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class ProposalDraftedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ProposalDraftedSubscriber.name);

  constructor(
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(GRAPH_PROPOSAL_DRAFTED_EVENT, async (payload) => {
      const { proposalId, ownerId, kind } = payload as GraphProposalDraftedEvent;
      if (kind !== 'extraction') return;
      try {
        await this.jobs.enqueue({
          type: KG_AUTOCOMMIT_JOB_TYPE,
          reason: 'upload',
          subjectType: KG_SUBJECT_PROPOSAL,
          subjectId: proposalId,
          payload: { proposalId, ownerId },
        });
      } catch (error) {
        this.logger.warn(`Could not queue an auto-commit of proposal ${proposalId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
