import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { JobsModule } from '../../jobs/jobs.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { GraphExtractionModule } from '../extraction/extraction.module';
import { GraphModule } from '../graph.module';
import { GraphResolutionModule } from '../resolution/resolution.module';
import { GraphImportController } from './graph-import.controller';
import { GraphImportService } from './graph-import.service';
import { KgImportHandler } from './kg-import.handler';

// =============================================================================
// GraphImportModule (#387, epic #349; docs/specs/ontology.md §18.3)
// =============================================================================
//
// `POST /api/graph/imports`, the attribute-offer routes, and the `kg.import`
// job. A SUB-MODULE like `GraphDedupModule`: the job runs every registered
// proposal stage (#363's `ProposalStageRegistry`, exported by
// `GraphExtractionModule`), and `GraphResolutionModule` must be loaded so its
// `resolution` stage has registered itself. One way only — nothing imports
// this module.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, AiModule, GraphModule, GraphExtractionModule, GraphResolutionModule],
  controllers: [GraphImportController],
  providers: [GraphImportService, KgImportHandler],
})
export class GraphImportModule {}
