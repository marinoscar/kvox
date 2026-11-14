// =============================================================================
// kg.voice_match (#825, epic #820): which speakers it compares, which candidates it may
// suggest, and what it writes. The SQL (ON CONFLICT, the per-entity MAX, the merged-entity
// filter) is proved against a real Postgres in `test/graph/voiceprints.db.spec.ts`.
// =============================================================================

import { Logger } from '@nestjs/common';

import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { KG_VOICE_MATCH_JOB_TYPE } from '../job-types.js';
import { KgVoiceMatchHandler } from './handlers/kg-voice-match.handler.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222221';
const S = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
const E = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
const VECTOR = [0.25, 0.5, 0.75];

const job = (payload: unknown) => ({ id: 'j-1', type: KG_VOICE_MATCH_JOB_TYPE, payload }) as never;

interface Options {
  enabled?: boolean;
  transcript?: { ownerId: string; speakerIdentities: unknown } | null;
  speakers?: Array<{ id: string; label: string | null; displayName: string }>;
  identities?: Record<string, string>;
  hasVoiceprints?: boolean;
  skipped?: 'unavailable' | 'no_audio' | 'no_ffmpeg' | null;
  voices?: Array<{ speakerId: string; embedding: number[]; speechMs: number }>;
  /** entity ids already linked to a speaker of the transcript. */
  taken?: string[];
  /** the nearest-people rows the DB returns, per call. */
  nearest?: Array<{ entity_id: string; score: number }>;
  decision?: { entityId: string; score: number; margin: number } | null;
}

function setup(opts: Options = {}) {
  const jobs = jobsMock();
  const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
  const prisma = {
    transcript: {
      findFirst: jest.fn().mockResolvedValue(
        opts.transcript === undefined ? { ownerId: OWNER, speakerIdentities: opts.identities ?? {} } : opts.transcript,
      ),
    },
    transcriptSpeaker: {
      findMany: jest.fn().mockResolvedValue(
        opts.speakers ?? [
          { id: S(1), label: 'A', displayName: 'Speaker A' },
          { id: S(2), label: 'B', displayName: 'Speaker B' },
        ],
      ),
    },
    $queryRaw: jest.fn().mockImplementation(async (strings: ReadonlyArray<string>) => {
      const sql = strings.join('?');
      if (sql.includes('SELECT 1 AS ok')) return opts.hasVoiceprints === false ? [] : [{ ok: 1 }];
      if (sql.includes('IDENTIFIED_AS')) return (opts.taken ?? []).map((entity_id) => ({ entity_id }));
      if (sql.includes('kg_person_voiceprints v')) return opts.nearest ?? [{ entity_id: E(1), score: 0.9 }];
      return [];
    }),
    $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const preferences = { voiceprintsEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true) };
  const audio = {
    computeSpeakerVoices: jest.fn().mockResolvedValue({
      skipped: opts.skipped ?? null,
      speakers: opts.voices ?? [{ speakerId: S(1), embedding: VECTOR, speechMs: 6000 }],
    }),
  };
  const voiceprints = {
    modelId: 'model-x',
    decide: jest.fn().mockImplementation(() => (opts.decision === undefined ? { entityId: E(1), score: 0.9, margin: 0.3 } : opts.decision)),
  };
  const handler = new KgVoiceMatchHandler(jobs as never, prisma as never, voiceprints as never, preferences as never, audio as never);
  return { handler, jobs, prisma, tx, preferences, audio, voiceprints };
}

const sqlOf = (mock: jest.Mock): string[] =>
  mock.mock.calls.map((call) => [(call[0] as string[]).join('?'), ...call.slice(1).map(String)].join(' '));

describe('KgVoiceMatchHandler', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is server-only and declares a label and profile', () => {
    const { handler, jobs } = setup();
    handler.onModuleInit();
    expect(handler.type).toBe(KG_VOICE_MATCH_JOB_TYPE);
    expect(handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 3 });
    expect(jobs.serverOnlyTypes()).toContain(KG_VOICE_MATCH_JOB_TYPE);
  });

  describe('does nothing when', () => {
    it('the payload is unreadable', async () => {
      const { handler, prisma } = setup();
      await handler.process(job({ transcriptId: 'nope' }));
      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('the transcript is gone', async () => {
      const { handler, preferences } = setup({ transcript: null });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(preferences.voiceprintsEnabled).not.toHaveBeenCalled();
    });

    it('the owner has not opted in', async () => {
      const { handler, audio, prisma } = setup({ enabled: false });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('every speaker is already named', async () => {
      const { handler, audio } = setup({ identities: { [S(1)]: 'Person A', [S(2)]: 'Person B' } });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
    });

    it('the owner has no voiceprints of the current model (no audio is decoded)', async () => {
      const { handler, audio, prisma } = setup({ hasVoiceprints: false });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(sqlOf(prisma.$queryRaw)[0]).toContain('FROM kg_person_voiceprints');
      expect(sqlOf(prisma.$queryRaw)[0]).toContain('model-x');
    });

    it.each(['unavailable', 'no_audio', 'no_ffmpeg'] as const)('the audio service skipped (%s)', async (skipped) => {
      const { handler, prisma } = setup({ skipped, voices: [] });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`skipped (${skipped})`));
    });
  });

  describe('speakers compared', () => {
    it('are the placeholder ones only: a named speaker is never embedded or suggested for', async () => {
      const { handler, audio } = setup({ identities: { [S(1)]: 'Person A' } });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(audio.computeSpeakerVoices).toHaveBeenCalledWith({ transcriptId: TRANSCRIPT, ownerId: OWNER, speakerIds: [S(2)] });
    });

    it('count a speaker whose display name was renamed as named', async () => {
      const { handler, audio } = setup({
        speakers: [
          { id: S(1), label: 'A', displayName: 'Person A' },
          { id: S(2), label: 'B', displayName: 'Speaker B' },
        ],
      });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(audio.computeSpeakerVoices.mock.calls[0]![0].speakerIds).toEqual([S(2)]);
    });
  });

  describe('candidates', () => {
    it('go through the port decision (threshold and margin live there), best first', async () => {
      const { handler, voiceprints } = setup({
        nearest: [
          { entity_id: E(1), score: 0.9 },
          { entity_id: E(2), score: 0.4 },
        ],
      });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(voiceprints.decide).toHaveBeenCalledWith([
        { entityId: E(1), score: 0.9 },
        { entityId: E(2), score: 0.4 },
      ]);
    });

    it('exclude people already linked to another speaker of the transcript, before deciding', async () => {
      const { handler, voiceprints } = setup({
        taken: [E(1)],
        nearest: [
          { entity_id: E(1), score: 0.95 },
          { entity_id: E(2), score: 0.6 },
        ],
      });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(voiceprints.decide).toHaveBeenCalledWith([{ entityId: E(2), score: 0.6 }]);
    });

    it('are looked up among live, accepted Persons only, grouped per person, limited', async () => {
      const { handler, prisma } = setup();
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      const nearest = sqlOf(prisma.$queryRaw).find((s) => s.includes('kg_person_voiceprints v'))!;
      expect(nearest).toContain("e.type = 'Person'");
      expect(nearest).toContain("e.review_status IN ('accepted', 'edited')");
      expect(nearest).toContain('e.merged_into_id IS NULL');
      expect(nearest).toContain('MAX(1 - (v.embedding <=>');
      expect(nearest).toContain('GROUP BY v.entity_id');
      expect(nearest).toContain('v.model_id');
    });

    it('queries the linked people over every speaker of the transcript, named or not', async () => {
      const { handler, prisma } = setup();
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      const linked = prisma.$queryRaw.mock.calls.find((c) => (c[0] as string[]).join('?').includes('IDENTIFIED_AS'))!;
      expect(linked[1]).toBe(OWNER);
      expect(linked[2]).toEqual([S(1), S(2)]);
    });
  });

  describe('persist', () => {
    it('deletes the speaker stale pending suggestions, then inserts the decision', async () => {
      const { handler, prisma, tx } = setup();
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [del, ins] = sqlOf(tx.$executeRaw);
      expect(del).toContain('DELETE FROM kg_speaker_suggestions');
      expect(del).toContain("status = 'pending'");
      expect(ins).toContain('INSERT INTO kg_speaker_suggestions');
      expect(ins).toContain("'pending'");
      expect(tx.$executeRaw.mock.calls[1]!.slice(1)).toEqual(
        expect.arrayContaining([OWNER, S(1), TRANSCRIPT, E(1), 0.9, 0.3, 'model-x']),
      );
    });

    it('never re-inserts a pair that is no longer pending: ON CONFLICT DO NOTHING, delete only touches pending', async () => {
      const { handler, tx } = setup();
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      const [del, ins] = sqlOf(tx.$executeRaw);
      expect(ins).toContain('ON CONFLICT (speaker_id, entity_id) DO NOTHING');
      expect(del).not.toContain("'dismissed'");
      expect(del).toMatch(/status = 'pending'/);
    });

    it('with no confident decision, still clears the stale pending row and inserts nothing', async () => {
      const { handler, tx } = setup({ decision: null });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      const statements = sqlOf(tx.$executeRaw);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('DELETE FROM kg_speaker_suggestions');
    });

    it('handles each embedded speaker in its own transaction', async () => {
      const { handler, prisma } = setup({
        voices: [
          { speakerId: S(1), embedding: VECTOR, speechMs: 6000 },
          { speakerId: S(2), embedding: VECTOR, speechMs: 6000 },
        ],
      });
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('logs counts only, never a vector or a score table', async () => {
      const { handler } = setup();
      await handler.process(job({ transcriptId: TRANSCRIPT }));
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('1 suggestion(s) for 1 speaker(s)');
      expect(logged).not.toContain('0.25');
      expect(logged).not.toContain('0.9');
    });
  });
});
