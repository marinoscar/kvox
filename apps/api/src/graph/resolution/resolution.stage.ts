// =============================================================================
// The `resolution` proposal stage (#364; docs/specs/ontology.md §4, §6, §7)
// =============================================================================
//
// Order 100 — the first stage `kg.extract` runs over a fresh proposal, so the
// review panel already shows proposed matches instead of a wall of "new"
// rows. Self-registers with #363's `ProposalStageRegistry` from `onModuleInit`,
// the job-handler shape. Everything it does is `ResolutionService`'s proposal
// mode; its stats land in `kg_proposals.stats.resolution`.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';

import { ProposalStageRegistry, type ProposalStage, type ProposalStageContext } from '../extraction/proposal-stage';
import { KG_EXTRACT_JOB_TYPE } from '../job-types';
import { RESOLUTION_STAGE_NAME, RESOLUTION_STAGE_ORDER, ResolutionService } from './resolution.service';

@Injectable()
export class ResolutionStage implements ProposalStage, OnModuleInit {
  readonly name = RESOLUTION_STAGE_NAME;
  readonly order = RESOLUTION_STAGE_ORDER;

  constructor(
    private readonly registry: ProposalStageRegistry,
    private readonly resolution: ResolutionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(ctx: ProposalStageContext): Promise<void> {
    // The stage runs inside `kg.extract`, so a rate limit defers THAT job.
    const stats = await this.resolution.resolveProposal(ctx, KG_EXTRACT_JOB_TYPE);
    Object.assign(ctx.stats, stats);
  }
}
