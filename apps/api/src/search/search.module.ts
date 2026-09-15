// =============================================================================
// SearchModule (issue #175, epic #164)
// =============================================================================
//
// One controller, one service, and `PrismaModule` - nothing else, which is the
// point. This module reads `transcripts`, `transcript_segments`,
// `transcript_shares` and `notes` through raw `SELECT`s and imports NEITHER
// `TranscriptsModule` NOR `NotesModule`.
//
// That is deliberate rather than lazy. Importing them would pull the whole
// transcript pipeline (the provider registry, five job handlers, the exporters)
// and the whole note generator (the AI provider registry, the credential
// store) into the graph of a read-only search endpoint - and would invite the
// next change to route a search through `TranscriptsService`, which answers
// `Prisma.TranscriptWhereInput` list queries and has no way to express a
// ranked union across two tables. The visibility predicates are restated in
// SQL in `search.service.ts`, with a comment naming
// `TranscriptsService.scopeWhere` as the definition they must agree with.
// =============================================================================

import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [PrismaModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
