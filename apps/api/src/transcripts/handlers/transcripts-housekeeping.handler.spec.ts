import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptsHousekeepingHandler } from './transcripts-housekeeping.handler';

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
    transcript: { findMany: jest.Mock };
    job: { findMany: jest.Mock };
    storageObject: { findMany: jest.Mock };
    transcriptExport: { findMany: jest.Mock; update: jest.Mock; delete: jest.Mock };
  };
  let pipeline: { enqueueFirstPoll: jest.Mock; markFailed: jest.Mock };
  let objects: { deleteIfPresent: jest.Mock };

  beforeEach(async () => {
    prisma = {
      transcript: { findMany: jest.fn().mockResolvedValue([]) },
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
    };

    objects = { deleteIfPresent: jest.fn().mockResolvedValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsHousekeepingHandler,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptObjectsService, useValue: objects },
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

  describe('failing abandoned uploads', () => {
    const stuck = [{ id: 't-9', sourceObjectId: 'obj-9' }];

    it('fails a transcript whose upload record has been cleaned up', async () => {
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'uploading' ? stuck : [],
      );
      prisma.storageObject.findMany.mockResolvedValue([]);

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptId: 't-9',
          stage: 'upload',
          retryable: false,
          reason: expect.stringContaining('cleaned up'),
        }),
      );
    });

    it('fails one whose upload is still sitting `pending`, naming the status', async () => {
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'uploading' ? stuck : [],
      );
      prisma.storageObject.findMany.mockResolvedValue([{ id: 'obj-9', status: 'pending' }]);

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.stringContaining("'pending'") }),
      );
    });

    it('REFUSES to fail one whose audio is present and ready', async () => {
      // That is a different bug — a missed upload event — and failing a
      // transcript whose audio is fine would destroy the one thing worth
      // keeping.
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          where.status === 'uploading' ? stuck : [],
      );
      prisma.storageObject.findMany.mockResolvedValue([{ id: 'obj-9', status: 'ready' }]);

      await handler.process(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
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
