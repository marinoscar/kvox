import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { GraphExtractionModule } from '../extraction/extraction.module';
import { GraphModule } from '../graph.module';
import { GraphResolutionModule } from '../resolution/resolution.module';
import { ItemCandidateService } from './item-candidates.service';
import { RejectionMemoryStage } from './rejection-memory.stage';
import { TemporalClosingStage } from './temporal-closing.stage';
import { WorkItemDedupStage } from './work-item-dedup.stage';

// =============================================================================
// GraphDedupModule (#365, epic #346; docs/specs/ontology.md §5.4, §7, §8)
// =============================================================================
//
// Three proposal stages, each self-registering with #363's
// `ProposalStageRegistry` from `onModuleInit`, ordered after #364's
// `resolution` (100): `work-item-dedup` (200), `temporal-closing` (300),
// `rejection-memory` (400). They write only `kg_proposal_items` rows and
// their evidence — never the graph; what the commit does with the rows they
// shape is `commit-contract.ts` (implemented by #366).
//
// A SUB-MODULE for the same one-way-dependency reason as
// `GraphResolutionModule`: Dedup → Resolution → Extraction → Graph. It reuses
// resolution's embedding path (`ResolutionService.embedMentions`) and
// `AdjudicationService.adjudicateItems` rather than a second copy of either.
// =============================================================================

@Module({
  imports: [PrismaModule, GraphModule, GraphExtractionModule, GraphResolutionModule],
  providers: [ItemCandidateService, WorkItemDedupStage, TemporalClosingStage, RejectionMemoryStage],
  exports: [ItemCandidateService],
})
export class GraphDedupModule {}
