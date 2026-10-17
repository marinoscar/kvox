// =============================================================================
// `search.index` (issue #188, epic #165) — unit tests
// =============================================================================
//
// The `KVOX_AI` and `KVOX_JOBS` ports are stubbed; the database is a SMALL IN-MEMORY SIMULATION rather
// than a bag of `jest.fn()`s returning fixed arrays, and that choice is what
// makes the headline test mean anything. "Only the chunks whose text moved are
// embedded" is a claim about an interaction between three things — the
// `content_hash` comparison in `reconcileChunks`, the explicit
// `searchEmbedding.deleteMany` that follows it, and the
// `embeddings: { none: { model } }` filter that selects what to send. A mock
// that simply answers "here is one pending chunk" would assert the mock, not
// the handler: it would keep passing after somebody deleted the `deleteMany`
// line, which is the exact regression that silently leaves a stale vector
// attached to edited text.
//
// So `fakePrisma` keeps real chunk and embedding rows, `deleteMany` really
// removes them, `$executeRaw` really inserts them, and the pending query is
// really computed from what is there. The application's `search-index.db.spec.ts`
// and the package's `test/search/search.db.spec.ts` then prove the same behaviour
// against real Postgres and the real chunker.
//
// ⚠ THE CHUNKER IS NOT MOCKED ANYWHERE IN THIS FILE. It is pure by
// construction (`search/chunking/chunk.types.ts`'s header), so the tests build
// their expectations by CALLING it — which is also the only way an assertion
// about "four unchanged, one moved" can stay true if the packing rules ever
// change.
// =============================================================================

import { Logger } from '@nestjs/common';

import {
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiCapabilities,
  type KvoxJob,
  type KvoxJobHandler,
} from '../../ports/index.js';
import { chunkNote, fingerprintDocument, type Chunk } from '../chunking/index.js';
import { SEARCH_EMBEDDING_DIMENSIONS } from '../search.options.js';
import {
  SEARCH_INDEX_JOB_TYPE,
  SEARCH_REASON_DIMENSION_MISMATCH,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_INVALID,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
} from './job-types.js';
import { SearchIndexHandler } from './search-index.handler.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '22222222-2222-4222-8222-222222222222';
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = SEARCH_EMBEDDING_DIMENSIONS;

/** Five paragraphs long enough that each becomes its own chunk. */
function fiveParagraphBody(marks: readonly string[]): string {
  return marks
    .map((mark, index) => `Paragraph ${index} ${mark}. ${'lorem ipsum dolor sit amet. '.repeat(55)}`)
    .join('\n\n');
}

const UNCHANGED_MARKS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;
const EDITED_MARKS = ['alpha', 'bravo', 'CHARLIE EDITED', 'delta', 'echo'] as const;

const TITLE = 'Quarterly planning';

interface ChunkRow {
  id: string;
  documentType: string;
  documentId: string;
  ordinal: number;
  text: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
}

interface EmbeddingRow {
  chunkId: string;
  model: string;
}

type StateRow = Record<string, unknown>;

/**
 * Enough of Prisma to run this handler, backed by real arrays.
 *
 * It implements only the operations the handler actually performs, and only
 * the argument shapes it actually passes — a fake that tried to be a general
 * query engine would be a second, worse Prisma. Anything the handler starts
 * doing that this does not understand fails loudly here rather than silently
 * returning `undefined`.
 */
function fakePrisma(initial: { chunks?: ChunkRow[]; embeddings?: EmbeddingRow[]; state?: StateRow | null } = {}) {
  const chunks: ChunkRow[] = [...(initial.chunks ?? [])];
  const embeddings: EmbeddingRow[] = [...(initial.embeddings ?? [])];
  let state: StateRow | null = initial.state ?? null;
  let nextId = 1;

  let noteRow: Record<string, unknown> | null = null;
  let noteReader: ((read: number) => Record<string, unknown> | null) | null = null;
  let noteReads = 0;

  // The three statements the handler sends about a note, answered from `noteRow`
  // (the transcripts and notes tables belong to other slices: the handler reads
  // them through raw SQL only, so the double answers by the statement's text).
  const queryRaw = jest.fn(async (sql: { sql: string; values: unknown[] }) => {
    // The chunks still to embed: those with NO vector for the model (a `NOT EXISTS`
    // over `search_embeddings`, computed here for real from the rows below).
    if (sql.sql.includes('FROM search_chunks c') && sql.sql.includes('NOT EXISTS')) {
      const model = String(sql.values[2]);

      return chunks
        .filter((chunk) => !embeddings.some((row) => row.chunkId === chunk.id && row.model === model))
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((chunk) => ({ id: chunk.id, text: chunk.text }));
    }

    if (!sql.sql.includes('FROM notes')) return [];

    noteReads += 1;
    const row = noteReader ? noteReader(noteReads) : noteRow;

    if (!row) return [];

    if (sql.sql.includes('body AS body')) {
      return [
        {
          owner_id: row.ownerId,
          current_version: row.currentVersion,
          title: row.title,
          body: row.body,
        },
      ];
    }

    if (sql.sql.includes('title AS title')) {
      return [{ current_version: row.currentVersion, title: row.title }];
    }

    return [{ owner_id: row.ownerId }];
  });

  let self: unknown;

  const prisma = {
    $queryRaw: queryRaw,

    searchIndexState: {
      findUnique: jest.fn(async () => state),
      update: jest.fn(async ({ data }: { data: StateRow }) => {
        state = { ...(state ?? {}), ...data };

        return state;
      }),
      upsert: jest.fn(async ({ create, update }: { create: StateRow; update: StateRow }) => {
        state = state ? { ...state, ...update } : { ...create };

        return state;
      }),
    },

    searchChunk: {
      // The reconcile read: every chunk the document has now, in ordinal order.
      findMany: jest.fn(async () =>
        chunks
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((chunk) => ({ ...chunk })),
      ),
      create: jest.fn(async ({ data }: { data: Omit<ChunkRow, 'id'> }) => {
        const row = { ...data, id: `chunk-${nextId++}` };
        chunks.push(row);

        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<ChunkRow> }) => {
        const row = chunks.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);

        return row;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { ordinal?: { gte: number } } }) => {
        const gte = where.ordinal?.gte ?? Number.POSITIVE_INFINITY;
        const doomed = chunks.filter((chunk) => chunk.ordinal >= gte);

        for (const chunk of doomed) {
          chunks.splice(chunks.indexOf(chunk), 1);
          // The real cascade from `SearchEmbedding.chunkId`.
          for (let i = embeddings.length - 1; i >= 0; i -= 1) {
            if (embeddings[i]!.chunkId === chunk.id) embeddings.splice(i, 1);
          }
        }

        return { count: doomed.length };
      }),
    },

    searchEmbedding: {
      deleteMany: jest.fn(async ({ where }: { where: { chunkId: string } }) => {
        let count = 0;

        for (let i = embeddings.length - 1; i >= 0; i -= 1) {
          if (embeddings[i]!.chunkId === where.chunkId) {
            embeddings.splice(i, 1);
            count += 1;
          }
        }

        return { count };
      }),
    },

    // The tagged-template raw insert. `values[1]` is the chunk id and
    // `values[2]` the model — see `writeVectors`.
    $executeRaw: jest.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      const chunkId = String(values[1]);
      const model = String(values[2]);

      if (!embeddings.some((row) => row.chunkId === chunkId && row.model === model)) {
        embeddings.push({ chunkId, model });
      }

      return Promise.resolve(1);
    }),

    // The interactive form: the callback gets a client with the same raw methods.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(self)),
  };

  self = prisma;

  return {
    prisma,
    chunks,
    embeddings,
    get state() {
      return state;
    },
    setNote(row: Record<string, unknown> | null) {
      noteRow = row;
    },
    /** Answers the n-th note statement (1-based) with the row it returns, to simulate an edit mid-run. */
    setNoteReader(reader: (read: number) => Record<string, unknown> | null) {
      noteReader = reader;
    },
  };
}

function vector(): number[] {
  return new Array(DIMENSIONS).fill(0.01);
}

/** What the scripted AI port answers for `capabilities`. */
type Scenario = 'ready' | 'ai_key_missing' | 'ai_not_configured' | 'graph_disabled' | 'no_embeddings' | 'wide_model';

function capabilitiesFor(scenario: Scenario): KvoxAiCapabilities {
  const base: KvoxAiCapabilities = {
    available: true,
    structuredOutput: true,
    toolCalling: true,
    embeddings: { model: MODEL, dimensions: DIMENSIONS },
    graphEnabled: true,
  };

  switch (scenario) {
    case 'ai_key_missing':
      return { ...base, available: false, reason: 'ai_key_missing' };
    case 'ai_not_configured':
      return { ...base, available: false, reason: 'ai_not_configured' };
    case 'graph_disabled':
      return { ...base, available: false, reason: 'graph_disabled' };
    case 'no_embeddings':
      return { ...base, embeddings: null };
    case 'wide_model':
      return { ...base, embeddings: { model: 'embed-3-large', dimensions: 3072 } };
    default:
      return base;
  }
}

interface HarnessOptions {
  chunks?: ChunkRow[];
  embeddings?: EmbeddingRow[];
  state?: StateRow | null;
  body?: string;
  title?: string;
  currentVersion?: number;
  /** What the AI port reports; omit for a ready owner. */
  scenario?: Scenario;
  batchSize?: number;
}

function harness(options: HarnessOptions = {}) {
  const db = fakePrisma({
    chunks: options.chunks,
    embeddings: options.embeddings,
    state: options.state ?? null,
  });

  db.setNote({
    ownerId: OWNER_ID,
    currentVersion: options.currentVersion ?? 1,
    title: options.title ?? TITLE,
    body: options.body ?? fiveParagraphBody(UNCHANGED_MARKS),
  });

  const embed = jest.fn(async (_ctx: unknown, request: { inputs: string[] }) => ({
    model: MODEL,
    dimensions: DIMENSIONS,
    vectors: request.inputs.map(() => vector()),
  }));

  const capabilities = jest.fn(async () => capabilitiesFor(options.scenario ?? 'ready'));

  const ai = { capabilities, embed };

  const jobs = { registerHandler: jest.fn(), enqueue: jest.fn(), isRegistered: jest.fn() };
  const index = { enqueue: jest.fn(async () => undefined), forget: jest.fn(async () => undefined) };

  const handler = new SearchIndexHandler(
    jobs as never,
    db.prisma as never,
    ai as never,
    index as never,
    { batchSize: options.batchSize ?? 128 },
  );

  return { handler, db, embed, capabilities, jobs, index };
}

function job(payload: unknown = { documentType: 'note', documentId: NOTE_ID }): KvoxJob {
  return {
    id: 'job-1',
    type: 'search.index',
    subjectType: null,
    subjectId: null,
    payload,
    attempts: 1,
    orgId: null,
  };
}

/** The chunk rows a previous successful index of `body` would have left. */
function storedChunksFor(body: string, title = TITLE): { chunks: ChunkRow[]; embeddings: EmbeddingRow[]; produced: Chunk[] } {
  const produced = chunkNote(title, body);

  const chunks = produced.map((chunk, position) => ({
    id: `chunk-${position}`,
    documentType: 'note',
    documentId: NOTE_ID,
    ordinal: chunk.ordinal,
    text: chunk.text,
    contentHash: chunk.contentHash,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
  }));

  return {
    chunks,
    embeddings: chunks.map((chunk) => ({ chunkId: chunk.id, model: MODEL })),
    produced,
  };
}

describe('SearchIndexHandler', () => {
  it('registers itself through the job port and declares the type, the profile, and NO node members', () => {
    const { handler, jobs } = harness();

    handler.onModuleInit();

    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('search.index');

    // ⚠ The inverse of `note.generate`'s 1 — see the handler's header. An
    // embedding is deterministic, nobody is watching, and content addressing
    // makes a retry re-embed only what the failed attempt did not commit.
    expect(handler.profile).toEqual({ maxRuntimeMs: 15 * 60 * 1000, maxAttempts: 3 });

    // ⚠ SERVER-ONLY, PERMANENTLY. Neither member, never exactly one: a
    // deployment cannot offer this type to a worker node, because there is no
    // job-scoped credential a job secret broker could broker for an
    // account-level OpenAI key. `usesAi` is what lets the web edition's job
    // adapter REFUSE to register it if it ever grows the pair.
    // Read through the interface: these members are ABSENT from the class, so
    // the assertion has to be made against the contract that declares them
    // optional.
    const asHandler: KvoxJobHandler = handler;
    expect(asHandler.usesAi).toBe(true);
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it("embeds as the OWNER, under the search.embed feature, with no key in sight", async () => {
    const { handler, embed, capabilities } = harness();

    await handler.process(job());

    // The owner's capabilities are asked first, for the registered feature.
    expect(capabilities).toHaveBeenCalledWith({
      userId: OWNER_ID,
      orgId: null,
      feature: 'search.embed',
    });

    const [ctx, request] = embed.mock.calls[0]!;

    expect(ctx).toEqual({ userId: OWNER_ID, orgId: null, feature: 'search.embed' });
    expect(Object.keys(request)).toEqual(['inputs']);
  });

  // ---------------------------------------------------------------------------
  // The skips — permanent outcomes, recorded, RETURNING NORMALLY
  // ---------------------------------------------------------------------------

  it('records `ai_key_missing` and does NOT throw when the owner has no key', async () => {
    const { handler, db, embed } = harness({ scenario: 'ai_key_missing' });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_KEY_MISSING });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `ai_not_configured` when the deployment is not set up', async () => {
    const { handler, db, embed } = harness({ scenario: 'ai_not_configured' });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_NOT_CONFIGURED });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `ai_not_configured` for a reason that is neither the key nor the model', async () => {
    const { handler, db } = harness({ scenario: 'graph_disabled' });

    await handler.process(job());

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_NOT_CONFIGURED });
  });

  it('records `embedding_unsupported` when the host has no embeddings model', async () => {
    // The host simply has no semantic search, which is a fact worth recording per
    // document rather than a crash inside a queue job.
    const { handler, db, embed } = harness({ scenario: 'no_embeddings' });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({
      status: 'skipped',
      reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED,
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `embedding_unsupported` and embeds NOTHING for a model whose vectors are not 1536 wide', async () => {
    // ⚠ Never a vector of another length: the check is BEFORE the first embed
    // call, so the owner is not even billed for a batch that cannot be stored.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const { handler, db, embed } = harness({ scenario: 'wide_model' });

      await expect(handler.process(job())).resolves.toBeUndefined();
      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(db.state).toMatchObject({
        status: 'skipped',
        reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED,
      });
      expect(embed).not.toHaveBeenCalled();

      // Logged ONCE, naming the model and the width.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('embed-3-large');
      expect(String(warn.mock.calls[0]![0])).toContain('3072');
    } finally {
      warn.mockRestore();
    }
  });

  it('records `ai_key_invalid` and returns when the provider refuses the key', async () => {
    const { handler, db, embed } = harness();

    embed.mockRejectedValueOnce(new KvoxAiError('auth', 'The provider rejected the key.'));

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_KEY_INVALID });
  });

  // ---------------------------------------------------------------------------
  // The fingerprint short-circuit
  // ---------------------------------------------------------------------------

  it('embeds NOTHING when the stored fingerprint still matches', async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);
    const stored = storedChunksFor(body);

    const { handler, db, embed } = harness({
      body,
      chunks: stored.chunks,
      embeddings: stored.embeddings,
      state: {
        status: 'indexed',
        contentFingerprint: fingerprintDocument(stored.produced),
        model: MODEL,
      },
    });

    await handler.process(job());

    // THE POINT: not one request, not one chunk re-read, not one row rewritten
    // beyond the "still current at" timestamp.
    expect(embed).not.toHaveBeenCalled();
    expect(db.prisma.searchIndexState.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ indexedAt: expect.any(Date) }) }),
    );
  });

  it('re-embeds everything when the model changed, even with an identical fingerprint', async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);
    const stored = storedChunksFor(body);

    const { handler, embed } = harness({
      body,
      chunks: stored.chunks,
      // Vectors exist, but under a model nobody is using any more. Two models'
      // vectors are not comparable at any width.
      embeddings: stored.chunks.map((chunk) => ({ chunkId: chunk.id, model: 'older-model' })),
      state: {
        status: 'indexed',
        contentFingerprint: fingerprintDocument(stored.produced),
        model: 'older-model',
      },
    });

    await handler.process(job());

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![1].inputs).toHaveLength(stored.produced.length);
  });

  // ---------------------------------------------------------------------------
  // THE HEADLINE: content addressing
  // ---------------------------------------------------------------------------

  it('embeds ONLY the chunks whose text actually moved', async () => {
    const before = fiveParagraphBody(UNCHANGED_MARKS);
    const after = fiveParagraphBody(EDITED_MARKS);

    const stored = storedChunksFor(before);
    const expected = chunkNote(TITLE, after);

    // Five chunks, one of which is different. If the chunker's packing ever
    // changes these numbers, this assertion says so rather than the test
    // quietly proving something weaker.
    expect(stored.produced).toHaveLength(5);
    expect(expected).toHaveLength(5);

    const moved = expected.filter(
      (chunk, position) => chunk.contentHash !== stored.produced[position]!.contentHash,
    );

    expect(moved).toHaveLength(1);

    const { handler, db, embed, index } = harness({
      body: after,
      chunks: stored.chunks,
      embeddings: stored.embeddings,
      state: {
        status: 'indexed',
        contentFingerprint: 'a-fingerprint-from-before-the-edit',
        model: MODEL,
      },
    });

    await handler.process(job());

    // ONE request, carrying ONE input: the edited chunk. The other four kept
    // their vectors and cost the owner nothing.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![1].inputs).toHaveLength(1);
    expect(embed.mock.calls[0]![1].inputs[0]).toBe(moved[0]!.text);

    // The stale vector was dropped EXPLICITLY — nothing cascaded, because
    // nothing was deleted. This is the assertion that fails if somebody
    // "simplifies" `reconcileChunks`.
    expect(db.prisma.searchEmbedding.deleteMany).toHaveBeenCalledTimes(1);

    expect(db.state).toMatchObject({ status: 'indexed', chunkCount: 5, model: MODEL });

    // Nothing moved underneath the run, so no follow-up was queued.
    expect(index.enqueue).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run over unchanged content embeds nothing new', async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);

    const { handler, db, embed } = harness({ body });

    await handler.process(job());

    const firstPass = embed.mock.calls.length;
    expect(firstPass).toBe(1);
    expect(db.embeddings).toHaveLength(5);

    embed.mockClear();

    // The queue is at-least-once: the same job, delivered again.
    await handler.process(job());

    expect(embed).not.toHaveBeenCalled();
    expect(db.embeddings).toHaveLength(5);
    expect(db.chunks).toHaveLength(5);
  });

  // ---------------------------------------------------------------------------
  // Batching
  // ---------------------------------------------------------------------------

  it("never sends more inputs than the module's configured batch size", async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);

    const { handler, embed } = harness({ body, batchSize: 2 });

    await handler.process(job());

    // Five chunks at two per request: 2 + 2 + 1.
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls.map((call) => call[1].inputs.length)).toEqual([2, 2, 1]);
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  it('defers a 429 through a throttle key naming THIS OWNER, not a shared one', async () => {
    const { handler, db, embed } = harness();

    embed.mockRejectedValueOnce(new KvoxAiError('rate_limit', 'Slow down.', 5000));

    const failure = await handler.process(job()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KvoxRateLimitError);

    // ⚠ PER USER. A shared `'ai-provider'` key is what transcription correctly
    // uses (one deployment-owned vendor account, one rate limit) and is exactly
    // wrong here: every user brings their own account, so A's 429 is evidence
    // about A alone. The host's job adapter registers the bucket the error names.
    expect((failure as KvoxRateLimitError).throttleKey).toBe(`ai-provider:${OWNER_ID}`);
    expect((failure as KvoxRateLimitError).retryAfterMs).toBe(5000);

    // Nothing was written: the document is still mid-index, and saying
    // otherwise would be a lie with a timestamp on it.
    expect(db.state).toMatchObject({ status: 'indexing' });
  });

  it('rethrows a KvoxRateLimitError the port already raised, unchanged', async () => {
    const { handler, embed } = harness();
    const limited = new KvoxRateLimitError('ai-provider:somebody-else', 100);

    embed.mockRejectedValueOnce(limited);

    await expect(handler.process(job())).rejects.toBe(limited);
  });

  // ---------------------------------------------------------------------------
  // The one failure that is a bug
  // ---------------------------------------------------------------------------

  it('records `dimension_mismatch` as FAILED and throws', async () => {
    const { handler, db, embed } = harness();

    // A full, correctly-counted batch — every vector the WRONG WIDTH. The
    // count check is not what should catch this.
    embed.mockImplementationOnce(async (_ctx: unknown, request: { inputs: string[] }) => ({
      model: MODEL,
      dimensions: 768,
      vectors: request.inputs.map(() => new Array(768).fill(0.1) as number[]),
    }));

    await expect(handler.process(job())).rejects.toThrow(/768-dimension vector/);

    expect(db.state).toMatchObject({
      status: 'failed',
      reason: SEARCH_REASON_DIMENSION_MISMATCH,
    });
  });

  // ---------------------------------------------------------------------------
  // Payload and lifecycle edges
  // ---------------------------------------------------------------------------

  it('does nothing for an unreadable payload', async () => {
    const { handler, db, embed } = harness();

    await expect(handler.process(job({ documentType: 'invoice', documentId: NOTE_ID }))).resolves.toBeUndefined();

    expect(embed).not.toHaveBeenCalled();
    expect(db.state).toBeNull();
  });

  it('forgets a document that has been deleted since the job was queued', async () => {
    const { handler, db, index, embed } = harness();

    db.setNote(null);

    await handler.process(job());

    expect(index.forget).toHaveBeenCalledWith('note', NOTE_ID);
    expect(embed).not.toHaveBeenCalled();
  });

  it('queues a follow-up, past its own dedup key, when the note moved mid-run', async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);
    const { handler, db, index } = harness({ body, currentVersion: 4 });

    // The note is edited while this job is embedding: `readRevision` at the end
    // (the third statement about the note) sees a different version than
    // `loadDocument` did at the start.
    db.setNoteReader((read) => ({
      ownerId: OWNER_ID,
      currentVersion: read >= 3 ? 5 : 4,
      title: TITLE,
      body,
    }));

    await handler.process(job());

    // ⚠ `skipDedup: true` IS THE WHOLE POINT. Without it the enqueue matches
    // THIS STILL-RUNNING JOB's dedup key and silently returns it, and the edit
    // is indexed never.
    expect(index.enqueue).toHaveBeenCalledWith('note', NOTE_ID, 'rerun', { skipDedup: true });
  });
});
