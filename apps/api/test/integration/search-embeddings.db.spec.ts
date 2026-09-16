// =============================================================================
// Real-Postgres test: pgvector storage for semantic search (issue #181,
// epic #165)
// =============================================================================
//
// A `vector(1536)` column's type modifier, an HNSW index's access method and
// operator class, and a hand-written foreign key's `ON DELETE` behaviour only
// exist once `20260915130000_add_search_embeddings/migration.sql` has
// actually run against a real database — a unit test importing
// `schema.prisma` can read the `Unsupported("vector(1536)")` DECLARATION,
// never prove the DATABASE enforces the width, builds the index with the
// right opclass, or cascades correctly. So, like `search-vectors.db.spec.ts`
// beside it (epic #164's layer 1), this is a `*.db.spec.ts` file,
// deliberately excluded from `npm test`/`test:unit`/`test:cov`/`test:ci`
// (see apps/api/package.json's testPathIgnorePatterns). It runs only via
// `npm run test:db`, against a real Postgres with pgvector 0.6.0+ installed
// and this migration applied. See `../jobs/db-test-support.ts` for the
// shared reachability probe and client factory this file reuses rather than
// re-implementing.
//
// What this file asserts, and why each one is the thing the migration's own
// header argues for:
//
//   1. SHAPE: the `vector` extension is installed; all three tables exist
//      with their expected columns; `search_embeddings.embedding` reports
//      EXACTLY `vector(1536)` via `pg_attribute`'s type modifier — the width
//      CONTRACT the migration header's point 1 describes, asserted
//      literally rather than merely "some vector type".
//   2. The HNSW index exists, with `amname = 'hnsw'` and opclass
//      `vector_cosine_ops` — points 3 and 4 of the header, the index type
//      that tolerates being built empty and the opclass that must match the
//      `<=>` operator a ranking query uses or the index is silently unused.
//   3. BEHAVIOUR: a nearest-neighbour `ORDER BY embedding <=> $query` query
//      ranks a nearly-parallel vector ahead of a nearly-orthogonal one —
//      proof the index (or, absent one being force-used by the planner on a
//      two-row table, the operator itself) computes what the header claims
//      it does, not just that the column exists.
//   4. THE WIDTH CONTRACT IS ENFORCED BY THE DATABASE: inserting a
//      768-dimension vector is rejected. This is the point of storing the
//      width as a real Postgres type rather than trusting application code
//      alone — the boot-time `AiProviderRegistry` check the header describes
//      is belt-and-braces, not the only guard.
//   5. CASCADE: deleting a `search_chunks` row deletes its
//      `search_embeddings` row (the one REAL foreign key this migration
//      adds — see header point 2).
//   6. CASCADE: deleting a `users` row deletes its `search_index_state`
//      rows.
//   7. `UNIQUE (chunk_id, model)` rejects a second vector for the same
//      chunk+model and accepts one for a different model — the constraint
//      the header's point 6 says is what makes a repeat-embed check cheap.
//   8. `UNIQUE (document_type, document_id, ordinal)` on `search_chunks` and
//      `UNIQUE (document_type, document_id)` on `search_index_state` are
//      both enforced.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

const HNSW_INDEX_NAME = 'search_embeddings_embedding_hnsw_idx';

const { describeWithDb } = resolveDbSuite('search-embeddings.db.spec');

/**
 * Builds a pgvector literal string (e.g. `[0,1,0,...,0]`) of `dims`
 * dimensions, zero everywhere except the given sparse `overrides`.
 *
 * Deliberately returns a plain string handed to Postgres as a normal bound
 * (text) parameter and cast with `::vector` at the call site — building the
 * cast INTO this helper would hide, from each call site, the exact thing
 * `SearchEmbedding`'s model comment in schema.prisma says every write to
 * this table must do by hand.
 */
function vectorLiteral(overrides: Record<number, number>, dims = 1536): string {
  const values = new Array(dims).fill(0);
  for (const [index, value] of Object.entries(overrides)) {
    values[Number(index)] = value;
  }
  return `[${values.join(',')}]`;
}

describeWithDb('Semantic search: pgvector storage (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'search-embeddings-test';
  let createdDocumentIds: string[] = [];
  let createdUserIds: string[] = [];

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    createdDocumentIds = [];
    createdUserIds = [];
  });

  afterEach(async () => {
    // search_chunks carries no FK to anything, so it is cleaned up
    // explicitly by the document ids each test registers.
    // search_embeddings cascades from search_chunks; search_index_state
    // cascades from users — cleaning up the parents below is enough for both.
    if (createdDocumentIds.length > 0) {
      await prisma.$executeRaw`
        DELETE FROM search_chunks WHERE document_id = ANY(${createdDocumentIds}::uuid[])
      `;
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    const user = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  /** Inserts a search_chunks row via raw SQL and registers its document id for cleanup. */
  async function insertChunk(params: {
    documentType?: string;
    documentId?: string;
    ordinal: number;
    text?: string;
    contentHash?: string;
    charStart?: number;
    charEnd?: number;
  }): Promise<{ id: string; documentId: string }> {
    const id = randomUUID();
    const documentId = params.documentId ?? randomUUID();
    const documentType = params.documentType ?? 'transcript';
    const text = params.text ?? 'a chunk of test content';
    const contentHash = params.contentHash ?? `hash-${randomUUID()}`;
    const charStart = params.charStart ?? 0;
    const charEnd = params.charEnd ?? text.length;

    await prisma.$executeRaw`
      INSERT INTO search_chunks
        (id, document_type, document_id, ordinal, text, content_hash, char_start, char_end, created_at)
      VALUES
        (${id}::uuid, ${documentType}, ${documentId}::uuid, ${params.ordinal}, ${text},
         ${contentHash}, ${charStart}, ${charEnd}, CURRENT_TIMESTAMP)
    `;
    if (!createdDocumentIds.includes(documentId)) {
      createdDocumentIds.push(documentId);
    }
    return { id, documentId };
  }

  /** Inserts a search_embeddings row via raw SQL — the only way to write this table (see below). */
  async function insertEmbedding(params: {
    chunkId: string;
    model?: string;
    dimensions?: number;
    vector: string;
  }): Promise<string> {
    const id = randomUUID();
    const model = params.model ?? 'test-embedding-model';
    const dimensions = params.dimensions ?? 1536;
    await prisma.$executeRaw`
      INSERT INTO search_embeddings (id, chunk_id, model, dimensions, embedding, created_at)
      VALUES (${id}::uuid, ${params.chunkId}::uuid, ${model}, ${dimensions}, ${params.vector}::vector, CURRENT_TIMESTAMP)
    `;
    return id;
  }

  // ===========================================================================
  // 1. Shape
  // ===========================================================================

  describe('shape', () => {
    it('the vector extension is installed', async () => {
      const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `;
      expect(rows).toHaveLength(1);
    });

    it('all three tables exist with their expected columns', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string; data_type: string }>
      >`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_name IN ('search_chunks', 'search_embeddings', 'search_index_state')
        ORDER BY table_name, column_name
      `;

      const byTable = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
        byTable.get(row.table_name)!.add(row.column_name);
      }

      expect([...(byTable.get('search_chunks') ?? [])].sort()).toEqual(
        [
          'id',
          'document_type',
          'document_id',
          'ordinal',
          'text',
          'content_hash',
          'char_start',
          'char_end',
          'created_at',
        ].sort(),
      );

      expect([...(byTable.get('search_embeddings') ?? [])].sort()).toEqual(
        ['id', 'chunk_id', 'model', 'dimensions', 'embedding', 'created_at'].sort(),
      );

      expect([...(byTable.get('search_index_state') ?? [])].sort()).toEqual(
        [
          'id',
          'document_type',
          'document_id',
          'owner_id',
          'status',
          'reason',
          'chunk_count',
          'model',
          'content_fingerprint',
          'last_error',
          'indexed_at',
          'created_at',
          'updated_at',
        ].sort(),
      );

      // embedding reports USER-DEFINED / vector at the information_schema
      // level; the literal typmod is asserted separately below, which is the
      // actual contract.
      const embeddingRow = rows.find(
        (r) => r.table_name === 'search_embeddings' && r.column_name === 'embedding',
      );
      expect(embeddingRow?.data_type).toBe('USER-DEFINED');

      const [udtRow] = await prisma.$queryRaw<Array<{ udt_name: string }>>`
        SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'search_embeddings' AND column_name = 'embedding'
      `;
      expect(udtRow.udt_name).toBe('vector');
    });

    it('search_embeddings.embedding is EXACTLY vector(1536) — the width contract, asserted literally', async () => {
      const [row] = await prisma.$queryRaw<Array<{ formatted: string }>>`
        SELECT format_type(atttypid, atttypmod) AS formatted
        FROM pg_attribute
        WHERE attrelid = 'search_embeddings'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped
      `;
      expect(row.formatted).toBe('vector(1536)');
    });
  });

  // ===========================================================================
  // 2. The HNSW index
  // ===========================================================================

  describe('the HNSW index', () => {
    it('exists with amname=hnsw and opclass vector_cosine_ops', async () => {
      const rows = await prisma.$queryRaw<Array<{ amname: string; opcname: string }>>`
        SELECT am.amname AS amname, opc.opcname AS opcname
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        JOIN pg_opclass opc ON opc.oid = x.indclass[0]
        WHERE i.relname = ${HNSW_INDEX_NAME}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].amname).toBe('hnsw');
      expect(rows[0].opcname).toBe('vector_cosine_ops');
    });
  });

  // ===========================================================================
  // 3. Behaviour: nearest-neighbour ordering
  // ===========================================================================

  describe('nearest-neighbour ranking', () => {
    it('ranks a nearly-parallel vector ahead of a nearly-orthogonal one under <=>', async () => {
      const documentId = randomUUID();
      const nearChunk = await insertChunk({ documentId, ordinal: 0, text: 'near chunk' });
      const farChunk = await insertChunk({ documentId, ordinal: 1, text: 'far chunk' });

      // Query vector points almost entirely along dimension 0.
      const queryVector = vectorLiteral({ 0: 1 });
      // "Near": nearly parallel to the query (small angle — mostly dim 0,
      // a little dim 1).
      const nearVector = vectorLiteral({ 0: 0.99, 1: 0.14 });
      // "Far": orthogonal to the query (entirely dim 1).
      const farVector = vectorLiteral({ 1: 1 });

      const nearEmbeddingId = await insertEmbedding({
        chunkId: nearChunk.id,
        vector: nearVector,
      });
      const farEmbeddingId = await insertEmbedding({ chunkId: farChunk.id, vector: farVector });

      const rows = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
        SELECT id, (embedding <=> ${queryVector}::vector) AS distance
        FROM search_embeddings
        WHERE id = ANY(${[nearEmbeddingId, farEmbeddingId]}::uuid[])
        ORDER BY distance ASC
      `;

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(nearEmbeddingId);
      expect(rows[1].id).toBe(farEmbeddingId);
      expect(Number(rows[0].distance)).toBeLessThan(Number(rows[1].distance));
    });
  });

  // ===========================================================================
  // 4. The width contract is enforced by the database
  // ===========================================================================

  describe('the width contract', () => {
    it('rejects an insert of a 768-dimension vector', async () => {
      const chunk = await insertChunk({ ordinal: 0 });
      const wrongWidthVector = vectorLiteral({ 0: 1 }, 768);

      await expect(
        insertEmbedding({ chunkId: chunk.id, dimensions: 768, vector: wrongWidthVector }),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 5. Cascade: search_chunks -> search_embeddings
  // ===========================================================================

  describe('cascade: search_chunks -> search_embeddings', () => {
    it('deleting a chunk deletes its embedding', async () => {
      const chunk = await insertChunk({ ordinal: 0 });
      const embeddingId = await insertEmbedding({ chunkId: chunk.id, vector: vectorLiteral({ 0: 1 }) });

      const before = await prisma.searchEmbedding.findUnique({ where: { id: embeddingId } });
      expect(before).not.toBeNull();

      await prisma.$executeRaw`DELETE FROM search_chunks WHERE id = ${chunk.id}::uuid`;

      const after = await prisma.searchEmbedding.findUnique({ where: { id: embeddingId } });
      expect(after).toBeNull();
    });
  });

  // ===========================================================================
  // 6. Cascade: users -> search_index_state
  // ===========================================================================

  describe('cascade: users -> search_index_state', () => {
    it('deleting a user deletes their search_index_state rows', async () => {
      const owner = await createUser('cascade-owner');
      const documentId = randomUUID();

      const state = await prisma.searchIndexState.create({
        data: {
          documentType: 'note',
          documentId,
          ownerId: owner.id,
          status: 'pending',
        },
      });

      await prisma.user.delete({ where: { id: owner.id } });
      // Deleted via cascade already, so don't try to clean it up again.
      createdUserIds = createdUserIds.filter((id) => id !== owner.id);

      const after = await prisma.searchIndexState.findUnique({ where: { id: state.id } });
      expect(after).toBeNull();
    });
  });

  // ===========================================================================
  // 7. UNIQUE (chunk_id, model)
  // ===========================================================================

  describe('UNIQUE (chunk_id, model)', () => {
    it('rejects a second vector for the same chunk+model, accepts one for a different model', async () => {
      const chunk = await insertChunk({ ordinal: 0 });
      const vector = vectorLiteral({ 0: 1 });

      await insertEmbedding({ chunkId: chunk.id, model: 'model-a', vector });

      await expect(
        insertEmbedding({ chunkId: chunk.id, model: 'model-a', vector }),
      ).rejects.toThrow();

      // A different model is a different row and is accepted.
      await expect(
        insertEmbedding({ chunkId: chunk.id, model: 'model-b', vector }),
      ).resolves.toBeDefined();
    });
  });

  // ===========================================================================
  // 8. UNIQUE (document_type, document_id, ordinal) / UNIQUE (document_type, document_id)
  // ===========================================================================

  describe('search_chunks: UNIQUE (document_type, document_id, ordinal)', () => {
    it('rejects a second chunk at the same ordinal for the same document', async () => {
      const documentId = randomUUID();
      await insertChunk({ documentId, ordinal: 0 });

      await expect(insertChunk({ documentId, ordinal: 0 })).rejects.toThrow();

      // A different ordinal for the same document is fine.
      await expect(insertChunk({ documentId, ordinal: 1 })).resolves.toBeDefined();
    });
  });

  describe('search_index_state: UNIQUE (document_type, document_id)', () => {
    it('rejects a second state row for the same document', async () => {
      const owner = await createUser('unique-state-owner');
      const documentId = randomUUID();

      await prisma.searchIndexState.create({
        data: { documentType: 'transcript', documentId, ownerId: owner.id, status: 'pending' },
      });

      await expect(
        prisma.searchIndexState.create({
          data: { documentType: 'transcript', documentId, ownerId: owner.id, status: 'pending' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });
});
