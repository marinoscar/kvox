import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRANSCODE_JOB_TYPE,
  TRANSCRIPT_SNAPSHOT_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
} from './job-types';
import {
  readPollDelayMs,
  readTranscriptId,
  TranscriptPipelineService,
} from './transcript-pipeline.service';

// =============================================================================
// TranscriptPipelineService — the rules that are invisible at a call site
// =============================================================================
//
// ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE is the one about
// `skipDedup: true` on the poll re-enqueue. Without it, `enqueue()` collides
// with the RUNNING poll job that is calling it — same type, same subject, both
// matching the active-dedup predicate — silently returns that row with its
// `scheduledFor` UNCHANGED, and the transcript sits in `submitted` forever
// with no error anywhere. It is not an optimisation. A regression here has no
// other symptom.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

describe('TranscriptPipelineService', () => {
  let service: TranscriptPipelineService;
  let jobs: { enqueue: jest.Mock };
  let registry: { get: jest.Mock };
  let prisma: {
    transcript: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
  };
  let notifications: { notify: jest.Mock };

  beforeEach(async () => {
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-9' }) };
    registry = { get: jest.fn().mockReturnValue(undefined) };

    prisma = {
      transcript: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: TRANSCRIPT_ID,
          ownerId: 'user-1',
          title: 'A recording',
        }),
      },
    };

    notifications = { notify: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptPipelineService,
        { provide: PrismaService, useValue: prisma },
        { provide: JobsService, useValue: jobs },
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('https://app.example.com/') },
        },
      ],
    }).compile();

    service = module.get(TranscriptPipelineService);
  });

  describe('enqueuePoll', () => {
    it('passes `skipDedup: true` — the re-enqueue would otherwise merge into itself', async () => {
      await service.enqueuePoll(TRANSCRIPT_ID, 90_000);

      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: TRANSCRIPTION_POLL_JOB_TYPE,
          subjectType: TRANSCRIPT_SUBJECT_TYPE,
          subjectId: TRANSCRIPT_ID,
          skipDedup: true,
        }),
      );
    });

    it('schedules the next check at the computed delay and carries it forward', async () => {
      const before = Date.now();

      await service.enqueuePoll(TRANSCRIPT_ID, 90_000);

      const [input] = jobs.enqueue.mock.calls[0];

      expect(input.payload).toEqual({ transcriptId: TRANSCRIPT_ID, delayMs: 90_000 });
      expect(input.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 90_000);
    });

    it('opens a chain at the duration-proportional first delay', async () => {
      await service.enqueueFirstPoll(TRANSCRIPT_ID, 20 * 60_000);

      expect(jobs.enqueue.mock.calls[0][0].payload).toEqual({
        transcriptId: TRANSCRIPT_ID,
        delayMs: 60_000,
      });
    });
  });

  describe('guarded enqueues for handlers other issues own', () => {
    it('queues nothing for `media.audio.transcode` until #26 registers it', async () => {
      // A `pending` row no worker can claim would sit in the admin job list
      // forever as a permanent backlog of one.
      const queued = await service.enqueueTranscode({
        id: TRANSCRIPT_ID,
        sourceObjectId: 'obj-1',
      } as never);

      expect(queued).toBe(false);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('queues it against the STORAGE OBJECT once a handler exists', async () => {
      // `subjectType: 'storage_object'` is spec §1.5.1 and is load-bearing: it
      // makes the job reuse the node data plane's existing input resolver.
      registry.get.mockImplementation((type: string) =>
        type === TRANSCODE_JOB_TYPE ? {} : undefined,
      );

      const queued = await service.enqueueTranscode({
        id: TRANSCRIPT_ID,
        sourceObjectId: 'obj-1',
      } as never);

      expect(queued).toBe(true);
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: TRANSCODE_JOB_TYPE,
          subjectType: 'storage_object',
          subjectId: 'obj-1',
          payload: { transcriptId: TRANSCRIPT_ID },
        }),
      );
    });

    it('queues nothing for `transcript.snapshot` until #27 registers it', async () => {
      await expect(service.enqueueSnapshot(TRANSCRIPT_ID, 1)).resolves.toBe(false);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('queues the snapshot once a handler exists', async () => {
      registry.get.mockImplementation((type: string) =>
        type === TRANSCRIPT_SNAPSHOT_JOB_TYPE ? {} : undefined,
      );

      await expect(service.enqueueSnapshot(TRANSCRIPT_ID, 1)).resolves.toBe(true);
    });
  });

  describe('markFailed', () => {
    it('guards on the row not already being terminal, in the UPDATE itself', async () => {
      // Two stages failing one transcript concurrently must produce ONE
      // failure and ONE notification. A `findFirst` before the update cannot
      // close that race; the predicate in the write can.
      await service.markFailed({
        transcriptId: TRANSCRIPT_ID,
        reason: 'Timed out.',
        stage: 'transcription',
      });

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: TRANSCRIPT_ID,
            status: { notIn: ['failed', 'deleting'] },
          }),
        }),
      );
    });

    it('reports false and notifies nobody when another caller got there first', async () => {
      prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markFailed({
          transcriptId: TRANSCRIPT_ID,
          reason: 'Timed out.',
          stage: 'transcription',
        }),
      ).resolves.toBe(false);

      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('writes the sub-pipeline status too, so the stepper agrees with the row', async () => {
      await service.markFailed({
        transcriptId: TRANSCRIPT_ID,
        reason: 'Timed out.',
        stage: 'transcription',
      });

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed', transcriptionStatus: 'failed' }),
        }),
      );
    });

    it('leaves `transcription_status` alone for an upload-stage failure', async () => {
      await service.markFailed({
        transcriptId: TRANSCRIPT_ID,
        reason: 'The upload never completed.',
        stage: 'upload',
      });

      expect(prisma.transcript.updateMany.mock.calls[0][0].data).not.toHaveProperty(
        'transcriptionStatus',
      );
    });

    it('notifies THE OWNER, with a reader-facing stage label and the reason', async () => {
      await service.markFailed({
        transcriptId: TRANSCRIPT_ID,
        reason: 'The provider rejected this audio.',
        stage: 'ingest',
        retryable: false,
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        'transcripts.transcript_failed',
        'user-1',
        expect.objectContaining({
          transcriptId: TRANSCRIPT_ID,
          reason: 'The provider rejected this audio.',
          stage: 'Saving the transcript',
          retryable: false,
          appUrl: 'https://app.example.com',
        }),
      );
    });
  });

  describe('notifyReady', () => {
    it('addresses the owner alone and names the provider', async () => {
      await service.notifyReady(
        {
          id: TRANSCRIPT_ID,
          ownerId: 'user-1',
          title: 'A recording',
          durationMs: 120_000,
          speakerCount: 2,
          wordCount: 400,
        },
        'Fake Provider',
      );

      expect(notifications.notify).toHaveBeenCalledWith(
        'transcripts.transcript_ready',
        'user-1',
        expect.objectContaining({ providerLabel: 'Fake Provider', wordCount: 400 }),
      );
    });
  });

  describe('loadForJob', () => {
    it('returns null for a soft-deleted transcript', async () => {
      prisma.transcript.findUnique.mockResolvedValue({ id: TRANSCRIPT_ID, deletedAt: new Date() });

      await expect(
        service.loadForJob({ transcriptId: TRANSCRIPT_ID } as never),
      ).resolves.toBeNull();
    });
  });
});

describe('readTranscriptId', () => {
  it('reads the id out of a well-formed payload', () => {
    expect(readTranscriptId({ transcriptId: 'abc' } as never)).toBe('abc');
  });

  it.each([
    ['null', null],
    ['an array', ['abc']],
    ['a string', 'abc'],
    ['an empty id', { transcriptId: '' }],
    ['a numeric id', { transcriptId: 7 }],
  ] as Array<[string, unknown]>)('is null for %s — the job is about nothing', (_label, value) => {
    expect(readTranscriptId(value as never)).toBeNull();
  });
});

describe('readPollDelayMs', () => {
  it('reads a positive delay', () => {
    expect(readPollDelayMs({ delayMs: 90_000 } as never)).toBe(90_000);
  });

  it.each([
    ['null', null],
    ['a negative delay', { delayMs: -1 }],
    ['a string delay', { delayMs: '90000' }],
    ['an absent key', {}],
  ] as Array<[string, unknown]>)('is null for %s', (_label, value) => {
    expect(readPollDelayMs(value as never)).toBeNull();
  });
});
