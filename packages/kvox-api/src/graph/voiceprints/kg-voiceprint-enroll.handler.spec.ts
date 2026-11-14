// =============================================================================
// kg.voiceprint_enroll (#825, epic #820): the decisions around the persist step.
//
// The SQL itself (prune, unique pair, cascades) is proved on a real Postgres in
// `test/graph/voiceprints.db.spec.ts`; here the Prisma client is a recorder, so a spec asserts
// WHICH statements ran and what the audit row and the thrown errors may carry.
// BIOMETRIC: no vector and no audio may appear in an audit payload, a log line or an error.
// =============================================================================

import { Logger } from '@nestjs/common';

import { auditPortOver } from '../__fixtures__/audit-port.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { KG_VOICEPRINT_ENROLL_JOB_TYPE } from '../job-types.js';
import { NOOP_KVOX_VOICEPRINTS } from '../../ports/index.js';
import {
  KgVoiceprintEnrollHandler,
  VOICEPRINT_ENROLLED_ACTION,
} from './handlers/kg-voiceprint-enroll.handler.js';
import { VoiceprintAudioService } from './voiceprint-audio.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222221';
const S1 = '33333333-3333-4333-8333-333333333331';
const S2 = '33333333-3333-4333-8333-333333333332';
const E1 = '44444444-4444-4444-8444-444444444441';
const E2 = '44444444-4444-4444-8444-444444444442';

/** A vector whose text form is searchable in whatever a spec captures. */
const VECTOR = Array.from({ length: 8 }, (_v, i) => 0.123456 + i);

const job = (payload: unknown) => ({ id: 'j-1', type: KG_VOICEPRINT_ENROLL_JOB_TYPE, payload }) as never;

interface Options {
  enabled?: boolean;
  /** entity ids whose IDENTIFIED_AS edge still holds (live Person, not merged). */
  live?: string[];
  skipped?: 'unavailable' | 'no_audio' | 'no_ffmpeg' | null;
  speakers?: Array<{ speakerId: string; embedding: number[]; speechMs: number }>;
  transcript?: { ownerId: string } | null;
  maxSamples?: number;
  auditFails?: boolean;
}

function setup(opts: Options = {}) {
  const jobs = jobsMock();
  const live = new Set(opts.live ?? [E1, E2]);
  const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
  const prisma = {
    transcript: { findFirst: jest.fn().mockResolvedValue(opts.transcript === undefined ? { ownerId: OWNER } : opts.transcript) },
    // liveLinks: tagged template, the entity id is the 3rd interpolated value (owner, speaker, entity).
    $queryRaw: jest.fn().mockImplementation(async (_strings: unknown, ...values: unknown[]) =>
      live.has(String(values[2])) ? [{ ok: 1 }] : [],
    ),
    $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const preferences = { voiceprintsEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true) };
  const audio = {
    computeSpeakerVoices: jest.fn().mockResolvedValue({
      skipped: opts.skipped ?? null,
      speakers: opts.speakers ?? [{ speakerId: S1, embedding: VECTOR, speechMs: 7000 }],
    }),
  };
  const voiceprints = { modelId: 'model-x', maxSamplesPerPerson: opts.maxSamples ?? 10 };
  const auditDb = {
    auditEvent: {
      create: jest.fn().mockImplementation(async () => {
        if (opts.auditFails) throw new Error('audit down');
        return {};
      }),
    },
  };
  const auditPort = auditPortOver(auditDb);
  const record = jest.spyOn(auditPort, 'record');
  const handler = new KgVoiceprintEnrollHandler(
    jobs as never,
    prisma as never,
    voiceprints as never,
    auditPort,
    preferences as never,
    audio as unknown as VoiceprintAudioService,
  );
  return { handler, jobs, prisma, tx, preferences, audio, record };
}

/** Every SQL text a mock saw, with its bound values appended, for substring assertions. */
function sqlOf(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call) => [(call[0] as string[]).join('?'), ...call.slice(1).map(String)].join(' '));
}

describe('KgVoiceprintEnrollHandler', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const payload = { transcriptId: TRANSCRIPT, links: [{ speakerId: S1, entityId: E1 }] };

  it('is server-only and declares a label and profile', () => {
    const { handler, jobs } = setup();
    handler.onModuleInit();
    expect(handler.type).toBe(KG_VOICEPRINT_ENROLL_JOB_TYPE);
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    expect(jobs.get(KG_VOICEPRINT_ENROLL_JOB_TYPE)).toBe(handler);
    expect(jobs.serverOnlyTypes()).toContain(KG_VOICEPRINT_ENROLL_JOB_TYPE);
  });

  describe('skips without writing', () => {
    it('on an unreadable payload', async () => {
      const { handler, prisma, audio } = setup();
      await handler.process(job({ transcriptId: 'x', links: [] }));
      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('when the transcript is gone', async () => {
      const { handler, preferences, audio } = setup({ transcript: null });
      await handler.process(job(payload));
      expect(preferences.voiceprintsEnabled).not.toHaveBeenCalled();
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
    });

    it('when the owner is not opted in (re-checked at run time)', async () => {
      const { handler, preferences, audio, prisma } = setup({ enabled: false });
      await handler.process(job(payload));
      expect(preferences.voiceprintsEnabled).toHaveBeenCalledWith(OWNER);
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('when the IDENTIFIED_AS edge is gone', async () => {
      const { handler, audio, prisma } = setup({ live: [] });
      await handler.process(job(payload));
      expect(audio.computeSpeakerVoices).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('when the Person was merged away or is no longer accepted (the live-link query filters them)', async () => {
      const { handler, prisma } = setup({ live: [] });
      await handler.process(job(payload));
      const [sql] = sqlOf(prisma.$queryRaw);
      expect(sql).toContain('e.merged_into_id IS NULL');
      expect(sql).toContain("e.review_status IN ('accepted', 'edited')");
      expect(sql).toContain("r.review_status IN ('accepted', 'edited')");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'no_audio', 'no_ffmpeg'] as const)('when the audio service skipped (%s)', async (skipped) => {
      const { handler, prisma, record } = setup({ skipped, speakers: [] });
      await handler.process(job(payload));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('when the speaker had too little speech (no voice came back for the link)', async () => {
      const { handler, prisma, record } = setup({ speakers: [] });
      await handler.process(job(payload));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('when the port is the unavailable default (real audio service, no ffmpeg call)', async () => {
      const jobs = jobsMock();
      const prisma = {
        transcript: { findFirst: jest.fn().mockResolvedValue({ ownerId: OWNER }) },
        $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
        $transaction: jest.fn(),
      };
      const ffmpeg = { decodePcm16kMono: jest.fn() };
      const audio = new VoiceprintAudioService(prisma as never, {} as never, NOOP_KVOX_VOICEPRINTS, ffmpeg as never);
      const handler = new KgVoiceprintEnrollHandler(
        jobs as never,
        prisma as never,
        NOOP_KVOX_VOICEPRINTS,
        auditPortOver({ auditEvent: { create: jest.fn() } }),
        { voiceprintsEnabled: jest.fn().mockResolvedValue(true) } as never,
        audio,
      );
      await handler.process(job(payload));
      expect(ffmpeg.decodePcm16kMono).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('stores a sample', () => {
    it('replaces the (Person, speaker) sample, inserts, prunes and closes a pending suggestion in one transaction', async () => {
      const { handler, prisma, tx } = setup();
      await handler.process(job(payload));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const statements = sqlOf(tx.$executeRaw);
      expect(statements).toHaveLength(4);
      expect(statements[0]).toContain('DELETE FROM kg_person_voiceprints');
      expect(statements[0]).toContain('source_speaker_id');
      expect(statements[1]).toContain('INSERT INTO kg_person_voiceprints');
      expect(statements[1]).toContain('::vector');
      expect(statements[2]).toContain('DELETE FROM kg_person_voiceprints');
      expect(statements[2]).toContain('OFFSET');
      expect(statements[3]).toContain('UPDATE kg_speaker_suggestions');
      expect(statements[3]).toContain("SET status = 'accepted'");
      expect(statements[3]).toContain("status = 'pending'");
    });

    it('binds the vector literal as text, the model id and the speech duration', async () => {
      const { handler, tx } = setup();
      await handler.process(job(payload));
      const insert = tx.$executeRaw.mock.calls[1]!;
      const values = insert.slice(1);
      expect(values).toEqual(expect.arrayContaining([`[${VECTOR.join(',')}]`, 'model-x', 7000, OWNER, E1, TRANSCRIPT, S1]));
    });

    it.each([
      [10, 10],
      [3, 3],
      [0, 1],
    ])('prunes to the newest %i (offset %i)', async (max, offset) => {
      const { handler, tx } = setup({ maxSamples: max });
      await handler.process(job(payload));
      expect(tx.$executeRaw.mock.calls[2]!.slice(1)).toEqual(expect.arrayContaining([offset]));
    });

    it('stores one sample per live link and skips a link whose speaker had no voice', async () => {
      const { handler, prisma, audio } = setup({
        speakers: [{ speakerId: S1, embedding: VECTOR, speechMs: 5000 }],
      });
      await handler.process(
        job({
          transcriptId: TRANSCRIPT,
          links: [
            { speakerId: S1, entityId: E1 },
            { speakerId: S2, entityId: E2 },
          ],
        }),
      );
      expect(audio.computeSpeakerVoices).toHaveBeenCalledWith({
        transcriptId: TRANSCRIPT,
        ownerId: OWNER,
        speakerIds: [S1, S2],
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('asks the audio service once per distinct speaker', async () => {
      const { handler, audio } = setup();
      await handler.process(
        job({
          transcriptId: TRANSCRIPT,
          links: [
            { speakerId: S1, entityId: E1 },
            { speakerId: S1, entityId: E2 },
          ],
        }),
      );
      expect(audio.computeSpeakerVoices.mock.calls[0]![0].speakerIds).toEqual([S1]);
    });
  });

  describe('audit and logs carry ids only', () => {
    it('records ids and a duration, never a vector or audio', async () => {
      const { handler, record } = setup();
      await handler.process(job(payload));

      expect(record).toHaveBeenCalledTimes(1);
      const event = record.mock.calls[0]![0];
      expect(event).toEqual({
        actorUserId: OWNER,
        action: VOICEPRINT_ENROLLED_ACTION,
        targetType: 'kg_entity',
        targetId: E1,
        meta: { entityId: E1, transcriptId: TRANSCRIPT, speakerId: S1, speechMs: 7000 },
      });
      const text = JSON.stringify(event);
      expect(text).not.toContain(String(VECTOR[0]));
      expect(text).not.toMatch(/embedding|vector|audio|samples/i);
    });

    it('logs no vector either', async () => {
      const { handler } = setup();
      await handler.process(job(payload));
      const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain(String(VECTOR[0]));
    });

    it('survives a failed audit write, and the error names no vector', async () => {
      const { handler, prisma } = setup({ auditFails: true });
      await expect(handler.process(job(payload))).resolves.toBeUndefined();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain(String(VECTOR[0]));
    });

    it('a failing persist rejects without the vector in the error (so the job retries)', async () => {
      const { handler, prisma } = setup();
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      const failure = await handler.process(job(payload)).catch((e: Error) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(`${(failure as Error).message}${(failure as Error).stack}`).not.toContain(String(VECTOR[0]));
    });
  });
});
