import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionSettingsService } from '../../transcription/transcription-settings.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import {
  decideAbandonedUpload,
  TranscriptsHousekeepingHandler,
} from './transcripts-housekeeping.handler';

// =============================================================================
// `transcripts.housekeeping` — the reconciliation sweep (issue #25, §1.5.8)
// =============================================================================
//
// The acceptance criterion is "housekeeping restarts an orphaned poll chain",
// and the rest of this file pins the two properties that keep a sweep useful:
// it does not act on a transcript whose chain is merely BETWEEN two links, and
// one failing step does not stop the other two from running.
// =============================================================================

const job = (): Job => ({ id: 'job-1', payload: null } as unknown as Job);

describe('TranscriptsHousekeepingHandler', () => {
  let handler: TranscriptsHousekeepingHandler;
  let prisma: {
    transcript: { findMany: jest.Mock; updateMany: jest.Mock };
    job: { findMany: jest.Mock };
    storageObject: { findMany: jest.Mock };
    transcriptExport: { findMany: jest.Mock; update: jest.Mock; delete: jest.Mock };
  };
  let pipeline: { enqueueFirstPoll: jest.Mock; markFailed: jest.Mock; enqueuePurge: jest.Mock };
  let objects: { deleteIfPresent: jest.Mock };
  let transcriptionSettings: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      transcript: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { findMany: jest.fn().mockResolvedValue([]) },
      storageObject: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptExport: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    };

    pipeline = {
      enqueueFirstPoll: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(true),
      enqueuePurge: jest.fn().mockResolvedValue(undefined),
    };

    transcriptionSettings = {
      get: jest.fn().mockResolvedValue({ abandonedUploadHours: 3 }),
    };

    objects = { deleteIfPresent: jest.fn().mockResolvedValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsHousekeepingHandler,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptObjectsService, useValue: objects },
        { provide: TranscriptionSettingsService, useValue: transcriptionSettings },
      ],
    }).compile();

    handler = module.get(TranscriptsHousekeepingHandler);
  });

  describe('restarting a lost poll chain', () => {
    /** A transcript waiting on the provider, older than the grace window. */
    const waiting = [
      { id: 't-1', durationMs: 60_000, lastPolledAt: null },
      { id: 't-2', durationMs: null, lastPolledAt: null },
    ];

    it('queues a fresh poll for a transcript with no live poll job', async () => {
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'processing' ? waiting : [],
      );

      await handler.process(job());

      expect(pipeline.enqueueFirstPoll).toHaveBeenCalledTimes(2);
      expect(pipeline.enqueueFirstPoll).toHaveBeenCalledWith('t-1', 60_000, 'rerun');
    });

    it('leaves alone a transcript whose chain is merely between two links', async () => {
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'processing' ? waiting : [],
      );
      prisma.job.findMany.mockResolvedValue([{ subjectId: 't-1' }]);

      await handler.process(job());

      expect(pipeline.enqueueFirstPoll).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueueFirstPoll).toHaveBeenCalledWith('t-2', null, 'rerun');
    });

    it('asks for every candidate\'s jobs in ONE query, not one per transcript', async () => {
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'processing' ? waiting : [],
      );

      await handler.process(job());

      expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ subjectId: { in: ['t-1', 't-2'] } }),
        }),
      );
    });
  });

  describe('purging abandoned uploads (issue #322)', () => {
    const HOUR = 3_600_000;
    const stuck = [{ id: 't-9', status: 'uploading', sourceObjectId: 'obj-9' }];

    /** Step 2 is the only query with an `OR`; step 1 filters on `status`. */
    const step2Returns = (rows: unknown[]) =>
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { OR?: unknown } }) => (where.OR ? rows : []),
      );

    it('purges a transcript whose upload record is gone', async () => {
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
        where: { id: 't-9', deletedAt: null, status: 'uploading' },
        data: { status: 'deleting', deletedAt: expect.any(Date) },
      });
      expect(pipeline.enqueuePurge).toHaveBeenCalledWith('t-9');
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('purges one whose upload has been idle past the configured window', async () => {
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-9', status: 'uploading', updatedAt: new Date(Date.now() - 4 * HOUR) },
      ]);

      await handler.process(job());

      expect(pipeline.enqueuePurge).toHaveBeenCalledWith('t-9');
    });

    it('KEEPS one whose upload was touched recently, however old the transcript', async () => {
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-9', status: 'uploading', updatedAt: new Date(Date.now() - 10 * 60_000) },
      ]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
    });

    it('REFUSES to purge one whose audio is present and ready', async () => {
      // That is a different bug — a missed upload event — and purging a
      // transcript whose audio is fine would destroy the one thing worth
      // keeping.
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-9', status: 'ready', updatedAt: new Date(0) },
      ]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
    });

    it('does not enqueue when the conditional soft-delete loses the race', async () => {
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([]);
      prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

      await handler.process(job());

      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
    });

    it('falls back to the default window when the settings read fails', async () => {
      transcriptionSettings.get.mockRejectedValue(new Error('db down'));
      step2Returns(stuck);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-9', status: 'pending', updatedAt: new Date(Date.now() - 4 * HOUR) },
      ]);

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(pipeline.enqueuePurge).toHaveBeenCalledWith('t-9');
    });
  });

  describe('decideAbandonedUpload', () => {
    const cutoff = new Date('2026-01-01T12:00:00Z');
    const before = new Date('2026-01-01T11:00:00Z');
    const after = new Date('2026-01-01T13:00:00Z');

    it.each([
      ['uploading', undefined, 'purge'],
      ['uploading', { status: 'failed', updatedAt: after }, 'purge'],
      ['uploading', { status: 'pending', updatedAt: before }, 'purge'],
      ['uploading', { status: 'uploading', updatedAt: after }, 'keep'],
      ['uploading', { status: 'ready', updatedAt: before }, 'audio_present'],
      ['uploading', { status: 'processing', updatedAt: before }, 'audio_present'],
      ['failed', undefined, 'purge'],
      ['failed', { status: 'uploading', updatedAt: after }, 'purge'],
      ['failed', { status: 'ready', updatedAt: before }, 'audio_present'],
      ['failed', { status: 'processing', updatedAt: before }, 'audio_present'],
    ] as const)('%s transcript, object %j → %s', (status, object, expected) => {
      expect(decideAbandonedUpload(status, object, cutoff)).toBe(expected);
    });
  });

  describe('expiring exports', () => {
    it('clears the reference, deletes the bytes, then the row — in that order', async () => {
      const order: string[] = [];

      prisma.transcriptExport.findMany.mockResolvedValue([
        { id: 'export-1', objectId: 'obj-export' },
      ]);
      prisma.transcriptExport.update.mockImplementation(async () => {
        order.push('clear-reference');
        return {};
      });
      objects.deleteIfPresent.mockImplementation(async () => {
        order.push('delete-bytes');
        return true;
      });
      prisma.transcriptExport.delete.mockImplementation(async () => {
        order.push('delete-row');
        return {};
      });

      await handler.process(job());

      // `object_id` is `Restrict`: the storage row cannot go while the export
      // points at it.
      expect(order).toEqual(['clear-reference', 'delete-bytes', 'delete-row']);
    });
  });

  describe('containment', () => {
    it('runs every step even when one of them throws, then reports', async () => {
      prisma.transcript.findMany.mockRejectedValueOnce(new Error('chain step exploded'));
      prisma.transcriptExport.findMany.mockResolvedValue([
        { id: 'export-1', objectId: null },
      ]);

      // Thrown so the sweep is retried and visible in the admin job list — but
      // only AFTER every step has had its turn.
      await expect(handler.process(job())).rejects.toThrow('chain step exploded');

      expect(prisma.transcriptExport.delete).toHaveBeenCalled();
    });

    it('succeeds quietly when there is nothing to do', async () => {
      await expect(handler.process(job())).resolves.toBeUndefined();
    });
  });
});
