import { Module } from '@nestjs/common';

import { NotesConfig } from '../../kvox/notes/notes.config';
import { PrismaModule } from '../../prisma/prisma.module';
import { GraphModule } from '../graph.module';
import { KgExtractHandler } from '../handlers/kg-extract.handler';
import { ExtractionInputLoader } from './extraction-input.loader';
import { GraphExtractionController } from './graph-extraction.controller';
import { GraphExtractionService } from './graph-extraction.service';
import { NoteReadyAutoExtractListener } from './note-ready-auto-extract.listener';
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
// A SUB-MODULE, NOT MORE PROVIDERS ON `GraphModule`, because of one edge: the notes slice
// emits its ready event and the app's `NoteReadyAutoExtractListener`
// (`./note-ready-auto-extract.listener.ts`, provided here) calls `GraphExtractionService.enqueueForReadyNote`,
// while this module needs two note services, `NoteAccessService` (the one 404 rule for a note)
// and `NoteOriginService` (the origin transcript across a note chain), which it reaches by
// importing the notes configuration (`NotesConfig`) instead of providing them again. The
// dependency runs one way: GraphExtraction -> Notes; the slice imports no graph.
// =============================================================================

@Module({
  imports: [PrismaModule, NotesConfig, GraphModule],
  controllers: [GraphExtractionController],
  providers: [
    ExtractionInputLoader,
    ProposalWriter,
    ProposalStageRegistry,
    GraphExtractionService,
    KgExtractHandler,
    // TEMPORARY (delete in #496): note ready -> `enqueueForReadyNote`.
    NoteReadyAutoExtractListener,
  ],
  exports: [GraphExtractionService, ProposalStageRegistry],
})
export class GraphExtractionModule {}
