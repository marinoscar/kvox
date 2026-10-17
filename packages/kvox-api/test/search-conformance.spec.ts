import { SearchIndexHandler } from '../src/search/indexing/search-index.handler.js';
import { SearchIndexService } from '../src/search/indexing/search-index.service.js';
import { SearchQueryEmbedder } from '../src/search/search-query-embedder.service.js';
import { DEFAULT_SEARCH_TYPE_PERMISSIONS, type ResolvedSearchOptions } from '../src/search/search.options.js';
import { SearchService } from '../src/search/search.service.js';
import { OwnerOnlyTranscriptVisibility } from '../src/search/search-visibility.js';
import { describeSearchConformance } from '../src/search/testing/index.js';
import { createFakeKvoxAi, createFakeKvoxJobs } from '../src/testing/index.js';

// =============================================================================
// The search conformance suite over the package's own binding (issue #494, epic #491)
// =============================================================================
//
// The slice exports `describeSearchConformance` (`@marinoscar/kvox-api/search/testing`)
// so a host proves ITS binding with the same assertions. This is the package's run:
// the real service, embedder and handler over the owner-only visibility and the
// fake ports. The web application runs the same suite over its own binding in
// `apps/api/test/conformance.spec.ts`.
// =============================================================================

describeSearchConformance(
  'the owner-only binding over the fake ports',
  () => {
    const jobs = createFakeKvoxJobs();
    const ai = createFakeKvoxAi();
    const db = { $queryRaw: async () => [], $executeRaw: async () => 0, $transaction: async () => undefined } as never;
    const index = new SearchIndexService(db, jobs);

    return {
      indexHandler: new SearchIndexHandler(jobs, db, ai, index, { batchSize: 128 }),
      serviceFor: ({ ai: port, db: client }) => {
        const options: ResolvedSearchOptions = {
          semanticEnabled: true,
          provider: 'conformance',
          typePermissions: DEFAULT_SEARCH_TYPE_PERMISSIONS,
        };

        return new SearchService(
          client,
          new SearchQueryEmbedder(port, options),
          new OwnerOnlyTranscriptVisibility(client),
          options,
        );
      },
    };
  },
  { describe, it, expect },
);
