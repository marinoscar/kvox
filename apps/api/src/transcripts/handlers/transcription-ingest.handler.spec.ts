import { Test } from '@nestjs/testing';
import type { Job } from '@prisma/client';
import { gunzipSync } from 'node:zlib';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderInputError } from '../../transcription/errors';
import { TranscriptObjectsService } from '../transcript-objects.service';
import { TranscriptPipelineService } from '../transcript-pipeline.service';
import { TranscriptionRuntimeService } from '../transcription-runtime.service';
import {
  createFakeProvider,
  fakeNormalized,
  type FakeProvider,
} from './__fixtures__/fake-provider';
import {
  buildSpeakers,
  countWords,
  ORDINAL_GAP,
  TranscriptionIngestHandler,
} from './transcription-ingest.handler';

// =============================================================================
// `transcription.ingest` — the acceptance criteria (issue #25)
// =============================================================================
//
//   • idempotent: exits if version 1 already exists;
//   • writes v1 ATOMICALLY — speakers, segments, the version row and
//     `status: ready` are one transaction;
//   • stores the raw provider JSON gzipped, for provenance;
//   • deletes the remote copy when `deleteRemoteAfterIngest` is on;
//   • and the three things deliberately OUTSIDE the transaction cannot roll it
//     back: a failed provenance upload, a failed remote delete, the
//     notification.
// =============================================================================

const TRANSCRIPT_ID = 'transcript-1';

const job = (payload: unknown = { transcriptId: TRANSCRIPT_ID }): Job =>
  ({ id: 'job-1', payload } as unknown as Job);

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'user-1',
  title: 'A recording',
  status: 'processing',
  transcriptionStatus: 'completed',
  providerJobId: 'remote-1',
  durationMs: null,
  language: null,
  deletedAt: null,
  ...overrides,
});

describe('TranscriptionIngestHandler', () => {
  let handler: TranscriptionIngestHandler;
  let provider: FakeProvider;
  let tx: {
    transcriptSpeaker: { create: jest.Mock };
    transcriptSegment: { createMany: jest.Mock };
    transcriptVersion: { create: jest.Mock };
    transcript: { update: jest.Mock };
  };
  let prisma: {
    transcriptVersion: { findUnique: jest.Mock };
    transcript: { update: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let pipeline: {
    loadForJob: jest.Mock;
    markFailed: jest.Mock;
    enqueueSnapshot: jest.Mock;
    notifyReady: jest.Mock;
  };
  let runtime: { resolve: jest.Mock };
  let objects: { put: jest.Mock };
  let policy: Record<string, unknown>;

  beforeEach(async () => {
    provider = createFakeProvider();
    provider.fetchResult.mockResolvedValue({
      raw: { id: 'remote-1', status: 'completed' },
      normalized: fakeNormalized(),
    });

    policy = { deleteRemoteAfterIngest: true };

    let speakerSeq = 0;

    tx = {
      transcriptSpeaker: {
        create: jest.fn().mockImplementation(async () => {
          speakerSeq += 1;
          return { id: `speaker-${speakerSeq}` };
        }),
      },
      transcriptSegment: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      transcriptVersion: { create: jest.fn().mockResolvedValue({}) },
      transcript: { update: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      transcriptVersion: { findUnique: jest.fn().mockResolvedValue(null) },
      transcript: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          id: TRANSCRIPT_ID,
          ownerId: 'user-1',
          title: 'A recording',
          durationMs: 120_000,
          speakerCount: 2,
          wordCount: 4,
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (client: unknown) => unknown) => fn(tx)),
    };

    pipeline = {
      loadForJob: jest.fn().mockResolvedValue(transcriptRow()),
      markFailed: jest.fn().mockResolvedValue(true),
      enqueueSnapshot: jest.fn().mockResolvedValue(false),
      notifyReady: jest.fn().mockResolvedValue(undefined),
    };

    runtime = {
      resolve: jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy }),
    };

    objects = { put: jest.fn().mockResolvedValue({ id: 'obj-raw' }) };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptionIngestHandler,
        { provide: JobHandlerRegistry, useValue: { register: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: TranscriptionRuntimeService, useValue: runtime },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptObjectsService, useValue: objects },
        { provide: ProviderThrottleService, useValue: { registerProviderKey: jest.fn() } },
      ],
    }).compile();

    handler = module.get(TranscriptionIngestHandler);
  });

  it('declares the fifteen-minute, three-attempt profile', () => {
    expect(handler.profile).toEqual({ maxRuntimeMs: 900_000, maxAttempts: 3 });
  });

  describe('idempotency', () => {
    it('exits without fetching anything when version 1 already exists', async () => {
      prisma.transcriptVersion.findUnique.mockResolvedValue({ id: 'version-1' });

      await handler.process(job());

      expect(provider.fetchResult).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('the one transaction', () => {
    it('writes speakers, segments, the version row and `ready` together', async () => {
      await handler.process(job());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.transcriptSpeaker.create).toHaveBeenCalledTimes(2);
      expect(tx.transcriptSegment.createMany).toHaveBeenCalledTimes(1);
      expect(tx.transcriptVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 1, kind: 'ai_original', authorId: null }),
        }),
      );
      expect(tx.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ready', currentVersion: 1 }),
        }),
      );
    });

    it('gives segments gap-based ordinals so a later split needs no renumbering', async () => {
      await handler.process(job());

      const { data } = tx.transcriptSegment.createMany.mock.calls[0][0];

      expect(data.map((row: { ordinal: number }) => row.ordinal)).toEqual([
        ORDINAL_GAP,
        2 * ORDINAL_GAP,
      ]);
    });

    it('marks freshly ingested word timings `exact` — they are the provider\'s own', async () => {
      await handler.process(job());

      const { data } = tx.transcriptSegment.createMany.mock.calls[0][0];

      expect(data.every((row: { wordsAlignment: string }) => row.wordsAlignment === 'exact')).toBe(
        true,
      );
      expect(data[0].words).toEqual([
        { t: 'Hello', s: 0, e: 800, c: 0.99 },
        { t: 'there.', s: 820, e: 2_000, c: 0.95 },
      ]);
    });

    it('records the speaker and word counts, and adopts the measured duration', async () => {
      await handler.process(job());

      expect(tx.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            speakerCount: 2,
            wordCount: 4,
            durationMs: 120_000,
            language: 'en',
          }),
        }),
      );
    });
  });

  describe('provenance', () => {
    it('stores the raw provider JSON gzipped, as a managed object', async () => {
      await handler.process(job());

      const [input] = objects.put.mock.calls[0];

      expect(input.mimeType).toBe('application/gzip');
      expect(input.ownerId).toBe('user-1');
      expect(input.storageKey).toBe(`transcripts/${TRANSCRIPT_ID}/raw/remote-1.json.gz`);
      expect(JSON.parse(gunzipSync(input.body).toString('utf8'))).toEqual({
        id: 'remote-1',
        status: 'completed',
      });
    });

    it('links it onto the transcript in the same write that makes it ready', async () => {
      await handler.process(job());

      expect(tx.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rawResultObjectId: 'obj-raw' }),
        }),
      );
    });

    it('INGESTS ANYWAY when storage is unavailable', async () => {
      // Provenance is insurance, not the product: a transcript the user can
      // read is worth more than a raw blob nobody has asked for.
      objects.put.mockRejectedValue(new Error('bucket unreachable'));

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.transcript.update.mock.calls[0][0].data).not.toHaveProperty(
        'rawResultObjectId',
      );
    });
  });

  describe('after the commit', () => {
    it('deletes the provider copy and records when, with the setting on', async () => {
      await handler.process(job());

      expect(provider.deleteRemote).toHaveBeenCalledWith({ apiKey: 'k' }, 'remote-1');
      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ remoteDeletedAt: expect.any(Date) }),
        }),
      );
    });

    it('leaves the provider copy alone with the setting off', async () => {
      policy.deleteRemoteAfterIngest = false;

      await handler.process(job());

      expect(provider.deleteRemote).not.toHaveBeenCalled();
    });

    it('still reports success when the remote delete fails', async () => {
      // A privacy debt to clear later, not a reason to tell the owner their
      // transcription failed.
      provider.deleteRemote.mockRejectedValue(new Error('vendor 500'));

      await expect(handler.process(job())).resolves.toBeUndefined();
      expect(pipeline.notifyReady).toHaveBeenCalled();
    });

    it('notifies the owner, naming the provider', async () => {
      await handler.process(job());

      expect(pipeline.notifyReady).toHaveBeenCalledWith(
        expect.objectContaining({ id: TRANSCRIPT_ID, ownerId: 'user-1' }),
        'Fake Provider',
      );
    });

    it('asks for a snapshot, which is a no-op until #27 registers the handler', async () => {
      await handler.process(job());

      expect(pipeline.enqueueSnapshot).toHaveBeenCalledWith(TRANSCRIPT_ID, 1);
    });
  });

  describe('failures', () => {
    it('records a rejected result as a domain failure and succeeds', async () => {
      provider.fetchResult.mockRejectedValue(new ProviderInputError('Corrupt audio.'));

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'ingest', reason: 'Corrupt audio.' }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rethrows a 429', async () => {
      provider.fetchResult.mockRejectedValue(new RateLimitError('429'));

      await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
    });

    it('fails the transcript when there is no provider job to fetch from', async () => {
      pipeline.loadForJob.mockResolvedValue(transcriptRow({ providerJobId: null }));

      await handler.process(job());

      expect(pipeline.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'ingest' }),
      );
    });

    it.each([
      ['a deleting transcript', { status: 'deleting' }],
      ['a cancelled transcription', { transcriptionStatus: 'cancelled' }],
    ] as Array<[string, Record<string, unknown>]>)(
      'is a no-op for %s',
      async (_label, overrides) => {
        pipeline.loadForJob.mockResolvedValue(transcriptRow(overrides));

        await handler.process(job());

        expect(provider.fetchResult).not.toHaveBeenCalled();
      },
    );
  });
});

describe('buildSpeakers', () => {
  it('names each provider label as a readable display name', () => {
    expect(buildSpeakers(fakeNormalized())).toEqual([
      { label: 'A', displayName: 'Speaker A', colorIndex: 0 },
      { label: 'B', displayName: 'Speaker B', colorIndex: 1 },
    ]);
  });

  it('falls back to the labels the segments actually use', () => {
    // A provider that diarizes but reports no speaker roster.
    const normalized = fakeNormalized({ speakers: [] });

    expect(buildSpeakers(normalized).map((entry) => entry.label)).toEqual(['A', 'B']);
  });
});

describe('countWords', () => {
  it('counts word timings when the provider produced them', () => {
    expect(countWords(fakeNormalized())).toBe(4);
  });

  it('falls back to tokenising the text when it did not', () => {
    // A provider that diarizes without word timings is a real configuration,
    // and `wordCount: 0` for a transcript full of text would be wrong in the
    // one field every list view shows.
    const normalized = fakeNormalized({
      segments: [
        {
          speakerLabel: 'A',
          startMs: 0,
          endMs: 1_000,
          text: 'one two three',
          confidence: null,
          words: [],
        },
      ],
    });

    expect(countWords(normalized)).toBe(3);
  });
});
