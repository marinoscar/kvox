import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { JobsModule } from '../../jobs/jobs.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SearchModule } from '../../search/search.module';
import { GraphExtractionModule } from '../extraction/extraction.module';
import { GraphModule } from '../graph.module';
import { KgEmbedHandler } from '../handlers/kg-embed.handler';
import { KgResolveHandler } from '../handlers/kg-resolve.handler';
import { AdjudicationService } from './adjudication.service';
import { AliasLearningService } from './alias-learning.service';
import { CandidateService } from './candidate.service';
import { ContextFeatureService } from './context-features.service';
import { DistinctPairService } from './distinct-pair.service';
import { GraphEmbedder } from './graph-embedder.service';
import { GraphResolutionController } from './graph-resolution.controller';
import { GraphPreferencesListener } from './listeners/graph-preferences.listener';
import { MergeService } from './merge.service';
import { ResolutionActionsService } from './resolution-actions.service';
import { ResolutionService } from './resolution.service';
import { ResolutionStage } from './resolution.stage';

// =============================================================================
// GraphResolutionModule (#364, epic #346; docs/specs/ontology.md §7)
// =============================================================================
//
// Entity resolution: candidates, scoring, adjudication, the `resolution`
// proposal stage (registered into #363's `ProposalStageRegistry`), merges and
// their reversal, distinct pairs, alias learning, and the `kg.resolve` /
// `kg.embed` jobs.
//
// A SUB-MODULE, like `GraphExtractionModule`, because it depends on that module
// (the stage registry) and on `SearchModule` (the embedder contract) — neither
// of which `GraphModule` may import without a cycle. The dependency runs one
// way: GraphResolution → GraphExtraction → Graph. #366's commit imports this
// module for `MergeService`, `DistinctPairService` and `AliasLearningService`;
// #365's `GraphDedupModule` for `ResolutionService` and `AdjudicationService`.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, AiModule, SearchModule, GraphModule, GraphExtractionModule],
  controllers: [GraphResolutionController],
  providers: [
    GraphEmbedder,
    CandidateService,
    ContextFeatureService,
    AdjudicationService,
    ResolutionService,
    ResolutionStage,
    DistinctPairService,
    AliasLearningService,
    MergeService,
    ResolutionActionsService,
    GraphPreferencesListener,
    KgResolveHandler,
    KgEmbedHandler,
  ],
  exports: [ResolutionService, MergeService, DistinctPairService, AliasLearningService, GraphEmbedder, AdjudicationService],
})
export class GraphResolutionModule {}
