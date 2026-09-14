import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import {
  TRANSCODE_JOB_TYPE,
  TRANSCRIPT_EXPORT_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
} from '../job-types';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import {
  MAX_QUOTED_JOB_ERROR_LENGTH,
  quoteJobError,
  resolveTranscriptId,
  TranscriptJobFailureListener,
} from './transcript-job-failure.listener';

// =============================================================================
// TranscriptJobFailureListener (issue #95, epic #19)
// =============================================================================
//
// This is the listener that closes the #95 stranding: a pipeline job that
// EXHAUSTED its retry budget must not leave a transcript saying "Sending to
// the transcription service" forever with no error anywhere. The file under
// test is already committed — see its own header for the full rationale —
// so this suite only proves the behaviour, against hand-built `Job` rows and
// a mocked `PrismaService`/`TranscriptPipelineService`, the same convention
// `transcripts-upload.listener.spec.ts` uses.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: TRANSCRIPTION_SUBMIT_JOB_TYPE,
    subjectType: null,
    subjectId: null,
    dedupKey: null,
    status: 'failed',
    reason: 'upload',
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: { transcriptId: TRANSCRIPT_ID },
    attempts: 3,
    lastError: 'AssemblyAI returned HTTP 400: deprecated parameter',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: new Date('2026-01-01T00:00:01Z'),
    finishedAt: new Date('2026-01-01T00:00:02Z'),
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: 'server',
    ...overrides,
  } as Job;
}

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  status: 'processing',
  deletedAt: null,
  ...overrides,
});

describe('TranscriptJobFailureListener', () => {
  let listener: TranscriptJobFailureListener;
  let prisma: {
    transcript: { findUnique: jest.Mock; updateMany: jest.Mock };
    job: { count: jest.Mock };
  };
  let pipeline: { markFailed: jest.Mock };
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    prisma = {
      transcript: {
        findUnique: jest.fn().mockResolvedValue(transcriptRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    pipeline = { markFailed: jest.fn().mockResolvedValue(true) };

    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const module = await Test.createTestingModule({
      providers: [
        TranscriptJobFailureListener,
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
      ],
    }).compile();

    listener = module.get(TranscriptJobFailureListener);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Let the detached `reconcile(...).catch(...)` promise settle. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ---------------------------------------------------------------------------
  // The filter, and the synchronous-return contract
  // ---------------------------------------------------------------------------

  describe('handleJobSettled', () => {
    it('ignores a succeeded job of a pipeline type', async () => {
      const result = listener.handleJobSettled(
        new JobSettledEvent(job({ status: 'succeeded' })),
      );

      expect(result).toBeUndefined();

      await flush();

      expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
      expect(prisma.job.count).not.toHaveBeenCalled();
    });

    it('ignores a failed job of a non-pipeline type (e.g. transcript.export)', async () => {
      const result = listener.handleJobSettled(
        new JobSettledEvent(job({ status: 'failed', type: TRANSCRIPT_EXPORT_JOB_TYPE })),
      );

      expect(result).toBeUndefined();

      await flush();

      expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
    });

    it('returns undefined synchronously even for a failed pipeline job', () => {
      const result = listener.handleJobSettled(new JobSettledEvent(job()));

      expect(result).toBeUndefined();
    });

    it('contains a rejection from reconcile() — no unhandled rejection, logged instead', async () => {
      prisma.transcript.findUnique.mockRejectedValue(new Error('database is on fire'));

      const result = listener.handleJobSettled(new JobSettledEvent(job()));

      // Synchronous return, exactly as when reconcile succeeds — the failure
      // happens on the detached promise, never on the call itself.
      expect(result).toBeUndefined();

      await flush();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('database is on fire'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // reconcile() — the exhausted-submit/poll/ingest path
  // ---------------------------------------------------------------------------

  describe('reconcile — transcription.submit / .poll / .ingest', () => {
    it('fails the transcript with stage "transcription" for an exhausted submit', async () => {
      await listener.reconcile(job({ type: TRANSCRIPTION_SUBMIT_JOB_TYPE }));

      expect(pipeline.markFailed).toHaveBeenCalledTimes(1);
      expect(pipeline.markFailed).toHaveBeenCalledWith({
        transcriptId: TRANSCRIPT_ID,
        stage: 'transcription',
        retryable: true,
        reason: expect.stringContaining('You can retry it.'),
      });

      const reason = pipeline.markFailed.mock.calls[0][0].reason as string;
      expect(reason).toContain('AssemblyAI returned HTTP 400: deprecated parameter');
    });

    it('fails the transcript with stage "transcription" for an exhausted poll', async () => {
      await listener.reconcile(job({ type: TRANSCRIPTION_POLL_JOB_TYPE }));

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'transcription', retryable: true }),
      );
    });

    it('fails the transcript with stage "ingest" for an exhausted ingest', async () => {
      await listener.reconcile(job({ type: TRANSCRIPTION_INGEST_JOB_TYPE }));

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'ingest', retryable: true }),
      );

      const reason = pipeline.markFailed.mock.calls[0][0].reason as string;
      expect(reason).toContain('You can retry it.');
      expect(reason).toMatch(/saved/i);
    });

    it('resolves the transcript id from the subject when the payload carries none', async () => {
      await listener.reconcile(
        job({
          type: TRANSCRIPTION_SUBMIT_JOB_TYPE,
          payload: null,
          subjectType: TRANSCRIPT_SUBJECT_TYPE,
          subjectId: 'transcript-from-subject',
        }),
      );

      expect(prisma.transcript.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'transcript-from-subject' } }),
      );
      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ transcriptId: 'transcript-from-subject' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // No-ops
  // ---------------------------------------------------------------------------

  describe('reconcile — no-ops', () => {
    it('does nothing when the transcript payload/subject names nothing at all', async () => {
      await listener.reconcile(job({ payload: null, subjectType: null, subjectId: null }));

      expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('does nothing when the transcript cannot be found', async () => {
      prisma.transcript.findUnique.mockResolvedValue(null);

      await listener.reconcile(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.job.count).not.toHaveBeenCalled();
    });

    it('does nothing when the transcript has been soft-deleted', async () => {
      prisma.transcript.findUnique.mockResolvedValue(
        transcriptRow({ deletedAt: new Date() }),
      );

      await listener.reconcile(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.job.count).not.toHaveBeenCalled();
    });

    it('does nothing when the transcript is already failed', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcriptRow({ status: 'failed' }));

      await listener.reconcile(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.job.count).not.toHaveBeenCalled();
    });

    it('does nothing when the transcript is already ready', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcriptRow({ status: 'ready' }));

      await listener.reconcile(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      expect(prisma.job.count).not.toHaveBeenCalled();
    });

    it('does nothing when a newer pipeline job for the same transcript is still active', async () => {
      prisma.job.count.mockResolvedValue(1);

      await listener.reconcile(job());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
    });

    it('excludes the settled job itself from the still-active count', async () => {
      const settled = job({ id: 'the-settled-job' });

      await listener.reconcile(settled);

      expect(prisma.job.count).toHaveBeenCalledTimes(1);
      const where = prisma.job.count.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'the-settled-job' });
    });
  });

  // ---------------------------------------------------------------------------
  // reconcile — media.audio.transcode
  // ---------------------------------------------------------------------------

  describe('reconcile — media.audio.transcode', () => {
    function transcodeJob(overrides: Partial<Job> = {}): Job {
      return job({
        type: TRANSCODE_JOB_TYPE,
        payload: { transcriptId: TRANSCRIPT_ID },
        subjectType: 'storage_object',
        subjectId: 'obj-1',
        ...overrides,
      });
    }

    it('always marks the playback rendition failed when it was pending/processing', async () => {
      prisma.transcript.findUnique
        .mockResolvedValueOnce(transcriptRow())
        .mockResolvedValueOnce({ transcriptionStatus: 'submitting' });

      await listener.reconcile(transcodeJob());

      expect(prisma.transcript.updateMany).toHaveBeenCalledWith({
        where: { id: TRANSCRIPT_ID, playbackStatus: { in: ['pending', 'processing'] } },
        data: { playbackStatus: 'failed' },
      });
    });

    it('fails the transcript with stage "transcode" only when transcription was waiting on this rendition', async () => {
      prisma.transcript.findUnique
        .mockResolvedValueOnce(transcriptRow())
        .mockResolvedValueOnce({ transcriptionStatus: 'waiting_input' });

      await listener.reconcile(transcodeJob());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ transcriptId: TRANSCRIPT_ID, stage: 'transcode' }),
      );
      // No `retryable` flag on this call site — unlike submit/poll/ingest.
      expect(pipeline.markFailed.mock.calls[0][0]).not.toHaveProperty('retryable');
    });

    it('does NOT fail the transcript when transcription is not waiting on this rendition', async () => {
      prisma.transcript.findUnique
        .mockResolvedValueOnce(transcriptRow())
        .mockResolvedValueOnce({ transcriptionStatus: 'submitting' });

      await listener.reconcile(transcodeJob());

      expect(pipeline.markFailed).not.toHaveBeenCalled();
      // The playback write still happened — it is unconditional.
      expect(prisma.transcript.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});

// -----------------------------------------------------------------------------
// resolveTranscriptId
// -----------------------------------------------------------------------------

describe('resolveTranscriptId', () => {
  it('prefers the payload transcriptId', () => {
    expect(
      resolveTranscriptId({
        payload: { transcriptId: 'from-payload' },
        subjectType: TRANSCRIPT_SUBJECT_TYPE,
        subjectId: 'from-subject',
      }),
    ).toBe('from-payload');
  });

  it('falls back to a transcript subject when the payload carries none', () => {
    expect(
      resolveTranscriptId({
        payload: null,
        subjectType: TRANSCRIPT_SUBJECT_TYPE,
        subjectId: 'from-subject',
      }),
    ).toBe('from-subject');
  });

  it('ignores a non-transcript subject', () => {
    expect(
      resolveTranscriptId({
        payload: null,
        subjectType: 'storage_object',
        subjectId: 'obj-1',
      }),
    ).toBeNull();
  });

  it('returns null when nothing names a transcript', () => {
    expect(
      resolveTranscriptId({ payload: null, subjectType: null, subjectId: null }),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// quoteJobError
// -----------------------------------------------------------------------------

describe('quoteJobError', () => {
  it('returns null for a null lastError', () => {
    expect(quoteJobError(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(quoteJobError('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(quoteJobError('   \n\t  ')).toBeNull();
  });

  it('collapses internal whitespace, including newlines, to single spaces', () => {
    expect(quoteJobError('line one\nline   two\t\tline three')).toBe(
      'line one line two line three',
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(quoteJobError('  padded message  ')).toBe('padded message');
  });

  it('bounds a long message to MAX_QUOTED_JOB_ERROR_LENGTH characters, ending with an ellipsis', () => {
    const long = 'x'.repeat(MAX_QUOTED_JOB_ERROR_LENGTH + 200);

    const result = quoteJobError(long);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(MAX_QUOTED_JOB_ERROR_LENGTH);
    expect(result?.endsWith('…')).toBe(true);
    expect(result?.slice(0, -1)).toBe('x'.repeat(MAX_QUOTED_JOB_ERROR_LENGTH - 1));
  });

  it('leaves a short message untouched (no ellipsis)', () => {
    expect(quoteJobError('short and sweet')).toBe('short and sweet');
  });
});

// -----------------------------------------------------------------------------
// The reason string carries no dangling "( … )" when there is no error to quote
// -----------------------------------------------------------------------------

describe('reconcile — the reason string when lastError is null', () => {
  it('has no trailing "( … )" segment', async () => {
    const prisma = {
      transcript: {
        findUnique: jest.fn().mockResolvedValue(transcriptRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      job: { count: jest.fn().mockResolvedValue(0) },
    };
    const pipeline = { markFailed: jest.fn().mockResolvedValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptJobFailureListener,
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptPipelineService, useValue: pipeline },
      ],
    }).compile();

    const listener = module.get(TranscriptJobFailureListener);

    await listener.reconcile(job({ lastError: null }));

    const reason = pipeline.markFailed.mock.calls[0][0].reason as string;
    expect(reason).not.toMatch(/\(.*\)\s*$/);
    expect(reason.endsWith('You can retry it.')).toBe(true);
  });
});
