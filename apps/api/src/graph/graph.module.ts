import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { GraphAccessService } from './access/graph-access.service';
import { GraphController } from './graph.controller';
import { GraphOntologyService } from './ontology/graph-ontology.service';

// =============================================================================
// GraphModule (#354, epic #344, docs/specs/ontology.md)
// =============================================================================
//
// The one module every connected-knowledge feature hangs its services,
// handlers and controllers on. Later issues add providers and controllers HERE
// and nowhere else, unless a sub-module is clearly warranted (e.g. #363 may add
// `graph/extraction/extraction.module.ts`, imported here).
//
// `TranscriptsModule` is imported now even though nothing here uses it yet:
// #355's evidence validation needs `TranscriptAccessService`, and settling the
// import list in the scaffold keeps parallel issues from each editing it.
// The dependency runs one way — nothing in TranscriptsModule imports this
// module — so no `forwardRef` is needed.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, TranscriptsModule],
  providers: [GraphAccessService, GraphOntologyService],
  controllers: [GraphController],
  exports: [GraphAccessService, GraphOntologyService],
})
export class GraphModule {}
