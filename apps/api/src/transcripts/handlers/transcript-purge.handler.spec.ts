import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SearchIndexService } from '../../search/indexing/search-index.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from './__fixtures__/fake-provider';
import { TranscriptPurgeHandler } from './transcript-purge.handler';
import { type JobHandler, JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

// =============================================================================
// `transcript.purge` — everything goes (issue #25, spec §1.5.7 and §10)
// =============================================================================
//
// The acceptance criterion is "purge removes all managed objects", and the two
// properties worth pinning beyond that are the ORDER (objects before rows,
// except the source, which the non-nullable `Restrict` foreign key forces to
// be second) and the RE-ENTRANCY: retrying is this handler's entire recovery
// strategy, so a second pass over a half-purged transcript must succeed.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const job = (payload: unknown = { transcriptId: TRANSCRIPT_ID }): Job =>
  ({ id: 'job-1', payload } as unknown as Job);

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  sourceObjectId: 'obj-source',
  playbackObjectId: 'obj-playback',
  rawResultObjectId: 'obj-raw',
  providerJobId: 'remote-1',
  remoteDeletedAt: null,
  versions: [{ snapshotObjectId: 'obj-snapshot' }, { snapshotObjectId: null }],
  exports: [{ id: 'export-1', objectId: 'obj-export' }],
  ...overrides,
});

describe('TranscriptPurgeHandler', () => {
  let handler: TranscriptPurgeHandler;
  let provider: FakeProvider;
  let prisma: {
    transcript: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock; delete: jest.Mock };
    transcriptVersion: { updateMany: jest.Mock };
    transcriptExport: { updateMany: jest.Mock; };
    note: { updateMany: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  let pipeline: { enqueuePurge: jest.Mock };
  let searchIndex: { forget: jest.Mock; forgetOwnerDocuments: jest.Mock };
  let objects: { deleteIfPresent: jest.Mock };
  let runtime: { resolve: jest.Mock };

  beforeEach(async () => {
    provider = createFakeProvider();

    prisma = {
      transcript: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(transcriptRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      transcriptVersion: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      transcriptExport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      note: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    pipeline = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };
    searchIndex = {
      forget: jest.fn(),
      forgetOwnerDocuments: jest.fn().mockResolvedValue(0),
    };

    objects = { deleteIfPresent: jest.fn().mockResolvedValue(true) };
    runtime = {
      resolve: jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy: {} }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptPurgeHandler,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptObjectsService, useValue: objects },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        // #188: the purge is one of the three owners of the semantic index
        // sweep — `search_chunks.document_id` has no foreign key, so no
        // cascade and no housekeeping cron is ever coming for those rows.
        { provide: SearchIndexService, useValue: searchIndex },
        { provide: TranscriptPipelineService, useValue: pipeline },
      ],
    }).compile();

    handler = module.get(TranscriptPurgeHandler);
  });

  it('takes no profile — it is an ordinary handler on the deployment defaults', () => {
    // Deleting a bounded set of objects for one transcript does not resemble
    // the multi-hour, never-auto-retry shape a profile exists for.
    expect((handler as JobHandler).profile).toBeUndefined();
  });

  it('deletes every managed object the transcript ever owned', async () => {
    await handler.process(job());

    const deleted = objects.deleteIfPresent.mock.calls.map(([id]) => id);

    expect(new Set(deleted)).toEqual(
      new Set(['obj-playback', 'obj-raw', 'obj-snapshot', 'obj-export', 'obj-source']),
    );
  });

  it('deletes the source object AFTER the row, which the Restrict FK forces', async () => {
    const order: string[] = [];

    objects.deleteIfPresent.mockImplementation(async (id: string) => {
      order.push(`object:${id}`);
      return true;
    });
    prisma.transcript.delete.mockImplementation(async () => {
      order.push('row');
      return {};
    });

    await handler.process(job());

    // `source_object_id` is NOT NULLABLE, so the reference cannot be cleared
    // the way every other one can — the row has to go first.
    expect(order.indexOf('row')).toBeLessThan(order.indexOf('object:obj-source'));
    expect(order.indexOf('object:obj-playback')).toBeLessThan(order.indexOf('row'));
  });

  it('clears each Restrict reference before asking for the bytes', async () => {
    await handler.process(job());

    expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { playbackObjectId: null } }),
    );
    expect(prisma.transcriptVersion.updateMany).toHaveBeenCalled();
    expect(prisma.transcriptExport.updateMany).toHaveBeenCalled();
  });

  it('deletes the provider copy when one is still held', async () => {
    await handler.process(job());

    expect(provider.deleteRemote).toHaveBeenCalledWith({ apiKey: 'k' }, 'remote-1');
  });

  it('skips the provider when the copy was already deleted at ingest', async () => {
    prisma.transcript.findUnique.mockResolvedValue(
      transcriptRow({ remoteDeletedAt: new Date() }),
    );

    await handler.process(job());

    expect(provider.deleteRemote).not.toHaveBeenCalled();
  });

  it('deletes everything local even when the vendor will not answer', async () => {
    // Refusing to delete anything until the vendor answers would leave the
    // audio in this deployment's own storage too — strictly worse for the
    // privacy outcome the deletion was asked for.
    runtime.resolve.mockRejectedValue(new Error('vendor unreachable'));

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(prisma.transcript.delete).toHaveBeenCalled();
  });

  it('is re-entrant: a second pass over a gone transcript succeeds', async () => {
    prisma.transcript.findUnique.mockResolvedValue(null);

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(prisma.transcript.delete).not.toHaveBeenCalled();
  });

  it('does nothing for a payload naming no transcript', async () => {
    await expect(handler.process(job({ nothing: true }))).resolves.toBeUndefined();
    expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
  });

  it('finds a SOFT-DELETED transcript, which is the only kind it ever sees', async () => {
    // The pipeline's `loadForJob` filters those out; this handler must not use
    // it, and `findUnique` with no `deletedAt` predicate is why.
    await handler.process(job());

    expect(prisma.transcript.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TRANSCRIPT_ID } }),
    );
  });

  // ---------------------------------------------------------------------------
  // The owner-level payload (issue #480): the delegate of `user.data.purge`
  // ---------------------------------------------------------------------------

  describe('{ mode: "owner", userId } (the platform user-data delegate)', () => {
    const USER_ID = '22222222-2222-4222-8222-222222222222';
    const owner = () => job({ mode: 'owner', userId: USER_ID });

    it('pins the payload shape: only a uuid userId with mode "owner" is an owner payload', async () => {
      for (const payload of [
        { mode: 'owner' },
        { mode: 'owner', userId: 'not-a-uuid' },
        { mode: 'other', userId: USER_ID },
        { userId: USER_ID },
      ]) {
        await handler.process(job(payload));
      }

      expect(prisma.transcript.findMany).not.toHaveBeenCalled();
      expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
    });

    it('clears notes.source_transcript_id BEFORE soft-deleting, then queues the per-item purge', async () => {
      const order: string[] = [];

      prisma.transcript.findMany
        .mockResolvedValueOnce([{ id: 't-1' }, { id: 't-2' }])
        .mockResolvedValueOnce([]);
      prisma.note.updateMany.mockImplementation(async () => {
        order.push('clear-note-fk');
        return { count: 3 };
      });
      prisma.transcript.updateMany.mockImplementation(async () => {
        order.push('soft-delete');
        return { count: 2 };
      });
      pipeline.enqueuePurge.mockImplementation(async (id: string) => {
        order.push(`enqueue:${id}`);
      });

      await handler.process(owner());

      expect(prisma.transcript.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: USER_ID, deletedAt: null } }),
      );
      // Every note citing one of the batch, whoever owns it: no ownerId filter.
      expect(prisma.note.updateMany).toHaveBeenCalledWith({
        where: { sourceTranscriptId: { in: ['t-1', 't-2'] } },
        data: { sourceTranscriptId: null },
      });
      expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['t-1', 't-2'] } },
        data: { status: 'deleting', deletedAt: expect.any(Date) },
      });
      expect(order).toEqual(['clear-note-fk', 'soft-delete', 'enqueue:t-1', 'enqueue:t-2']);
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: USER_ID,
          action: 'user_data:transcripts_deleted',
          meta: { count: 2 },
        }),
      });
    });

    it('forgets the owner’s transcripts in the semantic index, and survives that failing', async () => {
      searchIndex.forgetOwnerDocuments.mockRejectedValue(new Error('index down'));

      await expect(handler.process(owner())).resolves.toBeUndefined();

      expect(searchIndex.forgetOwnerDocuments).toHaveBeenCalledWith(USER_ID, 'transcript');
    });

    it('is re-entrant: with nothing live left it deletes nothing and writes no audit row', async () => {
      await handler.process(owner());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('never touches a storage object itself: the per-item purge owns the bytes', async () => {
      prisma.transcript.findMany.mockResolvedValueOnce([{ id: 't-1' }]).mockResolvedValueOnce([]);

      await handler.process(owner());

      expect(objects.deleteIfPresent).not.toHaveBeenCalled();
      expect(prisma.transcript.delete).not.toHaveBeenCalled();
    });
  });
});
