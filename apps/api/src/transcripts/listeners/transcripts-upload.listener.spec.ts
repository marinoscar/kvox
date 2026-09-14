import { Test } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import { ObjectUploadedEvent } from '../../storage/processing/events/object-uploaded.event';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from '../handlers/__fixtures__/fake-provider';
import { TranscriptsUploadListener } from './transcripts-upload.listener';

// =============================================================================
// TranscriptsUploadListener — it ONLY enqueues (issue #25)
// =============================================================================
//
// CLAUDE.md rule 1 names an `@OnEvent` body that downloads or spawns as a
// violation, and submitting to a transcription provider from here would be
// exactly that: a multi-minute network call with no job row, no timeout, no
// retry and nothing to recover it if the process died. The first test in this
// file is the one that pins that.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const event = (objectId = 'obj-1'): ObjectUploadedEvent =>
  new ObjectUploadedEvent({ id: objectId } as never);

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'user-1',
  status: 'uploading',
  transcriptionStatus: 'waiting_input',
  playbackStatus: 'pending',
  sourceObjectId: 'obj-1',
  deletedAt: null,
  ...overrides,
});

describe('TranscriptsUploadListener', () => {
  let listener: TranscriptsUploadListener;
  let provider: FakeProvider;
  let prisma: {
    transcript: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    storageObject: { findUnique: jest.Mock };
  };
  let pipeline: {
    enqueueTranscode: jest.Mock;
    enqueueSubmit: jest.Mock;
    markFailed: jest.Mock;
  };
  let runtime: { activeProvider: jest.Mock };
  let policy: Record<string, unknown>;

  beforeEach(async () => {
    provider = createFakeProvider();
    policy = { audioDelivery: 'presigned_url' };

    prisma = {
      transcript: {
        findFirst: jest.fn().mockResolvedValue(transcriptRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'obj-1',
          mimeType: 'audio/mpeg',
          size: BigInt(1_000_000),
        }),
      },
    };

    pipeline = {
      enqueueTranscode: jest.fn().mockResolvedValue(true),
      enqueueSubmit: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(true),
    };

    runtime = { activeProvider: jest.fn().mockResolvedValue({ provider, policy }) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsUploadListener,
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptionRuntimeService, useValue: runtime },
      ],
    }).compile();

    listener = module.get(TranscriptsUploadListener);
  });

  it('NEVER calls the provider inline — it only enqueues', async () => {
    await listener.handleObjectUploaded(event());

    expect(provider.submit).not.toHaveBeenCalled();
    expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);
  });

  it('promotes the transcript to `processing` and starts both sub-pipelines', async () => {
    await listener.handleObjectUploaded(event());

    expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TRANSCRIPT_ID, status: 'uploading' },
        data: { status: 'processing' },
      }),
    );
    expect(pipeline.enqueueTranscode).toHaveBeenCalled();
    expect(pipeline.enqueueSubmit).toHaveBeenCalled();
  });

  it('ignores an object that is not a transcript\'s audio', async () => {
    // Most completed uploads in this application have nothing to do with
    // transcripts, so this is the common case rather than an error.
    prisma.transcript.findFirst.mockResolvedValue(null);

    await listener.handleObjectUploaded(event('obj-unrelated'));

    expect(pipeline.enqueueTranscode).not.toHaveBeenCalled();
    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
  });

  it('promotes exactly once when the event arrives twice', async () => {
    // The emitter offers no exactly-once guarantee, and a retried
    // `completeUpload` raises a second event.
    prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

    await listener.handleObjectUploaded(event());

    expect(pipeline.enqueueTranscode).not.toHaveBeenCalled();
    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
  });

  it('does nothing for a transcript already past `uploading`', async () => {
    prisma.transcript.findFirst.mockResolvedValue(transcriptRow({ status: 'ready' }));

    await listener.handleObjectUploaded(event());

    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
  });

  it('waits for the rendition when the provider will not take the original', async () => {
    provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
    prisma.storageObject.findUnique.mockResolvedValue({
      id: 'obj-1',
      mimeType: 'audio/amr',
      size: BigInt(1_000_000),
    });

    await listener.handleObjectUploaded(event());

    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    expect(prisma.transcript.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { transcriptionStatus: 'waiting_input' } }),
    );
  });

  it('fails permanently when nothing will ever be transcribable', async () => {
    provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
    prisma.storageObject.findUnique.mockResolvedValue({
      id: 'obj-1',
      mimeType: 'audio/amr',
      size: BigInt(1_000_000),
    });
    // No transcode handler in this build, so no rendition is coming.
    pipeline.enqueueTranscode.mockResolvedValue(false);

    await listener.handleObjectUploaded(event());

    expect(pipeline.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: false }),
    );
  });

  it('fails the transcript when transcription was turned off mid-upload', async () => {
    // `POST /api/transcripts` refuses with a 409 when transcription is not
    // configured, so getting here means an administrator changed it while a
    // multi-gigabyte file was uploading.
    runtime.activeProvider.mockResolvedValue(null);

    await listener.handleObjectUploaded(event());

    expect(pipeline.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'transcription' }),
    );
  });

  it('CONTAINS a thrown error rather than crashing the process', async () => {
    // An event listener that throws produces an unhandled rejection, which
    // terminates the process by default — a damaged transcript row must not be
    // able to take the API down on somebody else's upload.
    prisma.transcript.findFirst.mockRejectedValue(new Error('database is on fire'));

    await expect(listener.handleObjectUploaded(event())).resolves.toBeUndefined();
  });
});
