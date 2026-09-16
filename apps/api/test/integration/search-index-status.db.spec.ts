// =============================================================================
// Real-Postgres test: the indexing status surface (issue #191, epic #165)
// =============================================================================
//
// `src/search/indexing/search-index-status.service.spec.ts` proves the
// service's decisions against a Prisma double that filters by `ownerId` and
// `deletedAt` in TypeScript. Three of those claims are only half-proved that
// way, because their other half is the DATABASE:
//
//   1. `unindexed` — A DOCUMENT WITH NO `search_index_state` ROW. The double
//      returns an empty list because it was given one; only a real schema
//      proves that a transcript created without ever being indexed genuinely
//      has no row to find, and that the service's two-query join therefore
//      reports it as unindexed rather than as zero of everything.
//   2. OWNER SCOPING. `search_index_state.owner_id` is a real column with a
//      real `(owner_id, status)` index, and `transcripts.owner_id` is a real
//      foreign key. A fake `where` filter proves the service passes the right
//      object; a real database proves the right rows come back. This is a
//      BILLING boundary — indexing spends the document owner's own vendor
//      account — so it is worth proving twice.
//   3. THE CANDIDATE SELECTION AND ITS CAP run against real rows here, through
//      the REAL `SearchIndexService.enqueue`, so the per-call bound is tested
//      on the same code path a user's button press takes.
//
// THE QUEUE IS STUBBED AND NOTHING ELSE IS. `JobsService.enqueue` is a jest
// mock — this suite is about which documents are selected, not about the
// `jobs` table, which `search-index.db.spec.ts` and the queue's own suites
// already cover. No network call is made and no key is needed.
//
// Like every other `*.db.spec.ts`, this file is excluded from `npm test` and
// runs via `npm run test:db` against a real Postgres, using the shared
// reachability probe in `../jobs/db-test-support.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import {
  SEARCH_DOC_NOTE,
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_REASON_KEY_MISSING,
} from '../../src/search/indexing/job-types';
import { SearchIndexService } from '../../src/search/indexing/search-index.service';
import { SearchIndexStatusService } from '../../src/search/indexing/search-index-status.service';
import { SEARCH_INDEX_REQUEST_CAP } from '../../src/search/indexing/dto/search-index-status.dto';
import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('search-index-status.db.spec');

const MODEL = 'text-embedding-3-small';
const EMAIL_PREFIX = 'search-index-status-test';

describeWithDb('Semantic search: the indexing status surface (real Postgres)', () => {
  let prisma: PrismaClient;

  let createdUserIds: string[] = [];
  let createdObjectIds: string[] = [];
  let createdTranscriptIds: string[] = [];
  let createdNoteIds: string[] = [];

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
    createdTranscriptIds = [];
    createdNoteIds = [];
  });

  afterEach(async () => {
    const documentIds = [...createdTranscriptIds, ...createdNoteIds];

    if (documentIds.length > 0) {
      // No foreign key on `document_id` in either direction — the polymorphic
      // reference this epic inherits from `Job.subjectType` — so these rows are
      // swept by id, exactly as `SearchIndexService.forget` has to.
      await prisma.$executeRaw`
        DELETE FROM search_index_state WHERE document_id = ANY(${documentIds}::uuid[])
      `;
    }

    // Notes RESTRICT on their source transcript, so they go first.
    await prisma.note.deleteMany({ where: { id: { in: createdNoteIds } } });
    await prisma.transcript.deleteMany({ where: { id: { in: createdTranscriptIds } } });
    await prisma.storageObject.deleteMany({ where: { id: { in: createdObjectIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${randomUUID()}@example.com`,
        displayName: 'Index Status Test',
      },
    });
    createdUserIds.push(user.id);

    return user.id;
  }

  async function createTranscript(
    ownerId: string,
    options: { deleted?: boolean } = {},
  ): Promise<string> {
    const object = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        status: 'ready',
        managedBy: 'transcripts',
      },
    });
    createdObjectIds.push(object.id);

    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: `Recording ${randomUUID().slice(0, 8)}`,
        provider: 'assemblyai',
        sourceObjectId: object.id,
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
        deletedAt: options.deleted ? new Date() : null,
      },
    });
    createdTranscriptIds.push(transcript.id);

    return transcript.id;
  }

  async function createNote(ownerId: string, sourceTranscriptId: string): Promise<string> {
    const note = await prisma.note.create({
      data: {
        ownerId,
        title: `Note ${randomUUID().slice(0, 8)}`,
        body: '# Notes\n\nWe ship on Friday.',
        status: 'ready',
        currentVersion: 1,
        sourceType: 'transcript',
        sourceTranscriptId,
      },
    });
    createdNoteIds.push(note.id);

    return note.id;
  }

  async function writeState(
    ownerId: string,
    documentType: string,
    documentId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await prisma.searchIndexState.create({
      data: {
        ownerId,
        documentType,
        documentId,
        status: 'indexed',
        chunkCount: 3,
        model: MODEL,
        contentFingerprint: randomUUID(),
        indexedAt: new Date(),
        ...overrides,
      },
    });
  }

  /**
   * The service, with the AI policy and the credential store stubbed and
   * EVERYTHING ELSE REAL — including `SearchIndexService`, so the candidate
   * selection runs through the one enqueue path the whole epic shares.
   */
  function buildService(options: { hasKey?: boolean; embedding?: boolean } = {}) {
    const { hasKey = true, embedding = true } = options;

    const provider = {
      id: 'openai',
      label: 'OpenAI',
      embedding: embedding
        ? { model: MODEL, dimensions: 1536, maxInputTokens: 8191, maxBatchSize: 128 }
        : undefined,
      embed: embedding ? async () => ({ vectors: [] }) : undefined,
    };

    // Typed with its real single-argument signature so the assertions below can
    // read `mock.calls[n][0].subjectId` rather than indexing an empty tuple.
    const jobs = {
      enqueue: jest.fn(async (_input: { subjectId: string }) => ({ id: randomUUID() })),
    };
    const index = new SearchIndexService(prisma as never, jobs as never);

    const service = new SearchIndexStatusService(
      prisma as never,
      { get: (id: string) => (id === 'openai' ? provider : undefined) } as never,
      { get: async () => ({ enabled: true, provider: 'openai', providers: { openai: {} } }) } as never,
      { hasKey: async () => hasKey } as never,
      index,
    );

    return { service, jobs };
  }

  // ---------------------------------------------------------------------------
  // Counts
  // ---------------------------------------------------------------------------

  it('counts a document with NO `search_index_state` row as `unindexed`', async () => {
    const owner = await createUser();

    const indexed = await createTranscript(owner);
    await createTranscript(owner); // never indexed, so no row exists at all
    await createTranscript(owner);

    await writeState(owner, SEARCH_DOC_TRANSCRIPT, indexed);

    const { service } = buildService();
    const status = await service.status(owner);
    const transcripts = status.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT);

    expect(transcripts).toEqual({
      type: SEARCH_DOC_TRANSCRIPT,
      indexed: 1,
      pending: 0,
      failed: 0,
      skipped: 0,
      unindexed: 2,
      total: 3,
    });

    // And the database really does hold nothing for the two: the count above is
    // derived from an absence, not from a row saying "unindexed".
    await expect(
      prisma.searchIndexState.count({ where: { ownerId: owner } }),
    ).resolves.toBe(1);
  });

  it('counts every state, across both document types, against real rows', async () => {
    const owner = await createUser();

    const source = await createTranscript(owner);
    const pending = await createTranscript(owner);
    const indexing = await createTranscript(owner);
    const failed = await createTranscript(owner);
    const skipped = await createTranscript(owner);

    await writeState(owner, SEARCH_DOC_TRANSCRIPT, source);
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, pending, {
      status: 'pending',
      indexedAt: null,
      model: null,
      contentFingerprint: null,
      chunkCount: 0,
    });
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, indexing, {
      status: 'indexing',
      indexedAt: null,
      chunkCount: 0,
    });
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, failed, {
      status: 'failed',
      reason: 'dimension_mismatch',
      lastError: 'expected 1536 dimensions',
    });
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, skipped, {
      status: 'skipped',
      reason: SEARCH_REASON_KEY_MISSING,
      indexedAt: null,
    });

    const note = await createNote(owner, source);
    await writeState(owner, SEARCH_DOC_NOTE, note);

    const { service } = buildService();
    const status = await service.status(owner);

    expect(status.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT)).toEqual({
      type: SEARCH_DOC_TRANSCRIPT,
      indexed: 1,
      // `indexing` and `pending` are ONE number on the wire.
      pending: 2,
      failed: 1,
      skipped: 1,
      unindexed: 0,
      total: 5,
    });
    expect(status.types.find((entry) => entry.type === SEARCH_DOC_NOTE)).toEqual({
      type: SEARCH_DOC_NOTE,
      indexed: 1,
      pending: 0,
      failed: 0,
      skipped: 0,
      unindexed: 0,
      total: 1,
    });

    // The per-document failure list carries the diagnostic text, and elides the
    // `ai_key_missing` skip — that is one fact about the account, already
    // reported once by `reason`.
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      type: SEARCH_DOC_TRANSCRIPT,
      id: failed,
      reason: 'dimension_mismatch',
      lastError: 'expected 1536 dimensions',
    });
  });

  it("never counts another user's documents, or their index rows", async () => {
    const owner = await createUser();
    const stranger = await createUser();

    const mine = await createTranscript(owner);
    const theirs = await createTranscript(stranger);

    await writeState(owner, SEARCH_DOC_TRANSCRIPT, mine);
    await writeState(stranger, SEARCH_DOC_TRANSCRIPT, theirs);

    const { service } = buildService();

    expect(
      (await service.status(owner)).types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT),
    ).toMatchObject({ total: 1, indexed: 1 });
    expect(
      (await service.status(stranger)).types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT),
    ).toMatchObject({ total: 1, indexed: 1 });
  });

  it('excludes a soft-deleted document, and ignores the index row it still has', async () => {
    const owner = await createUser();

    const alive = await createTranscript(owner);
    const deleted = await createTranscript(owner, { deleted: true });

    await writeState(owner, SEARCH_DOC_TRANSCRIPT, alive);
    // The window between a soft delete and `transcript.purge` calling `forget`.
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, deleted);

    const { service } = buildService();
    const status = await service.status(owner);

    expect(status.types.find((entry) => entry.type === SEARCH_DOC_TRANSCRIPT)).toMatchObject({
      total: 1,
      indexed: 1,
      unindexed: 0,
    });
  });

  // ---------------------------------------------------------------------------
  // Queueing
  // ---------------------------------------------------------------------------

  it('queues exactly the documents that need indexing, through the real enqueue path', async () => {
    const owner = await createUser();
    const stranger = await createUser();

    const never = await createTranscript(owner);
    const alreadyIndexed = await createTranscript(owner);
    const alreadyQueued = await createTranscript(owner);
    const previouslySkipped = await createTranscript(owner);
    const strangers = await createTranscript(stranger);

    await writeState(owner, SEARCH_DOC_TRANSCRIPT, alreadyIndexed);
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, alreadyQueued, {
      status: 'pending',
      indexedAt: null,
    });
    await writeState(owner, SEARCH_DOC_TRANSCRIPT, previouslySkipped, {
      status: 'skipped',
      reason: SEARCH_REASON_KEY_MISSING,
      indexedAt: null,
    });
    await writeState(stranger, SEARCH_DOC_TRANSCRIPT, strangers, {
      status: 'skipped',
      reason: SEARCH_REASON_KEY_MISSING,
      indexedAt: null,
    });

    const { service, jobs } = buildService();
    const result = await service.requestIndex(owner);

    expect(result).toEqual({ queued: 2, remaining: 0, cap: SEARCH_INDEX_REQUEST_CAP });

    const queuedIds = jobs.enqueue.mock.calls.map((call) => call[0].subjectId);
    expect(queuedIds.sort()).toEqual([never, previouslySkipped].sort());
    expect(queuedIds).not.toContain(alreadyIndexed);
    expect(queuedIds).not.toContain(alreadyQueued);
    expect(queuedIds).not.toContain(strangers);
  });

  it('refuses, and queues nothing, when the caller has saved no key', async () => {
    const owner = await createUser();
    await createTranscript(owner);

    const { service, jobs } = buildService({ hasKey: false });

    await expect(service.requestIndex(owner)).rejects.toMatchObject({
      response: { details: { reason: SEARCH_REASON_KEY_MISSING } },
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
