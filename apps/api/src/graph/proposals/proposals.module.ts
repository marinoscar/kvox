import { Module } from '@nestjs/common';

import { AiModule } from '../../ai/ai.module';
import { JobsModule } from '../../jobs/jobs.module';
import { NoteAccessService } from '../../notes/access/note-access.service';
import { NoteOriginService } from '../../notes/note-origin.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { GraphModule } from '../graph.module';
import { GraphResolutionModule } from '../resolution/resolution.module';
import { GraphProposalsController } from './graph-proposals.controller';
import { ProposalCommitService } from './proposal-commit.service';
import { ProposalRevertService } from './proposal-revert.service';
import { ProposalsService } from './proposals.service';
import { SpanValidator } from './span-validator';

// =============================================================================
// GraphProposalsModule (#366, epic #346; docs/specs/ontology.md §8, §19)
// =============================================================================
//
// The proposal review API: read, decide, add-from-span, commit, discard,
// revert.
//
// A SUB-MODULE rather than more providers on `GraphModule` (which the issue
// text names): the commit needs #364's `MergeService`, `DistinctPairService`
// and `AliasLearningService`, which live in `GraphResolutionModule` — and that
// module already imports `GraphModule`, so `GraphModule` importing it back
// would be a cycle. The dependency runs one way:
// GraphProposals → GraphResolution → GraphExtraction → Graph.
//
// `NoteAccessService` (the one 404 rule for a note) and `NoteOriginService`
// (the origin transcript across a note chain) are provided here directly, the
// same arrangement `GraphExtractionModule` documents: both are stateless and
// depend on `PrismaService` alone, and importing `NotesModule` would cycle
// back through `GraphExtractionModule`.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule, AiModule, GraphModule, GraphResolutionModule],
  controllers: [GraphProposalsController],
  providers: [
    NoteAccessService,
    NoteOriginService,
    SpanValidator,
    ProposalsService,
    ProposalCommitService,
    ProposalRevertService,
  ],
  exports: [ProposalsService, ProposalCommitService, ProposalRevertService],
})
export class GraphProposalsModule {}
