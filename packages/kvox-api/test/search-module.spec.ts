import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_PERMISSIONS_KEY, KvoxAuthGuard } from '../src/core/index.js';
import { KVOX_JOBS, type KvoxJobHandler } from '../src/ports/index.js';
import {
  OwnerOnlyTranscriptVisibility,
  SEARCH_TRANSCRIPT_VISIBILITY,
  SearchController,
  SearchIndexController,
  SearchIndexHandler,
  SearchIndexService,
  SearchIndexStatusService,
  SearchIndexingModule,
  SearchModule,
  SearchQueryEmbedder,
  SearchService,
  type SearchModuleOptions,
  type SearchTranscriptVisibility,
} from '../src/search/index.js';
import {
  SEARCH_DEFAULT_BATCH_SIZE,
  SEARCH_INDEXING_MODULE_OPTIONS,
  SEARCH_MODULE_OPTIONS,
} from '../src/search/search.options.js';
import {
  createFakeKvoxAi,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  type FakeKvoxJobs,
} from '../src/testing/index.js';

// =============================================================================
// SearchModule.forRoot and SearchIndexingModule.forRoot over the fake ports
// (issue #494, epic #491)
// =============================================================================
//
// What the two modules promise a host: they boot on the ports alone, bind the
// owner-only transcript visibility unless the host brings its own, take the
// permission strings and the semantic switches from the host, register
// `search.index` through the job port, and put NO permission on the routes (the
// either-or the guard cannot express; the service narrows from the principal).
// =============================================================================

async function boot(
  options?: SearchModuleOptions,
  indexing?: { batchSize?: number },
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity(), ai: createFakeKvoxAi() } }),
      SearchModule.forRoot(options),
      SearchIndexingModule.forRoot(indexing),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('SearchModule.forRoot and SearchIndexingModule.forRoot', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('boots on the ports alone and exports the services', async () => {
    moduleRef = await boot();

    expect(moduleRef.get(SearchService)).toBeInstanceOf(SearchService);
    expect(moduleRef.get(SearchQueryEmbedder)).toBeInstanceOf(SearchQueryEmbedder);
    expect(moduleRef.get(SearchIndexService)).toBeInstanceOf(SearchIndexService);
    expect(moduleRef.get(SearchIndexStatusService, { strict: false })).toBeInstanceOf(SearchIndexStatusService);
  });

  it('is not global: only a module that imports it can reach its providers', () => {
    expect(SearchModule.forRoot().global).toBe(false);
    expect(SearchIndexingModule.forRoot().global).toBe(false);
  });

  it('exports the query services (and the transcript-visibility rule the graph reuses) and ONLY the index service from the indexing side', () => {
    expect(SearchModule.forRoot().exports).toEqual([SearchService, SearchQueryEmbedder, SEARCH_TRANSCRIPT_VISIBILITY]);
    expect(SearchIndexingModule.forRoot().exports).toEqual([SearchIndexService]);
  });

  it('registers search.index through the job port when the module starts', async () => {
    moduleRef = await boot();

    const jobs = moduleRef.get(KVOX_JOBS) as FakeKvoxJobs;
    const handler = moduleRef.get(SearchIndexHandler, { strict: false });

    expect(jobs.isRegistered('search.index')).toBe(true);
    expect(handler.usesAi).toBe(true);
    expect((handler as KvoxJobHandler).nodeResultSchema).toBeUndefined();
  });

  it('queues a re-index through the job port with the document as its subject', async () => {
    moduleRef = await boot();

    await moduleRef.get(SearchIndexService).enqueue('note', '33333333-3333-4333-8333-333333333333');

    const jobs = moduleRef.get(KVOX_JOBS) as FakeKvoxJobs;

    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]!.input).toMatchObject({
      type: 'search.index',
      subjectType: 'note',
      subjectId: '33333333-3333-4333-8333-333333333333',
      priority: 10,
    });
  });

  describe('options', () => {
    it('defaults the semantic arm on, the permissions to the web strings and the batch to 128', async () => {
      moduleRef = await boot();

      expect(moduleRef.get(SEARCH_MODULE_OPTIONS, { strict: false })).toMatchObject({
        semanticEnabled: true,
        provider: 'embeddings',
        typePermissions: { transcript: 'transcripts:read', note: 'notes:read' },
      });
      expect(moduleRef.get(SEARCH_INDEXING_MODULE_OPTIONS, { strict: false })).toEqual({
        batchSize: SEARCH_DEFAULT_BATCH_SIZE,
      });
      expect(SEARCH_DEFAULT_BATCH_SIZE).toBe(128);
    });

    it('takes the host\'s semantic switch, provider label, permissions and batch size', async () => {
      moduleRef = await boot(
        {
          semantic: { enabled: false, provider: 'openai' },
          typePermissions: { transcript: 'recordings:view' },
        },
        { batchSize: 16 },
      );

      expect(moduleRef.get(SEARCH_MODULE_OPTIONS, { strict: false })).toMatchObject({
        semanticEnabled: false,
        provider: 'openai',
        typePermissions: { transcript: 'recordings:view', note: 'notes:read' },
      });
      expect(moduleRef.get(SEARCH_INDEXING_MODULE_OPTIONS, { strict: false })).toEqual({ batchSize: 16 });
    });

    it('binds the owner-only transcript visibility by default and the host\'s own when given', async () => {
      moduleRef = await boot();
      expect(moduleRef.get(SEARCH_TRANSCRIPT_VISIBILITY, { strict: false })).toBeInstanceOf(OwnerOnlyTranscriptVisibility);
      await moduleRef.close();

      class HostVisibility implements SearchTranscriptVisibility {
        async viewerFor(userId: string) {
          return { userId };
        }
        transcriptVisibleSql(): never {
          throw new Error('not reached in this spec');
        }
        run<R>(): Promise<R> {
          throw new Error('not reached in this spec');
        }
      }

      moduleRef = await boot({ transcriptVisibility: HostVisibility });
      expect(moduleRef.get(SEARCH_TRANSCRIPT_VISIBILITY, { strict: false })).toBeInstanceOf(HostVisibility);
    });

    it('turns the semantic arm off for a host that asked, without touching the AI port', async () => {
      moduleRef = await boot({ semantic: { enabled: false } });

      const embedder = moduleRef.get(SearchQueryEmbedder);

      await expect(embedder.resolve('user-1')).resolves.toEqual({ ok: false, reason: 'embeddings_unavailable' });
    });
  });

  describe('the routes', () => {
    it('are behind KvoxAuthGuard and name NO permission (either-or is the service\'s to enforce)', () => {
      for (const [controller, methods] of [
        [SearchController, ['searchAll']],
        [SearchIndexController, ['indexStatus', 'requestIndex']],
      ] as const) {
        for (const method of methods) {
          const handler = (controller.prototype as unknown as Record<string, object>)[method]!;

          expect(Reflect.getMetadata('__guards__', handler)).toContain(KvoxAuthGuard);
          expect(Reflect.getMetadata(KVOX_PERMISSIONS_KEY, handler)).toEqual([]);
        }
      }
    });
  });
});
