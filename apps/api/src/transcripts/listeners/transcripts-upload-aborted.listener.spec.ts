import { Test } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { ObjectUploadAbortedEvent } from '../../storage/processing/events/object-upload-aborted.event';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptsUploadAbortedListener } from './transcripts-upload-aborted.listener';

// =============================================================================
// TranscriptsUploadAbortedListener — it ONLY writes a status and enqueues (issue #322)
// =============================================================================
//
// CLAUDE.md rule 1 names an `@OnEvent` body that does long-running work as a
// violation. This listener's whole job is a conditional `updateMany` plus an
// enqueue; deleting the object's bytes, calling the provider, or anything
// else purge-shaped belongs to `transcript.purge`, on the queue.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';
const OBJECT_ID = 'obj-1';

const abortedEvent = (overrides: Record<string, unknown> = {}) =>
  new ObjectUploadAbortedEvent({
    id: OBJECT_ID,
    managedBy: 'transcripts',
    uploadedById: 'user-1',
    storageKey: 'key-1',
    name: 'recording.mp3',
    ...overrides,
  } as never);

describe('TranscriptsUploadAbortedListener', () => {
  let listener: TranscriptsUploadAbortedListener;
  let prisma: {
    transcript: { findFirst: jest.Mock; updateMany: jest.Mock };
  };
  let pipeline: { enqueuePurge: jest.Mock };

  beforeEach(async () => {
    prisma = {
      transcript: {
        findFirst: jest.fn().mockResolvedValue({ id: TRANSCRIPT_ID, status: 'uploading' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    pipeline = {
      enqueuePurge: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsUploadAbortedListener,
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
      ],
    }).compile();

    listener = module.get(TranscriptsUploadAbortedListener);
  });

  it('ignores an event for an object managed by another module', async () => {
    await listener.handleUploadAborted(abortedEvent({ managedBy: 'notes' }));

    expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
  });

  it('is a no-op when the aborted object has no live transcript', async () => {
    prisma.transcript.findFirst.mockResolvedValue(null);

    await listener.handleUploadAborted(abortedEvent());

    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
  });

  it.each(['processing', 'deleting'])(
    'does nothing for a transcript already %s',
    async (status) => {
      prisma.transcript.findFirst.mockResolvedValue({ id: TRANSCRIPT_ID, status });

      await listener.handleUploadAborted(abortedEvent());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
    },
  );

  it('soft-deletes an uploading transcript and queues its purge', async () => {
    await listener.handleUploadAborted(abortedEvent());

    expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
      where: { id: TRANSCRIPT_ID, status: 'uploading', deletedAt: null },
      data: { status: 'deleting', deletedAt: expect.any(Date) },
    });
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith(TRANSCRIPT_ID);
  });

  it('does not enqueue a purge when it loses the race for the row', async () => {
    // A concurrent write (an explicit delete, or a duplicated event) moved
    // the transcript off `uploading` between the read and the write.
    prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

    await listener.handleUploadAborted(abortedEvent());

    expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
  });

  it('CONTAINS a thrown error rather than crashing the process', async () => {
    // An event listener that throws produces an unhandled rejection, which
    // terminates the process by default — a damaged transcript row must not
    // be able to take the API down on somebody else's cancelled upload.
    prisma.transcript.findFirst.mockRejectedValue(new Error('database is on fire'));

    await expect(listener.handleUploadAborted(abortedEvent())).resolves.toBeUndefined();
    expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
  });
});
