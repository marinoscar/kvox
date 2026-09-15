// =============================================================================
// Real-Postgres test: the generated `tsvector` search columns + GIN indexes
// (issue #174, epic #164)
// =============================================================================
//
// A `GENERATED ALWAYS AS (...) STORED` column's expression and a GIN index's
// access method only exist once a migration has actually run against a real
// database — a unit test importing `schema.prisma` can read the
// `Unsupported("tsvector")?` DECLARATION, never prove the DATABASE populates
// it, weights it correctly, or updates it on every write with no application
// code involved. So, like `transcript-schema.db.spec.ts` and
// `note-schema.db.spec.ts` beside it, this is a `*.db.spec.ts` file,
// deliberately excluded from `npm test`/`test:unit`/`test:cov`/`test:ci`
// (see apps/api/package.json's testPathIgnorePatterns). It runs only via
// `npm run test:db`, against a real Postgres with this migration applied.
// See `../jobs/db-test-support.ts` for the shared reachability probe and
// client factory this file reuses rather than re-implementing.
//
// What this file asserts, and why each one is the thing
// `20260915120000_add_search_vectors/migration.sql` is responsible for:
//
//   1. SHAPE: all three columns exist, are `GENERATED ALWAYS ... STORED`
//      (`information_schema.columns.is_generated`), and are typed
//      `tsvector`. All three GIN indexes exist (`pg_am.amname = 'gin'`).
//   2. BEHAVIOUR on `transcript_segments.search_vector`: inserting a
//      segment whose text mentions a term makes `search_vector @@
//      plainto_tsquery('english', ...)` true for that row, with no
//      application code ever touching the column — the generation
//      expression populated itself as part of the INSERT.
//   3. WEIGHTING on `notes.search_vector`: a title hit outranks a body hit
//      under `ts_rank_cd`, proving the A/B `setweight` split the migration
//      header argues for is actually in the expression, not just described
//      by it.
//   4. GENERATED, NOT BACKFILLED ONCE: an UPDATE to `text` changes the
//      vector, which a one-time backfill script could never do.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { resolveDbSuite, createDbClient } from '../jobs/db-test-support';

const SEARCH_VECTOR_INDEX_NAMES = [
  'transcript_segments_search_vector_idx',
  'notes_search_vector_idx',
  'transcripts_title_search_vector_idx',
];

const { describeWithDb } = resolveDbSuite('search-vectors.db.spec');

describeWithDb('Full-text search vectors (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'search-vectors-test';

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    // Children first, transcripts/notes next, storage objects, users last —
    // mirrors transcript-schema.db.spec.ts / note-schema.db.spec.ts.
    await prisma.note.deleteMany({ where: { title: { startsWith: 'test-note-' } } });
    await prisma.transcriptSegment.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcriptSpeaker.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: 'test-transcript-' } } });
    await prisma.storageObject.deleteMany({
      where: { storageKey: { startsWith: 'test-search-vectors/' } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
      },
    });
  }

  async function createSourceObject(uploadedById: string, suffix: string) {
    return prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `test-search-vectors/${suffix}-${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById,
      },
    });
  }

  async function createTranscript(
    ownerId: string,
    sourceObjectId: string,
    suffix: string,
    title = `test-transcript-${suffix}`,
  ) {
    return prisma.transcript.create({
      data: {
        ownerId,
        title,
        sourceObjectId,
        provider: 'assemblyai',
      },
    });
  }

  async function createSpeaker(transcriptId: string) {
    return prisma.transcriptSpeaker.create({
      data: { transcriptId, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
  }

  // ===========================================================================
  // 1. Shape: columns are GENERATED STORED tsvector, indexes are GIN
  // ===========================================================================

  describe('shape', () => {
    it('all three columns are GENERATED ALWAYS ... STORED, typed tsvector', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string; is_generated: string; data_type: string }>
      >`
        SELECT table_name, column_name, is_generated, data_type
        FROM information_schema.columns
        WHERE (table_name, column_name) IN (
          ('transcript_segments', 'search_vector'),
          ('notes', 'search_vector'),
          ('transcripts', 'title_search_vector')
        )
      `;

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.is_generated).toBe('ALWAYS');
        expect(row.data_type).toBe('tsvector');
      }
    });

    it('all three GIN indexes exist', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string; amname: string }>>`
        SELECT i.relname AS indexname, am.amname AS amname
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        WHERE i.relname = ANY(${SEARCH_VECTOR_INDEX_NAMES})
      `;

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.amname).toBe('gin');
      }
      expect(rows.map((r) => r.indexname).sort()).toEqual([...SEARCH_VECTOR_INDEX_NAMES].sort());
    });
  });

  // ===========================================================================
  // 2. Behaviour: transcript_segments.search_vector populates itself
  // ===========================================================================

  describe('transcript_segments.search_vector', () => {
    it('matches a plainto_tsquery against inserted text with no application code involved', async () => {
      const owner = await createUser('segment-owner');
      const source = await createSourceObject(owner.id, 'segment');
      const transcript = await createTranscript(owner.id, source.id, 'segment-match');
      const speaker = await createSpeaker(transcript.id);

      const segment = await prisma.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          speakerId: speaker.id,
          startMs: 0,
          endMs: 4000,
          ordinal: 1000,
          text: 'the subsurface pricing model was discussed',
          words: [],
        },
      });

      const [hit] = await prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT search_vector @@ plainto_tsquery('english', 'pricing') AS matches
        FROM transcript_segments WHERE id = ${segment.id}::uuid
      `;
      expect(hit.matches).toBe(true);

      const [miss] = await prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT search_vector @@ plainto_tsquery('english', 'giraffe') AS matches
        FROM transcript_segments WHERE id = ${segment.id}::uuid
      `;
      expect(miss.matches).toBe(false);
    });
  });

  // ===========================================================================
  // 3. Behaviour: notes.search_vector is weighted A (title) / B (body)
  // ===========================================================================

  describe('notes.search_vector weighting', () => {
    it('ranks a title hit higher than a body hit under ts_rank_cd', async () => {
      const owner = await createUser('note-owner');
      const source = await createSourceObject(owner.id, 'note-source');
      const transcript = await createTranscript(owner.id, source.id, 'note-source');

      const titleHit = await prisma.note.create({
        data: {
          ownerId: owner.id,
          title: 'test-note-quarterly-pricing-review',
          body: 'This document discusses various unrelated topics with no relevant term.',
          sourceType: 'transcript',
          sourceTranscriptId: transcript.id,
        },
      });
      const bodyHit = await prisma.note.create({
        data: {
          ownerId: owner.id,
          title: 'test-note-generic-summary',
          body: 'A long discussion touching on pricing considerations near the end.',
          sourceType: 'transcript',
          sourceTranscriptId: transcript.id,
        },
      });

      const rows = await prisma.$queryRaw<Array<{ id: string; rank: number }>>`
        SELECT id, ts_rank_cd(search_vector, plainto_tsquery('english', 'pricing')) AS rank
        FROM notes WHERE id IN (${titleHit.id}::uuid, ${bodyHit.id}::uuid)
      `;
      const byId = new Map(rows.map((r) => [r.id, Number(r.rank)]));

      expect(byId.get(titleHit.id)).toBeGreaterThan(0);
      expect(byId.get(bodyHit.id)).toBeGreaterThan(0);
      expect(byId.get(titleHit.id)!).toBeGreaterThan(byId.get(bodyHit.id)!);
    });
  });

  // ===========================================================================
  // 4. Generated, not backfilled once: an UPDATE recomputes the vector
  // ===========================================================================

  describe('recomputation on UPDATE', () => {
    it('changes transcript_segments.search_vector when text is updated', async () => {
      const owner = await createUser('update-owner');
      const source = await createSourceObject(owner.id, 'update');
      const transcript = await createTranscript(owner.id, source.id, 'update-recompute');
      const speaker = await createSpeaker(transcript.id);

      const segment = await prisma.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          speakerId: speaker.id,
          startMs: 0,
          endMs: 1000,
          ordinal: 1000,
          text: 'an entirely unrelated sentence',
          words: [],
        },
      });

      const [before] = await prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT search_vector @@ plainto_tsquery('english', 'astronomy') AS matches
        FROM transcript_segments WHERE id = ${segment.id}::uuid
      `;
      expect(before.matches).toBe(false);

      await prisma.transcriptSegment.update({
        where: { id: segment.id },
        data: { text: 'a sentence now about astronomy' },
      });

      const [after] = await prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT search_vector @@ plainto_tsquery('english', 'astronomy') AS matches
        FROM transcript_segments WHERE id = ${segment.id}::uuid
      `;
      expect(after.matches).toBe(true);
    });
  });
});
