// =============================================================================
// Real-Postgres test: the `search.index` round trip (issue #188, epic #165)
// =============================================================================
//
// `src/search/indexing/search-index.handler.spec.ts` proves the handler's
// decisions against an in-memory simulation of Prisma. Three of those decisions
// are only half-proved that way, because their other half lives in the
// DATABASE and cannot be exercised by a fake:
//
//   1. THE VECTOR ACTUALLY GOES IN. `search_embeddings.embedding` is
//      `Unsupported("vector(1536)")` and REQUIRED, so the generated Prisma
//      client emits no `create` for the model and every write is hand-built raw
//      SQL (`writeVectors`). A mocked `$executeRaw` proves the handler CALLS
//      it; only a real `vector` column proves the literal it assembles is one
//      pgvector accepts.
//   2. `embeddings: { none: { model } }` — the query that decides what gets
//      embedded, and therefore what the owner is billed for — is a real Prisma
//      relation filter compiled into a real `LEFT JOIN`. The unit test
//      reimplements it in TypeScript; this one runs it.
//   3. `SearchEmbedding.chunkId`'s CASCADE is what lets
//      `SearchIndexService.forget` delete chunks and say nothing about
//      vectors. A fake cascade proves nothing about the foreign key.
//
// Like every other `*.db.spec.ts` (see `search-embeddings.db.spec.ts` beside
// it), this file is excluded from `npm test`/`test:unit`/`test:cov`/`test:ci`
// and runs via `npm run test:db` against a real Postgres with pgvector, using
// the shared reachability probe in `../jobs/db-test-support.ts`.
//
// THE PROVIDER IS STUBBED AND NOTHING ELSE IS. No network call is made and no
// key is needed; the chunker, the reconciliation, the raw writes, the relation
// filter and the cascade are all the real ones.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { EMBEDDING_DIMENSIONS } from '../../src/ai/providers/ai-provider.interface';
import {
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_INDEX_JOB_TYPE,
} from '../../src/search/indexing/job-types';
import { SearchIndexHandler } from '../../src/search/indexing/search-index.handler';
import { SearchIndexService } from '../../src/search/indexing/search-index.service';
import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('search-index.db.spec');

const MODEL = 'text-embedding-3-small';
const EMAIL_PREFIX = 'search-index-test';

/** A paragraph long enough to become its own chunk. */
function line(mark: string): string {
  return `${mark}. ${'the quick brown fox jumps over the lazy dog. '.repeat(34)}`;
}

describeWithDb('Semantic search: the `search.index` round trip (real Postgres)', () => {
  let prisma: PrismaClient;

  let createdUserIds: string[] = [];
  let createdObjectIds: string[] = [];
  let createdDocumentIds: string[] = [];

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    createdUserIds = [];
    createdObjectIds = [];
    createdDocumentIds = [];
  });

  afterEach(async () => {
    // `search_chunks` carries no foreign key to anything, so it is swept by the
    // document ids each test registers — which is the whole point of the
    // handler's own `forget` and of this cleanup looking the way it does.
    if (createdDocumentIds.length > 0) {
      await prisma.$executeRaw`
        DELETE FROM search_chunks WHERE document_id = ANY(${createdDocumentIds}::uuid[])
      `;
      await prisma.$executeRaw`
        DELETE FROM search_index_state WHERE document_id = ANY(${createdDocumentIds}::uuid[])
      `;
    }

    await prisma.transcript.deleteMany({ where: { id: { in: createdDocumentIds } } });
    await prisma.storageObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createTranscript(marks: readonly string[]) {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${randomUUID()}@example.com`, displayName: 'Index Test' },
    });
    createdUserIds.push(user.id);

    const object = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `search-index-test/${randomUUID()}`,
        status: 'ready',
        managedBy: 'transcripts',
      },
    });
    createdObjectIds.push(object.id);

    const transcript = await prisma.transcript.create({
      data: {
        ownerId: user.id,
        title: 'Weekly sync',
        provider: 'assemblyai',
        sourceObjectId: object.id,
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
      },
    });
    createdDocumentIds.push(transcript.id);

    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });

    const segments = [];

    for (const [position, mark] of marks.entries()) {
      segments.push(
        await prisma.transcriptSegment.create({
          data: {
            transcriptId: transcript.id,
            speakerId: speaker.id,
            startMs: position * 1000,
            endMs: position * 1000 + 900,
            ordinal: position + 1,
            text: line(mark),
            words: [],
          },
        }),
      );
    }

    return { user, transcript, segments };
  }

  /**
   * The handler, with the PROVIDER stubbed and everything else real.
   *
   * The vectors are deterministic and distinct per input, so a wrong-chunk
   * pairing would be visible rather than hidden behind identical numbers.
   */
  function buildHandler() {
    const embed = jest.fn(async (_ctx: unknown, request: { inputs: string[] }) => ({
      vectors: request.inputs.map((_input, position) => {
        const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
        vector[position % EMBEDDING_DIMENSIONS] = 1;

        return vector as number[];
      }),
      promptTokens: 42,
      model: MODEL,
    }));

    const provider = {
      id: 'openai',
      label: 'OpenAI',
      settingsSchema: { safeParse: () => ({ success: true as const, data: {} }) },
      embedding: {
        model: MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        maxInputTokens: 8191,
        maxBatchSize: 2,
      },
      embed,
    };

    const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
    const index = new SearchIndexService(prisma as never, jobs as never);

    const handler = new SearchIndexHandler(
      new JobHandlerRegistry(),
      prisma as never,
      { get: (id: string) => (id === 'openai' ? provider : undefined) } as never,
      { get: async () => ({ enabled: true, provider: 'openai', providers: { openai: {} } }) } as never,
      {
        getSecret: async () => 'sk-test-not-used',
        markUsed: async () => undefined,
      } as never,
      { registerProviderKey: jest.fn() } as never,
      index as never,
    );

    return { handler, embed, index, jobs };
  }

  function job(documentId: string) {
    return {
      id: randomUUID(),
      payload: { documentType: SEARCH_DOC_TRANSCRIPT, documentId },
    } as never;
  }

  // ---------------------------------------------------------------------------
  // 1. The full round trip
  // ---------------------------------------------------------------------------

  it('chunks, embeds and records a transcript as `indexed`', async () => {
    const { user, transcript } = await createTranscript(['alpha', 'bravo', 'charlie', 'delta']);
    const { handler, embed } = buildHandler();

    await handler.process(job(transcript.id));

    const chunks = await prisma.searchChunk.findMany({
      where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
      orderBy: { ordinal: 'asc' },
    });

    expect(chunks.length).toBeGreaterThan(1);
    // The speaker's DISPLAY name is what a reader sees and what the model
    // embeds — not the provider's diarization letter.
    expect(chunks[0]!.text).toContain('Speaker A');

    const vectors = await prisma.$queryRaw<{ chunk_id: string; model: string; dims: number }[]>`
      SELECT chunk_id, model, vector_dims(embedding) AS dims
      FROM search_embeddings
      WHERE chunk_id = ANY(${chunks.map((chunk) => chunk.id)}::uuid[])
    `;

    // Every chunk got a vector, of exactly the contracted width, written by
    // hand-built raw SQL into an `Unsupported("vector(1536)")` column.
    expect(vectors).toHaveLength(chunks.length);
    expect(vectors.every((row) => Number(row.dims) === EMBEDDING_DIMENSIONS)).toBe(true);
    expect(vectors.every((row) => row.model === MODEL)).toBe(true);

    // `maxBatchSize: 2` above, so the batching is real rather than incidental.
    expect(embed.mock.calls.every((call) => call[1].inputs.length <= 2)).toBe(true);

    const state = await prisma.searchIndexState.findUnique({
      where: {
        documentType_documentId: {
          documentType: SEARCH_DOC_TRANSCRIPT,
          documentId: transcript.id,
        },
      },
    });

    expect(state).toMatchObject({
      status: 'indexed',
      ownerId: user.id,
      reason: null,
      chunkCount: chunks.length,
      model: MODEL,
    });
    expect(state!.contentFingerprint).toEqual(expect.any(String));
    expect(state!.indexedAt).toBeInstanceOf(Date);
  });

  // ---------------------------------------------------------------------------
  // 2. An unedited re-run costs nothing
  // ---------------------------------------------------------------------------

  it('embeds nothing at all on a re-run over unchanged content', async () => {
    const { transcript } = await createTranscript(['alpha', 'bravo', 'charlie']);
    const { handler, embed } = buildHandler();

    await handler.process(job(transcript.id));

    embed.mockClear();

    await handler.process(job(transcript.id));

    expect(embed).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 3. THE HEADLINE: one edited segment re-embeds only what it touched
  // ---------------------------------------------------------------------------

  it('re-embeds only the chunks an edit actually moved', async () => {
    const { transcript, segments } = await createTranscript([
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
    ]);
    const { handler, embed } = buildHandler();

    await handler.process(job(transcript.id));

    const before = await prisma.searchChunk.findMany({
      where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true, contentHash: true },
    });

    expect(before.length).toBeGreaterThan(2);

    // Correct one line, exactly as `POST /:id/operations` would, and bump the
    // version the way a committed batch does.
    await prisma.transcriptSegment.update({
      where: { id: segments[0]!.id },
      data: { text: line('ALPHA, CORRECTED') },
    });
    await prisma.transcript.update({
      where: { id: transcript.id },
      data: { currentVersion: 2 },
    });

    embed.mockClear();

    await handler.process(job(transcript.id));

    const after = await prisma.searchChunk.findMany({
      where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
      orderBy: { ordinal: 'asc' },
      select: { id: true, ordinal: true, contentHash: true },
    });

    const moved = after.filter(
      (chunk) => before.find((row) => row.ordinal === chunk.ordinal)?.contentHash !== chunk.contentHash,
    );

    // Something moved, but NOT everything — that is the whole economic claim.
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(after.length);

    const embeddedInputs = embed.mock.calls.reduce(
      (total, call) => total + call[1].inputs.length,
      0,
    );

    expect(embeddedInputs).toBe(moved.length);

    // Chunk IDENTITY survived the edit — which is what kept the untouched
    // chunks' vectors attached to them.
    expect(after.map((chunk) => chunk.id).sort()).toEqual(
      before
        .filter((row) => after.some((chunk) => chunk.ordinal === row.ordinal))
        .map((row) => row.id)
        .sort(),
    );

    // Every chunk still has exactly one vector under the active model, and the
    // moved ones' vectors were replaced rather than left stale.
    const counts = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM search_embeddings
      WHERE chunk_id = ANY(${after.map((chunk) => chunk.id)}::uuid[]) AND model = ${MODEL}
    `;

    expect(Number(counts[0]!.count)).toBe(after.length);
  });

  // ---------------------------------------------------------------------------
  // 4. A purge takes the rows with it — and the vectors cascade
  // ---------------------------------------------------------------------------

  it('forgets every chunk, vector and state row when the document is purged', async () => {
    const { transcript } = await createTranscript(['alpha', 'bravo']);
    const { handler, index } = buildHandler();

    await handler.process(job(transcript.id));

    const chunkIds = (
      await prisma.searchChunk.findMany({
        where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
        select: { id: true },
      })
    ).map((chunk) => chunk.id);

    expect(chunkIds.length).toBeGreaterThan(0);

    // What `transcript.purge` / `note.purge` / `user.data.purge` call. Nothing
    // else ever will: `document_id` carries no foreign key, so no cascade and
    // no (deliberately absent) housekeeping cron is coming.
    await index.forget(SEARCH_DOC_TRANSCRIPT, transcript.id);

    expect(
      await prisma.searchChunk.count({
        where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
      }),
    ).toBe(0);

    expect(
      await prisma.searchIndexState.count({
        where: { documentType: SEARCH_DOC_TRANSCRIPT, documentId: transcript.id },
      }),
    ).toBe(0);

    // The vectors went with the chunks, through `SearchEmbedding.chunkId`'s
    // real, cascading foreign key — which is why `forget` never names them.
    const orphans = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM search_embeddings
      WHERE chunk_id = ANY(${chunkIds}::uuid[])
    `;

    expect(Number(orphans[0]!.count)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 5. The job type says what it is
  // ---------------------------------------------------------------------------

  it('is registered under `search.index`', () => {
    const { handler } = buildHandler();

    expect(handler.type).toBe(SEARCH_INDEX_JOB_TYPE);
  });
});
