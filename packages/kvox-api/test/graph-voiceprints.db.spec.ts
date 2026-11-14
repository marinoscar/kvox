import { randomUUID } from 'node:crypto';

import { Logger, NotFoundException } from '@nestjs/common';

import { KgVoiceMatchHandler } from '../src/graph/voiceprints/handlers/kg-voice-match.handler.js';
import {
  KgVoiceprintBackfillHandler,
  VOICEPRINT_BACKFILL_MAX_LINKS,
  VOICEPRINT_BACKFILL_PER_PERSON,
} from '../src/graph/voiceprints/handlers/kg-voiceprint-backfill.handler.js';
import { KgVoiceprintEnrollHandler } from '../src/graph/voiceprints/handlers/kg-voiceprint-enroll.handler.js';
import { toVectorLiteral } from '../src/graph/voiceprints/voiceprint-audio.service.js';
import {
  VOICEPRINTS_DELETED_ALL_ACTION,
  VOICEPRINT_FORGOTTEN_ACTION,
  VoiceprintsService,
} from '../src/graph/voiceprints/voiceprints.service.js';
import { createTestDb, type TestDb } from './host/db.js';

// =============================================================================
// Speaker voiceprints on a real PostgreSQL (#825, #826, epic #820)
// =============================================================================
//
// What a recorded Prisma client cannot prove, with the REAL handlers and service on the test
// host's migrated database (pgvector, the deferred no-orphans trigger, the unique pair, the
// CHECK, the cascades):
//
//   - the vector(512) round trip through the same raw SQL the handlers run;
//   - the match query: per-person best similarity, highest first, never a merged or rejected
//     Person, never a person already linked to another speaker of the transcript;
//   - the enrol persist: one sample per (Person, speaker), pruned to the newest N, a pending
//     suggestion for the pair closed;
//   - the suggestion store: unique (speaker, person), a status CHECK, a dismissed pair never
//     re-suggested;
//   - cascades: the Person, the transcript, the speaker or the user takes the samples and the
//     suggestions with it (biometric data never outlives what it was taken from);
//   - the list, summary and forget queries of `VoiceprintsService`, scoped to the caller;
//   - the backfill's window: newest links, at most 3 speakers per Person, 200 in all.
//
// Vectors are synthetic (unit vectors on chosen axes); names are invented placeholders.
// =============================================================================

const DIMENSIONS = 512;
const MODEL = 'model-x';

/** A unit vector whose cosine similarity with `unit(0)` is `cosine` (its remainder on axis `axis`). */
function similarTo(cosine: number, axis = 1): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = cosine;
  v[axis] = Math.sqrt(1 - cosine * cosine);
  return v;
}

/** The first axis, the reference voice. */
const unit0 = (): number[] => similarTo(1);

describe('voiceprints (real PostgreSQL)', () => {
  let db: TestDb;
  let orgId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const org = await db.prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!org) throw new Error('the test host has no default organization');
    orgId = org.id;
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db.dispose();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  const user = (suffix: string) =>
    db.prisma.user.create({ data: { email: `voiceprints-${suffix}-${randomUUID()}@example.test` } });

  async function transcript(ownerId: string, labels: string[]) {
    // `storage_objects` forces row-level security on `org_id`; the test host's role may not be a superuser,
    // so a fixture opens the transaction-local bypass the platform's own system client uses.
    const source = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
      return tx.storageObject.create({
        data: { name: 'r.m4a', size: BigInt(1), mimeType: 'audio/mp4', storageKey: `voiceprints/${randomUUID()}`, uploadedById: ownerId, orgId },
      });
    });
    const row = await db.prisma.transcript.create({
      data: { ownerId, orgId, title: 'Meeting', sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speakers: Record<string, string> = {};
    for (const [i, label] of labels.entries()) {
      const speaker = await db.prisma.transcriptSpeaker.create({
        data: { transcriptId: row.id, label, displayName: `Speaker ${label}`, colorIndex: i },
      });
      speakers[label] = speaker.id;
    }
    return { transcriptId: row.id, speakers };
  }

  /** An accepted entity with the evidence the no-orphans trigger demands. */
  async function entity(ownerId: string, label: string, over: { reviewStatus?: 'accepted' | 'rejected' | 'unreviewed'; type?: string; mergedIntoId?: string } = {}) {
    const id = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({
        data: {
          id,
          ownerId,
          type: over.type ?? 'Person',
          label,
          reviewStatus: over.reviewStatus ?? 'accepted',
          mergedIntoId: over.mergedIntoId ?? null,
          ontologyVersion: '1.0.0',
          props: {},
        },
      });
      if ((over.reviewStatus ?? 'accepted') === 'accepted') {
        await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'entity', subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' } });
      }
    });
    return id;
  }

  /** The IDENTIFIED_AS edge from a speaker to a Person. */
  async function link(ownerId: string, speakerId: string, personId: string, over: { reviewStatus?: 'accepted' | 'rejected'; createdAt?: Date } = {}) {
    const id = randomUUID();
    await db.prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({
        data: {
          id,
          ownerId,
          type: 'IDENTIFIED_AS',
          fromSpeakerId: speakerId,
          toId: personId,
          reviewStatus: over.reviewStatus ?? 'accepted',
          ontologyVersion: '1.0.0',
          props: {},
          ...(over.createdAt ? { createdAt: over.createdAt } : {}),
        },
      });
      if ((over.reviewStatus ?? 'accepted') === 'accepted') {
        await tx.kgEvidence.create({ data: { ownerId, subjectKind: 'relation', subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' } });
      }
    });
    return id;
  }

  /** A stored sample, written with the SQL the enrol handler uses. */
  async function sample(
    ownerId: string,
    entityId: string,
    transcriptId: string,
    speakerId: string,
    vector: number[],
    over: { createdAt?: Date; model?: string; speechMs?: number } = {},
  ) {
    const id = randomUUID();
    await db.prisma.$executeRaw`
      INSERT INTO kg_person_voiceprints
        (id, owner_id, entity_id, source_transcript_id, source_speaker_id, embedding, model_id, speech_ms, created_at)
      VALUES
        (${id}::uuid, ${ownerId}::uuid, ${entityId}::uuid, ${transcriptId}::uuid, ${speakerId}::uuid,
         ${toVectorLiteral(vector)}::vector, ${over.model ?? MODEL}, ${over.speechMs ?? 5000}::int,
         ${over.createdAt ?? new Date()})`;
    return id;
  }

  async function suggestion(
    ownerId: string,
    speakerId: string,
    transcriptId: string,
    entityId: string,
    status: 'pending' | 'accepted' | 'dismissed' = 'pending',
  ) {
    const id = randomUUID();
    await db.prisma.$executeRaw`
      INSERT INTO kg_speaker_suggestions (id, owner_id, speaker_id, transcript_id, entity_id, score, margin, model_id, status)
      VALUES (${id}::uuid, ${ownerId}::uuid, ${speakerId}::uuid, ${transcriptId}::uuid, ${entityId}::uuid, 0.9, 0.3, ${MODEL}, ${status})`;
    return id;
  }

  const samplesOf = (entityId: string) =>
    db.prisma.$queryRaw<Array<{ id: string; source_speaker_id: string; speech_ms: number; model_id: string; dims: number }>>`
      SELECT id::text, source_speaker_id::text, speech_ms, model_id, vector_dims(embedding) AS dims
        FROM kg_person_voiceprints WHERE entity_id = ${entityId}::uuid ORDER BY created_at ASC, id ASC`;
  const suggestionsOf = (speakerId: string) =>
    db.prisma.$queryRaw<Array<{ id: string; entity_id: string; status: string; decided_at: Date | null }>>`
      SELECT id::text, entity_id::text, status, decided_at FROM kg_speaker_suggestions WHERE speaker_id = ${speakerId}::uuid ORDER BY created_at ASC`;
  const countSamples = async (where: { ownerId?: string; entityId?: string; transcriptId?: string; speakerId?: string }) => {
    const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kg_person_voiceprints
       WHERE (${where.ownerId ?? null}::uuid IS NULL OR owner_id = ${where.ownerId ?? null}::uuid)
         AND (${where.entityId ?? null}::uuid IS NULL OR entity_id = ${where.entityId ?? null}::uuid)
         AND (${where.transcriptId ?? null}::uuid IS NULL OR source_transcript_id = ${where.transcriptId ?? null}::uuid)
         AND (${where.speakerId ?? null}::uuid IS NULL OR source_speaker_id = ${where.speakerId ?? null}::uuid)`;
    return rows[0]!.n;
  };
  const countSuggestions = async (where: { ownerId?: string; entityId?: string; transcriptId?: string; speakerId?: string }) => {
    const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kg_speaker_suggestions
       WHERE (${where.ownerId ?? null}::uuid IS NULL OR owner_id = ${where.ownerId ?? null}::uuid)
         AND (${where.entityId ?? null}::uuid IS NULL OR entity_id = ${where.entityId ?? null}::uuid)
         AND (${where.transcriptId ?? null}::uuid IS NULL OR transcript_id = ${where.transcriptId ?? null}::uuid)
         AND (${where.speakerId ?? null}::uuid IS NULL OR speaker_id = ${where.speakerId ?? null}::uuid)`;
    return rows[0]!.n;
  };

  // ---------------------------------------------------------------------------
  // The handlers, with the audio side faked
  // ---------------------------------------------------------------------------

  /** A port whose `decide` is the real rule (0.52, 0.05) and records what it was asked. */
  function port(over: { max?: number } = {}) {
    const asked: Array<Array<{ entityId: string; score: number }>> = [];
    return {
      asked,
      modelId: MODEL,
      dimensions: DIMENSIONS,
      maxSamplesPerPerson: over.max ?? 10,
      decide: jest.fn((candidates: ReadonlyArray<{ entityId: string; score: number }>) => {
        asked.push(candidates.map((c) => ({ ...c })));
        const sorted = [...candidates].sort((a, b) => b.score - a.score);
        const best = sorted[0];
        if (!best || best.score < 0.52) return null;
        const lead = sorted[1] ? best.score - sorted[1].score : best.score;
        return sorted[1] && lead < 0.05 ? null : { entityId: best.entityId, score: best.score, margin: lead };
      }),
    };
  }

  const audioReturning = (voices: Array<{ speakerId: string; embedding: number[]; speechMs: number }>) => ({
    computeSpeakerVoices: jest.fn().mockResolvedValue({ skipped: null, speakers: voices }),
  });

  const prefs = (enabled = true) => ({ voiceprintsEnabled: jest.fn().mockResolvedValue(enabled) });

  function enroll(opts: { audio: ReturnType<typeof audioReturning>; max?: number; enabled?: boolean }) {
    const audit: Array<Record<string, unknown>> = [];
    const handler = new KgVoiceprintEnrollHandler(
      { registerHandler: jest.fn() } as never,
      db.prisma as never,
      port({ max: opts.max }) as never,
      { record: async (event: Record<string, unknown>) => void audit.push(event) } as never,
      prefs(opts.enabled) as never,
      opts.audio as never,
    );
    return {
      audit,
      run: (transcriptId: string, links: Array<{ speakerId: string; entityId: string }>) =>
        handler.process({ id: 'j', payload: { transcriptId, links } } as never),
    };
  }

  function match(opts: { audio: ReturnType<typeof audioReturning>; voiceprints?: ReturnType<typeof port>; enabled?: boolean }) {
    const voiceprints = opts.voiceprints ?? port();
    const handler = new KgVoiceMatchHandler(
      { registerHandler: jest.fn() } as never,
      db.prisma as never,
      voiceprints as never,
      prefs(opts.enabled) as never,
      opts.audio as never,
    );
    return { voiceprints, run: (transcriptId: string) => handler.process({ id: 'j', payload: { transcriptId } } as never) };
  }

  // ===========================================================================
  // The enrol persist
  // ===========================================================================

  describe('kg.voiceprint_enroll', () => {
    it('stores a 512-dimension sample for the (Person, speaker) pair, and closes the pending suggestion of that pair only', async () => {
      const owner = await user('enroll');
      const t = await transcript(owner.id, ['A', 'B']);
      const person = await entity(owner.id, 'Person A');
      const other = await entity(owner.id, 'Person B');
      await link(owner.id, t.speakers.A!, person);
      const pendingForPair = await suggestion(owner.id, t.speakers.A!, t.transcriptId, person);
      const pendingElsewhere = await suggestion(owner.id, t.speakers.A!, t.transcriptId, other);
      const dismissedForPair = await suggestion(owner.id, t.speakers.B!, t.transcriptId, person, 'dismissed');

      const { run, audit } = enroll({ audio: audioReturning([{ speakerId: t.speakers.A!, embedding: similarTo(0.6, 7), speechMs: 8200 }]) });
      await run(t.transcriptId, [{ speakerId: t.speakers.A!, entityId: person }]);

      const stored = await samplesOf(person);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ source_speaker_id: t.speakers.A, speech_ms: 8200, model_id: MODEL, dims: DIMENSIONS });

      const rows = await db.prisma.$queryRaw<Array<{ id: string; status: string; decided_at: Date | null }>>`
        SELECT id::text, status, decided_at FROM kg_speaker_suggestions WHERE owner_id = ${owner.id}::uuid`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(pendingForPair)).toMatchObject({ status: 'accepted' });
      expect(byId.get(pendingForPair)!.decided_at).toBeInstanceOf(Date);
      expect(byId.get(pendingElsewhere)).toMatchObject({ status: 'pending', decided_at: null });
      expect(byId.get(dismissedForPair)).toMatchObject({ status: 'dismissed' });

      // The audit row names ids and a duration, never the vector.
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ meta: { entityId: person, speakerId: t.speakers.A, speechMs: 8200 } });
      expect(JSON.stringify(audit)).not.toMatch(/embedding|vector/i);
    });

    it('replaces, never duplicates, the sample of one (Person, speaker) pair on a re-run', async () => {
      const owner = await user('rerun');
      const t = await transcript(owner.id, ['A']);
      const person = await entity(owner.id, 'Person A');
      await link(owner.id, t.speakers.A!, person);

      await enroll({ audio: audioReturning([{ speakerId: t.speakers.A!, embedding: similarTo(0.5, 2), speechMs: 4000 }]) }).run(
        t.transcriptId,
        [{ speakerId: t.speakers.A!, entityId: person }],
      );
      await enroll({ audio: audioReturning([{ speakerId: t.speakers.A!, embedding: similarTo(0.9, 3), speechMs: 9000 }]) }).run(
        t.transcriptId,
        [{ speakerId: t.speakers.A!, entityId: person }],
      );

      const stored = await samplesOf(person);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.speech_ms).toBe(9000);
    });

    it('keeps the newest 10 samples of a Person and drops the older ones', async () => {
      const owner = await user('prune');
      const old = await transcript(owner.id, Array.from({ length: 10 }, (_v, i) => `O${i}`));
      const fresh = await transcript(owner.id, ['N']);
      const person = await entity(owner.id, 'Person A');
      await link(owner.id, fresh.speakers.N!, person);

      const oldIds: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        oldIds.push(
          await sample(owner.id, person, old.transcriptId, old.speakers[`O${i}`]!, similarTo(0.5, 4), {
            createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
          }),
        );
      }
      expect(await countSamples({ entityId: person })).toBe(10);

      await enroll({ audio: audioReturning([{ speakerId: fresh.speakers.N!, embedding: similarTo(0.8, 5), speechMs: 6000 }]) }).run(
        fresh.transcriptId,
        [{ speakerId: fresh.speakers.N!, entityId: person }],
      );

      const kept = await samplesOf(person);
      expect(kept).toHaveLength(10);
      expect(kept.map((s) => s.id)).not.toContain(oldIds[0]);
      expect(kept.map((s) => s.id)).toEqual(expect.arrayContaining(oldIds.slice(1)));
      expect(kept.at(-1)!.source_speaker_id).toBe(fresh.speakers.N);
    });

    it("prunes only that Person's samples, and honours a smaller port cap", async () => {
      const owner = await user('prune-scope');
      const old = await transcript(owner.id, ['O1', 'O2', 'O3', 'P1', 'P2']);
      const fresh = await transcript(owner.id, ['N']);
      const person = await entity(owner.id, 'Person A');
      const bystander = await entity(owner.id, 'Person B');
      await link(owner.id, fresh.speakers.N!, person);
      for (const [i, key] of ['O1', 'O2', 'O3'].entries()) {
        await sample(owner.id, person, old.transcriptId, old.speakers[key]!, similarTo(0.5, 4), { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
      }
      await sample(owner.id, bystander, old.transcriptId, old.speakers.P1!, similarTo(0.5, 4), { createdAt: new Date(Date.UTC(2025, 0, 1)) });
      await sample(owner.id, bystander, old.transcriptId, old.speakers.P2!, similarTo(0.5, 4), { createdAt: new Date(Date.UTC(2025, 0, 2)) });

      await enroll({
        max: 2,
        audio: audioReturning([{ speakerId: fresh.speakers.N!, embedding: similarTo(0.8, 5), speechMs: 6000 }]),
      }).run(fresh.transcriptId, [{ speakerId: fresh.speakers.N!, entityId: person }]);

      expect(await countSamples({ entityId: person })).toBe(2);
      expect(await countSamples({ entityId: bystander })).toBe(2);
    });

    it('stores nothing for a Person merged away, a rejected edge, or a vanished edge', async () => {
      const owner = await user('not-live');
      const t = await transcript(owner.id, ['A', 'B', 'C']);
      const survivor = await entity(owner.id, 'Person A');
      const merged = await entity(owner.id, 'Person A (dup)', { mergedIntoId: survivor });
      const live = await entity(owner.id, 'Person B');
      await link(owner.id, t.speakers.A!, merged);
      await link(owner.id, t.speakers.B!, live, { reviewStatus: 'rejected' });
      // C has no edge at all.

      const audio = audioReturning([
        { speakerId: t.speakers.A!, embedding: unit0(), speechMs: 5000 },
        { speakerId: t.speakers.B!, embedding: unit0(), speechMs: 5000 },
        { speakerId: t.speakers.C!, embedding: unit0(), speechMs: 5000 },
      ]);
      await enroll({ audio }).run(t.transcriptId, [
        { speakerId: t.speakers.A!, entityId: merged },
        { speakerId: t.speakers.B!, entityId: live },
        { speakerId: t.speakers.C!, entityId: live },
      ]);

      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(await countSamples({ ownerId: owner.id })).toBe(0);
    });

    it('rolls the whole persist back when the transaction fails part-way (no half-replaced sample)', async () => {
      const owner = await user('atomic');
      const t = await transcript(owner.id, ['A']);
      const person = await entity(owner.id, 'Person A');
      await link(owner.id, t.speakers.A!, person);
      await sample(owner.id, person, t.transcriptId, t.speakers.A!, similarTo(0.5, 2), { speechMs: 1234 });

      // 513 dimensions: the INSERT fails after the replace-DELETE ran in the same transaction.
      const wrong = new Array<number>(DIMENSIONS + 1).fill(0);
      wrong[0] = 1;
      await expect(
        enroll({ audio: audioReturning([{ speakerId: t.speakers.A!, embedding: wrong, speechMs: 9999 }]) }).run(t.transcriptId, [
          { speakerId: t.speakers.A!, entityId: person },
        ]),
      ).rejects.toThrow();

      const stored = await samplesOf(person);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.speech_ms).toBe(1234);
    });
  });

  // ===========================================================================
  // The match
  // ===========================================================================

  describe('kg.voice_match', () => {
    it('compares per-person BEST similarity, highest first, over live Persons only', async () => {
      const owner = await user('match');
      const known = await transcript(owner.id, ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7']);
      const t = await transcript(owner.id, ['X']);
      const p1 = await entity(owner.id, 'Person A');
      const p2 = await entity(owner.id, 'Person B');
      const mergedAway = await entity(owner.id, 'Person C', { mergedIntoId: p1 });
      const rejected = await entity(owner.id, 'Person D', { reviewStatus: 'rejected' });
      const notAPerson = await entity(owner.id, 'Org Alpha', { type: 'Organization' });

      await sample(owner.id, p1, known.transcriptId, known.speakers.K1!, similarTo(0.3, 2));
      await sample(owner.id, p1, known.transcriptId, known.speakers.K2!, similarTo(0.9, 3)); // the best of two
      await sample(owner.id, p2, known.transcriptId, known.speakers.K3!, similarTo(0.6, 4));
      await sample(owner.id, mergedAway, known.transcriptId, known.speakers.K4!, similarTo(0.99, 5));
      await sample(owner.id, rejected, known.transcriptId, known.speakers.K5!, similarTo(0.98, 6));
      await sample(owner.id, notAPerson, known.transcriptId, known.speakers.K6!, similarTo(0.97, 7));
      await sample(owner.id, p2, known.transcriptId, known.speakers.K7!, similarTo(0.95, 8), { model: 'another-model' });

      const voiceprints = port();
      await match({
        voiceprints,
        audio: audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]),
      }).run(t.transcriptId);

      expect(voiceprints.asked).toHaveLength(1);
      const candidates = voiceprints.asked[0]!;
      expect(candidates.map((c) => c.entityId)).toEqual([p1, p2]);
      expect(candidates[0]!.score).toBeCloseTo(0.9, 5);
      expect(candidates[1]!.score).toBeCloseTo(0.6, 5);
    });

    it('writes a pending suggestion for the confident match, and nothing for a close call', async () => {
      const owner = await user('decide');
      const known = await transcript(owner.id, ['K1', 'K2']);
      const t = await transcript(owner.id, ['X']);
      const p1 = await entity(owner.id, 'Person A');
      const p2 = await entity(owner.id, 'Person B');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K1!, similarTo(0.9, 2));
      await sample(owner.id, p2, known.transcriptId, known.speakers.K2!, similarTo(0.4, 3));

      await match({ audio: audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]) }).run(t.transcriptId);

      const rows = await suggestionsOf(t.speakers.X!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_id: p1, status: 'pending' });
      const detail = await db.prisma.$queryRaw<Array<{ score: number; margin: number; model_id: string; transcript_id: string }>>`
        SELECT score, margin, model_id, transcript_id::text FROM kg_speaker_suggestions WHERE id = ${rows[0]!.id}::uuid`;
      expect(detail[0]!.score).toBeCloseTo(0.9, 5);
      expect(detail[0]!.margin).toBeCloseTo(0.5, 5);
      expect(detail[0]).toMatchObject({ model_id: MODEL, transcript_id: t.transcriptId });

      // A second voice that sits between two people: no confident answer, nothing stored.
      const t2 = await transcript(owner.id, ['Y']);
      await sample(owner.id, p2, known.transcriptId, known.speakers.K1!, similarTo(0.88, 4));
      await match({ audio: audioReturning([{ speakerId: t2.speakers.Y!, embedding: unit0(), speechMs: 6000 }]) }).run(t2.transcriptId);
      expect(await countSuggestions({ speakerId: t2.speakers.Y! })).toBe(0);
    });

    it('is idempotent: a re-run leaves exactly one pending row for the pair', async () => {
      const owner = await user('idem');
      const known = await transcript(owner.id, ['K']);
      const t = await transcript(owner.id, ['X']);
      const p1 = await entity(owner.id, 'Person A');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K!, similarTo(0.9, 2));
      const audio = audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]);

      await match({ audio }).run(t.transcriptId);
      await match({ audio }).run(t.transcriptId);

      expect(await suggestionsOf(t.speakers.X!)).toHaveLength(1);
    });

    it('never re-inserts a dismissed (or accepted) pair, and keeps its decision', async () => {
      const owner = await user('dismissed');
      const known = await transcript(owner.id, ['K']);
      const t = await transcript(owner.id, ['X', 'Y']);
      const p1 = await entity(owner.id, 'Person A');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K!, similarTo(0.9, 2));
      const dismissed = await suggestion(owner.id, t.speakers.X!, t.transcriptId, p1, 'dismissed');
      const accepted = await suggestion(owner.id, t.speakers.Y!, t.transcriptId, p1, 'accepted');

      await match({
        audio: audioReturning([
          { speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 },
          { speakerId: t.speakers.Y!, embedding: unit0(), speechMs: 6000 },
        ]),
      }).run(t.transcriptId);

      const x = await suggestionsOf(t.speakers.X!);
      const y = await suggestionsOf(t.speakers.Y!);
      expect(x).toEqual([expect.objectContaining({ id: dismissed, status: 'dismissed' })]);
      expect(y).toEqual([expect.objectContaining({ id: accepted, status: 'accepted' })]);
    });

    it('replaces a stale pending suggestion for the speaker with the new answer, and clears it when nobody matches', async () => {
      const owner = await user('stale');
      const known = await transcript(owner.id, ['K1', 'K2']);
      const t = await transcript(owner.id, ['X']);
      const p1 = await entity(owner.id, 'Person A');
      const p2 = await entity(owner.id, 'Person B');
      await sample(owner.id, p2, known.transcriptId, known.speakers.K2!, similarTo(0.9, 3));
      await suggestion(owner.id, t.speakers.X!, t.transcriptId, p1); // stale: points at the wrong person

      await match({ audio: audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]) }).run(t.transcriptId);
      expect((await suggestionsOf(t.speakers.X!)).map((s) => [s.entity_id, s.status])).toEqual([[p2, 'pending']]);

      // The only voiceprint now sounds nothing like the speaker.
      await db.prisma.$executeRaw`DELETE FROM kg_person_voiceprints WHERE entity_id = ${p2}::uuid`;
      await sample(owner.id, p2, known.transcriptId, known.speakers.K2!, similarTo(0.1, 3));
      await match({ audio: audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]) }).run(t.transcriptId);
      expect(await suggestionsOf(t.speakers.X!)).toEqual([]);
    });

    it('does not suggest a Person already linked to another speaker of the transcript', async () => {
      const owner = await user('taken');
      const known = await transcript(owner.id, ['K1', 'K2']);
      const t = await transcript(owner.id, ['X', 'Y']);
      const p1 = await entity(owner.id, 'Person A');
      const p2 = await entity(owner.id, 'Person B');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K1!, similarTo(0.95, 2));
      await sample(owner.id, p2, known.transcriptId, known.speakers.K2!, similarTo(0.7, 3));
      // Y is already named Person A: X cannot be Person A as well.
      await link(owner.id, t.speakers.Y!, p1);
      await db.prisma.transcript.update({ where: { id: t.transcriptId }, data: { speakerIdentities: { [t.speakers.Y!]: 'Person A' } } });

      const voiceprints = port();
      await match({ voiceprints, audio: audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]) }).run(t.transcriptId);

      // The SQL returns both people; the handler removes the taken one before deciding.
      expect(voiceprints.asked[0]!.map((c) => c.entityId)).toEqual([p2]);
      expect((await suggestionsOf(t.speakers.X!)).map((s) => s.entity_id)).toEqual([p2]);
    });

    it('compares placeholder speakers only', async () => {
      const owner = await user('placeholders');
      const known = await transcript(owner.id, ['K']);
      const t = await transcript(owner.id, ['X', 'Y']);
      const p1 = await entity(owner.id, 'Person A');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K!, similarTo(0.9, 2));
      // Y was named by hand (the identities overlay); X is still "Speaker X".
      await db.prisma.transcript.update({ where: { id: t.transcriptId }, data: { speakerIdentities: { [t.speakers.Y!]: 'Person Z' } } });

      const audio = audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]);
      await match({ audio }).run(t.transcriptId);

      expect(audio.computeSpeakerVoices).toHaveBeenCalledWith({ transcriptId: t.transcriptId, ownerId: owner.id, speakerIds: [t.speakers.X] });
      expect(await countSuggestions({ speakerId: t.speakers.Y! })).toBe(0);
    });

    it('does nothing for an owner with no voiceprint of the current model', async () => {
      const owner = await user('no-voiceprints');
      const known = await transcript(owner.id, ['K']);
      const t = await transcript(owner.id, ['X']);
      const p1 = await entity(owner.id, 'Person A');
      await sample(owner.id, p1, known.transcriptId, known.speakers.K!, similarTo(0.9, 2), { model: 'another-model' });

      const audio = audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]);
      await match({ audio }).run(t.transcriptId);

      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(await countSuggestions({ transcriptId: t.transcriptId })).toBe(0);
    });

    it("never uses another owner's voiceprints", async () => {
      const owner = await user('mine');
      const stranger = await user('theirs');
      const strangerKnown = await transcript(stranger.id, ['K']);
      const t = await transcript(owner.id, ['X']);
      const theirs = await entity(stranger.id, 'Person A');
      await sample(stranger.id, theirs, strangerKnown.transcriptId, strangerKnown.speakers.K!, unit0());

      const audio = audioReturning([{ speakerId: t.speakers.X!, embedding: unit0(), speechMs: 6000 }]);
      await match({ audio }).run(t.transcriptId);

      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(await countSuggestions({ transcriptId: t.transcriptId })).toBe(0);
    });
  });

  // ===========================================================================
  // Constraints
  // ===========================================================================

  describe('the schema', () => {
    it('round-trips a vector(512) and orders by cosine distance', async () => {
      const owner = await user('vec');
      const t = await transcript(owner.id, ['A', 'B']);
      const p = await entity(owner.id, 'Person A');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, similarTo(0.25, 9));
      const [row] = await db.prisma.$queryRaw<Array<{ text: string; dims: number; sim: number }>>`
        SELECT embedding::text AS text, vector_dims(embedding) AS dims,
               (1 - (embedding <=> ${toVectorLiteral(unit0())}::vector))::double precision AS sim
          FROM kg_person_voiceprints WHERE entity_id = ${p}::uuid`;
      expect(row!.dims).toBe(DIMENSIONS);
      expect(row!.sim).toBeCloseTo(0.25, 5);
      expect(JSON.parse(row!.text)).toHaveLength(DIMENSIONS);
      expect(JSON.parse(row!.text)[0]).toBeCloseTo(0.25, 5);
    });

    it('refuses a vector of the wrong width', async () => {
      const owner = await user('width');
      const t = await transcript(owner.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      await expect(sample(owner.id, p, t.transcriptId, t.speakers.A!, [1, 0, 0])).rejects.toThrow(/dimensions/i);
    });

    it('keeps one suggestion per (speaker, Person) pair', async () => {
      const owner = await user('unique');
      const t = await transcript(owner.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
      await expect(suggestion(owner.id, t.speakers.A!, t.transcriptId, p, 'dismissed')).rejects.toThrow(/unique|duplicate/i);
      expect(await countSuggestions({ speakerId: t.speakers.A! })).toBe(1);
    });

    it('refuses a status outside pending, accepted and dismissed', async () => {
      const owner = await user('check');
      const t = await transcript(owner.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      await expect(suggestion(owner.id, t.speakers.A!, t.transcriptId, p, 'rejected' as never)).rejects.toThrow(/kg_speaker_suggestions_status_chk|check/i);
      const id = await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
      await expect(db.prisma.$executeRaw`UPDATE kg_speaker_suggestions SET status = 'maybe' WHERE id = ${id}::uuid`).rejects.toThrow(/check/i);
    });

    describe('cascades: a sample and a suggestion never outlive what they were taken from', () => {
      async function seeded() {
        const owner = await user('cascade');
        const t = await transcript(owner.id, ['A', 'B']);
        const p = await entity(owner.id, 'Person A');
        const q = await entity(owner.id, 'Person B');
        await sample(owner.id, p, t.transcriptId, t.speakers.A!, similarTo(0.5, 2));
        await sample(owner.id, q, t.transcriptId, t.speakers.B!, similarTo(0.5, 3));
        await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
        await suggestion(owner.id, t.speakers.B!, t.transcriptId, q);
        return { owner, t, p, q };
      }

      it('deleting the Person removes that Person samples and suggestions, and only those', async () => {
        const { owner, t, p, q } = await seeded();
        await db.prisma.kgEntity.delete({ where: { id: p } });
        expect(await countSamples({ entityId: p })).toBe(0);
        expect(await countSuggestions({ entityId: p })).toBe(0);
        expect(await countSamples({ entityId: q })).toBe(1);
        expect(await countSuggestions({ speakerId: t.speakers.B! })).toBe(1);
        expect(await countSamples({ ownerId: owner.id })).toBe(1);
      });

      it('deleting the source transcript removes the samples taken from it and the suggestions about it', async () => {
        const { owner, t } = await seeded();
        await db.prisma.transcript.delete({ where: { id: t.transcriptId } });
        expect(await countSamples({ ownerId: owner.id })).toBe(0);
        expect(await countSuggestions({ ownerId: owner.id })).toBe(0);
      });

      it('deleting the speaker removes the sample taken from it and the suggestion for it', async () => {
        const { owner, t, p, q } = await seeded();
        await db.prisma.transcriptSpeaker.delete({ where: { id: t.speakers.A! } });
        expect(await countSamples({ entityId: p })).toBe(0);
        expect(await countSuggestions({ entityId: p })).toBe(0);
        expect(await countSamples({ entityId: q })).toBe(1);
        expect(await countSamples({ ownerId: owner.id })).toBe(1);
      });

      it('deleting the user removes everything of theirs, and nothing of anyone else', async () => {
        const { owner } = await seeded();
        const stranger = await user('cascade-other');
        const st = await transcript(stranger.id, ['A']);
        const sp = await entity(stranger.id, 'Person A');
        await sample(stranger.id, sp, st.transcriptId, st.speakers.A!, similarTo(0.5, 2));
        await suggestion(stranger.id, st.speakers.A!, st.transcriptId, sp);

        await db.prisma.user.delete({ where: { id: owner.id } });

        expect(await countSamples({ ownerId: owner.id })).toBe(0);
        expect(await countSuggestions({ ownerId: owner.id })).toBe(0);
        expect(await countSamples({ ownerId: stranger.id })).toBe(1);
        expect(await countSuggestions({ ownerId: stranger.id })).toBe(1);
      });
    });
  });

  // ===========================================================================
  // VoiceprintsService queries
  // ===========================================================================

  describe('VoiceprintsService', () => {
    const audit: Array<Record<string, unknown>> = [];

    function service(over: { enabled?: boolean } = {}) {
      return new VoiceprintsService(
        db.prisma as never,
        { record: async (event: Record<string, unknown>) => void audit.push(event) } as never,
        { require: jest.fn().mockImplementation(async (_u: string, _k: string, id: string) => ({ id, type: 'Person' })) } as never,
        {
          require: jest.fn().mockImplementation(async (_u: string, id: string) => {
            const row = await db.prisma.transcript.findUniqueOrThrow({ where: { id }, select: { id: true, currentVersion: true, speakerIdentities: true } });
            return { transcript: row };
          }),
        } as never,
        { applyOperations: jest.fn() } as never,
        {
          get: jest.fn().mockResolvedValue({ voiceprints: { enabled: over.enabled ?? true, consentAt: '2026-01-01T00:00:00.000Z' } }),
        } as never,
      );
    }
    const actor = (id: string) => ({ id, permissions: ['graph:read', 'graph:write', 'transcripts:read', 'transcripts:write'] }) as never;

    beforeEach(() => {
      audit.length = 0;
    });

    it('lists only pending suggestions of still-unnamed speakers for live Persons, best score first, never a vector', async () => {
      const owner = await user('list');
      const t = await transcript(owner.id, ['A', 'B', 'C', 'D', 'E', 'F']);
      const live = await entity(owner.id, 'Person A');
      const live2 = await entity(owner.id, 'Person B');
      const survivor = await entity(owner.id, 'Person C');
      const merged = await entity(owner.id, 'Person C (dup)', { mergedIntoId: survivor });
      const rejected = await entity(owner.id, 'Person D', { reviewStatus: 'rejected' });
      const org = await entity(owner.id, 'Org Alpha', { type: 'Organization' });

      const low = await suggestion(owner.id, t.speakers.A!, t.transcriptId, live);
      const high = await suggestion(owner.id, t.speakers.B!, t.transcriptId, live2);
      await db.prisma.$executeRaw`UPDATE kg_speaker_suggestions SET score = 0.97 WHERE id = ${high}::uuid`;
      await suggestion(owner.id, t.speakers.C!, t.transcriptId, merged);
      await suggestion(owner.id, t.speakers.D!, t.transcriptId, rejected);
      await suggestion(owner.id, t.speakers.D!, t.transcriptId, org);
      await suggestion(owner.id, t.speakers.E!, t.transcriptId, live, 'dismissed');
      await suggestion(owner.id, t.speakers.F!, t.transcriptId, live, 'accepted');
      // A named speaker keeps its suggestion row but is no longer listed.
      await suggestion(owner.id, t.speakers.C!, t.transcriptId, live2);
      await db.prisma.transcript.update({ where: { id: t.transcriptId }, data: { speakerIdentities: { [t.speakers.C!]: 'Person Q' } } });
      // Another owner's row on the same transcript is invisible.
      const stranger = await user('list-other');
      const strangerPerson = await entity(stranger.id, 'Person X');
      await db.prisma.$executeRaw`
        INSERT INTO kg_speaker_suggestions (id, owner_id, speaker_id, transcript_id, entity_id, score, margin, model_id, status)
        VALUES (${randomUUID()}::uuid, ${stranger.id}::uuid, ${t.speakers.A!}::uuid, ${t.transcriptId}::uuid, ${strangerPerson}::uuid, 0.99, 0.5, ${MODEL}, 'pending')`;

      const listed = await service().listForTranscript(t.transcriptId, actor(owner.id));

      expect(listed.map((s) => s.id)).toEqual([high, low]);
      expect(listed[0]).toMatchObject({ speakerId: t.speakers.B, entityId: live2, entityName: 'Person B', score: 0.97 });
      expect(JSON.stringify(listed)).not.toMatch(/embedding|vector/i);
    });

    it('summarises the caller people and samples, not anyone else', async () => {
      const owner = await user('summary');
      const stranger = await user('summary-other');
      const t = await transcript(owner.id, ['A', 'B', 'C']);
      const st = await transcript(stranger.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      const q = await entity(owner.id, 'Person B');
      const sp = await entity(stranger.id, 'Person X');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, unit0());
      await sample(owner.id, p, t.transcriptId, t.speakers.B!, unit0());
      await sample(owner.id, q, t.transcriptId, t.speakers.C!, unit0());
      await sample(stranger.id, sp, st.transcriptId, st.speakers.A!, unit0());

      expect(await service().summary(actor(owner.id))).toEqual({
        enabled: true,
        consentAt: '2026-01-01T00:00:00.000Z',
        people: 2,
        samples: 3,
      });
      expect(await service().summary(actor(randomUUID()))).toMatchObject({ people: 0, samples: 0 });
    });

    it('reports what is stored about one Person: count, total speech, newest, model', async () => {
      const owner = await user('person-voiceprint');
      const t = await transcript(owner.id, ['A', 'B']);
      const p = await entity(owner.id, 'Person A');
      const empty = await entity(owner.id, 'Person B');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, unit0(), { speechMs: 4000, createdAt: new Date('2026-01-01T00:00:00Z') });
      await sample(owner.id, p, t.transcriptId, t.speakers.B!, unit0(), { speechMs: 6500, createdAt: new Date('2026-02-01T00:00:00Z') });

      expect(await service().personVoiceprint(p, actor(owner.id))).toEqual({
        enrolled: true,
        samples: 2,
        speechMs: 10_500,
        lastUpdatedAt: '2026-02-01T00:00:00.000Z',
        modelId: MODEL,
      });
      expect(await service().personVoiceprint(empty, actor(owner.id))).toEqual({
        enrolled: false,
        samples: 0,
        speechMs: 0,
        lastUpdatedAt: null,
        modelId: null,
      });
    });

    it('forgetting one Person deletes their samples and PENDING suggestions only, and audits ids', async () => {
      const owner = await user('forget');
      const t = await transcript(owner.id, ['A', 'B', 'C']);
      const p = await entity(owner.id, 'Person A');
      const q = await entity(owner.id, 'Person B');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, unit0());
      await sample(owner.id, p, t.transcriptId, t.speakers.B!, unit0());
      await sample(owner.id, q, t.transcriptId, t.speakers.C!, unit0());
      await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
      await suggestion(owner.id, t.speakers.B!, t.transcriptId, p, 'dismissed');
      await suggestion(owner.id, t.speakers.C!, t.transcriptId, q);

      await service().forgetPerson(p, actor(owner.id));

      expect(await countSamples({ entityId: p })).toBe(0);
      expect(await countSamples({ entityId: q })).toBe(1);
      expect((await suggestionsOf(t.speakers.A!)).length).toBe(0);
      expect((await suggestionsOf(t.speakers.B!)).map((s) => s.status)).toEqual(['dismissed']);
      expect((await suggestionsOf(t.speakers.C!)).length).toBe(1);
      expect(audit).toEqual([
        expect.objectContaining({ action: VOICEPRINT_FORGOTTEN_ACTION, meta: { entityId: p, samples: 2 } }),
      ]);
    });

    it("deleting all deletes the caller's samples and pending suggestions, and leaves other users alone", async () => {
      const owner = await user('delete-all');
      const stranger = await user('delete-all-other');
      const t = await transcript(owner.id, ['A', 'B']);
      const st = await transcript(stranger.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      const sp = await entity(stranger.id, 'Person X');
      await sample(owner.id, p, t.transcriptId, t.speakers.A!, unit0());
      await sample(owner.id, p, t.transcriptId, t.speakers.B!, unit0());
      await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);
      await suggestion(owner.id, t.speakers.B!, t.transcriptId, p, 'accepted');
      await sample(stranger.id, sp, st.transcriptId, st.speakers.A!, unit0());
      await suggestion(stranger.id, st.speakers.A!, st.transcriptId, sp);

      const result = await service().deleteAll(actor(owner.id));

      expect(result).toEqual({ deletedSamples: 2, deletedSuggestions: 1 });
      expect(await countSamples({ ownerId: owner.id })).toBe(0);
      expect(await countSuggestions({ ownerId: owner.id })).toBe(1); // the accepted one is history, kept
      expect(await countSamples({ ownerId: stranger.id })).toBe(1);
      expect(await countSuggestions({ ownerId: stranger.id })).toBe(1);
      expect(audit).toEqual([
        expect.objectContaining({ action: VOICEPRINTS_DELETED_ALL_ACTION, meta: { deletedSamples: 2, deletedSuggestions: 1 } }),
      ]);
    });

    it('a suggestion id of another owner (or not a uuid) is a 404, never a leak', async () => {
      const owner = await user('scope');
      const stranger = await user('scope-other');
      const t = await transcript(stranger.id, ['A']);
      const p = await entity(stranger.id, 'Person X');
      const theirs = await suggestion(stranger.id, t.speakers.A!, t.transcriptId, p);

      await expect(service().dismiss(theirs, actor(owner.id))).rejects.toBeInstanceOf(NotFoundException);
      await expect(service().dismiss('not-a-uuid', actor(owner.id))).rejects.toBeInstanceOf(NotFoundException);
      expect((await suggestionsOf(t.speakers.A!))[0]!.status).toBe('pending');
    });

    it('dismiss closes the row once, keeps its first decided_at, and answers again idempotently', async () => {
      const owner = await user('dismiss');
      const t = await transcript(owner.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      const id = await suggestion(owner.id, t.speakers.A!, t.transcriptId, p);

      const first = await service().dismiss(id, actor(owner.id));
      const second = await service().dismiss(id, actor(owner.id));

      expect(first).toMatchObject({ id, status: 'dismissed' });
      expect(second).toEqual(first);
      expect((await suggestionsOf(t.speakers.A!))[0]).toMatchObject({ status: 'dismissed' });
    });
  });

  // ===========================================================================
  // The backfill window
  // ===========================================================================

  describe('kg.voiceprint_backfill', () => {
    function backfill(enabled = true) {
      const enqueued: Array<{ payload: { transcriptId: string; links: Array<{ speakerId: string; entityId: string }> } }> = [];
      const handler = new KgVoiceprintBackfillHandler(
        { registerHandler: jest.fn(), enqueue: jest.fn(async (input: never) => void enqueued.push(input)) } as never,
        db.prisma as never,
        prefs(enabled) as never,
      );
      return { enqueued, run: (ownerId: string) => handler.process({ id: 'j', payload: { ownerId } } as never) };
    }
    const pairs = (enqueued: ReturnType<typeof backfill>['enqueued']) =>
      enqueued.flatMap((e) => e.payload.links.map((l) => `${l.speakerId}>${l.entityId}`));

    it('queues the newest 3 links per Person, skipping deleted transcripts, merged or rejected Persons and rejected edges', async () => {
      const owner = await user('window');
      const t1 = await transcript(owner.id, ['A', 'B', 'C', 'D']);
      const t2 = await transcript(owner.id, ['E']);
      const gone = await transcript(owner.id, ['F']);
      const p = await entity(owner.id, 'Person A');
      const survivor = await entity(owner.id, 'Person B');
      const merged = await entity(owner.id, 'Person B (dup)', { mergedIntoId: survivor });
      const rejectedPerson = await entity(owner.id, 'Person C', { reviewStatus: 'rejected' });
      const day = (n: number) => new Date(Date.UTC(2026, 0, n));

      await link(owner.id, t1.speakers.A!, p, { createdAt: day(1) }); // the 4th newest: cut
      await link(owner.id, t1.speakers.B!, p, { createdAt: day(2) });
      await link(owner.id, t1.speakers.C!, p, { createdAt: day(3) });
      await link(owner.id, t2.speakers.E!, p, { createdAt: day(4) });
      await link(owner.id, t1.speakers.D!, merged, { createdAt: day(5) });
      await link(owner.id, gone.speakers.F!, p, { createdAt: day(6) });
      await db.prisma.transcript.update({ where: { id: gone.transcriptId }, data: { deletedAt: new Date() } });
      const t3 = await transcript(owner.id, ['G', 'H']);
      await link(owner.id, t3.speakers.G!, rejectedPerson, { createdAt: day(7) });
      await link(owner.id, t3.speakers.H!, p, { reviewStatus: 'rejected', createdAt: day(8) });

      const { enqueued, run } = backfill();
      await run(owner.id);

      expect(pairs(enqueued).sort()).toEqual(
        [`${t1.speakers.B}>${p}`, `${t1.speakers.C}>${p}`, `${t2.speakers.E}>${p}`].sort(),
      );
      // One enrol job per transcript, links grouped.
      expect(enqueued.map((e) => e.payload.transcriptId).sort()).toEqual([t1.transcriptId, t2.transcriptId].sort());
      expect(VOICEPRINT_BACKFILL_PER_PERSON).toBe(3);
    });

    it("is scoped to the owner's own graph and transcripts", async () => {
      const owner = await user('window-owner');
      const stranger = await user('window-other');
      const t = await transcript(stranger.id, ['A']);
      const p = await entity(stranger.id, 'Person X');
      await link(stranger.id, t.speakers.A!, p);

      const { enqueued, run } = backfill();
      await run(owner.id);
      expect(enqueued).toEqual([]);
    });

    it('queues nothing when the owner opted out', async () => {
      const owner = await user('window-off');
      const t = await transcript(owner.id, ['A']);
      const p = await entity(owner.id, 'Person A');
      await link(owner.id, t.speakers.A!, p);

      const { enqueued, run } = backfill(false);
      await run(owner.id);
      expect(enqueued).toEqual([]);
    });

    it(`stops at ${VOICEPRINT_BACKFILL_MAX_LINKS} links, newest first`, async () => {
      const owner = await user('window-limit');
      const people = 70; // 70 people x 3 links = 210 > 200
      const speakerCount = people * 3;
      const t = await transcript(owner.id, []);
      const personIds = Array.from({ length: people }, () => randomUUID());
      const speakerIds = Array.from({ length: speakerCount }, () => randomUUID());
      const relationIds = Array.from({ length: speakerCount }, () => randomUUID());

      await db.prisma.$transaction(
        async (tx) => {
          await tx.kgEntity.createMany({
            data: personIds.map((id, i) => ({ id, ownerId: owner.id, type: 'Person', label: `Person ${i}`, reviewStatus: 'accepted' as const, ontologyVersion: '1.0.0', props: {} })),
          });
          await tx.transcriptSpeaker.createMany({
            data: speakerIds.map((id, i) => ({ id, transcriptId: t.transcriptId, label: `L${i}`, displayName: `Speaker ${i}`, colorIndex: i % 8 })),
          });
          await tx.kgRelation.createMany({
            data: relationIds.map((id, i) => ({
              id,
              ownerId: owner.id,
              type: 'IDENTIFIED_AS',
              fromSpeakerId: speakerIds[i]!,
              toId: personIds[i % people]!,
              reviewStatus: 'accepted' as const,
              ontologyVersion: '1.0.0',
              props: {},
              createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
            })),
          });
          await tx.kgEvidence.createMany({
            data: [
              ...personIds.map((id) => ({ ownerId: owner.id, subjectKind: 'entity' as const, subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' })),
              ...relationIds.map((id) => ({ ownerId: owner.id, subjectKind: 'relation' as const, subjectId: id, quote: 'cited', sourceIri: 'https://example.test/s' })),
            ],
          });
        },
        { timeout: 60_000 },
      );

      const { enqueued, run } = backfill();
      await run(owner.id);

      const queued = pairs(enqueued);
      expect(queued).toHaveLength(VOICEPRINT_BACKFILL_MAX_LINKS);
      // The cut falls on the OLDEST links: the newest speaker is in, the oldest is out.
      expect(queued).toContain(`${speakerIds[speakerCount - 1]}>${personIds[(speakerCount - 1) % people]}`);
      expect(queued.some((q) => q.startsWith(`${speakerIds[0]}>`))).toBe(false);
      // 200 links on one transcript: ceil(200 / 50) = 4 enrol jobs, each within the payload limit.
      expect(enqueued).toHaveLength(4);
      for (const e of enqueued) expect(e.payload.links.length).toBeLessThanOrEqual(50);
    });
  });
});
