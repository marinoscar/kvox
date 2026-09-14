import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderAuthError } from '../../transcription/errors';
import { TRANSCRIPTION_THROTTLE_KEY } from '../job-types';
import { MAX_POLL_DELAY_MS, MIN_POLL_DELAY_MS } from '../poll-schedule';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from './__fixtures__/fake-provider';
import { TranscriptionPollHandler } from './transcription-poll.handler';

// =============================================================================
// `transcription.poll` — the chain, the backoff and the deadline (issue #25)
// =============================================================================
//
// The acceptance criteria: the re-enqueue follows the backoff schedule,
// passing the deadline marks the transcript failed, a provider-side error is a
// domain failure and a 429 throws. The `skipDedup: true` itself is asserted in
// `transcript-pipeline.service.spec.ts`, where the call that carries it lives.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';
const NOW = new Date('2026-01-01T06:00:00.000Z');

const job = (payload: unknown = { transcriptId: TRANSCRIPT_ID }): Job =>
  ({ id: 'job-1', payload } as unknown as Job);

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'user-1',
  title: 'A recording',
  status: 'processing',
  transcriptionStatus: 'submitted',
  providerJobId: 'remote-1',
  durationMs: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T05:00:00.000Z'),
  submittedAt: new Date('2026-01-01T05:00:00.000Z'),
  ...overrides,
});

describe('TranscriptionPollHandler', () => {
  let handler: TranscriptionPollHandler;
  let provider: FakeProvider;
  let prisma: { transcript: { update: jest.Mock } };
  let pipeline: {
    loadForJob: jest.Mock;
    markFailed: jest.Mock;
    enqueuePoll: jest.Mock;
    enqueueIngest: jest.Mock;
  };
  let runtime: { resolve: jest.Mock };
  let registry: { register: jest.Mock };
  let throttle: { registerProviderKey: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW });

    provider = createFakeProvider();
    prisma = { transcript: { update: jest.fn().mockResolvedValue({}) } };

    pipeline = {
      loadForJob: jest.fn().mockResolvedValue(transcriptRow()),
      markFailed: jest.fn().mockResolvedValue(true),
      enqueuePoll: jest.fn().mockResolvedValue(undefined),
      enqueueIngest: jest.fn().mockResolvedValue(undefined),
    };

    runtime = {
      resolve: jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy: {} }),
    };

    registry = { register: jest.fn() };
    throttle = { registerProviderKey: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptionPollHandler,
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: ProviderThrottleService, useValue: throttle },
      ],
    }).compile();

    handler = module.get(TranscriptionPollHandler);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('self-registers and joins the shared provider throttle bucket', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(throttle.registerProviderKey).toHaveBeenCalledWith(
      'transcription.poll',
      TRANSCRIPTION_THROTTLE_KEY,
    );
  });

  it('declares a TINY runtime and a generous attempt budget', () => {
    // One poll is one HTTP round trip. A chain of short jobs, not one long one.
    expect(handler.profile).toEqual({ maxRuntimeMs: 120_000, maxAttempts: 5 });
  });

  describe('the chain', () => {
    it('re-enqueues itself while the provider is still working', async () => {
      provider.getStatus.mockResolvedValue('processing');

      await handler.process(job());

      expect(pipeline.enqueuePoll).toHaveBeenCalledWith(TRANSCRIPT_ID, MIN_POLL_DELAY_MS);
      expect(pipeline.enqueueIngest).not.toHaveBeenCalled();
    });

    it('follows the ×1.5 backoff from the previous delay in the payload', async () => {
      provider.getStatus.mockResolvedValue('queued');

      await handler.process(job({ transcriptId: TRANSCRIPT_ID, delayMs: 60_000 }));

      expect(pipeline.enqueuePoll).toHaveBeenCalledWith(TRANSCRIPT_ID, 90_000);
    });

    it('caps the backoff at five minutes', async () => {
      provider.getStatus.mockResolvedValue('queued');

      await handler.process(job({ transcriptId: TRANSCRIPT_ID, delayMs: 280_000 }));

      expect(pipeline.enqueuePoll).toHaveBeenCalledWith(TRANSCRIPT_ID, MAX_POLL_DELAY_MS);
    });

    it('records `processing` separately from `submitted`', async () => {
      // Two different facts: "it accepted the job" and "it is transcribing".
      provider.getStatus.mockResolvedValue('processing');

      await handler.process(job());

      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transcriptionStatus: 'processing' }),
        }),
      );
    });

    it('queues ingest and stops the chain when the provider is done', async () => {
      provider.getStatus.mockResolvedValue('completed');

      await handler.process(job());

      expect(pipeline.enqueueIngest).toHaveBeenCalledWith(TRANSCRIPT_ID);
      expect(pipeline.enqueuePoll).not.toHaveBeenCalled();
    });

    it.each([
      ['ready', { status: 'ready' }],
      ['failed', { status: 'failed' }],
      ['deleting', { status: 'deleting' }],
      ['cancelled', { transcriptionStatus: 'cancelled' }],
      ['already completed', { transcriptionStatus: 'completed' }],
    ] as Array<[string, Record<string, unknown>]>)(
      'ends quietly — not with a throw — for a %s transcript',
      async (_label, overrides) => {
        pipeline.loadForJob.mockResolvedValue(transcriptRow(overrides));

        await expect(handler.process(job())).resolves.toBeUndefined();
        expect(provider.getStatus).not.toHaveBeenCalled();
        expect(pipeline.enqueuePoll).not.toHaveBeenCalled();
      },
    );

    it('ends the chain rather than looping when there is nothing to poll', async () => {
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ providerJobId: null }));

      await handler.process(job());

      expect(pipeline.enqueuePoll).not.toHaveBeenCalled();
    });
  });

  describe('the hard deadline', () => {
    it('fails the transcript once `submittedAt + 6h` has passed', async () => {
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({ submittedAt: new Date('2025-12-31T23:00:00.000Z') }),
      );

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptId: TRANSCRIPT_ID,
          stage: 'transcription',
          reason: expect.stringContaining('6 hours'),
        }),
      );
      expect(provider.getStatus).not.toHaveBeenCalled();
    });

    it('gives a long recording `3 × duration` instead of the six-hour floor', async () => {
      // Submitted 7h ago with a 4h recording: the window is 12h, so this is
      // still well inside it.
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({
          submittedAt: new Date('2025-12-31T23:00:00.000Z'),
          durationMs: 4 * 60 * 60_000,
        }),
      );

      await handler.process(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(provider.getStatus).toHaveBeenCalled();
    });

    it('treats a missing `submittedAt` as `createdAt` rather than as no deadline', async () => {
      // The dangerous reading of a damaged row is the one that polls forever.
      pipeline.loadForJob.mockResolvedValue(
        transcriptRow({
          submittedAt: null,
          createdAt: new Date('2025-12-31T20:00:00.000Z'),
        }),
      );

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('records a provider-side error as a transcript failure and succeeds', async () => {
      provider.getStatus.mockResolvedValue('failed');

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'transcription' }),
      );
      expect(pipeline.enqueuePoll).not.toHaveBeenCalled();
    });

    it('rethrows a 429 so the shared throttle defers the whole bucket', async () => {
      provider.getStatus.mockRejectedValue(new RateLimitError('429', 1_000));

      await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

      // From the owner's point of view a rate limit is invisible backoff, not
      // a failure — so the transcript's own status is untouched.
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('records an auth failure as a domain failure', async () => {
      provider.getStatus.mockRejectedValue(new ProviderAuthError('Key revoked.'));

      await expect(handler.process(job())).resolves.toBeUndefined();
      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Key revoked.', retryable: true }),
      );
    });

    it('rethrows an unrecognised error rather than failing the transcript', async () => {
      provider.getStatus.mockRejectedValue(new Error('ECONNRESET'));

      await expect(handler.process(job())).rejects.toThrow('ECONNRESET');
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });
  });
});
