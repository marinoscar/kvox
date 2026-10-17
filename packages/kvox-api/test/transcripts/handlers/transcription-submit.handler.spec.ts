import { Test } from '@nestjs/testing';

import {
  KVOX_JOBS,
  KVOX_OBJECT_STORE,
  KVOX_PRISMA,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxObjectInfo,
} from '../../../src/ports/index.js';
import { ProviderAuthError, ProviderInputError, RateLimitError } from '../../../src/transcription/index.js';
import { TRANSCRIPTION_THROTTLE_KEY } from '../../../src/transcripts/job-types.js';
import { TranscriptPipelineService } from '../../../src/transcripts/transcript-pipeline.service.js';
import { TranscriptionRuntimeService } from '../../../src/transcripts/transcription-runtime.service.js';
import { createFakeProvider, type FakeProvider } from '../../../src/transcripts/handlers/__fixtures__/fake-provider.js';
import {
  readSpeakersExpected,
  TranscriptionSubmitHandler,
} from '../../../src/transcripts/handlers/transcription-submit.handler.js';

// =============================================================================
// `transcription.submit` — the four acceptance criteria (issue #25)
// =============================================================================
//
//   • idempotent when `provider_job_id` is already set;
//   • the URL is presigned WHEN THE JOB RUNS, not when it was enqueued;
//   • an auth or input error marks the transcript failed while the JOB
//     SUCCEEDS — no attempt is spent re-asking a question whose answer cannot
//     change;
//   • a 429 propagates as `RateLimitError` so the queue defers it.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const job = (payload: unknown = { transcriptId: TRANSCRIPT_ID }): KvoxJob =>
  ({ id: 'job-1', payload } as unknown as KvoxJob);

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'user-1',
  title: 'A recording',
  status: 'processing',
  transcriptionStatus: 'queued',
  playbackStatus: 'pending',
  sourceObjectId: 'obj-1',
  playbackObjectId: null,
  providerJobId: null,
  provider: 'fake',
  providerOptions: { speakersExpected: 3 },
  language: null,
  durationMs: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  submittedAt: null,
  ...overrides,
});

/** What the object store reports about a stored object. */
const stored = (overrides: Partial<KvoxObjectInfo> = {}): KvoxObjectInfo => ({
  id: 'obj-1',
  name: 'a.mp3',
  mimeType: 'audio/mpeg',
  size: 1_000_000,
  state: 'ready',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const sourceObject = stored();

describe('TranscriptionSubmitHandler', () => {
  let handler: TranscriptionSubmitHandler;
  let provider: FakeProvider;
  let objects: Map<string, KvoxObjectInfo>;
  let prisma: {
    transcript: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
  };
  let pipeline: {
    loadForJob: jest.Mock;
    markFailed: jest.Mock;
    enqueueFirstPoll: jest.Mock;
  };
  let runtime: { resolve: jest.Mock };
  let storage: { describe: jest.Mock; signedDownloadUrl: jest.Mock; openRead: jest.Mock };
  let registry: { registerHandler: jest.Mock; enqueue: jest.Mock; isRegistered: jest.Mock };
  let policy: Record<string, unknown>;

  beforeEach(async () => {
    provider = createFakeProvider();
    policy = {
      audioDelivery: 'presigned_url',
      presignedUrlTtlMinutes: 360,
      defaultLanguage: null,
      deleteRemoteAfterIngest: true,
    };

    objects = new Map([['obj-1', sourceObject]]);

    prisma = {
      transcript: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
    };

    pipeline = {
      loadForJob: jest.fn().mockResolvedValue(transcriptRow()),
      markFailed: jest.fn().mockResolvedValue(true),
      enqueueFirstPoll: jest.fn().mockResolvedValue(undefined),
    };

    runtime = {
      resolve: jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy }),
    };

    storage = {
      describe: jest.fn(async (ids: readonly string[]) => new Map(ids.flatMap((id) => (objects.has(id) ? [[id, objects.get(id)]] : [])))),
      signedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/audio'),
      openRead: jest.fn(),
    };

    registry = { registerHandler: jest.fn(), enqueue: jest.fn(), isRegistered: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptionSubmitHandler,
        { provide: KVOX_JOBS, useValue: registry },
        { provide: KVOX_PRISMA, useValue: prisma },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: KVOX_OBJECT_STORE, useValue: storage },
      ],
    }).compile();

    handler = module.get(TranscriptionSubmitHandler);
  });

  describe('registration', () => {
    it('self-registers and shares the one provider throttle bucket', () => {
      handler.onModuleInit();

      expect(registry.registerHandler).toHaveBeenCalledWith(handler);
      // The host registers the key with its provider throttle when it registers the handler.
      expect(handler.throttleKey).toBe(TRANSCRIPTION_THROTTLE_KEY);
    });

    it('declares the two-hour, three-attempt profile and NO node members', () => {
      // Node-eligibility is DERIVED from `nodeResultSchema` + `persistNodeResult`
      // (CLAUDE.md rule 2); this type is server-only under rule 3, and the way
      // that is expressed is the absence of both.
      expect(handler.profile).toEqual({ maxRuntimeMs: 7_200_000, maxAttempts: 3 });

      const asHandler = handler as KvoxJobHandler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
    });
  });

  describe('the happy path', () => {
    it('signs the URL when the job runs and submits the original', async () => {
      await handler.process(job());

      // ⚠ THE ACCEPTANCE CRITERION: signed HERE, during `process`, not at
      // enqueue time. A URL signed when the job was queued is that much closer
      // to expiry by the time the provider reads bytes.
      expect(storage.signedDownloadUrl).toHaveBeenCalledWith('obj-1', {
        ttlSeconds: 360 * 60,
      });

      expect(provider.submit).toHaveBeenCalledWith(
        { apiKey: 'k' },
        expect.objectContaining({
          audio: { kind: 'url', url: 'https://signed.example/audio' },
        }),
      );
    });

    it('records the provider handle IMMEDIATELY, before the poll is queued', async () => {
      const order: string[] = [];

      prisma.transcript.update.mockImplementation(async (args: { data: { providerJobId?: string } }) => {
        if (args.data.providerJobId) order.push('saved-handle');
        return {};
      });
      pipeline.enqueueFirstPoll.mockImplementation(async () => {
        order.push('queued-poll');
      });

      await handler.process(job());

      // A process killed between the two must find the handle on retry, not
      // submit a second remote job for one recording.
      expect(order).toEqual(['saved-handle', 'queued-poll']);
    });

    it('passes the speakers hint out of provider_options and asks for detection', async () => {
      await handler.process(job());

      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          options: {
            language: null,
            detectLanguage: true,
            speakersExpected: 3,
            // A row with no stored keyterms (every row before #327) sends none.
            keyterms: [],
          },
        }),
      );
    });

    it('passes the stored keyterms out of provider_options (#327)', async () => {
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({
          providerOptions: { speakersExpected: 3, keyterms: ['Kvox', 'Oscar Marín'] },
        }),
      );

      await handler.process(job());

      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          options: expect.objectContaining({ keyterms: ['Kvox', 'Oscar Marín'] }),
        }),
      );
    });

    it("clamps the stored keyterms to the provider's own limits (#327)", async () => {
      provider = createFakeProvider({ keyterms: { maxTerms: 1, maxWordsPerTerm: 2 } });
      runtime.resolve.mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy });
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({
          providerOptions: { keyterms: ['three word phrase', 'Kvox', 'Second'] },
        }),
      );

      await handler.process(job());

      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          options: expect.objectContaining({ keyterms: ['Kvox'] }),
        }),
      );
    });

    it('silently drops keyterms for a provider without the capability, leaving them stored (#327)', async () => {
      provider = createFakeProvider({ keyterms: null });
      runtime.resolve.mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy });
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({ providerOptions: { keyterms: ['Kvox'] } }),
      );

      await handler.process(job());

      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          options: expect.objectContaining({ keyterms: [] }),
        }),
      );
      // The job never rewrites provider_options: the stored terms survive for a
      // later retry against a provider that can take them.
      for (const [arg] of prisma.transcript.update.mock.calls) {
        expect(arg.data).not.toHaveProperty('providerOptions');
      }
    });

    it('forces the language and turns detection off when one is chosen', async () => {
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ language: 'es' }));

      await handler.process(job());

      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          options: expect.objectContaining({ language: 'es', detectLanguage: false }),
        }),
      );
    });

    it('relays the bytes itself in `upload` delivery mode', async () => {
      policy.audioDelivery = 'upload';
      storage.openRead.mockResolvedValue('a-readable');
      // In `upload` mode the ORIGINAL is not chosen (see
      // `selectTranscriptionInput`), so a ready rendition has to exist.
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({ playbackObjectId: 'obj-2', playbackStatus: 'ready' }),
      );
      objects.set('obj-2', stored({ id: 'obj-2', mimeType: 'audio/mp4', size: 90_000 }));

      await handler.process(job());

      expect(storage.openRead).toHaveBeenCalledWith('obj-2');
      expect(provider.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          audio: { kind: 'stream', stream: 'a-readable', size: 90_000, mimeType: 'audio/mp4' },
        }),
      );
    });
  });

  describe('idempotency', () => {
    it('skips submission entirely when a provider job id is already set', async () => {
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ providerJobId: 'remote-9' }));

      await handler.process(job());

      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.enqueueFirstPoll).toHaveBeenCalledWith(TRANSCRIPT_ID, null);
    });

    it('does not even resolve the provider credential on that path', async () => {
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ providerJobId: 'remote-9' }));

      await handler.process(job());

      expect(runtime.resolve).not.toHaveBeenCalled();
    });
  });

  describe('domain failures spend no attempt', () => {
    it.each([
      ['a bad key', new ProviderAuthError('The API key was refused.')],
      ['a rejected file', new ProviderInputError('That audio is corrupt.')],
    ] as Array<[string, Error]>)(
      'records %s as a transcript failure and RETURNS NORMALLY',
      async (_label, error) => {
        provider.submit.mockRejectedValue(error);

        // The job SUCCEEDS: it correctly determined a permanent outcome.
        await expect(handler.process(job())).resolves.toBeUndefined();

        expect(pipeline.markFailed).toHaveBeenCalledWith(
          expect.objectContaining({
            transcriptId: TRANSCRIPT_ID,
            reason: error.message,
            stage: 'transcription',
          }),
        );
        expect(pipeline.enqueueFirstPoll).not.toHaveBeenCalled();
      },
    );

    it('fails on the FIRST attempt when the deployment is unconfigured', async () => {
      runtime.resolve.mockRejectedValue(
        new ProviderAuthError('Transcription is turned off for this deployment.'),
      );

      await expect(handler.process(job())).resolves.toBeUndefined();
      expect(pipeline.markFailed).toHaveBeenCalled();
    });
  });

  describe('retryable failures', () => {
    it('rethrows a 429 so the queue defers it without spending an attempt', async () => {
      provider.submit.mockRejectedValue(new RateLimitError(TRANSCRIPTION_THROTTLE_KEY, 30_000, 'Slow down'));

      await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('rethrows an unrecognised error rather than failing the transcript', async () => {
      // "Positively identify, otherwise assume retryable" — one wasted attempt
      // beats a permanently failed transcript on a transient condition.
      provider.submit.mockRejectedValue(new Error('socket hang up'));

      await expect(handler.process(job())).rejects.toThrow('socket hang up');
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('states that make the job a no-op', () => {
    it.each([
      ['no live transcript', null],
      ['a failed transcript', transcriptRow({ status: 'failed' })],
      ['a deleting transcript', transcriptRow({ status: 'deleting' })],
      ['a cancelled transcription', transcriptRow({ transcriptionStatus: 'cancelled' })],
    ] as Array<[string, unknown]>)('returns quietly for %s', async (_label, row) => {
      pipeline.loadForJob.mockResolvedValue(row);

      await expect(handler.process(job())).resolves.toBeUndefined();
      expect(provider.submit).not.toHaveBeenCalled();
    });
  });

  describe('input selection at run time', () => {
    it('waits rather than failing when no acceptable input exists yet', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      objects.set('obj-1', stored({ mimeType: 'audio/amr' }));

      await handler.process(job());

      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { transcriptionStatus: 'waiting_input' } }),
      );
    });

    it('fails permanently when no rendition is coming and the original is unusable', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      objects.set('obj-1', stored({ mimeType: 'audio/amr' }));
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ playbackStatus: 'failed' }));

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ retryable: false }),
      );
    });

    it('refuses a recording over the provider\'s duration ceiling, before submitting', async () => {
      // The only point where knowing the duration is still worth acting on:
      // the provider has not been asked to do anything yet, so refusing costs
      // nothing and saves the bill.
      provider.capabilities.maxDurationMs = 60 * 60_000;
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ durationMs: 3 * 60 * 60_000 }));

      await handler.process(job());

      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: false,
          reason: expect.stringContaining('180 minutes long'),
        }),
      );
    });

    it('submits a recording whose duration is not yet known', async () => {
      // `duration_ms` is null until #26's probe or the provider's own
      // `audio_duration` fills it in, and an unknown length must not block the
      // submission that would measure it.
      await handler.process(job());

      expect(provider.submit).toHaveBeenCalled();
    });

    it('fails when the uploaded audio has vanished from storage', async () => {
      objects.clear();

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'upload', retryable: false }),
      );
    });
  });
});

describe('readSpeakersExpected', () => {
  it('reads a positive integer hint', () => {
    expect(readSpeakersExpected({ speakersExpected: 4 })).toBe(4);
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'four'],
    ['a fraction', { speakersExpected: 2.5 }],
    ['zero', { speakersExpected: 0 }],
    ['an absent key', {}],
  ] as Array<[string, unknown]>)('is null for %s — a hint nobody can read is no opinion', (_label, value) => {
    expect(readSpeakersExpected(value)).toBeNull();
  });
});
