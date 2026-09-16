import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchIndexService } from '../../search/indexing/search-index.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from './__fixtures__/fake-provider';
import { TranscriptPurgeHandler } from './transcript-purge.handler';

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
    transcript: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock; delete: jest.Mock };
    transcriptVersion: { updateMany: jest.Mock };
    transcriptExport: { updateMany: jest.Mock };
  };
  let objects: { deleteIfPresent: jest.Mock };
  let runtime: { resolve: jest.Mock };

  beforeEach(async () => {
    provider = createFakeProvider();

    prisma = {
      transcript: {
        findUnique: jest.fn().mockResolvedValue(transcriptRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      transcriptVersion: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      transcriptExport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
        { provide: SearchIndexService, useValue: { forget: jest.fn() } },
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
});
