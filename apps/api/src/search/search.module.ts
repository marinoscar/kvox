// =============================================================================
// SearchModule (issue #175, epic #164)
// =============================================================================
//
// This module reads `transcripts`, `transcript_segments`, `notes`,
// `search_chunks`, `search_embeddings` and `search_index_state` through raw
// `SELECT`s (a transcript's shares through the platform's `accessibleSql`, never
// the `grants` table itself), and it imports NEITHER `TranscriptsModule` NOR
// `NotesModule`.
//
// That is deliberate rather than lazy. Importing them would pull the whole
// transcript pipeline (the provider registry, five job handlers, the exporters)
// and the whole note generator (the prompt assembly, the generation stream, the
// exporters) into the graph of a read-only search endpoint - and would invite
// the next change to route a search through `TranscriptsService`, which answers
// `Prisma.TranscriptWhereInput` list queries and has no way to express a
// ranked union across two tables. The visibility predicates are restated in
// SQL in `search.service.ts`, with a comment naming
// `TranscriptsService.scopeWhere` as the definition they must agree with.
//
// -----------------------------------------------------------------------------
// THE AI PORT IS GLOBAL, SO THERE IS NO AI IMPORT HERE
// -----------------------------------------------------------------------------
//
// The semantic arm EMBEDS THE QUERY WITH THE SEARCHER'S OWN API KEY, so this
// module needs the `KVOX_AI` port (is embedding ready for this caller, and the
// embed call itself). `KvoxAiModule` is `@Global()`, so `SearchQueryEmbedder`
// injects the token without this module importing anything AI-shaped.
//
// What the original argument above still buys is the SHAPE of the dependency.
// `SearchQueryEmbedder` is a LEAF, so the port is reached through one small
// class that this module owns, rather than by `SearchService` growing a second
// opinion about what "AI is available" means.
// =============================================================================

import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { SearchController } from './search.controller';
import { SearchQueryEmbedder } from './search-query-embedder.service';
import { SearchService } from './search.service';

@Module({
  imports: [PrismaModule],
  controllers: [SearchController],
  providers: [SearchService, SearchQueryEmbedder],
  // SearchQueryEmbedder: the graph's embedder (#364) reuses its gate, rather
  // than growing a second model/dimension contract.
  exports: [SearchService, SearchQueryEmbedder],
})
export class SearchModule {}
