import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionSettingsService } from '../../transcription/transcription-settings.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import {
  ABORT_RECONCILE_BATCH,
  decideAbandonedUpload,
  decideAbortedUpload,
  TranscriptsHousekeepingHandler,
} from './transcripts-housekeeping.handler';
import { JobHandlerRegistry, JobScope } from '@marinoscar/platform-api/jobs';

// =============================================================================
// `transcripts.housekeeping` — the reconciliation sweep (issue #25, §1.5.8)
// =============================================================================
//
// The acceptance criterion is "housekeeping restarts an orphaned poll chain",
// and the rest of this file pins the two properties that keep a sweep useful:
// it does not act on a transcript whose chain is merely BETWEEN two links, and
// one failing step does not stop the other two from running.
// =============================================================================

const job = (): Job => ({ id: 'job-1', payload: null, orgId: 'org-1' } as unknown as Job);

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
  let scopeRun: jest.Mock;

  beforeEach(async () => {
    scopeRun = jest.fn(async (_job: unknown, fn: (tx: unknown) => unknown) => fn(prisma));

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
        // The scoped transaction client is the Prisma stub itself.
        { provide: JobScope, useValue: { run: scopeRun } },
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

  describe('reconciling aborted uploads (issue #469)', () => {
    const HOUR = 3_600_000;
    const uploading = (id: string, sourceObjectId: string) => ({ id, sourceObjectId });

    /** Step 3 is the `uploading` query without an `OR` (step 2 has one, step 1 filters `processing`). */
    const step3Returns = (rows: unknown[]) =>
      prisma.transcript.findMany.mockImplementation(
        async ({ where }: { where: { status?: string; OR?: unknown } }) =>
          where.status === 'uploading' && !where.OR ? rows : [],
      );

    const abortedWrite = {
      where: { id: 't-1', deletedAt: null, status: 'uploading' },
      data: { status: 'failed', failureReason: 'upload_aborted' },
    };

    it('fails a transcript whose source object was aborted', async () => {
      step3Returns([uploading('t-1', 'obj-1')]);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-1', status: 'failed', createdAt: new Date(), updatedAt: new Date() },
      ]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(abortedWrite);
      // A cancelled upload is not a pipeline failure: no email, no purge in this step.
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('fails a transcript whose source object is gone', async () => {
      step3Returns([uploading('t-1', 'obj-1')]);
      prisma.storageObject.findMany.mockResolvedValue([]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(abortedWrite);
    });

    it('fails an upload older than the platform stale-upload threshold', async () => {
      step3Returns([uploading('t-1', 'obj-1')]);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-1', status: 'uploading', createdAt: new Date(Date.now() - 100 * HOUR), updatedAt: new Date() },
      ]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(abortedWrite);
    });

    it('leaves a live upload, and one whose audio is present, alone', async () => {
      step3Returns([uploading('t-1', 'obj-1'), uploading('t-2', 'obj-2')]);
      prisma.storageObject.findMany.mockResolvedValue([
        { id: 'obj-1', status: 'uploading', createdAt: new Date(Date.now() - HOUR), updatedAt: new Date() },
        { id: 'obj-2', status: 'ready', createdAt: new Date(0), updatedAt: new Date() },
      ]);

      await handler.process(job());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('reads every source object in ONE query, inside the job organization', async () => {
      step3Returns([uploading('t-1', 'obj-1'), uploading('t-2', 'obj-2')]);
      prisma.storageObject.findMany.mockResolvedValue([]);

      await handler.process(job());

      expect(prisma.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['obj-1', 'obj-2'] } } }),
      );
      expect(scopeRun).toHaveBeenCalledWith({ id: 'job-1', orgId: 'org-1' }, expect.any(Function));
    });

    it('is bounded to 500 transcripts per run, oldest first', async () => {
      step3Returns([]);

      await handler.process(job());

      expect(ABORT_RECONCILE_BATCH).toBe(500);
      expect(prisma.transcript.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, status: 'uploading' },
          orderBy: { createdAt: 'asc' },
          take: 500,
        }),
      );
    });

    it('does nothing when the conditional write loses the race', async () => {
      step3Returns([uploading('t-1', 'obj-1')]);
      prisma.storageObject.findMany.mockResolvedValue([]);
      prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

      await expect(handler.process(job())).resolves.toBeUndefined();
    });

    it('does not stop the other steps when it fails, and reports afterwards', async () => {
      step3Returns([uploading('t-1', 'obj-1')]);
      prisma.storageObject.findMany.mockRejectedValue(new Error('rls down'));
      prisma.transcriptExport.findMany.mockResolvedValue([{ id: 'export-1', objectId: null }]);

      await expect(handler.process(job())).rejects.toThrow('reconciling aborted uploads');

      expect(prisma.transcriptExport.delete).toHaveBeenCalled();
    });
  });

  describe('decideAbortedUpload', () => {
    const cutoff = new Date('2026-01-01T12:00:00Z');
    const before = new Date('2026-01-01T11:00:00Z');
    const after = new Date('2026-01-01T13:00:00Z');

    it.each([
      [undefined, 'abort'],
      [{ status: 'failed', createdAt: after }, 'abort'],
      [{ status: 'pending', createdAt: before }, 'abort'],
      [{ status: 'uploading', createdAt: before }, 'abort'],
      [{ status: 'uploading', createdAt: after }, 'keep'],
      [{ status: 'pending', createdAt: after }, 'keep'],
      [{ status: 'ready', createdAt: before }, 'keep'],
      [{ status: 'processing', createdAt: before }, 'keep'],
    ] as const)('object %j -> %s', (object, expected) => {
      expect(decideAbortedUpload(object, cutoff)).toBe(expected);
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
