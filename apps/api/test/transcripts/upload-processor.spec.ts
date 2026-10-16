import { Test } from '@nestjs/testing';
import { ObjectProcessorRegistry } from '@marinoscar/platform-api/storage';

import { KvoxManagedObjectsService } from '../../src/kvox-objects/kvox-managed-objects.service';
import {
  TRANSCRIPT_UPLOAD_PROCESSOR_NAME,
  TranscriptUploadProcessor,
} from '../../src/transcripts/transcript-upload.processor';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createFakeProvider, type FakeProvider } from '../../src/transcripts/handlers/__fixtures__/fake-provider';
import { TranscriptPipelineService } from '../../src/transcripts/transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../../src/transcripts/transcription-runtime.service';

// =============================================================================
// TranscriptUploadProcessor: it ONLY enqueues (issues #25, #469)
// =============================================================================
//
// Queue rule 1: a processor body that downloads or calls the transcription
// provider is a violation (the work would have no job row, no timeout and no
// retry of its own). The first test pins that. The rest pin the ownership gate
// that replaced the old "is this object a transcript's audio" event filter.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const objectRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'obj-1',
    orgId: 'org-1',
    mimeType: 'audio/mpeg',
    size: BigInt(1_000_000),
    ...overrides,
  }) as never;

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

describe('TranscriptUploadProcessor', () => {
  let processor: TranscriptUploadProcessor;
  let provider: FakeProvider;
  let registry: { register: jest.Mock };
  let managed: { managedBy: jest.Mock };
  let prisma: {
    transcript: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let pipeline: { enqueueTranscode: jest.Mock; enqueueSubmit: jest.Mock; markFailed: jest.Mock };
  let runtime: { activeProvider: jest.Mock };

  beforeEach(async () => {
    provider = createFakeProvider();
    registry = { register: jest.fn() };
    managed = { managedBy: jest.fn().mockResolvedValue(new Map([['obj-1', 'transcripts']])) };
    prisma = {
      transcript: {
        findFirst: jest.fn().mockResolvedValue(transcriptRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    pipeline = {
      enqueueTranscode: jest.fn().mockResolvedValue(true),
      enqueueSubmit: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    runtime = {
      activeProvider: jest.fn().mockResolvedValue({ provider, policy: { audioDelivery: 'presigned_url' } }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptUploadProcessor,
        { provide: ObjectProcessorRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: KvoxManagedObjectsService, useValue: managed },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptionRuntimeService, useValue: runtime },
      ],
    }).compile();

    processor = module.get(TranscriptUploadProcessor);
  });

  describe('registration', () => {
    it('registers itself under its name from onModuleInit', () => {
      processor.onModuleInit();

      expect(processor.name).toBe('kvox.transcripts.source');
      expect(TRANSCRIPT_UPLOAD_PROCESSOR_NAME).toBe('kvox.transcripts.source');
      expect(registry.register).toHaveBeenCalledWith(processor);
    });

    it.each([
      ['audio/mpeg', true],
      ['AUDIO/WAV', true],
      ['video/mp4', true],
      ['image/png', false],
      ['application/pdf', false],
      ['', false],
    ])('canProcess(%s) is %s', (mimeType, expected) => {
      expect(processor.canProcess(objectRow({ mimeType }))).toBe(expected);
    });
  });

  describe('ownership gate', () => {
    it.each(['notes', 'graph'])('skips an object owned by %s', async (owner) => {
      managed.managedBy.mockResolvedValue(new Map([['obj-1', owner]]));

      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: true,
        metadata: { skipped: true },
      });

      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('skips an unmanaged object (a generic upload)', async () => {
      managed.managedBy.mockResolvedValue(new Map());

      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: true,
        metadata: { skipped: true },
      });
    });

    it('asks the gateway about exactly this object', async () => {
      await processor.process(objectRow(), jest.fn());

      expect(managed.managedBy).toHaveBeenCalledWith(['obj-1']);
    });
  });

  describe('starting the pipeline', () => {
    it('NEVER downloads and NEVER calls the provider: it only enqueues', async () => {
      const getStream = jest.fn();

      await processor.process(objectRow(), getStream);

      expect(getStream).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);
    });

    it('promotes the transcript to `processing` and starts both sub-pipelines', async () => {
      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: true,
        metadata: { started: true },
      });

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TRANSCRIPT_ID, status: 'uploading' },
          data: { status: 'processing' },
        }),
      );
      expect(pipeline.enqueueTranscode).toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).toHaveBeenCalled();
    });

    it('is a no-op for a managed object with no live transcript', async () => {
      prisma.transcript.findFirst.mockResolvedValue(null);

      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: true,
        metadata: { started: false },
      });

      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('promotes exactly once when the job runs twice', async () => {
      prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

      await processor.process(objectRow(), jest.fn());

      expect(pipeline.enqueueTranscode).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('does nothing for a transcript already past `uploading`', async () => {
      prisma.transcript.findFirst.mockResolvedValue(transcriptRow({ status: 'ready' }));

      await processor.process(objectRow(), jest.fn());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('waits for the rendition when the provider will not take the original', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];

      await processor.process(objectRow({ mimeType: 'audio/amr' }), jest.fn());

      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { transcriptionStatus: 'waiting_input' } }),
      );
    });

    it('fails permanently when nothing will ever be transcribable', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      // No transcode handler in this build, so no rendition is coming.
      pipeline.enqueueTranscode.mockResolvedValue(false);

      await processor.process(objectRow({ mimeType: 'audio/amr' }), jest.fn());

      expect(pipeline.markFailed).toHaveBeenCalledWith(expect.objectContaining({ retryable: false }));
    });

    it('fails the transcript when transcription was turned off mid-upload', async () => {
      runtime.activeProvider.mockResolvedValue(null);

      await processor.process(objectRow(), jest.fn());

      expect(pipeline.markFailed).toHaveBeenCalledWith(expect.objectContaining({ stage: 'transcription' }));
    });
  });

  describe('failure', () => {
    it('reports the error and fails the transcript instead of throwing', async () => {
      prisma.transcript.findFirst
        .mockRejectedValueOnce(new Error('database is on fire'))
        .mockResolvedValueOnce({ id: TRANSCRIPT_ID });

      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: false,
        error: 'database is on fire',
      });

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ transcriptId: TRANSCRIPT_ID, stage: 'upload' }),
      );
    });

    it('still reports the original error when marking the transcript failed also fails', async () => {
      prisma.transcript.findFirst.mockRejectedValue(new Error('database is on fire'));

      await expect(processor.process(objectRow(), jest.fn())).resolves.toEqual({
        success: false,
        error: 'database is on fire',
      });
    });
  });
});
