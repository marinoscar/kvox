// =============================================================================
// VoiceprintAudioService (#825): window selection, which object is decoded, the signed URL,
// skips, and containment. BIOMETRIC: the logs and results carry ids and reason codes only.
// =============================================================================

import { Logger } from '@nestjs/common';

import { VOICEPRINT_MIN_SPEECH_MS, VoiceprintAudioService, toVectorLiteral } from './voiceprint-audio.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222221';
const SA = '33333333-3333-4333-8333-333333333331';
const SB = '33333333-3333-4333-8333-333333333332';
const PLAYBACK = 'obj-playback';
const SOURCE = 'obj-source';
const SIGNED = 'https://store.example.test/obj?X-Signature=SECRET';

interface Options {
  ffmpeg?: boolean;
  available?: boolean;
  transcript?: Record<string, unknown> | null;
  states?: Record<string, string>;
  segments?: Array<{ speakerId: string; startMs: number; endMs: number }>;
  speechMs?: number;
  windows?: Array<{ startMs: number; endMs: number }>;
}

function setup(opts: Options = {}) {
  const prisma = {
    transcript: {
      findFirst: jest.fn().mockResolvedValue(
        opts.transcript === undefined
          ? { playbackObjectId: PLAYBACK, playbackStatus: 'ready', sourceObjectId: SOURCE }
          : opts.transcript,
      ),
    },
    transcriptSegment: {
      findMany: jest.fn().mockResolvedValue(
        opts.segments ?? [
          { speakerId: SA, startMs: 0, endMs: 5000 },
          { speakerId: SB, startMs: 5000, endMs: 11000 },
        ],
      ),
    },
  };
  const states = opts.states ?? { [PLAYBACK]: 'ready', [SOURCE]: 'ready' };
  const store = {
    describe: jest.fn().mockImplementation(async (ids: string[]) => new Map(ids.filter((id) => states[id]).map((id) => [id, { state: states[id] }]))),
    signedDownloadUrl: jest.fn().mockResolvedValue(SIGNED),
  };
  const embedding = new Float32Array([0.5, 0.25]);
  const voiceprints = {
    available: jest.fn().mockResolvedValue(opts.available ?? true),
    selectWindows: jest.fn().mockImplementation((segments: Array<{ startMs: number; endMs: number }>) => ({
      windows: opts.windows ?? segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
      speechMs: opts.speechMs ?? segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0),
    })),
    embed: jest.fn().mockResolvedValue(embedding),
  };
  const ffmpeg = { decodePcm16kMono: jest.fn().mockResolvedValue(new Float32Array(16000)) };
  const service = new VoiceprintAudioService(
    prisma as never,
    store as never,
    voiceprints as never,
    opts.ffmpeg === false ? undefined : (ffmpeg as never),
  );
  return { service, prisma, store, voiceprints, ffmpeg };
}

const compute = (service: VoiceprintAudioService, speakerIds = [SA]) =>
  service.computeSpeakerVoices({ transcriptId: TRANSCRIPT, ownerId: OWNER, speakerIds });

describe('VoiceprintAudioService', () => {
  let warn: jest.SpyInstance;
  let debug: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('skips the whole run', () => {
    it('with no speakers: nothing asked of anyone', async () => {
      const { service, voiceprints } = setup();
      await expect(compute(service, [])).resolves.toEqual({ speakers: [], skipped: null });
      expect(voiceprints.available).not.toHaveBeenCalled();
    });

    it('with no_ffmpeg when the transcripts slice has no ffmpeg service, before touching the port', async () => {
      const { service, voiceprints, prisma } = setup({ ffmpeg: false });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: 'no_ffmpeg' });
      expect(voiceprints.available).not.toHaveBeenCalled();
      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('with unavailable when the port cannot run', async () => {
      const { service, prisma } = setup({ available: false });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: 'unavailable' });
      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('propagates a model-download failure so the job retries', async () => {
      const { service, voiceprints } = setup();
      voiceprints.available.mockRejectedValue(new Error('download failed'));
      await expect(compute(service)).rejects.toThrow('download failed');
    });

    it('with no_audio when the transcript is gone, deleted or not the owner', async () => {
      const { service, prisma } = setup({ transcript: null });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: 'no_audio' });
      expect(prisma.transcript.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TRANSCRIPT, ownerId: OWNER, deletedAt: null } }),
      );
    });

    it('with no_audio when no object is ready', async () => {
      const { service, ffmpeg } = setup({ states: { [PLAYBACK]: 'pending', [SOURCE]: 'missing' } });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: 'no_audio' });
      expect(ffmpeg.decodePcm16kMono).not.toHaveBeenCalled();
    });

    it('with no_audio when the transcript has neither object', async () => {
      const { service } = setup({ transcript: { playbackObjectId: null, playbackStatus: 'none', sourceObjectId: null } });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: 'no_audio' });
    });
  });

  describe('which object is decoded', () => {
    it('prefers the playback rendition over the source when it is ready', async () => {
      const { service, store } = setup();
      await compute(service);
      expect(store.describe).toHaveBeenCalledWith([PLAYBACK, SOURCE]);
      expect(store.signedDownloadUrl).toHaveBeenCalledWith(PLAYBACK, { ttlSeconds: 3600 });
    });

    it('falls back to the source when the playback rendition is not ready', async () => {
      const { service, store } = setup({ states: { [PLAYBACK]: 'pending', [SOURCE]: 'ready' } });
      await compute(service);
      expect(store.signedDownloadUrl).toHaveBeenCalledWith(SOURCE, { ttlSeconds: 3600 });
    });

    it('ignores the playback object unless its status is ready', async () => {
      const { service, store } = setup({
        transcript: { playbackObjectId: PLAYBACK, playbackStatus: 'failed', sourceObjectId: SOURCE },
      });
      await compute(service);
      expect(store.describe).toHaveBeenCalledWith([SOURCE]);
      expect(store.signedDownloadUrl).toHaveBeenCalledWith(SOURCE, expect.anything());
    });
  });

  describe('windows and decoding', () => {
    it('reads the segments of the requested speakers only and decodes each speaker own windows', async () => {
      const { service, prisma, voiceprints, ffmpeg } = setup();
      const result = await compute(service, [SA, SB]);
      expect(prisma.transcriptSegment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { transcriptId: TRANSCRIPT, speakerId: { in: [SA, SB] } } }),
      );
      expect(voiceprints.selectWindows).toHaveBeenNthCalledWith(1, [{ speakerId: SA, startMs: 0, endMs: 5000 }]);
      expect(voiceprints.selectWindows).toHaveBeenNthCalledWith(2, [{ speakerId: SB, startMs: 5000, endMs: 11000 }]);
      expect(ffmpeg.decodePcm16kMono).toHaveBeenNthCalledWith(1, expect.objectContaining({ windows: [{ startMs: 0, endMs: 5000 }] }));
      expect(ffmpeg.decodePcm16kMono).toHaveBeenNthCalledWith(2, expect.objectContaining({ windows: [{ startMs: 5000, endMs: 11000 }] }));
      expect(result.skipped).toBeNull();
      expect(result.speakers.map((s) => [s.speakerId, s.speechMs])).toEqual([[SA, 5000], [SB, 6000]]);
    });

    it('hands ffmpeg the signed URL (a fresh one per speaker) and a bounded timeout', async () => {
      const { service, store, ffmpeg } = setup();
      await compute(service, [SA, SB]);
      expect(store.signedDownloadUrl).toHaveBeenCalledTimes(2);
      expect(ffmpeg.decodePcm16kMono).toHaveBeenCalledWith(expect.objectContaining({ input: SIGNED, timeoutMs: 240_000 }));
    });

    it('returns the embedding as a plain array with the speech it came from', async () => {
      const { service, voiceprints, ffmpeg } = setup();
      const decoded = new Float32Array([0.1, 0.2]);
      ffmpeg.decodePcm16kMono.mockResolvedValue(decoded);
      const result = await compute(service);
      expect(voiceprints.embed).toHaveBeenCalledWith(decoded);
      expect(result.speakers).toEqual([{ speakerId: SA, embedding: [0.5, 0.25], speechMs: 5000 }]);
    });

    it(`skips a speaker with less than ${VOICEPRINT_MIN_SPEECH_MS} ms of speech, without decoding`, async () => {
      const { service, ffmpeg } = setup({ speechMs: VOICEPRINT_MIN_SPEECH_MS - 1 });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: null });
      expect(ffmpeg.decodePcm16kMono).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(SA));
    });

    it('accepts exactly the minimum', async () => {
      const { service } = setup({ speechMs: VOICEPRINT_MIN_SPEECH_MS });
      expect((await compute(service)).speakers).toHaveLength(1);
    });

    it('skips a speaker with no window', async () => {
      const { service, ffmpeg } = setup({ windows: [], speechMs: 9000 });
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: null });
      expect(ffmpeg.decodePcm16kMono).not.toHaveBeenCalled();
    });

    it('skips a speaker whose decode came back empty, without embedding', async () => {
      const { service, ffmpeg, voiceprints } = setup();
      ffmpeg.decodePcm16kMono.mockResolvedValue(new Float32Array(0));
      await expect(compute(service)).resolves.toEqual({ speakers: [], skipped: null });
      expect(voiceprints.embed).not.toHaveBeenCalled();
    });
  });

  describe('failure containment', () => {
    it('one speaker failing to decode or embed does not lose the others, and the log names no URL', async () => {
      const { service, ffmpeg } = setup();
      ffmpeg.decodePcm16kMono.mockRejectedValueOnce(new Error(`ffmpeg failed for ${SIGNED}`));
      const result = await compute(service, [SA, SB]);
      expect(result.speakers.map((s) => s.speakerId)).toEqual([SB]);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain(SA);
      expect(logged).not.toContain('SECRET');
      expect(logged).not.toContain('store.example.test');
    });

    it('an embed failure is logged by class only', async () => {
      const { service, voiceprints } = setup();
      voiceprints.embed.mockRejectedValue(new RangeError('raw samples 0.123 0.456'));
      const result = await compute(service);
      expect(result.speakers).toEqual([]);
      expect(JSON.stringify(warn.mock.calls)).toContain('RangeError');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('0.123');
    });

    it('a failure to sign the URL skips that speaker only', async () => {
      const { service, store } = setup();
      store.signedDownloadUrl.mockRejectedValueOnce(new Error('store down'));
      const result = await compute(service, [SA, SB]);
      expect(result.speakers.map((s) => s.speakerId)).toEqual([SB]);
    });
  });
});

describe('toVectorLiteral', () => {
  it('is the pgvector text form', () => {
    expect(toVectorLiteral([0.5, -1, 2])).toBe('[0.5,-1,2]');
    expect(toVectorLiteral([])).toBe('[]');
  });
});
