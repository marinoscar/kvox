// =============================================================================
// `search.index` (issue #188, epic #165) — unit tests
// =============================================================================
//
// The provider is mocked; the database is a SMALL IN-MEMORY SIMULATION rather
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
// really computed from what is there. `test/integration/search-index.db.spec.ts`
// then proves the same behaviour against real Postgres and the real chunker.
//
// ⚠ THE CHUNKER IS NOT MOCKED ANYWHERE IN THIS FILE. It is pure by
// construction (`search/chunking/chunk.types.ts`'s header), so the tests build
// their expectations by CALLING it — which is also the only way an assertion
// about "four unchanged, one moved" can stay true if the packing rules ever
// change.
// =============================================================================

import { Job } from '@prisma/client';

import { AiAuthError, RateLimitError } from '../../ai/ai-errors';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { chunkNote, fingerprintDocument, type Chunk } from '../chunking';
import {
  SEARCH_INDEX_JOB_TYPE,
  SEARCH_REASON_DIMENSION_MISMATCH,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_INVALID,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
} from './job-types';
import { SearchIndexHandler } from './search-index.handler';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '22222222-2222-4222-8222-222222222222';
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

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

  const note = {
    findFirst: jest.fn(async () => noteRow),
  };

  let noteRow: Record<string, unknown> | null = null;

  const prisma = {
    note,
    transcript: { findFirst: jest.fn(async () => null) },

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
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const pendingOnly = 'embeddings' in args.where;

        return chunks
          .filter((chunk) => {
            if (!pendingOnly) return true;

            // The `embeddings: { none: { model } }` filter, computed for real.
            return !embeddings.some((row) => row.chunkId === chunk.id && row.model === MODEL);
          })
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((chunk) => ({ ...chunk }));
      }),
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

    $transaction: jest.fn(async (statements: Promise<unknown>[]) => Promise.all(statements)),
  };

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
  };
}

function vector(): number[] {
  return new Array(DIMENSIONS).fill(0.01);
}

interface HarnessOptions {
  chunks?: ChunkRow[];
  embeddings?: EmbeddingRow[];
  state?: StateRow | null;
  body?: string;
  title?: string;
  currentVersion?: number;
  apiKey?: string | null;
  policy?: Record<string, unknown>;
  /** Simulates a chat-only provider: no `embedding` capability, no `embed`. */
  noEmbedding?: boolean;
  maxBatchSize?: number;
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
    vectors: request.inputs.map(() => vector()),
    promptTokens: 10,
    model: MODEL,
  }));

  const provider = {
    id: 'openai',
    label: 'OpenAI',
    settingsSchema: { safeParse: () => ({ success: true as const, data: {} }) },
    embedding: options.noEmbedding
      ? undefined
      : {
          model: MODEL,
          dimensions: DIMENSIONS,
          maxInputTokens: 8191,
          maxBatchSize: options.maxBatchSize ?? 128,
        },
    embed: options.noEmbedding ? undefined : embed,
  };

  const providers = {
    get: jest.fn((id: string) => (id === 'openai' ? provider : undefined)),
  };

  const settings = {
    get: jest.fn(async () => options.policy ?? { enabled: true, provider: 'openai', providers: { openai: {} } }),
  };

  const credentials = {
    getSecret: jest.fn(async () => (options.apiKey === undefined ? 'sk-test' : options.apiKey)),
    markUsed: jest.fn(async () => undefined),
  };

  const throttle = { registerProviderKey: jest.fn() };
  const index = { enqueue: jest.fn(async () => undefined), forget: jest.fn(async () => undefined) };
  const registry = new JobHandlerRegistry();

  const handler = new SearchIndexHandler(
    registry,
    db.prisma as never,
    providers as never,
    settings as never,
    credentials as never,
    throttle as never,
    index as never,
  );

  return { handler, db, provider, embed, providers, settings, credentials, throttle, index, registry };
}

function job(payload: unknown = { documentType: 'note', documentId: NOTE_ID }): Job {
  return { id: 'job-1', payload } as unknown as Job;
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
  it('registers itself and declares the type, the profile, and NO node members', () => {
    const { handler, registry } = harness();

    handler.onModuleInit();

    expect(registry.get(SEARCH_INDEX_JOB_TYPE)).toBe(handler);
    expect(handler.type).toBe('search.index');

    // ⚠ The inverse of `note.generate`'s 1 — see the handler's header. An
    // embedding is deterministic, nobody is watching, and content addressing
    // makes a retry re-embed only what the failed attempt did not commit.
    expect(handler.profile).toEqual({ maxRuntimeMs: 15 * 60 * 1000, maxAttempts: 3 });

    // ⚠ SERVER-ONLY, PERMANENTLY. Neither member, never exactly one: a
    // deployment cannot offer this type to a worker node, because there is no
    // job-scoped credential a `nodeSecretBroker` could broker for an
    // account-level OpenAI key.
    // Read through the interface: these members are ABSENT from the class, so
    // the assertion has to be made against the contract that declares them
    // optional — which is also the exact shape `serverOnlyTypes()` derives from.
    const asHandler: JobHandler = handler;

    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(asHandler.nodeSecretBroker).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // The skips — permanent outcomes, recorded, RETURNING NORMALLY
  // ---------------------------------------------------------------------------

  it('records `ai_key_missing` and does NOT throw when the owner has no key', async () => {
    const { handler, db, embed } = harness({ apiKey: null });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_KEY_MISSING });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `ai_not_configured` when no provider is chosen', async () => {
    const { handler, db, embed } = harness({
      policy: { enabled: true, provider: null, providers: {} },
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_NOT_CONFIGURED });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `ai_not_configured` when the master switch is off', async () => {
    const { handler, db } = harness({
      policy: { enabled: false, provider: 'openai', providers: { openai: {} } },
    });

    await handler.process(job());

    expect(db.state).toMatchObject({ status: 'skipped', reason: SEARCH_REASON_NOT_CONFIGURED });
  });

  it('records `embedding_unsupported` for a chat-only provider', async () => {
    // A provider with no `embedding` capability is a perfectly REGISTRABLE chat
    // provider — an OpenAI-compatible gateway proxying only
    // `/chat/completions` is the worked example in the interface's own header.
    // Its deployment simply has no semantic search, which is a fact worth
    // recording per document rather than a crash inside a queue job.
    const { handler, db, embed } = harness({ noEmbedding: true });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.state).toMatchObject({
      status: 'skipped',
      reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED,
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('records `ai_key_invalid` and returns when the provider refuses the key', async () => {
    const { handler, db, embed } = harness();

    embed.mockRejectedValueOnce(new AiAuthError('The provider rejected the key.', 'openai'));

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

  it("never sends more inputs than the provider's declared maxBatchSize", async () => {
    const body = fiveParagraphBody(UNCHANGED_MARKS);

    const { handler, embed } = harness({ body, maxBatchSize: 2 });

    await handler.process(job());

    // Five chunks at two per request: 2 + 2 + 1.
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls.map((call) => call[1].inputs.length)).toEqual([2, 2, 1]);
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  it('defers a 429 through a throttle key naming THIS OWNER, not a shared one', async () => {
    const { handler, db, embed, throttle } = harness();

    embed.mockRejectedValueOnce(new RateLimitError('Slow down.', 5000));

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

    expect(throttle.registerProviderKey).toHaveBeenCalledWith(
      SEARCH_INDEX_JOB_TYPE,
      expect.stringContaining(OWNER_ID),
    );

    // ⚠ PER USER. A shared `'ai-provider'` key is what transcription correctly
    // uses (one deployment-owned vendor account, one rate limit) and is exactly
    // wrong here: every user brings their own account, so A's 429 is evidence
    // about A alone.
    expect(throttle.registerProviderKey).toHaveBeenCalledWith(
      SEARCH_INDEX_JOB_TYPE,
      `ai-provider:${OWNER_ID}`,
    );

    // Nothing was written: the document is still mid-index, and saying
    // otherwise would be a lie with a timestamp on it.
    expect(db.state).toMatchObject({ status: 'indexing' });
  });

  // ---------------------------------------------------------------------------
  // The one failure that is a bug
  // ---------------------------------------------------------------------------

  it('records `dimension_mismatch` as FAILED and throws', async () => {
    const { handler, db, embed } = harness();

    // A full, correctly-counted batch — every vector the WRONG WIDTH. The
    // count check is not what should catch this.
    embed.mockImplementationOnce(async (_ctx: unknown, request: { inputs: string[] }) => ({
      vectors: request.inputs.map(() => new Array(768).fill(0.1) as number[]),
      promptTokens: 1,
      model: MODEL,
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
    // sees a different version than `loadDocument` did at the start.
    let reads = 0;
    (db.prisma.note.findFirst as jest.Mock).mockImplementation(async () => {
      reads += 1;

      return {
        ownerId: OWNER_ID,
        currentVersion: reads >= 3 ? 5 : 4,
        title: TITLE,
        body,
      };
    });

    await handler.process(job());

    // ⚠ `skipDedup: true` IS THE WHOLE POINT. Without it the enqueue matches
    // THIS STILL-RUNNING JOB's dedup key and silently returns it, and the edit
    // is indexed never.
    expect(index.enqueue).toHaveBeenCalledWith('note', NOTE_ID, 'rerun', { skipDedup: true });
  });
});
