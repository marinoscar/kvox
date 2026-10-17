// =============================================================================
// SearchIndexingModule (issue #188, epic #165 — Semantic Search)
// =============================================================================
//
// The `search.index` job type and the two-verb surface its enqueue points talk
// to. One class, self-registered from `onModuleInit`, exactly as
// `handlers/README.md` describes — nothing in the worker, the claim query, the
// enqueue service or the admin dashboard is touched by adding it.
//
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS RATHER THAN A `SearchModule`
// -----------------------------------------------------------------------------
//
// The search slice holds `chunking/`, which is deliberately NOT a Nest module at
// all — its header states the rule: plain pure functions, no `@Injectable`, no
// DI, because a chunker one constructor parameter away from holding a repository
// is a chunker whose output can stop being a function of its input. This module
// is scoped to INDEXING specifically rather than claiming the whole namespace,
// and the query side has its own (`SearchModule`). A single module that owned both
// would make the retrieval path import the job port for no reason.
//
// -----------------------------------------------------------------------------
// THE DEPENDENCY DIRECTION IS ONE-WAY, AND THAT IS WHAT KEEPS IT ACYCLIC
// -----------------------------------------------------------------------------
//
// This module imports NEITHER the transcripts slice NOR the notes slice — it reads
// both documents' rows through raw SQL rather than through their services,
// precisely so those two can import this one. The transcripts and notes slices
// each import it to reach `SearchIndexService` (the user-data purge reaches it
// through their owner-level purge handlers); nothing here reaches back, so
// there is no `forwardRef` anywhere and there should not be one.
//
// The handler needs one thing from the AI side, the host's `KVOX_AI` port: the
// resolution it performs - deployment policy, the embeddings model, the OWNER's
// own key - is the one the note generator performs, reached through the same
// port. It registers through `KVOX_JOBS` and is server-only (`usesAi`).
// =============================================================================

import { DynamicModule, Module, type Provider } from '@nestjs/common';

import { documentKvoxAuth } from '../../core/index.js';
import {
  SEARCH_DEFAULT_BATCH_SIZE,
  SEARCH_INDEXING_MODULE_OPTIONS,
  type ResolvedSearchIndexingOptions,
  type SearchIndexingModuleOptions,
} from '../search.options.js';
import { SearchIndexController } from './search-index.controller.js';
import { SearchIndexStatusService } from './search-index-status.service.js';
import { SearchIndexHandler } from './search-index.handler.js';
import { SearchIndexService } from './search-index.service.js';

/**
 * The indexing side of search: the `search.index` job, the two-verb enqueue and
 * forget surface and the two index routes.
 *
 * @stability experimental
 */
@Module({})
export class SearchIndexingModule {
  /**
   * Builds the module over the host's ports. NOT global: the transcripts and notes
   * slices list the returned module in their own `imports`.
   *
   * @param options - the embeddings batch size.
   * @returns the dynamic module; it exports {@link SearchIndexService}.
   */
  static forRoot(options: SearchIndexingModuleOptions = {}): DynamicModule {
    const resolved: ResolvedSearchIndexingOptions = {
      batchSize: options.batchSize ?? SEARCH_DEFAULT_BATCH_SIZE,
    };
    // ⚠ THE CONTROLLER LIVES HERE, NOT IN `SearchModule` (issue #191). Its two
    // routes are an INDEXING surface — they read the AI capabilities and the job
    // queue — while `SearchModule` is a query surface that needs neither. See the
    // controller's own header; the path prefix they share (`/api/search`) is a
    // client-facing grouping, not a module boundary.
    const controllers = [SearchIndexController];
    const providers: Provider[] = [
      SearchIndexHandler,
      SearchIndexService,
      SearchIndexStatusService,
      { provide: SEARCH_INDEXING_MODULE_OPTIONS, useValue: resolved },
    ];

    documentKvoxAuth(controllers);

    return {
      module: SearchIndexingModule,
      global: false,
      controllers,
      providers,
      // Only the service. `SearchIndexHandler` is reached by the host's queue
      // through `KVOX_JOBS`, never by injection, so exporting it would advertise a
      // seam nobody may use — and would let a caller invoke `process` directly,
      // outside the lease, the attempt budget and the timeout that make it safe.
      exports: [SearchIndexService],
    };
  }
}
