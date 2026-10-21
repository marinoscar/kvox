import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';

import {
  SearchIndexHandler,
  SearchIndexService,
  SearchIndexingModule,
  SearchModule,
  SearchService,
} from '../../src/search/index.js';
import {
  SEARCH_CORPUS_TERMS,
  seedSearchCorpus,
  sparseVector,
  type SeededSearchCorpus,
} from '../../src/search/testing/index.js';
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  type SearchIndexingModuleOptions,
} from '../../src/search/search.options.js';
import type { KvoxAiCapabilities, KvoxAiPort, KvoxJob } from '../../src/ports/index.js';
import { createTestDb, createTestKvoxModule, type TestDb } from '../host/db.js';

// =============================================================================
// Search on the test host: a real PostgreSQL with pgvector (issue #494, epic #491)
// =============================================================================
//
// Almost nothing search promises can be proved without a real database: the
// generated `tsvector` columns, `plainto_tsquery`'s stopword list,
// `ts_rank_cd`'s cover density, `ts_headline`'s fragment selection and the
// `vector(1536)` column with its cosine operator all live in Postgres. So this
// spec runs the REAL `search.index` handler and the REAL `SearchService` against
// a migrated database holding the seeded corpus (`seedSearchCorpus`), with the AI
// port replaced by a deterministic embedder.
//
// THE EMBEDDER IS A TOPIC MAP, NOT A MODEL. Each text lands on one axis of the
// 1536-wide space by the words it contains, so every cosine similarity in this
// file is 0 or 1 and a failing ranking assertion means the FUSION changed, not
// that a model drifted:
//
//   axis 0  pricing   (packaging, tiers, invoice, billed)
//   axis 1  hiring    (roles, candidate, interview)
//   axis 2  logistics (venue, catering, offsite)
//   axis 3  anything else (the second transcript's only chunk)
//   axis 5  a query made only of a seeded nonsense term: no chunk is there
//
// Two scenarios are built to be falsifiable, as the app's own db spec builds them:
//
//   - THE PARAPHRASE. `invoices billed monthly` shares no stemmed term with the
//     pricing transcript, so the full-text arm returns nothing for it (asserted
//     directly, so the semantic arm cannot pass by accident) and only meaning finds it.
//   - THE HOST WITHOUT EMBEDDINGS. The same corpus and the same queries with
//     `embeddings: null`: full-text answers alone and says why.
//
// Visibility is the OWNER-ONLY default of the slice: the second user owns nothing
// and must see nothing. (Sharing and row-level security are the web edition's, and
// stay in the application's own db specs.)
//
// Needs `npm run test:host:prepare -w @marinoscar/kvox-api` and PostgreSQL 16 with
// pgvector; run by `npm run test:db -w @marinoscar/kvox-api -- search`.
// =============================================================================

const TOPIC_AXES: ReadonlyArray<readonly [RegExp, number]> = [
  [/pricing|packaging|tiers|invoice|billed/i, 0],
  [/hiring|roles|candidate|interview/i, 1],
  [/venue|catering|offsite/i, 2],
  // LAST, so a seeded document's own topic wins: a query that is only one of the
  // nonsense terms lands on an axis no chunk is on, and only the full-text arm answers.
  [/zarquon|vorpal|grimwald|fnord/i, 5],
];
const OTHER_AXIS = 3;

const MODEL = 'topic-embed';

function topicVector(text: string): number[] {
  const axis = TOPIC_AXES.find(([pattern]) => pattern.test(text))?.[1] ?? OTHER_AXIS;

  return sparseVector({ [axis]: 1 });
}

/** An AI port whose embeddings are the topic map; `embeddings: null` removes them. */
function topicAi(options: { embeddings: boolean; model?: string } = { embeddings: true }): KvoxAiPort & { embedCalls: string[][] } {
  const embedCalls: string[][] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error('search calls only capabilities and embed');
  };

  return {
    embedCalls,
    async capabilities(): Promise<KvoxAiCapabilities> {
      return {
        available: true,
        structuredOutput: false,
        toolCalling: false,
        embeddings: options.embeddings ? { model: options.model ?? MODEL, dimensions: SEARCH_EMBEDDING_DIMENSIONS } : null,
        graphEnabled: false,
      };
    },
    async embed(_ctx, request) {
      embedCalls.push([...request.inputs]);

      return {
        model: options.model ?? MODEL,
        dimensions: SEARCH_EMBEDDING_DIMENSIONS,
        vectors: request.inputs.map(topicVector),
      };
    },
    resolveTask: unsupported,
    generateText: unsupported as never,
    generateStructured: unsupported,
    chat: unsupported as never,
    countTokens: () => 0,
  };
}

function indexJob(documentType: 'transcript' | 'note', documentId: string): KvoxJob {
  return {
    id: randomUUID(),
    type: 'search.index',
    subjectType: documentType,
    subjectId: documentId,
    payload: { documentType, documentId },
    attempts: 1,
    orgId: null,
  };
}

async function bootSearch(
  db: TestDb,
  ai: KvoxAiPort,
  indexing: SearchIndexingModuleOptions = {},
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createTestKvoxModule({ db, overrides: { ai } }),
      SearchModule.forRoot(),
      SearchIndexingModule.forRoot(indexing),
    ],
  }).compile();

  await moduleRef.init();

  return moduleRef;
}

/** Everything a caller may do, so the specs below are about data, not permissions. */
const principalOf = (userId: string) => ({
  userId,
  permissions: new Set(['transcripts:read', 'notes:read']) as ReadonlySet<string>,
});

describe('search on the kvox-api test host', () => {
  let db: TestDb;
  let corpus: SeededSearchCorpus;

  beforeAll(async () => {
    db = await createTestDb();
    corpus = await seedSearchCorpus(db.prisma as never);
  });

  afterAll(async () => {
    await db.dispose();
  });

  describe('with an embeddings model (1536 wide)', () => {
    let moduleRef: TestingModule;
    let search: SearchService;
    let ai: ReturnType<typeof topicAi>;

    beforeAll(async () => {
      ai = topicAi();
      moduleRef = await bootSearch(db, ai, { batchSize: 2 });
      search = moduleRef.get(SearchService);

      const handler = moduleRef.get(SearchIndexHandler, { strict: false });

      for (const transcript of corpus.transcripts) await handler.process(indexJob('transcript', transcript.id));
      for (const note of corpus.notes) await handler.process(indexJob('note', note.id));
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('indexed all four documents, one vector per chunk, exactly 1536 wide', async () => {
      const states = await db.prisma.$queryRaw<Array<{ status: string; model: string | null; chunk_count: number }>>`
        SELECT status::text AS status, model, chunk_count FROM search_index_state
        WHERE owner_id = ${corpus.ownerId}::uuid`;

      expect(states).toHaveLength(4);
      expect(states.every((row) => row.status === 'indexed' && row.model === MODEL)).toBe(true);

      const vectors = await db.prisma.$queryRaw<Array<{ dims: number; model: string }>>`
        SELECT vector_dims(e.embedding) AS dims, e.model AS model
        FROM search_embeddings e JOIN search_chunks c ON c.id = e.chunk_id
        WHERE c.document_id = ANY(${[...corpus.transcripts, ...corpus.notes].map((doc) => doc.id)}::uuid[])`;

      expect(vectors.length).toBeGreaterThanOrEqual(4);
      expect(vectors.every((row) => Number(row.dims) === SEARCH_EMBEDDING_DIMENSIONS && row.model === MODEL)).toBe(true);

      // The batch size of the module is honoured: never more inputs than 2 per request.
      expect(ai.embedCalls.every((inputs) => inputs.length <= 2)).toBe(true);
    });

    it('finds a transcript by a word spoken in its middle, with the segment as the snippet', async () => {
      const result = await search.search({ q: `${SEARCH_CORPUS_TERMS.transcriptSegment} migration`, limit: 20 }, principalOf(corpus.ownerId));

      expect(result.results.map((row) => row.id)).toEqual([corpus.transcripts[0].id]);
      expect(result.results[0]).toMatchObject({ type: 'transcript', title: 'Quarterly pricing review' });

      const [snippet] = result.results[0]!.snippets;

      expect(snippet).toMatchObject({ field: 'segment', startMs: 4000 });
      expect(snippet!.html).toContain(`<mark>${SEARCH_CORPUS_TERMS.transcriptSegment}</mark>`);
      expect(result.searchedTypes).toEqual(['transcript', 'note']);
    });

    it('ranks a document both arms found above the rest, and renders its snippet', async () => {
      const result = await search.search({ q: 'hiring', limit: 20 }, principalOf(corpus.ownerId));

      // Found lexically (title and body) AND by meaning (axis 1): rank 1 in both
      // arms, so the fused score is 2 / (60 + 1).
      expect(result.results[0]).toMatchObject({ type: 'note', id: corpus.notes[0].id });
      expect(result.results[0]!.score).toBeCloseTo(2 / 61, 10);
      expect(result.semantic).toBe(true);
      expect(result.semanticReason).toBeNull();
      expect(result.results[0]!.snippets[0]!.html).toContain('<mark>');
    });

    it('finds a paraphrase only by meaning: the full-text arm has nothing for it', async () => {
      const q = 'invoices billed monthly';
      const result = await search.search({ q, limit: 20 }, principalOf(corpus.ownerId));

      // The semantic arm carried it: pricing axis -> the pricing transcript.
      expect(result.semantic).toBe(true);
      expect(result.results.map((row) => row.id)).toEqual([corpus.transcripts[0].id]);
      // No lexical overlap, so no snippet: an empty list, not a fabricated one.
      expect(result.results[0]!.snippets).toEqual([]);
      expect(result.results[0]!.score).toBeCloseTo(1 / 61, 10);

      // And it really is meaning alone: the same query with the semantic arm off finds nothing.
      const off = await bootSearch(db, topicAi({ embeddings: false }));
      try {
        const lexicalOnly = await off.get(SearchService).search({ q, limit: 20 }, principalOf(corpus.ownerId));
        expect(lexicalOnly.results).toEqual([]);
      } finally {
        await off.close();
      }
    });

    it('finds a document by a word in its title, transcript and note alike', async () => {
      const byTranscriptTitle = await search.search({ q: SEARCH_CORPUS_TERMS.transcriptTitle, limit: 20 }, principalOf(corpus.ownerId));
      const byNoteTitle = await search.search({ q: SEARCH_CORPUS_TERMS.noteTitle, limit: 20 }, principalOf(corpus.ownerId));
      const byNoteBody = await search.search({ q: SEARCH_CORPUS_TERMS.noteBody, limit: 20 }, principalOf(corpus.ownerId));

      expect(byTranscriptTitle.results.map((row) => row.id)).toContain(corpus.transcripts[1].id);
      expect(byNoteTitle.results.map((row) => row.id)).toContain(corpus.notes[1].id);
      expect(byNoteBody.results.map((row) => row.id)).toContain(corpus.notes[0].id);
      expect(byNoteBody.results.find((row) => row.id === corpus.notes[0].id)!.snippets[0]).toMatchObject({
        field: 'body',
      });
    });

    it('shows a second user NOTHING: not the hits, not the vector arm, not even a count', async () => {
      for (const q of [SEARCH_CORPUS_TERMS.transcriptSegment, SEARCH_CORPUS_TERMS.noteBody, 'invoices billed monthly']) {
        const result = await search.search({ q, limit: 20 }, principalOf(corpus.strangerId));

        expect(result.results).toEqual([]);
        expect(result.matchedDocuments).toBe(0);
        expect(result.unindexedCount).toBe(0);
      }

      // The stranger owns nothing indexed, so the vector arm is not even tried.
      const result = await search.search({ q: 'invoices billed monthly', limit: 20 }, principalOf(corpus.strangerId));

      expect(result).toMatchObject({ semantic: false, semanticReason: 'no_indexed_content' });
    });

    it('does not re-embed an unchanged document on a second run', async () => {
      const handler = moduleRef.get(SearchIndexHandler, { strict: false });
      const before = ai.embedCalls.length;

      await handler.process(indexJob('note', corpus.notes[0].id));

      expect(ai.embedCalls.length).toBe(before);
    });

    it('forgets a document completely, vectors included', async () => {
      const index = moduleRef.get(SearchIndexService);
      const victim = corpus.notes[1].id;

      await index.forget('note', victim);

      const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT (SELECT count(*) FROM search_chunks WHERE document_id = ${victim}::uuid)::int
             + (SELECT count(*) FROM search_embeddings e JOIN search_chunks c ON c.id = e.chunk_id WHERE c.document_id = ${victim}::uuid)::int
             + (SELECT count(*) FROM search_index_state WHERE document_id = ${victim}::uuid)::int AS n`;

      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  describe('on a host with no embeddings model (embeddings: null)', () => {
    let moduleRef: TestingModule;
    let ai: ReturnType<typeof topicAi>;
    let owner: SeededSearchCorpus;

    beforeAll(async () => {
      // Its own owner and documents, so the indexed corpus above cannot answer for it.
      owner = await seedSearchCorpus(db.prisma as never);
      ai = topicAi({ embeddings: false });
      moduleRef = await bootSearch(db, ai);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('answers with the full-text ranking and the snippet, and says why the semantic arm is off', async () => {
      const result = await moduleRef
        .get(SearchService)
        .search({ q: `${SEARCH_CORPUS_TERMS.transcriptSegment} migration`, limit: 20 }, principalOf(owner.ownerId));

      expect(result).toMatchObject({ semantic: false, semanticReason: 'embeddings_unavailable' });
      expect(result.results.map((row) => row.id)).toEqual([owner.transcripts[0].id]);
      expect(result.results[0]!.snippets[0]!.html).toContain(`<mark>${SEARCH_CORPUS_TERMS.transcriptSegment}</mark>`);
      expect(ai.embedCalls).toEqual([]);
    });

    it('indexes nothing, and records on the document why', async () => {
      const handler = moduleRef.get(SearchIndexHandler, { strict: false });

      await handler.process(indexJob('note', owner.notes[0].id));

      const rows = await db.prisma.$queryRaw<Array<{ status: string; reason: string | null }>>`
        SELECT status::text AS status, reason FROM search_index_state WHERE document_id = ${owner.notes[0].id}::uuid`;

      expect(rows).toEqual([{ status: 'skipped', reason: 'embedding_unsupported' }]);
      expect(ai.embedCalls).toEqual([]);
    });

    it('falls back to a title match for an all-stopword query, as it always has', async () => {
      const result = await moduleRef
        .get(SearchService)
        .search({ q: 'the and of', limit: 20 }, principalOf(owner.ownerId));

      expect(result.degraded).toBe('stopwords');
      expect(result.semantic).toBe(false);
    });
  });
  describe('model isolation (#660)', () => {
    it('never returns a row stored under another model, and re-indexing under a new model drops the old rows', async () => {
      const own = await seedSearchCorpus(db.prisma as never);
      const first = await bootSearch(db, topicAi({ embeddings: true, model: 'model-a' }));

      try {
        const handler = first.get(SearchIndexHandler, { strict: false });

        for (const note of own.notes) await handler.process(indexJob('note', note.id));

        // Relabel every vector of these notes as a foreign model: the vectors still sit
        // exactly where the query points, but none of them belongs to the active model.
        await db.prisma.$executeRaw`
          UPDATE search_embeddings e SET model = 'ghost-model'
          FROM search_chunks c
          WHERE c.id = e.chunk_id AND c.document_id = ANY(${own.notes.map((n) => n.id)}::uuid[])`;

        const result = await first
          .get(SearchService)
          .search({ q: 'venue catering offsite', limit: 20 }, principalOf(own.ownerId));

        // Unfiltered, the probe would see the ghost rows and the vector arm would run (and
        // match at cosine 1). Filtered on the active model there is nothing to compare with,
        // so the semantic arm stands down; any hit comes from full text alone.
        expect(result.semantic).toBe(false);
        expect(result.semanticReason).toBe('no_indexed_content');
      } finally {
        await first.close();
      }

      const second = await bootSearch(db, topicAi({ embeddings: true, model: 'model-b' }));

      try {
        const handler = second.get(SearchIndexHandler, { strict: false });

        for (const note of own.notes) await handler.process(indexJob('note', note.id));

        const models = await db.prisma.$queryRaw<Array<{ model: string }>>`
          SELECT DISTINCT e.model AS model FROM search_embeddings e JOIN search_chunks c ON c.id = e.chunk_id
          WHERE c.document_id = ANY(${own.notes.map((n) => n.id)}::uuid[])`;

        expect(models.map((row) => row.model)).toEqual(['model-b']);
      } finally {
        await second.close();
      }
    });

    it('a 384-wide vector zero-padded to 1536 has the same cosine as the unpadded pair', async () => {
      const a = Array.from({ length: 384 }, (_, i) => Math.sin(i + 1));
      const b = Array.from({ length: 384 }, (_, i) => Math.cos(i * 0.5));
      const pad = (v: number[]) => `[${[...v, ...new Array(SEARCH_EMBEDDING_DIMENSIONS - v.length).fill(0)].join(',')}]`;
      const raw = (v: number[]) => `[${v.join(',')}]`;

      const [row] = await db.prisma.$queryRaw<Array<{ padded: number; native: number }>>`
        SELECT (${pad(a)}::vector <=> ${pad(b)}::vector)::float8 AS padded,
               (${raw(a)}::vector(384) <=> ${raw(b)}::vector(384))::float8 AS native`;

      expect(row!.padded).toBeCloseTo(row!.native, 9);
    });
  });
});
