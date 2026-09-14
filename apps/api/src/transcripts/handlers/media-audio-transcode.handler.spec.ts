import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mediaAudioTranscodeResultSchema } from '../../jobs/contracts/media-audio-transcode.contract';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import * as jobTemp from '../../jobs/job-temp';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { TRANSCODE_JOB_TYPE } from '../job-types';
import { selectTranscriptionInput } from '../transcription-input';
import { FfmpegService } from '../media/ffmpeg.service';
import { MissingUploadedObjectError, TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import { createFakeProvider, type FakeProvider } from './__fixtures__/fake-provider';
import { MediaAudioTranscodeHandler } from './media-audio-transcode.handler';

// =============================================================================
// `media.audio.transcode` — the acceptance criteria (issue #26)
// =============================================================================
//
// ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE is "the server and node paths
// produce identical rows". A node-eligible handler has two execution paths and
// each is otherwise tested on its own, which is exactly how a divergence gets
// in: a field written by one and not the other looks fine in both suites and
// wrong only in production, on whichever transcripts the fleet happened to
// claim. Running both against the same recorders and diffing the calls is the
// only thing that can see it.
//
// No binary is required by this file — `FfmpegService` is mocked whole. The
// suite that genuinely runs ffmpeg is `media-audio-transcode.ffmpeg.spec.ts`.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';
const JOB_ID = 'job-7';

const job = (overrides: Partial<Job> = {}): Job =>
  ({
    id: JOB_ID,
    type: TRANSCODE_JOB_TYPE,
    attempts: 1,
    subjectType: 'storage_object',
    subjectId: 'obj-1',
    payload: { transcriptId: TRANSCRIPT_ID, bitrateKbps: 96 },
    ...overrides,
  }) as unknown as Job;

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'user-1',
  title: 'A recording',
  status: 'processing',
  transcriptionStatus: 'waiting_input',
  playbackStatus: 'processing',
  sourceObjectId: 'obj-1',
  playbackObjectId: null,
  durationMs: null,
  deletedAt: null,
  ...overrides,
});

const NODE_RESULT = {
  bytes: 512_000,
  durationMs: 75_264,
  codec: 'aac',
  bitrateKbps: 96,
  channels: 1,
  remuxed: false,
};

describe('MediaAudioTranscodeHandler', () => {
  let handler: MediaAudioTranscodeHandler;
  let provider: FakeProvider;
  let prisma: {
    transcript: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
    storageObject: { findUnique: jest.Mock };
  };
  let ffmpeg: { probe: jest.Mock; transcode: jest.Mock };
  let objects: { recordUploaded: jest.Mock };
  let pipeline: { loadForJob: jest.Mock; markFailed: jest.Mock; enqueueSubmit: jest.Mock };
  let runtime: { policy: jest.Mock; activeProvider: jest.Mock };
  let storage: { getSignedDownloadUrl: jest.Mock; upload: jest.Mock };
  let registry: { register: jest.Mock };
  let tempDir: string;

  beforeEach(async () => {
    provider = createFakeProvider();

    // `jobTempPath` returns a path; the caller writes the file. The handler
    // never creates it either — ffmpeg does — so the mocked transcode has to,
    // and this directory is where.
    tempDir = mkdtempSync(join(tmpdir(), 'transcode-spec-'));
    jest
      .spyOn(jobTemp, 'jobTempPath')
      .mockImplementation((suffix = '') => join(tempDir, `out${suffix}`));

    prisma = {
      transcript: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          transcriptionStatus: 'waiting_input',
          status: 'processing',
        }),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'obj-1',
          storageKey: 'transcripts/t-1/source/a.wav',
          size: BigInt(10_000_000),
          mimeType: 'audio/wav',
        }),
      },
    };

    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        durationMs: 75_264,
        codec: 'pcm_s16le',
        channels: 2,
        bitrateKbps: 1411,
        formatName: 'wav',
      }),
      transcode: jest.fn().mockImplementation(async ({ output }: { output: string }) => {
        writeFileSync(output, Buffer.alloc(512_000, 7));
      }),
    };

    objects = {
      recordUploaded: jest.fn().mockResolvedValue({ id: 'rendition-1' }),
    };

    pipeline = {
      loadForJob: jest.fn().mockResolvedValue(transcriptRow()),
      markFailed: jest.fn().mockResolvedValue(true),
      enqueueSubmit: jest.fn().mockResolvedValue(undefined),
    };

    runtime = {
      policy: jest.fn().mockResolvedValue({
        transcodeNodeOffloadEnabled: true,
        playback: { bitrateKbps: 96 },
      }),
      activeProvider: jest.fn().mockResolvedValue({ provider, policy: {} }),
    };

    storage = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://bucket.example/signed'),
      upload: jest.fn().mockResolvedValue({}),
    };

    registry = { register: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        MediaAudioTranscodeHandler,
        { provide: JobHandlerRegistry, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: FfmpegService, useValue: ffmpeg },
        { provide: TranscriptObjectsService, useValue: objects },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();

    handler = module.get(MediaAudioTranscodeHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Registration and node eligibility
  // ---------------------------------------------------------------------------

  it('self-registers, and carries BOTH members that make a type node-eligible', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);

    const asHandler: JobHandler = handler;

    // Both or neither — a schema with no persist function describes a payload
    // nobody can store, and a persist function with no schema would trust an
    // unvalidated remote body. `serverOnlyTypes()` reads exactly this pair.
    expect(asHandler.nodeResultSchema).toBeDefined();
    expect(typeof asHandler.persistNodeResult).toBe('function');
    expect(asHandler.profile).toEqual({ maxRuntimeMs: 3 * 60 * 60 * 1000, maxAttempts: 3 });
  });

  it('offers the type to nodes only while the deployment setting says so', async () => {
    await expect(handler.nodeOffloadEnabled()).resolves.toBe(true);

    runtime.policy.mockResolvedValue({ transcodeNodeOffloadEnabled: false });
    await expect(handler.nodeOffloadEnabled()).resolves.toBe(false);

    // A settings read that FAILS withholds the type: falling back to the
    // in-process worker is never worse than producing no rendition.
    runtime.policy.mockRejectedValue(new Error('settings unreadable'));
    await expect(handler.nodeOffloadEnabled()).resolves.toBe(false);
  });

  it('derives an idempotent output key under the transcript prefix', async () => {
    await expect(handler.deriveOutputKey(job())).resolves.toBe(
      `transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`,
    );
    await expect(handler.deriveOutputKey(job())).resolves.toBe(
      `transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`,
    );
  });

  // ---------------------------------------------------------------------------
  // The server path
  // ---------------------------------------------------------------------------

  it('probes the SIGNED URL, re-encodes, uploads and records the rendition', async () => {
    await handler.process(job());

    // Signed when the job RUNS. A URL minted at enqueue time is that much
    // closer to expiry by the time ffmpeg starts reading bytes.
    expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
      'transcripts/t-1/source/a.wav',
      expect.objectContaining({ expiresIn: expect.any(Number) }),
    );
    expect(ffmpeg.probe).toHaveBeenCalledWith('https://bucket.example/signed');

    expect(ffmpeg.transcode).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'https://bucket.example/signed',
        plan: { remux: false, bitrateKbps: 96 },
      }),
    );

    expect(storage.upload).toHaveBeenCalledWith(
      `transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`,
      expect.anything(),
      { mimeType: 'audio/mp4' },
    );

    expect(objects.recordUploaded).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: `transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`,
        mimeType: 'audio/mp4',
        size: 512_000,
        ownerId: 'user-1',
      }),
    );

    expect(prisma.transcript.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          playbackObjectId: 'rendition-1',
          playbackStatus: 'ready',
          durationMs: 75_264,
        }),
      }),
    );
  });

  it('takes the target bitrate from the JOB, not from the current setting', async () => {
    // The payload is how a worker node — which reads no settings — learns it,
    // so the server must honour the same number or the two executors produce
    // different files for one job.
    runtime.policy.mockResolvedValue({ playback: { bitrateKbps: 16 } });

    await handler.process(job());

    expect(ffmpeg.transcode).toHaveBeenCalledWith(
      expect.objectContaining({ plan: { remux: false, bitrateKbps: 96 } }),
    );
  });

  it('falls back to the deployment setting for a job enqueued before #26', async () => {
    await handler.process(job({ payload: { transcriptId: TRANSCRIPT_ID } as never }));

    expect(ffmpeg.transcode).toHaveBeenCalledWith(
      expect.objectContaining({ plan: { remux: false, bitrateKbps: 96 } }),
    );
    expect(runtime.policy).toHaveBeenCalled();
  });

  it('REMUXES an AAC file at or under 128 kbps instead of re-encoding it', async () => {
    ffmpeg.probe.mockResolvedValue({
      durationMs: 60_000,
      codec: 'aac',
      channels: 2,
      bitrateKbps: 112,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    });

    await handler.process(job());

    expect(ffmpeg.transcode).toHaveBeenCalledWith(
      expect.objectContaining({ plan: { remux: true, bitrateKbps: 96 } }),
    );

    // And the recorded facts describe the COPIED stream, not the target: a
    // remux leaves 112 kbit/s stereo alone.
    expect(objects.recordUploaded).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ remuxed: true, channels: 2, bitrateKbps: 112 }),
      }),
    );
  });

  it('does nothing for a transcript that already has a ready rendition', async () => {
    pipeline.loadForJob.mockResolvedValue(
      transcriptRow({ playbackStatus: 'ready', playbackObjectId: 'rendition-0' }),
    );

    await handler.process(job());

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('does nothing for a transcript that is gone, failed or being deleted', async () => {
    pipeline.loadForJob.mockResolvedValue(null);
    await handler.process(job());

    pipeline.loadForJob.mockResolvedValue(transcriptRow({ status: 'deleting' }));
    await handler.process(job());

    expect(ffmpeg.probe).not.toHaveBeenCalled();
  });

  it('refuses a rendition ffmpeg produced as zero bytes', async () => {
    ffmpeg.transcode.mockImplementation(async ({ output }: { output: string }) => {
      writeFileSync(output, Buffer.alloc(0));
    });

    await expect(handler.process(job())).rejects.toThrow(/empty rendition/i);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Unblocking transcription
  // ---------------------------------------------------------------------------

  it('queues the submission only when transcription was waiting for this file', async () => {
    await handler.process(job());
    expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);

    pipeline.enqueueSubmit.mockClear();
    // Already submitted against the original: submitting again would pay the
    // vendor twice for one recording.
    prisma.transcript.findUnique.mockResolvedValue({
      transcriptionStatus: 'submitted',
      status: 'processing',
    });

    await handler.process(job());
    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
  });

  it('closes the loop: an input the provider cannot accept waits, then submits', async () => {
    // The two halves of the decision, in the order they really happen.
    const capabilities = provider.capabilities;

    // 1. At upload time there is no rendition, so `transcription.submit` is
    //    told to WAIT — which is what put the transcript in `waiting_input`.
    const beforeRendition = selectTranscriptionInput({
      capabilities,
      audioDelivery: 'presigned_url',
      original: { id: 'obj-1', mimeType: 'audio/wav', size: 10_000_000 },
      rendition: null,
      renditionExpected: true,
    });

    expect(beforeRendition.kind).toBe('wait');
    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();

    // 2. This handler produces it, and only now is the submission queued.
    await handler.process(job());

    expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID);

    // 3. And the file it produced is one the provider takes, so the re-decision
    //    inside `transcription.submit` will choose it rather than waiting again.
    const afterRendition = selectTranscriptionInput({
      capabilities,
      audioDelivery: 'presigned_url',
      original: { id: 'obj-1', mimeType: 'audio/wav', size: 10_000_000 },
      rendition: { id: 'rendition-1', mimeType: 'audio/mp4', size: 512_000 },
    });

    expect(afterRendition).toMatchObject({ kind: 'rendition', objectId: 'rendition-1' });
  });

  it('re-reads the transcription status rather than trusting the copy from an hour ago', async () => {
    // The transcode may have run for an hour; `transcription_status` is
    // exactly the kind of field that moves while it does.
    pipeline.loadForJob.mockResolvedValue(transcriptRow({ transcriptionStatus: 'waiting_input' }));
    prisma.transcript.findUnique.mockResolvedValue({
      transcriptionStatus: 'cancelled',
      status: 'processing',
    });

    await handler.process(job());

    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
  });

  it('fails the transcript with a clear reason when the recording is over the provider limit', async () => {
    provider.capabilities.maxDurationMs = 30 * 60_000;
    ffmpeg.probe.mockResolvedValue({
      durationMs: 90 * 60_000,
      codec: 'pcm_s16le',
      channels: 1,
      bitrateKbps: 700,
      formatName: 'wav',
    });

    await handler.process(job());

    // The RENDITION is still recorded: the audio is worth playing back even
    // though nobody will transcribe it.
    expect(objects.recordUploaded).toHaveBeenCalled();
    expect(prisma.transcript.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ playbackStatus: 'ready' }) }),
    );

    expect(pipeline.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptId: TRANSCRIPT_ID,
        stage: 'transcription',
        retryable: false,
        reason: expect.stringContaining('90 minutes long'),
      }),
    );
    expect(pipeline.markFailed.mock.calls[0][0].reason).toContain('30-minute limit');
    expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Failure policy
  // ---------------------------------------------------------------------------

  it('leaves playback_status alone on a retryable attempt', async () => {
    ffmpeg.probe.mockRejectedValue(new Error('signed URL expired'));

    await expect(handler.process(job({ attempts: 1 }))).rejects.toThrow('signed URL expired');

    expect(prisma.transcript.updateMany).not.toHaveBeenCalled();
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });

  it('marks playback failed on the LAST attempt, and fails a transcript waiting on it', async () => {
    // Otherwise `transcription.submit` reads `renditionExpected` as true
    // forever and the transcript sits in `waiting_input` with no error.
    ffmpeg.probe.mockRejectedValue(new Error('no audio stream'));
    prisma.transcript.findUnique.mockResolvedValue({ transcriptionStatus: 'waiting_input' });

    await expect(handler.process(job({ attempts: 3 }))).rejects.toThrow('no audio stream');

    expect(prisma.transcript.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { playbackStatus: 'failed' } }),
    );
    expect(pipeline.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'transcode' }),
    );
  });

  it('does not fail a transcript that was never waiting on the rendition', async () => {
    ffmpeg.probe.mockRejectedValue(new Error('no audio stream'));
    prisma.transcript.findUnique.mockResolvedValue({ transcriptionStatus: 'submitted' });

    await expect(handler.process(job({ attempts: 3 }))).rejects.toThrow();

    expect(prisma.transcript.updateMany).toHaveBeenCalled();
    expect(pipeline.markFailed).not.toHaveBeenCalled();
  });

  it('reports the REAL error even when recording the failure also fails', async () => {
    ffmpeg.probe.mockRejectedValue(new Error('no audio stream'));
    prisma.transcript.updateMany.mockRejectedValue(new Error('database is down'));

    await expect(handler.process(job({ attempts: 3 }))).rejects.toThrow('no audio stream');
  });

  // ---------------------------------------------------------------------------
  // The node path
  // ---------------------------------------------------------------------------

  describe('nodeResultSchema', () => {
    it('accepts a well-formed result', () => {
      expect(mediaAudioTranscodeResultSchema.parse(NODE_RESULT)).toEqual(NODE_RESULT);
    });

    it.each([
      ['a zero-byte rendition', { ...NODE_RESULT, bytes: 0 }],
      ['a fractional byte count', { ...NODE_RESULT, bytes: 1.5 }],
      ['a negative duration', { ...NODE_RESULT, durationMs: -1 }],
      ['an implausible duration', { ...NODE_RESULT, durationMs: 50 * 60 * 60 * 1000 }],
      ['a bitrate above the schema ceiling', { ...NODE_RESULT, bitrateKbps: 999 }],
      ['zero channels', { ...NODE_RESULT, channels: 0 }],
      ['an empty codec', { ...NODE_RESULT, codec: '' }],
      ['a non-boolean remuxed', { ...NODE_RESULT, remuxed: 'yes' }],
      ['a missing field', { bytes: 1 }],
      ['not an object at all', 'nope'],
    ])('rejects %s', (_label, body) => {
      expect(() => mediaAudioTranscodeResultSchema.parse(body)).toThrow();
    });
  });

  it('persists a node result without re-probing or re-converting anything', async () => {
    await handler.persistNodeResult(job(), NODE_RESULT);

    // PERSIST ONLY. The moment the server recomputes, the node's answer is
    // decorative and the reason for the node plane is gone.
    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(ffmpeg.transcode).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();

    expect(objects.recordUploaded).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: `transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`,
        size: NODE_RESULT.bytes,
      }),
    );
  });

  it('refuses a result whose object never landed in the bucket', async () => {
    // The read-back check is the one thing `persistNodeResult` MAY do: it
    // establishes that the bytes exist, it does not re-derive what is in them.
    objects.recordUploaded.mockRejectedValue(
      new MissingUploadedObjectError(`transcripts/${TRANSCRIPT_ID}/renditions/${JOB_ID}.m4a`),
    );

    await expect(handler.persistNodeResult(job(), NODE_RESULT)).rejects.toThrow(
      MissingUploadedObjectError,
    );
    expect(prisma.transcript.update).not.toHaveBeenCalled();
  });

  it('re-parses the result rather than trusting the caller to have validated it', async () => {
    await expect(handler.persistNodeResult(job(), { bytes: -3 })).rejects.toThrow();
    expect(objects.recordUploaded).not.toHaveBeenCalled();
  });

  it('records nothing when the transcript is gone by the time the node reports', async () => {
    pipeline.loadForJob.mockResolvedValue(null);

    await expect(handler.persistNodeResult(job(), NODE_RESULT)).resolves.toBeUndefined();
    expect(objects.recordUploaded).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // ⚠ The one that catches a divergence between the two paths
  // ---------------------------------------------------------------------------

  it('writes the SAME rows whichever executor produced the rendition', async () => {
    // The server path, with a probe and a file that describe exactly what the
    // node reports below.
    ffmpeg.probe.mockResolvedValue({
      durationMs: NODE_RESULT.durationMs,
      codec: 'pcm_s16le',
      channels: 2,
      bitrateKbps: 1411,
      formatName: 'wav',
    });
    ffmpeg.transcode.mockImplementation(async ({ output }: { output: string }) => {
      writeFileSync(output, Buffer.alloc(NODE_RESULT.bytes, 3));
    });

    await handler.process(job());

    const serverRecord = objects.recordUploaded.mock.calls[0][0];
    const serverUpdate = prisma.transcript.update.mock.calls[0][0];
    const serverSubmits = pipeline.enqueueSubmit.mock.calls.length;

    objects.recordUploaded.mockClear();
    prisma.transcript.update.mockClear();
    pipeline.enqueueSubmit.mockClear();

    await handler.persistNodeResult(job(), NODE_RESULT);

    const nodeRecord = objects.recordUploaded.mock.calls[0][0];
    const nodeUpdate = prisma.transcript.update.mock.calls[0][0];

    // `producedBy` is the ONE field that is allowed to differ, and it exists
    // precisely so a result that looks wrong can be traced to its executor.
    expect(serverRecord.metadata.producedBy).toBe('server');
    expect(nodeRecord.metadata.producedBy).toBe('node');

    const omitProducer = (record: Record<string, unknown>): unknown => ({
      ...record,
      metadata: { ...(record.metadata as Record<string, unknown>), producedBy: undefined },
    });

    expect(omitProducer(nodeRecord)).toEqual(omitProducer(serverRecord));
    expect(nodeUpdate).toEqual(serverUpdate);
    expect(pipeline.enqueueSubmit.mock.calls.length).toBe(serverSubmits);
  });
});
