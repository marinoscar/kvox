// =============================================================================
// Real-Postgres test: the voiceprint tables in the APPLICATION's migrated schema
// (#825, #826, epic #820)
// =============================================================================
//
// `packages/kvox-api/test/graph-voiceprints.db.spec.ts` runs the real handlers and service on the
// package's own test host. This file proves the application's INSTALLED migration
// (`..._add_kg_voiceprints`) carries the same guarantees on the schema the API ships, with the
// same raw SQL the handlers and `VoiceprintsService` run (keep the two in step):
//
//   - a vector(512) round trip, and the match query: per-person best similarity, highest first,
//     never a merged or rejected Person;
//   - prune to the newest 10 per Person;
//   - the unique (speaker, Person) pair and the status CHECK;
//   - cascades: the Person, the transcript, the speaker or the user takes samples and
//     suggestions with it;
//   - the suggestions list, the summary and the backfill window queries.
//
// Vectors are synthetic and every name is an invented placeholder.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { defaultOrgId } from '../helpers/storage-object.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-voiceprints.db.spec');

const EMAIL_PREFIX = 'kg-voiceprints-test';
const DIMENSIONS = 512;
const MODEL = 'model-x';

const literal = (values: number[]): string => `[${values.join(',')}]`;

/** A unit vector whose cosine similarity with axis 0 is `cosine`. */
function similarTo(cosine: number, axis = 1): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = cosine;
  v[axis] = Math.sqrt(1 - cosine * cosine);
  return v;
}

describeWithDb('voiceprint tables (real Postgres)', () => {
  let prisma: PrismaClient;
  let orgId: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = createDbClient();
    await prisma.$connect();
    orgId = await defaultOrgId(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    // Samples and suggestions cascade from the Person, the transcript and the user; the rest in order.
    await prisma.kgRelation.deleteMany({ where: { owner: owner.owner } });
    await prisma.kgEntity.deleteMany({ where: { owner: owner.owner } });
    await prisma.kgEvidence.deleteMany({ where: { owner: owner.owner } });
    await prisma.transcriptSegment.deleteMany({ where: { transcript: { owner: owner.owner } } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: { owner: owner.owner } } });
    await prisma.transcript.deleteMany({ where: { owner: owner.owner } });
    await rlsBypass((tx) => tx.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } }));
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  /** `storage_objects` forces row-level security; a fixture opens the transaction-local bypass the platform's system client uses. */
  async function rlsBypass<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
      return fn(tx);
    });
  }

  const user = (suffix: string) =>
    prisma.user.create({ data: { email: `${EMAIL_PREFIX}-${suffix}-${randomUUID()}@example.test` } });

  async function transcript(ownerId: string, labels: string[]) {
    const source: { id: string } = await rlsBypass((tx) =>
      tx.storageObject.create({
        data: { name: 'r.m4a', size: BigInt(1), mimeType: 'audio/mp4', storageKey: `${EMAIL_PREFIX}/${randomUUID()}`, uploadedById: ownerId, orgId },
      }),
    );
    const row = await prisma.transcript.create({
      data: { ownerId, orgId, title: 'Meeting', sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speakers: Record<string, string> = {};
    for (const [i, label] of labels.entries()) {
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: row.id, label, displayName: `Speaker ${label}`, colorIndex: i },
      });
      speakers[label] = speaker.id;
    }
    return { transcriptId: row.id, speakers };
  }

  async function person(ownerId: string, label: string, over: { reviewStatus?: 'accepted' | 'rejected'; mergedIntoId?: string } = {}) {
    const id = randomUUID();
    const reviewStatus = over.reviewStatus ?? 'accepted';
    await prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({
        data: { id, ownerId, type: 'Person', label, reviewStatus, mergedIntoId: over.mergedIntoId ?? null, ontologyVersion: '1.0.0', props: {} },
      });
      if (reviewStatus === 'accepted') {
        await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'entity', subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' } });
      }
    });
    return id;
  }

  async function link(ownerId: string, speakerId: string, personId: string, createdAt: Date, reviewStatus: 'accepted' | 'rejected' = 'accepted') {
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({
        data: { id, ownerId, type: 'IDENTIFIED_AS', fromSpeakerId: speakerId, toId: personId, reviewStatus, ontologyVersion: '1.0.0', props: {}, createdAt },
      });
      if (reviewStatus === 'accepted') {
        await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'relation', subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' } });
      }
    });
  }

  async function sample(ownerId: string, entityId: string, transcriptId: string, speakerId: string, vector: number[], over: { createdAt?: Date; speechMs?: number; model?: string } = {}) {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO kg_person_voiceprints
        (id, owner_id, entity_id, source_transcript_id, source_speaker_id, embedding, model_id, speech_ms, created_at)
      VALUES
        (${id}::uuid, ${ownerId}::uuid, ${entityId}::uuid, ${transcriptId}::uuid, ${speakerId}::uuid,
         ${literal(vector)}::vector, ${over.model ?? MODEL}, ${over.speechMs ?? 5000}::int, ${over.createdAt ?? new Date()})`;
    return id;
  }

  async function suggestion(ownerId: string, speakerId: string, transcriptId: string, entityId: string, status = 'pending', score = 0.9) {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO kg_speaker_suggestions (id, owner_id, speaker_id, transcript_id, entity_id, score, margin, model_id, status)
      VALUES (${id}::uuid, ${ownerId}::uuid, ${speakerId}::uuid, ${transcriptId}::uuid, ${entityId}::uuid, ${score}::float8, 0.3, ${MODEL}, ${status})`;
    return id;
  }

  const count = async (table: 'kg_person_voiceprints' | 'kg_speaker_suggestions', column: 'owner_id' | 'entity_id' | 'speaker_id' | 'transcript_id', id: string): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1::uuid`, id);
    return rows[0]!.n;
  };
  const samplesOwner = (id: string) => count('kg_person_voiceprints', 'owner_id', id);
  const suggestionsOwner = (id: string) => count('kg_speaker_suggestions', 'owner_id', id);

  // ===========================================================================

  it('round-trips a vector(512) and rejects a vector of another width', async () => {
    const owner = await user('vec');
    const t = await transcript(owner.id, ['A']);
    const p = await person(owner.id, 'Person A');
    await sample(owner.id, p, t.transcriptId, t.speakers.A!, similarTo(0.25, 9));

    const [row] = await prisma.$queryRaw<Array<{ text: string; dims: number }>>`
      SELECT embedding::text AS text, vector_dims(embedding) AS dims FROM kg_person_voiceprints WHERE entity_id = ${p}::uuid`;
    expect(row!.dims).toBe(DIMENSIONS);
    expect(JSON.parse(row!.text)[0]).toBeCloseTo(0.25, 5);

    await expect(sample(owner.id, p, t.transcriptId, t.speakers.A!, [1, 0, 0])).rejects.toThrow(/dimensions/i);
  });

  it('the match query returns per-person best similarity, highest first, never a merged or rejected Person', async () => {
    const owner = await user('match');
    const t = await transcript(owner.id, ['K1', 'K2', 'K3', 'K4', 'K5', 'K6']);
    const p1 = await person(owner.id, 'Person A');
    const p2 = await person(owner.id, 'Person B');
    const merged = await person(owner.id, 'Person A (dup)', { mergedIntoId: p1 });
    const rejected = await person(owner.id, 'Person C', { reviewStatus: 'rejected' });
    await sample(owner.id, p1, t.transcriptId, t.speakers.K1!, similarTo(0.3, 2));
    await sample(owner.id, p1, t.transcriptId, t.speakers.K2!, similarTo(0.9, 3));
    await sample(owner.id, p2, t.transcriptId, t.speakers.K3!, similarTo(0.6, 4));
    await sample(owner.id, merged, t.transcriptId, t.speakers.K4!, similarTo(0.99, 5));
    await sample(owner.id, rejected, t.transcriptId, t.speakers.K5!, similarTo(0.98, 6));
    await sample(owner.id, p2, t.transcriptId, t.speakers.K6!, similarTo(0.97, 7), { model: 'another-model' });

    const probe = literal(similarTo(1));
    const rows = await prisma.$queryRaw<Array<{ entity_id: string; score: number }>>`
      SELECT v.entity_id::text AS entity_id,
             MAX(1 - (v.embedding <=> ${probe}::vector))::double precision AS score
        FROM kg_person_voiceprints v
        JOIN kg_entities e ON e.id = v.entity_id
       WHERE v.owner_id = ${owner.id}::uuid
         AND v.model_id = ${MODEL}
         AND e.type = 'Person'
         AND e.review_status IN ('accepted', 'edited')
         AND e.merged_into_id IS NULL
       GROUP BY v.entity_id
       ORDER BY score DESC
       LIMIT ${5}::int`;

    expect(rows.map((r) => r.entity_id)).toEqual([p1, p2]);
    expect(Number(rows[0]!.score)).toBeCloseTo(0.9, 5);
    expect(Number(rows[1]!.score)).toBeCloseTo(0.6, 5);
  });

  it('prunes to the newest 10 samples of a Person with the handler SQL', async () => {
    const owner = await user('prune');
    const t = await transcript(owner.id, Array.from({ length: 12 }, (_v, i) => `S${i}`));
    const p = await person(owner.id, 'Person A');
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(await sample(owner.id, p, t.transcriptId, t.speakers[`S${i}`]!, similarTo(0.5, 2), { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) }));
    }

    const keep = 10;
    await prisma.$executeRaw`
      DELETE FROM kg_person_voiceprints
       WHERE id IN (
         SELECT id FROM kg_person_voiceprints
          WHERE owner_id = ${owner.id}::uuid AND entity_id = ${p}::uuid
          ORDER BY created_at DESC, id DESC
         OFFSET ${keep}::int)`;

    const left = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM kg_person_voiceprints WHERE entity_id = ${p}::uuid`;
    expect(left.map((r) => r.id).sort()).toEqual(ids.slice(2).sort());
  });

  it('keeps one suggestion per (speaker, Person) and refuses an unknown status', async () => {
    const owner = await user('constraints');
    const t = await transcript(owner.id, ['A']);
    const p = await person(owner.id, 'Person A');
    const id = await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);

    await expect(suggestion(owner.id, t.speakers.A!, t.transcriptId, p, 'dismissed')).rejects.toThrow(/unique|duplicate/i);
    // The handler's insert is a no-op on the pair instead.
    await prisma.$executeRaw`
      INSERT INTO kg_speaker_suggestions (id, owner_id, speaker_id, transcript_id, entity_id, score, margin, model_id, status)
      VALUES (${randomUUID()}::uuid, ${owner.id}::uuid, ${t.speakers.A!}::uuid, ${t.transcriptId}::uuid, ${p}::uuid, 0.5, 0.1, ${MODEL}, 'pending')
      ON CONFLICT (speaker_id, entity_id) DO NOTHING`;
    expect(await count('kg_speaker_suggestions', 'speaker_id', t.speakers.A!)).toBe(1);

    await expect(suggestion(owner.id, t.speakers.A!, t.transcriptId, await person(owner.id, 'Person B'), 'rejected')).rejects.toThrow(/status_chk|check/i);
    await expect(prisma.$executeRaw`UPDATE kg_speaker_suggestions SET status = 'maybe' WHERE id = ${id}::uuid`).rejects.toThrow(/status_chk|check/i);
  });

  describe('cascades', () => {
    async function seeded() {
      const owner = await user('cascade');
      const t = await transcript(owner.id, ['A', 'B']);
      const p = await person(owner.id, 'Person A');
      const q = await person(owner.id, 'Person B');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, similarTo(0.5, 2));
      await sample(owner.id, q, t.transcriptId, t.speakers.B!, similarTo(0.5, 3));
      await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
      await suggestion(owner.id, t.speakers.B!, t.transcriptId, q);
      return { owner, t, p, q };
    }

    it('deleting the Person removes their samples and suggestions only', async () => {
      const { owner, p, q } = await seeded();
      await prisma.kgEntity.delete({ where: { id: p } });
      expect(await count('kg_person_voiceprints', 'entity_id', p)).toBe(0);
      expect(await count('kg_speaker_suggestions', 'entity_id', p)).toBe(0);
      expect(await count('kg_person_voiceprints', 'entity_id', q)).toBe(1);
      expect(await samplesOwner(owner.id)).toBe(1);
    });

    it('deleting the source transcript removes the samples taken from it and the suggestions about it', async () => {
      const { owner, t } = await seeded();
      await prisma.transcript.delete({ where: { id: t.transcriptId } });
      expect(await samplesOwner(owner.id)).toBe(0);
      expect(await suggestionsOwner(owner.id)).toBe(0);
    });

    it('deleting the speaker removes the sample taken from it and the suggestion for it', async () => {
      const { owner, t, p } = await seeded();
      await prisma.transcriptSpeaker.delete({ where: { id: t.speakers.A! } });
      expect(await count('kg_person_voiceprints', 'entity_id', p)).toBe(0);
      expect(await count('kg_speaker_suggestions', 'entity_id', p)).toBe(0);
      expect(await samplesOwner(owner.id)).toBe(1);
    });

    it('deleting the user removes everything of theirs and nothing of anyone else', async () => {
      const { owner } = await seeded();
      const stranger = await user('cascade-other');
      const st = await transcript(stranger.id, ['A']);
      const sp = await person(stranger.id, 'Person X');
      await sample(stranger.id, sp, st.transcriptId, st.speakers.A!, similarTo(0.5, 2));
      await suggestion(stranger.id, st.speakers.A!, st.transcriptId, sp);

      await prisma.user.delete({ where: { id: owner.id } });

      expect(await samplesOwner(owner.id)).toBe(0);
      expect(await suggestionsOwner(owner.id)).toBe(0);
      expect(await samplesOwner(stranger.id)).toBe(1);
      expect(await suggestionsOwner(stranger.id)).toBe(1);
    });
  });

  it('the suggestions list returns pending rows of unnamed speakers for live Persons of the owner, best score first', async () => {
    const owner = await user('list');
    const stranger = await user('list-other');
    const t = await transcript(owner.id, ['A', 'B', 'C', 'D']);
    const live = await person(owner.id, 'Person A');
    const live2 = await person(owner.id, 'Person B');
    const survivor = await person(owner.id, 'Person C');
    const merged = await person(owner.id, 'Person C (dup)', { mergedIntoId: survivor });
    const rejected = await person(owner.id, 'Person D', { reviewStatus: 'rejected' });
    const low = await suggestion(owner.id, t.speakers.A!, t.transcriptId, live, 'pending', 0.6);
    const high = await suggestion(owner.id, t.speakers.B!, t.transcriptId, live2, 'pending', 0.95);
    await suggestion(owner.id, t.speakers.C!, t.transcriptId, merged);
    await suggestion(owner.id, t.speakers.D!, t.transcriptId, rejected);
    await suggestion(owner.id, t.speakers.C!, t.transcriptId, live, 'dismissed');
    await suggestion(owner.id, t.speakers.D!, t.transcriptId, live, 'accepted');
    const strangerPerson = await person(stranger.id, 'Person X');
    await suggestion(stranger.id, t.speakers.A!, t.transcriptId, strangerPerson);

    const rows = await prisma.$queryRaw<Array<{ id: string; label: string }>>`
      SELECT s.id::text, e.label
        FROM kg_speaker_suggestions s
        JOIN kg_entities e ON e.id = s.entity_id
       WHERE s.owner_id = ${owner.id}::uuid
         AND s.transcript_id = ${t.transcriptId}::uuid
         AND s.status = 'pending'
         AND e.owner_id = ${owner.id}::uuid
         AND e.type = 'Person'
         AND e.review_status IN ('accepted', 'edited')
         AND e.merged_into_id IS NULL
       ORDER BY s.score DESC, s.created_at ASC`;

    expect(rows.map((r) => r.id)).toEqual([high, low]);
    expect(rows.map((r) => r.label)).toEqual(['Person B', 'Person A']);
  });

  it('the summary counts the owner people and samples only', async () => {
    const owner = await user('summary');
    const stranger = await user('summary-other');
    const t = await transcript(owner.id, ['A', 'B', 'C']);
    const st = await transcript(stranger.id, ['A']);
    const p = await person(owner.id, 'Person A');
    const q = await person(owner.id, 'Person B');
    const sp = await person(stranger.id, 'Person X');
    await sample(owner.id, p, t.transcriptId, t.speakers.A!, similarTo(0.5, 2));
    await sample(owner.id, p, t.transcriptId, t.speakers.B!, similarTo(0.5, 2));
    await sample(owner.id, q, t.transcriptId, t.speakers.C!, similarTo(0.5, 2));
    await sample(stranger.id, sp, st.transcriptId, st.speakers.A!, similarTo(0.5, 2));

    const [row] = await prisma.$queryRaw<Array<{ people: number; samples: number }>>`
      SELECT count(DISTINCT entity_id)::int AS people, count(*)::int AS samples
        FROM kg_person_voiceprints WHERE owner_id = ${owner.id}::uuid`;
    expect(row).toEqual({ people: 2, samples: 3 });
  });

  it('the backfill window keeps the newest 3 links per Person and skips deleted transcripts, merged Persons and rejected edges', async () => {
    const owner = await user('window');
    const t1 = await transcript(owner.id, ['A', 'B', 'C', 'D', 'E']);
    const gone = await transcript(owner.id, ['F']);
    const p = await person(owner.id, 'Person A');
    const survivor = await person(owner.id, 'Person B');
    const merged = await person(owner.id, 'Person B (dup)', { mergedIntoId: survivor });
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await link(owner.id, t1.speakers.A!, p, day(1));
    await link(owner.id, t1.speakers.B!, p, day(2));
    await link(owner.id, t1.speakers.C!, p, day(3));
    await link(owner.id, t1.speakers.D!, p, day(4));
    await link(owner.id, gone.speakers.F!, p, day(5));
    await link(owner.id, t1.speakers.E!, merged, day(6));
    await prisma.transcript.update({ where: { id: gone.transcriptId }, data: { deletedAt: new Date() } });

    const rows = await prisma.$queryRaw<Array<{ transcript_id: string; speaker_id: string; entity_id: string }>>`
      SELECT transcript_id, speaker_id, entity_id FROM (
        SELECT s.transcript_id, r.from_speaker_id AS speaker_id, r.to_id AS entity_id, r.created_at,
               row_number() OVER (PARTITION BY r.to_id ORDER BY r.created_at DESC, r.id DESC) AS rn
          FROM kg_relations r
          JOIN kg_entities e ON e.id = r.to_id
          JOIN transcript_speakers s ON s.id = r.from_speaker_id
          JOIN transcripts t ON t.id = s.transcript_id
         WHERE r.owner_id = ${owner.id}::uuid
           AND r.type = 'IDENTIFIED_AS'
           AND r.review_status IN ('accepted', 'edited')
           AND e.owner_id = ${owner.id}::uuid
           AND e.type = 'Person'
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND t.owner_id = ${owner.id}::uuid
           AND t.deleted_at IS NULL
      ) ranked
       WHERE rn <= ${3}::int
       ORDER BY created_at DESC
       LIMIT ${200}::int`;

    expect(rows.map((r) => r.speaker_id)).toEqual([t1.speakers.D, t1.speakers.C, t1.speakers.B]);
    expect(rows.every((r) => r.entity_id === p)).toBe(true);
  });
});
