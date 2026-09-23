import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { ProviderAuthError, ProviderInputError } from '../../transcription/errors';
import { TRANSCRIPTION_THROTTLE_KEY } from '../job-types';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from './__fixtures__/fake-provider';
import {
  readSpeakersExpected,
  TranscriptionSubmitHandler,
} from './transcription-submit.handler';

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

const job = (payload: unknown = { transcriptId: TRANSCRIPT_ID }): Job =>
  ({ id: 'job-1', payload } as unknown as Job);

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

const sourceObject = {
  id: 'obj-1',
  mimeType: 'audio/mpeg',
  size: BigInt(1_000_000),
  storageKey: 'uploads/1/a.mp3',
};

describe('TranscriptionSubmitHandler', () => {
  let handler: TranscriptionSubmitHandler;
  let provider: FakeProvider;
  let prisma: {
    transcript: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
    storageObject: { findUnique: jest.Mock };
  };
  let pipeline: {
    loadForJob: jest.Mock;
    markFailed: jest.Mock;
    enqueueFirstPoll: jest.Mock;
  };
  let runtime: { resolve: jest.Mock };
  let storage: { getSignedDownloadUrl: jest.Mock; download: jest.Mock };
  let registry: { register: jest.Mock };
  let throttle: { registerProviderKey: jest.Mock };
  let policy: Record<string, unknown>;

  beforeEach(async () => {
    provider = createFakeProvider();
    policy = {
      audioDelivery: 'presigned_url',
      presignedUrlTtlMinutes: 360,
      defaultLanguage: null,
      deleteRemoteAfterIngest: true,
    };

    prisma = {
      transcript: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      storageObject: { findUnique: jest.fn().mockResolvedValue(sourceObject) },
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
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/audio'),
      download: jest.fn(),
    };

    registry = { register: jest.fn() };
    throttle = { registerProviderKey: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptionSubmitHandler,
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: ProviderThrottleService, useValue: throttle },
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();

    handler = module.get(TranscriptionSubmitHandler);
  });

  describe('registration', () => {
    it('self-registers and shares the one provider throttle bucket', () => {
      handler.onModuleInit();

      expect(registry.register).toHaveBeenCalledWith(handler);
      expect(throttle.registerProviderKey).toHaveBeenCalledWith(
        'transcription.submit',
        TRANSCRIPTION_THROTTLE_KEY,
      );
    });

    it('declares the two-hour, three-attempt profile and NO node members', () => {
      // Node-eligibility is DERIVED from `nodeResultSchema` + `persistNodeResult`
      // (CLAUDE.md rule 2); this type is server-only under rule 3, and the way
      // that is expressed is the absence of both.
      expect(handler.profile).toEqual({ maxRuntimeMs: 7_200_000, maxAttempts: 3 });

      const asHandler = handler as JobHandler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
    });
  });

  describe('the happy path', () => {
    it('signs the URL when the job runs and submits the original', async () => {
      await handler.process(job());

      // ⚠ THE ACCEPTANCE CRITERION: signed HERE, during `process`, not at
      // enqueue time. A URL signed when the job was queued is that much closer
      // to expiry by the time the provider reads bytes.
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('uploads/1/a.mp3', {
        expiresIn: 360 * 60,
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
      storage.download.mockResolvedValue('a-readable');
      // In `upload` mode the ORIGINAL is not chosen (see
      // `selectTranscriptionInput`), so a ready rendition has to exist.
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({ playbackObjectId: 'obj-2', playbackStatus: 'ready' }),
      );
      prisma.storageObject.findUnique.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'obj-2'
            ? { id: 'obj-2', mimeType: 'audio/mp4', size: BigInt(90_000), storageKey: 'r/1.m4a' }
            : sourceObject,
      );

      await handler.process(job());

      expect(storage.download).toHaveBeenCalledWith('r/1.m4a');
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
      provider.submit.mockRejectedValue(new RateLimitError('Slow down', 30_000));

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
      prisma.storageObject.findUnique.mockResolvedValue({
        ...sourceObject,
        mimeType: 'audio/amr',
      });

      await handler.process(job());

      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { transcriptionStatus: 'waiting_input' } }),
      );
    });

    it('fails permanently when no rendition is coming and the original is unusable', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      prisma.storageObject.findUnique.mockResolvedValue({
        ...sourceObject,
        mimeType: 'audio/amr',
      });
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
      prisma.storageObject.findUnique.mockResolvedValue(null);

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
