import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { JobsModule } from '../../jobs/jobs.module';
import { NoteAccessService } from '../../notes/access/note-access.service';
import { NoteOriginService } from '../../notes/note-origin.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { GraphModule } from '../graph.module';
import { KgExtractHandler } from '../handlers/kg-extract.handler';
import { ExtractionInputLoader } from './extraction-input.loader';
import { GraphExtractionController } from './graph-extraction.controller';
import { GraphExtractionService } from './graph-extraction.service';
import { ProposalStageRegistry } from './proposal-stage';
import { ProposalWriter } from './proposal-writer.service';

// =============================================================================
// GraphExtractionModule (#363, epic #346; docs/specs/ontology.md §6)
// =============================================================================
//
// `kg.extract`, its two routes, and the stage registry later issues plug into
// (#364 resolution, #365 dedup/closing/rejection memory — they import this
// module for `ProposalStageRegistry`).
//
// A SUB-MODULE, NOT MORE PROVIDERS ON `GraphModule`, because of one edge:
// `NotesModule` imports this module for the note-ready hook
// (`GraphExtractionService.enqueueForReadyNote`), and this module needs two
// note services. Importing `NotesModule` back would be a cycle, so the two it
// needs — `NoteAccessService` (the one 404 rule for a note) and
// `NoteOriginService` (the origin transcript across a note chain) — are
// provided here directly: both are stateless and depend on `PrismaService`
// alone, so a second instance is the same code, not a second implementation.
// The dependency therefore runs one way: Notes → GraphExtraction → Graph.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, AiModule, GraphModule],
  controllers: [GraphExtractionController],
  providers: [
    NoteAccessService,
    NoteOriginService,
    ExtractionInputLoader,
    ProposalWriter,
    ProposalStageRegistry,
    GraphExtractionService,
    KgExtractHandler,
  ],
  exports: [GraphExtractionService, ProposalStageRegistry],
})
export class GraphExtractionModule {}
