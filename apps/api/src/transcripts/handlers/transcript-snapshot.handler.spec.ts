// =============================================================================
// `transcript.snapshot` (issue #27, epic #19, spec §1.5.5 / §4.3)
// =============================================================================
//
// ⚠ THE ASSERTION THAT MATTERS MOST is "it snapshots the version the consistent
// read ACTUALLY saw". The job is enqueued with the version that triggered it,
// but a user may save again before a worker claims it — and a snapshot labelled
// v7 containing v9's segments is a lie `materialize()` would faithfully replay
// ops on top of, producing a version that never existed.
// =============================================================================

import { Test } from '@nestjs/testing';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptMaterializeService } from '../transcript-materialize.service';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TRANSCRIPT_SNAPSHOT_JOB_TYPE } from '../job-types';
import { SNAPSHOT_MAX_RUNTIME_MS, TranscriptSnapshotHandler } from './transcript-snapshot.handler';

const TRANSCRIPT_ID = 'transcript-1';

const job = (payload: unknown) => ({ id: 'job-1', payload }) as never;

describe('TranscriptSnapshotHandler', () => {
  let handler: TranscriptSnapshotHandler;
  let prisma: {
    $transaction: jest.Mock;
    transcriptVersion: { updateMany: jest.Mock };
  };
  let tx: {
    transcript: { findUnique: jest.Mock };
    transcriptVersion: { findUnique: jest.Mock };
  };
  let materialize: { loadLiveState: jest.Mock; serializeSnapshot: jest.Mock };
  let objects: { put: jest.Mock; deleteIfPresent: jest.Mock };
  let registry: { register: jest.Mock };

  const liveState = {
    speakers: [{ id: 'A', label: 'A', displayName: 'A', colorIndex: 0, rev: 1 }],
    segments: [
      {
        id: 's1',
        speakerId: 'A',
        startMs: 0,
        endMs: 100,
        ordinal: 1000,
        text: 'hello',
        words: [],
        wordsAlignment: 'exact' as const,
        confidence: null,
        origin: 'ai' as const,
        rev: 1,
      },
    ],
  };

  beforeEach(async () => {
    tx = {
      transcript: {
        findUnique: jest.fn().mockResolvedValue({
          id: TRANSCRIPT_ID,
          ownerId: 'owner-1',
          currentVersion: 3,
          deletedAt: null,
        }),
      },
      transcriptVersion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ver-3', version: 3, snapshotObjectId: null }),
      },
    };

    prisma = {
      $transaction: jest.fn().mockImplementation((fn: (client: unknown) => unknown) => fn(tx)),
      transcriptVersion: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };

    materialize = {
      loadLiveState: jest.fn().mockResolvedValue({ state: liveState, editedAt: new Map() }),
      serializeSnapshot: jest.fn().mockReturnValue(Buffer.from('gz')),
    };

    objects = {
      put: jest.fn().mockResolvedValue({ id: 'object-1' }),
      deleteIfPresent: jest.fn().mockResolvedValue(true),
    };

    registry = { register: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptSnapshotHandler,
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptMaterializeService, useValue: materialize },
        { provide: TranscriptObjectsService, useValue: objects },
      ],
    }).compile();

    handler = module.get(TranscriptSnapshotHandler);
  });

  it('registers itself with the real job type and a 10-minute, 3-attempt profile', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe(TRANSCRIPT_SNAPSHOT_JOB_TYPE);
    expect(handler.profile).toEqual({ maxRuntimeMs: SNAPSHOT_MAX_RUNTIME_MS, maxAttempts: 3 });
    expect(SNAPSHOT_MAX_RUNTIME_MS).toBe(10 * 60 * 1000);
  });

  it('is SERVER-ONLY: it declares neither node member', () => {
    // Both or neither (CLAUDE.md rule 2). This job is a multi-table consistent
    // read — there is nothing for a remote machine to compute.
    expect((handler as { nodeResultSchema?: unknown }).nodeResultSchema).toBeUndefined();
    expect((handler as { persistNodeResult?: unknown }).persistNodeResult).toBeUndefined();
  });

  it('reads under REPEATABLE READ and snapshots the version it actually saw', async () => {
    // The job was enqueued for v1; by the time it runs the transcript is at v3.
    await handler.process(job({ transcriptId: TRANSCRIPT_ID, version: 1 }));

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    );
    expect(tx.transcriptVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transcriptId_version: { transcriptId: TRANSCRIPT_ID, version: 3 } },
      }),
    );
    expect(materialize.serializeSnapshot).toHaveBeenCalledWith(TRANSCRIPT_ID, 3, liveState);
    expect(objects.put).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: `transcripts/${TRANSCRIPT_ID}/snapshots/v3.json.gz`,
        mimeType: 'application/gzip',
        ownerId: 'owner-1',
      }),
    );
    expect(prisma.transcriptVersion.updateMany).toHaveBeenCalledWith({
      // The claim is conditional, so two racing runs cannot both link a row.
      where: { id: 'ver-3', snapshotObjectId: null },
      data: { snapshotObjectId: 'object-1' },
    });
  });

  it('is idempotent: a version that already has a snapshot writes nothing', async () => {
    tx.transcriptVersion.findUnique.mockResolvedValue({
      id: 'ver-3',
      version: 3,
      snapshotObjectId: 'object-existing',
    });

    await handler.process(job({ transcriptId: TRANSCRIPT_ID, version: 3 }));

    expect(objects.put).not.toHaveBeenCalled();
    expect(prisma.transcriptVersion.updateMany).not.toHaveBeenCalled();
  });

  it('cleans up its own object when it loses the claim race', async () => {
    prisma.transcriptVersion.updateMany.mockResolvedValue({ count: 0 });

    await handler.process(job({ transcriptId: TRANSCRIPT_ID, version: 3 }));

    expect(objects.deleteIfPresent).toHaveBeenCalledWith('object-1');
  });

  it('is a no-op for a transcript that is gone or soft-deleted', async () => {
    tx.transcript.findUnique.mockResolvedValue(null);

    await handler.process(job({ transcriptId: TRANSCRIPT_ID, version: 1 }));

    expect(objects.put).not.toHaveBeenCalled();
  });

  it('is a no-op for a transcript with no version yet', async () => {
    tx.transcript.findUnique.mockResolvedValue({
      id: TRANSCRIPT_ID,
      ownerId: 'owner-1',
      currentVersion: 0,
      deletedAt: null,
    });

    await handler.process(job({ transcriptId: TRANSCRIPT_ID, version: 1 }));

    expect(objects.put).not.toHaveBeenCalled();
  });

  it('is a no-op for a payload that names no transcript', async () => {
    await handler.process(job({ nothing: true }));

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
