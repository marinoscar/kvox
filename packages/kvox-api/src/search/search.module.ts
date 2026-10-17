// =============================================================================
// SearchModule (issue #175, epic #164)
// =============================================================================
//
// This module reads `transcripts`, `transcript_segments`, `notes`,
// `search_chunks`, `search_embeddings` and `search_index_state` through raw
// `SELECT`s (a transcript's shares through the host's
// `SearchTranscriptVisibility`, never a sharing table itself), and it imports
// NEITHER the transcripts slice NOR the notes slice.
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
// THE PORTS ARE THE HOST'S, SO THERE IS NO PLATFORM IMPORT HERE
// -----------------------------------------------------------------------------
//
// The semantic arm EMBEDS THE QUERY WITH THE SEARCHER'S OWN API KEY, so this
// module needs the `KVOX_AI` port (does this caller's host have embeddings, and
// the embed call itself), `KVOX_PRISMA` for the reads and `KVOX_IDENTITY` for the
// guard. The host binds all three globally, so nothing is imported here but the
// slice's own providers.
//
// What the original argument above still buys is the SHAPE of the dependency.
// `SearchQueryEmbedder` is a LEAF, so the port is reached through one small
// class that this module owns, rather than by `SearchService` growing a second
// opinion about what "AI is available" means.
// =============================================================================

import { DynamicModule, Module, type Provider } from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { SearchController } from './search.controller.js';
import { SearchQueryEmbedder } from './search-query-embedder.service.js';
import { SearchService } from './search.service.js';
import {
  DEFAULT_SEARCH_TYPE_PERMISSIONS,
  SEARCH_MODULE_OPTIONS,
  type ResolvedSearchOptions,
  type SearchModuleOptions,
} from './search.options.js';
import {
  OwnerOnlyTranscriptVisibility,
  SEARCH_TRANSCRIPT_VISIBILITY,
} from './search-visibility.js';

/**
 * The query side of search: `GET /api/search`, the hybrid ranking and the
 * embedder it reuses.
 *
 * @stability experimental
 */
@Module({})
export class SearchModule {
  /**
   * Builds the module over the host's ports. NOT global: a consumer lists the
   * returned module in `imports`.
   *
   * @param options - the semantic arm, the transcript visibility rule and the permission strings.
   * @returns the dynamic module; it exports {@link SearchService} and {@link SearchQueryEmbedder}
   *   (the graph's embedder reuses the latter's gate rather than growing a second
   *   model-and-dimension contract).
   */
  static forRoot(options: SearchModuleOptions = {}): DynamicModule {
    const resolved: ResolvedSearchOptions = {
      semanticEnabled: options.semantic?.enabled ?? true,
      provider: options.semantic?.provider ?? 'embeddings',
      ...(options.semantic?.onSemanticOff ? { onSemanticOff: options.semantic.onSemanticOff } : {}),
      typePermissions: {
        ...DEFAULT_SEARCH_TYPE_PERMISSIONS,
        ...Object.fromEntries(
          Object.entries(options.typePermissions ?? {}).filter(([, value]) => value !== undefined),
        ),
      },
    };
    const controllers = [SearchController];
    const providers: Provider[] = [
      SearchService,
      SearchQueryEmbedder,
      { provide: SEARCH_MODULE_OPTIONS, useValue: resolved },
      {
        provide: SEARCH_TRANSCRIPT_VISIBILITY,
        useClass: options.transcriptVisibility ?? OwnerOnlyTranscriptVisibility,
      },
    ];

    // The route needs no permission (an either-or the guard cannot express), so it
    // is documented with the empty requirement `@Auth()` documents.
    documentKvoxAuth(controllers);

    return {
      module: SearchModule,
      global: false,
      controllers,
      providers,
      exports: [SearchService, SearchQueryEmbedder],
    };
  }
}
