// =============================================================================
// SearchModule (issue #175, epic #164)
// =============================================================================
//
// This module reads `transcripts`, `transcript_segments`, `transcript_shares`,
// `notes`, `search_chunks`, `search_embeddings` and `search_index_state`
// through raw `SELECT`s, and it imports NEITHER `TranscriptsModule` NOR
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
// ⚠ `AiModule` IS NOW IMPORTED, AND THE HEADER USED TO SAY IT WOULD NOT BE
// -----------------------------------------------------------------------------
//
// The paragraph above once listed "the AI provider registry, the credential
// store" among the things a read-only search endpoint had no business pulling
// in. Issue #189 changes that fact, not merely that sentence: the semantic arm
// EMBEDS THE QUERY WITH THE SEARCHER'S OWN API KEY, so this module genuinely
// needs `AiSettingsService` (is a provider configured), `AiProviderRegistry`
// (does this build implement it, and does it embed) and
// `UserAiCredentialsService` (does THIS caller have a key). There is no version
// of query-time semantic search that does not need all three.
//
// What the original argument still buys is the SHAPE of the dependency.
// `SearchQueryEmbedder` is a LEAF - the same shape `AiConfigService` and
// `AiModelDiscoveryService` already take - so those three services are reached
// through one small class that this module owns, rather than by
// `SearchService` growing four constructor parameters and a second opinion
// about what "AI is available" means. And the import is of `AiModule`, which
// carries no job handlers and no pipeline, not of `NotesModule`, which does.
// =============================================================================

import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SearchController } from './search.controller';
import { SearchQueryEmbedder } from './search-query-embedder.service';
import { SearchService } from './search.service';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [SearchController],
  providers: [SearchService, SearchQueryEmbedder],
  exports: [SearchService],
})
export class SearchModule {}
