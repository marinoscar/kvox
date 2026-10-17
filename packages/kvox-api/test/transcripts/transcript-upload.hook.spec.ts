import { Test } from '@nestjs/testing';

import {
  KVOX_OBJECT_STORE,
  KVOX_PRISMA,
  type KvoxAbortedEvent,
  type KvoxManagedBy,
  type KvoxObjectInfo,
  type KvoxUploadedEvent,
} from '../../src/ports/index.js';
import { createFakeProvider, type FakeProvider } from '../../src/transcripts/handlers/__fixtures__/fake-provider.js';
import { TRANSCRIPTS_MANAGED_BY } from '../../src/transcripts/job-types.js';
import { TranscriptPipelineService } from '../../src/transcripts/transcript-pipeline.service.js';
import { TranscriptUploadHook, UPLOAD_ABORTED_REASON } from '../../src/transcripts/transcript-upload.hook.js';
import { TranscriptionRuntimeService } from '../../src/transcripts/transcription-runtime.service.js';

// =============================================================================
// TranscriptUploadHook: it ONLY enqueues (issues #25, #469; the port form of #493)
// =============================================================================
//
// Queue rule 1: a hook body that downloads or calls the transcription provider is a
// violation (the work would have no job row, no timeout and no retry of its own). The
// first test pins that. The rest pin the ownership gate (only an object the transcripts
// module owns starts a pipeline), the promotion that makes a repeated event a no-op, and
// the abort path.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const completed = (overrides: { managedBy?: KvoxManagedBy | null } = {}): KvoxUploadedEvent & KvoxAbortedEvent => ({
  objectId: 'obj-1',
  managedBy: TRANSCRIPTS_MANAGED_BY,
  ...overrides,
});

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

describe('TranscriptUploadHook', () => {
  let hook: TranscriptUploadHook;
  let provider: FakeProvider;
  let source: KvoxObjectInfo | undefined;
  let store: { onUploaded: jest.Mock; onAborted: jest.Mock; describe: jest.Mock; openRead: jest.Mock };
  let prisma: {
    transcript: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let pipeline: { enqueueTranscode: jest.Mock; enqueueSubmit: jest.Mock; markFailed: jest.Mock };
  let runtime: { activeProvider: jest.Mock };

  beforeEach(async () => {
    provider = createFakeProvider();
    source = {
      id: 'obj-1',
      name: 'meeting.mp3',
      mimeType: 'audio/mpeg',
      size: 1_000_000,
      state: 'ready',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store = {
      onUploaded: jest.fn(),
      onAborted: jest.fn(),
      describe: jest.fn(async () => (source ? new Map([['obj-1', source]]) : new Map())),
      openRead: jest.fn(),
    };
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
        TranscriptUploadHook,
        { provide: KVOX_OBJECT_STORE, useValue: store },
        { provide: KVOX_PRISMA, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptionRuntimeService, useValue: runtime },
      ],
    }).compile();

    hook = module.get(TranscriptUploadHook);
  });

  describe('registration', () => {
    it('subscribes to completed and aborted uploads when the module starts', () => {
      hook.onModuleInit();

      expect(store.onUploaded).toHaveBeenCalledTimes(1);
      expect(store.onAborted).toHaveBeenCalledTimes(1);
    });

    it('asks to be told about audio and video only, so a host queues no processing job for any other file', () => {
      hook.onModuleInit();

      expect(store.onUploaded.mock.calls[0][1]).toEqual({ contentTypes: ['audio/*', 'video/*'] });
    });

    it('routes the port\'s events to its handlers', async () => {
      hook.onModuleInit();

      await store.onUploaded.mock.calls[0][0](completed());
      expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);

      await store.onAborted.mock.calls[0][0](completed());
      expect(prisma.transcript.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('ownership gate', () => {
    it.each(['notes', 'graph'] as const)('skips an object owned by %s', async (owner) => {
      await hook.handleUploaded(completed({ managedBy: owner }));

      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('skips an unmanaged object (a generic upload)', async () => {
      await hook.handleUploaded(completed({ managedBy: null }));

      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('ignores an abort of an object another module owns', async () => {
      await hook.handleAborted(completed({ managedBy: 'notes' }));

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('starting the pipeline', () => {
    it('NEVER downloads and NEVER calls the provider: it only enqueues', async () => {
      await hook.handleUploaded(completed());

      expect(store.openRead).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);
    });

    it('promotes the transcript to `processing` and starts both sub-pipelines', async () => {
      await hook.handleUploaded(completed());

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

      await hook.handleUploaded(completed());

      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('is a no-op for an object the store no longer knows', async () => {
      source = undefined;

      await hook.handleUploaded(completed());

      expect(prisma.transcript.findFirst).not.toHaveBeenCalled();
    });

    it('promotes exactly once when the event arrives twice', async () => {
      prisma.transcript.updateMany.mockResolvedValue({ count: 0 });

      await hook.handleUploaded(completed());

      expect(pipeline.enqueueTranscode).not.toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('does nothing for a transcript already past `uploading`', async () => {
      prisma.transcript.findFirst.mockResolvedValue(transcriptRow({ status: 'ready' }));

      await hook.handleUploaded(completed());

      expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('waits for the rendition when the provider will not take the original', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      source = { ...(source as KvoxObjectInfo), mimeType: 'audio/amr' };

      await hook.handleUploaded(completed());

      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { transcriptionStatus: 'waiting_input' } }),
      );
    });

    it('fails permanently when nothing will ever be transcribable', async () => {
      provider.capabilities.acceptedMimeTypes = ['audio/mp4'];
      source = { ...(source as KvoxObjectInfo), mimeType: 'audio/amr' };
      // No transcode handler in this build, so no rendition is coming.
      pipeline.enqueueTranscode.mockResolvedValue(false);

      await hook.handleUploaded(completed());

      expect(pipeline.markFailed).toHaveBeenCalledWith(expect.objectContaining({ retryable: false }));
    });

    it('fails the transcript when transcription was turned off mid-upload', async () => {
      runtime.activeProvider.mockResolvedValue(null);

      await hook.handleUploaded(completed());

      expect(pipeline.markFailed).toHaveBeenCalledWith(expect.objectContaining({ stage: 'transcription' }));
    });
  });

  describe('failure', () => {
    it('reports the error and fails the transcript instead of throwing', async () => {
      prisma.transcript.findFirst
        .mockRejectedValueOnce(new Error('database is on fire'))
        .mockResolvedValueOnce({ id: TRANSCRIPT_ID });

      await expect(hook.handleUploaded(completed())).resolves.toBeUndefined();

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ transcriptId: TRANSCRIPT_ID, stage: 'upload' }),
      );
    });

    it('still returns when marking the transcript failed also fails', async () => {
      prisma.transcript.findFirst.mockRejectedValue(new Error('database is on fire'));

      await expect(hook.handleUploaded(completed())).resolves.toBeUndefined();
    });
  });

  describe('an aborted upload', () => {
    it('fails the transcript that was waiting for it, only while it is still uploading', async () => {
      await hook.handleAborted(completed());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
        where: { sourceObjectId: 'obj-1', deletedAt: null, status: 'uploading' },
        data: { status: 'failed', failureReason: UPLOAD_ABORTED_REASON },
      });
    });
  });
});
