import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { createFakeProvider, type FakeProvider } from './handlers/__fixtures__/fake-provider';
import { TRANSCRIPTS_MANAGED_BY } from './job-types';
import { TranscriptAccessService } from './transcript-access.service';
import { TranscriptObjectsService } from './transcript-objects.service';
import { TranscriptPipelineService } from './transcript-pipeline.service';
import { TranscriptionRuntimeService } from './transcription-runtime.service';
import {
  decodeCursor,
  defaultTitle,
  encodeCursor,
  readWords,
  TranscriptsService,
} from './transcripts.service';

// =============================================================================
// TranscriptsService — create, retry, cancel and the cursor (issue #25)
// =============================================================================
//
// The acceptance criteria covered here are the two 4xx codes on create — 400
// for a file over the provider's ceiling, 409 for a deployment that has not
// been configured — and the retry rule that decides the stage FROM THE ROW
// rather than from the caller, which is what stops a second remote job (and a
// second bill) for one recording.
// =============================================================================

const USER: RequestUser = {
  id: 'user-1',
  email: 'owner@example.com',
  roles: ['viewer'],
  permissions: ['transcripts:read', 'transcripts:write'],
  isActive: true,
};

const TRANSCRIPT_ID = 'transcript-1';

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: USER.id,
  title: 'A recording',
  status: 'failed',
  transcriptionStatus: 'failed',
  playbackStatus: 'pending',
  language: null,
  durationMs: 60_000,
  speakerCount: 0,
  wordCount: 0,
  currentVersion: 0,
  failureReason: 'It broke.',
  provider: 'fake',
  providerJobId: null,
  sourceObjectId: 'obj-1',
  playbackObjectId: null,
  remoteDeletedAt: null,
  submittedAt: null,
  completedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

describe('TranscriptsService', () => {
  let service: TranscriptsService;
  let provider: FakeProvider;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let objects: { initUpload: jest.Mock };
  let access: { require: jest.Mock };
  let pipeline: {
    enqueuePurge: jest.Mock;
    enqueueSubmit: jest.Mock;
    enqueueFirstPoll: jest.Mock;
  };
  let runtime: { activeProvider: jest.Mock; isAvailable: jest.Mock; resolve: jest.Mock };

  beforeEach(async () => {
    provider = createFakeProvider();

    prisma = {
      transcript: {
        create: jest.fn().mockResolvedValue(transcriptRow({ status: 'uploading' })),
        update: jest.fn().mockResolvedValue(transcriptRow()),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue(transcriptRow()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      // #48 (epic #45): `remove` pre-checks the notes generated from this
      // transcript, because `notes.source_transcript_id` is `Restrict`.
      note: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptSpeaker: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptSegment: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptShare: { findMany: jest.fn().mockResolvedValue([]) },
      // #29: every list and detail row carries the owner's display name, so
      // both shapes read `users` — the batch path once per page, the detail
      // path once per row.
      user: {
        findUnique: jest.fn().mockResolvedValue({
          displayName: 'Ana Rivera',
          providerDisplayName: null,
          email: 'ana@example.test',
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: USER.id,
            displayName: 'Ana Rivera',
            providerDisplayName: null,
            email: 'ana@example.test',
          },
        ]),
      },
      storageObject: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'meeting.mp3',
          mimeType: 'audio/mpeg',
          size: BigInt(1_000_000),
          status: 'ready',
        }),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    objects = {
      initUpload: jest.fn().mockResolvedValue({
        objectId: 'obj-1',
        uploadId: 'upload-1',
        partSize: 10_485_760,
        totalParts: 1,
        presignedUrls: [{ partNumber: 1, url: 'https://signed' }],
      }),
    };

    access = {
      require: jest.fn().mockResolvedValue({ transcript: transcriptRow(), role: 'owner' }),
    };

    pipeline = {
      enqueuePurge: jest.fn().mockResolvedValue(undefined),
      enqueueSubmit: jest.fn().mockResolvedValue(undefined),
      enqueueFirstPoll: jest.fn().mockResolvedValue(undefined),
    };

    runtime = {
      activeProvider: jest
        .fn()
        .mockResolvedValue({ provider, policy: { audioDelivery: 'presigned_url' } }),
      isAvailable: jest.fn().mockResolvedValue(true),
      resolve: jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy: {} }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ObjectsService, useValue: objects },
        {
          provide: TranscriptObjectsService,
          useValue: { signedUrlFor: jest.fn(), playbackUrlTtlSeconds: () => 21_600 },
        },
        { provide: TranscriptAccessService, useValue: access },
        { provide: TranscriptPipelineService, useValue: pipeline },
        { provide: TranscriptionRuntimeService, useValue: runtime },
      ],
    }).compile();

    service = module.get(TranscriptsService);
  });

  describe('create', () => {
    const dto = {
      source: { name: 'meeting.mp3', size: 1_000_000, mimeType: 'audio/mpeg' },
    };

    it('claims the upload object for this module, which no HTTP caller can', async () => {
      // `managedBy` is a service-level argument only: a client able to declare
      // its own upload "managed by transcripts" could mint a row the generic
      // delete refuses to remove and the generic list refuses to show.
      await service.create(dto, USER);

      expect(objects.initUpload).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'meeting.mp3' }),
        USER.id,
        expect.objectContaining({ managedBy: TRANSCRIPTS_MANAGED_BY }),
      );
    });

    // Issue #79: `create` must gate the upload on the transcription allowlist
    // — the whole audio and video families — NOT on `storage.allowedMimeTypes`
    // (the operator's policy for arbitrary uploads through
    // `POST /api/storage/objects*`). Asserting the literal array, not
    // `expect.any(Array)`, because `expect.any(Array)` would pass just as
    // happily if `create` started passing `[]` or the wrong families.
    //
    // `TRANSCRIPT_SOURCE_MIME_TYPES` is a module-private constant in
    // `transcripts.service.ts` (not exported), so the literal is asserted
    // directly rather than imported.
    it('gates the upload on audio/video, not the operator\'s generic upload allowlist (#79)', async () => {
      await service.create(dto, USER);

      expect(objects.initUpload).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'meeting.mp3' }),
        USER.id,
        {
          managedBy: TRANSCRIPTS_MANAGED_BY,
          allowedMimeTypes: ['audio/*', 'video/*'],
        },
      );
    });

    // The end-to-end-ish case at this layer: an Android .m4a recording —
    // `audio/x-m4a`, the exact type issue #79 was filed over — reaches
    // `initUpload` at all, rather than being turned away earlier by the
    // size/provider pre-flight checks this method runs first.
    it('lets a .m4a / audio/x-m4a source through the pre-flight checks to initUpload (#79)', async () => {
      const m4aDto = {
        source: { name: 'recording.m4a', size: 500_000, mimeType: 'audio/x-m4a' },
      };

      await expect(service.create(m4aDto, USER)).resolves.toBeDefined();

      expect(objects.initUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'recording.m4a',
          mimeType: 'audio/x-m4a',
        }),
        USER.id,
        expect.objectContaining({ allowedMimeTypes: ['audio/*', 'video/*'] }),
      );
    });

    it('returns the transcript AND its upload, so one action is one call', async () => {
      const result = await service.create(dto, USER);

      expect(result.transcript.id).toBe(TRANSCRIPT_ID);
      expect(result.upload.objectId).toBe('obj-1');
    });

    it('titles the transcript after the filename, without its extension', async () => {
      await service.create(dto, USER);

      expect(prisma.transcript.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ title: 'meeting' }) }),
      );
    });

    it('records the speakers hint in provider_options', async () => {
      await service.create({ ...dto, speakersExpected: 4 }, USER);

      expect(prisma.transcript.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerOptions: { speakersExpected: 4, language: null, keyterms: [] },
          }),
        }),
      );
    });

    it('stores keyterms in provider_options whatever the provider supports (#327)', async () => {
      await service.create({ ...dto, keyterms: ['Kvox', 'Oscar Marín'] }, USER);

      expect(prisma.transcript.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerOptions: expect.objectContaining({
              keyterms: ['Kvox', 'Oscar Marín'],
            }),
          }),
        }),
      );
    });

    it('writes an audit event', async () => {
      await service.create(dto, USER);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'transcript:create',
            targetType: 'transcript',
          }),
        }),
      );
    });

    it('is a 409 when nothing is configured — the deployment, not the caller', async () => {
      runtime.activeProvider.mockResolvedValue(null);

      await expect(service.create(dto, USER)).rejects.toBeInstanceOf(ConflictException);
      expect(objects.initUpload).not.toHaveBeenCalled();
    });

    it('is a 409 when a provider is chosen but has no key stored', async () => {
      // The most common half-finished state: choosing a provider and pasting
      // its key are two fields and people save in between.
      runtime.isAvailable.mockResolvedValue(false);

      await expect(service.create(dto, USER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('is a 400 when the file is over the provider\'s ceiling', async () => {
      provider.capabilities.maxInputBytes = 500_000;

      await expect(service.create(dto, USER)).rejects.toBeInstanceOf(BadRequestException);
      expect(objects.initUpload).not.toHaveBeenCalled();
    });

    it('checks everything BEFORE the upload, so nothing half-started is left', async () => {
      runtime.activeProvider.mockResolvedValue(null);

      await expect(service.create(dto, USER)).rejects.toThrow();
      expect(prisma.transcript.create).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('soft-deletes and queues the purge rather than deleting inline', async () => {
      await service.remove(TRANSCRIPT_ID, USER);

      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'deleting', deletedAt: expect.any(Date) }),
        }),
      );
      expect(pipeline.enqueuePurge).toHaveBeenCalledWith(TRANSCRIPT_ID);
    });

    it('requires OWN access with the write permission', async () => {
      await service.remove(TRANSCRIPT_ID, USER);

      expect(access.require).toHaveBeenCalledWith(
        USER.id,
        TRANSCRIPT_ID,
        'own',
        USER.permissions,
      );
    });

    it('is idempotent for a transcript already on its way out', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status: 'deleting' }),
        role: 'owner',
      });

      await service.remove(TRANSCRIPT_ID, USER);

      expect(pipeline.enqueuePurge).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('RE-POLLS a transcript the provider already accepted', async () => {
      // Re-submitting would create a second remote job — and a second bill —
      // for one recording.
      access.require.mockResolvedValue({
        transcript: transcriptRow({ providerJobId: 'remote-1' }),
        role: 'owner',
      });

      await service.retry(TRANSCRIPT_ID, USER);

      expect(pipeline.enqueueFirstPoll).toHaveBeenCalled();
      expect(pipeline.enqueueSubmit).not.toHaveBeenCalled();
    });

    it('RE-SUBMITS one that never got a provider job', async () => {
      await service.retry(TRANSCRIPT_ID, USER);

      expect(pipeline.enqueueSubmit).toHaveBeenCalledWith(TRANSCRIPT_ID, 'rerun');
      expect(pipeline.enqueueFirstPoll).not.toHaveBeenCalled();
    });

    it('clears a CANCELLED transcript\'s handle so it is re-submitted, not revived', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({
          providerJobId: 'remote-1',
          transcriptionStatus: 'cancelled',
        }),
        role: 'owner',
      });

      await service.retry(TRANSCRIPT_ID, USER);

      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerJobId: null, submittedAt: null }),
        }),
      );
      expect(pipeline.enqueueSubmit).toHaveBeenCalled();
    });

    it.each([
      ['already complete', 'ready'],
      ['still uploading', 'uploading'],
      ['being deleted', 'deleting'],
    ] as Array<[string, string]>)('is a 409 for a transcript %s', async (_label, status) => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status }),
        role: 'owner',
      });

      await expect(service.retry(TRANSCRIPT_ID, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('is a 409 when the audio is no longer in storage', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.retry(TRANSCRIPT_ID, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('cancel', () => {
    it('asks the provider to stop when it can, and marks the transcript either way', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status: 'processing', providerJobId: 'remote-1' }),
        role: 'owner',
      });

      await service.cancel(TRANSCRIPT_ID, USER);

      expect(provider.cancel).toHaveBeenCalledWith({ apiKey: 'k' }, 'remote-1');
      expect(prisma.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transcriptionStatus: 'cancelled' }),
        }),
      );
    });

    it('still cancels locally when the vendor will not answer', async () => {
      // The user asked to stop waiting; a vendor that will not answer must not
      // prevent that.
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status: 'processing', providerJobId: 'remote-1' }),
        role: 'owner',
      });
      runtime.resolve.mockRejectedValue(new Error('vendor down'));

      await expect(service.cancel(TRANSCRIPT_ID, USER)).resolves.toBeDefined();
      expect(prisma.transcript.update).toHaveBeenCalled();
    });

    it('skips the provider entirely when it declares no cancel capability', async () => {
      provider.capabilities.cancel = false;
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status: 'processing', providerJobId: 'remote-1' }),
        role: 'owner',
      });

      await service.cancel(TRANSCRIPT_ID, USER);

      expect(provider.cancel).not.toHaveBeenCalled();
    });

    it.each([['ready'], ['deleting']])('is a 409 for a %s transcript', async (status) => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ status }),
        role: 'owner',
      });

      await expect(service.cancel(TRANSCRIPT_ID, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('words', () => {
    it('caps a window nobody should be able to ask for', async () => {
      const result = await service.words(
        TRANSCRIPT_ID,
        { fromMs: 0, toMs: 10 * 60 * 60_000 },
        USER,
      );

      // Thirty minutes, silently, rather than a refusal: the client gets
      // useful data and a `toMs` telling it what it actually got.
      expect(result.toMs).toBe(30 * 60_000);
    });

    it('selects segments by OVERLAP, so the one being played is included', async () => {
      await service.words(TRANSCRIPT_ID, { fromMs: 60_000, toMs: 120_000 }, USER);

      expect(prisma.transcriptSegment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            startMs: { lt: 120_000 },
            endMs: { gte: 60_000 },
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // GET /api/transcripts/summary — the home page's "Needs attention" list
  // ===========================================================================
  //
  // Issue #171 (epic #166) added a `failed` LIST beside the `failed` COUNT the
  // endpoint already had. Prisma is a double here, so what is asserted is the
  // QUERY the method issues — its scope, its order and its cap — plus the one
  // thing no query shape can show: that the count and the list are two
  // separate numbers and the cap never leaks into the count.
  describe('summary', () => {
    /** The eight rows the failed query answers with, newest first. */
    const failedRows = Array.from({ length: 8 }, (_, index) =>
      transcriptRow({
        id: `failed-${index}`,
        status: 'failed',
        updatedAt: new Date(Date.UTC(2026, 0, 20 - index)),
      }),
    );

    /** A failed transcript somebody ELSE owns and shared with this caller. */
    const sharedFailedRow = transcriptRow({
      id: 'shared-failed',
      ownerId: 'someone-else',
      status: 'failed',
    });

    /** The `findMany` args of the one call whose `where` names `status: 'failed'`. */
    const failedQuery = () =>
      prisma.transcript.findMany.mock.calls
        .map(([args]) => args as Record<string, never>)
        .find((args) => (args.where as Record<string, unknown>).status === 'failed') as
        | Record<string, never>
        | undefined;

    beforeEach(() => {
      // The caller holds one share, and the transcript behind it has failed.
      prisma.transcriptShare.findMany.mockResolvedValue([
        { transcriptId: sharedFailedRow.id, role: 'viewer' },
      ]);

      prisma.transcript.findMany.mockImplementation((args: Record<string, never>) => {
        const where = args.where as Record<string, unknown>;

        if (where.status === 'failed') return Promise.resolve(failedRows);
        if (where.id) return Promise.resolve([sharedFailedRow]);
        if (where.status) return Promise.resolve([]);

        return Promise.resolve([]);
      });

      prisma.transcript.count.mockImplementation((args: Record<string, never>) =>
        Promise.resolve((args.where as Record<string, unknown>).status === 'failed' ? 30 : 42),
      );
    });

    it('returns the caller\'s failed transcripts as a list, not only a count', async () => {
      const summary = await service.summary(USER.id);

      expect(summary.failed.map((item) => item.id)).toEqual(
        failedRows.map((row) => row.id),
      );
    });

    it('asks for them owner-scoped, newest first, excluding soft-deleted rows', async () => {
      await service.summary(USER.id);

      expect(failedQuery()).toEqual({
        where: { deletedAt: null, ownerId: USER.id, status: 'failed' },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 8,
      });
    });

    it('caps the list at eight, the same cap `recent` and `sharedWithMe` use', async () => {
      await service.summary(USER.id);

      expect(failedQuery()?.take).toBe(8);
    });

    // OWNER-SCOPED, unlike `inProgress`, which unions the caller's shares:
    // retry is owner-only, so a stranger's failure is an item the caller could
    // not act on. The share is real here — it shows up in `sharedWithMe` — so
    // its absence from `failed` is the scope rule working, not an empty
    // fixture.
    it('leaves out a failed transcript that was merely SHARED with the caller', async () => {
      const summary = await service.summary(USER.id);

      expect(summary.sharedWithMe.map((item) => item.id)).toContain(sharedFailedRow.id);
      expect(summary.failed.map((item) => item.id)).not.toContain(sharedFailedRow.id);
      expect(failedQuery()?.where).not.toHaveProperty('OR');
    });

    // ⚠ The regression this exists to catch is `failed: failedItems.length`,
    // which would read 8 for a user with thirty broken recordings and quietly
    // turn the cap into the truth.
    it('keeps `counts.failed` the TRUE total when more than eight have failed', async () => {
      const summary = await service.summary(USER.id);

      expect(summary.counts.failed).toBe(30);
      expect(summary.failed).toHaveLength(8);
    });

    // The method's whole reason to exist is ONE round trip. A fifth query
    // awaited after the others would still pass every assertion above, so this
    // asserts the shape directly: with no query ever resolving, all four lists
    // and both counts must still have been ISSUED.
    it('issues the failed query in the same round trip as the other lists', async () => {
      prisma.transcript.findMany.mockImplementation(() => new Promise(() => {}));
      prisma.transcript.count.mockImplementation(() => new Promise(() => {}));

      void service.summary(USER.id);
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.transcript.findMany).toHaveBeenCalledTimes(4);
      expect(prisma.transcript.count).toHaveBeenCalledTimes(2);
    });
  });

  describe('detail', () => {
    it('publishes the source size as a decimal STRING, never a BigInt', async () => {
      // `JSON.stringify` throws on a BigInt rather than rounding it, and a
      // multi-gigabyte recording is the ordinary case here.
      const detail = await service.detail(TRANSCRIPT_ID, USER);

      expect(detail.sourceSizeBytes).toBe('1000000');
    });

    it('reports the caller\'s own role, not the owner\'s', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ ownerId: 'someone-else' }),
        role: 'viewer',
      });

      const detail = await service.detail(TRANSCRIPT_ID, USER);

      expect(detail.access).toBe('viewer');
    });
  });

  // ===========================================================================
  // detailConditional / segmentsConditional — the controller's ETag inputs
  // (issue #323)
  // ===========================================================================

  describe('detailConditional', () => {
    it('reports an empty identities map when nobody has named a speaker', async () => {
      const { version, identities } = await service.detailConditional(TRANSCRIPT_ID, USER);

      expect(version).toBe(transcriptRow().currentVersion);
      expect(identities).toEqual({});
    });

    it('parses the speaker_identities column off the SAME row the access check read', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ speakerIdentities: { A: 'Oscar' } }),
        role: 'owner',
      });

      const { identities } = await service.detailConditional(TRANSCRIPT_ID, USER);

      expect(identities).toEqual({ A: 'Oscar' });
      // No second read of the transcript for this — the row access.require()
      // already fetched is enough.
      expect(prisma.transcript.findUnique).not.toHaveBeenCalled();
    });

    it('is total over a malformed column — an empty map, never a throw', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ speakerIdentities: 'not-an-object' }),
        role: 'owner',
      });

      const { identities } = await service.detailConditional(TRANSCRIPT_ID, USER);

      expect(identities).toEqual({});
    });

    it('detail() is exactly detailConditional()\'s payload', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ speakerIdentities: { A: 'Oscar' } }),
        role: 'owner',
      });

      const [detail, conditional] = await Promise.all([
        service.detail(TRANSCRIPT_ID, USER),
        service.detailConditional(TRANSCRIPT_ID, USER),
      ]);

      expect(detail).toEqual(conditional.payload);
    });
  });

  describe('segmentsConditional', () => {
    it('carries the same version and identities as detailConditional, off the same access check', async () => {
      access.require.mockResolvedValue({
        transcript: transcriptRow({ currentVersion: 7, speakerIdentities: { A: 'Oscar' } }),
        role: 'owner',
      });

      const { version, identities } = await service.segmentsConditional(TRANSCRIPT_ID, USER);

      expect(version).toBe(7);
      expect(identities).toEqual({ A: 'Oscar' });
    });

    it('segments() is exactly segmentsConditional()\'s payload', async () => {
      const [segments, conditional] = await Promise.all([
        service.segments(TRANSCRIPT_ID, USER),
        service.segmentsConditional(TRANSCRIPT_ID, USER),
      ]);

      expect(segments).toEqual(conditional.payload);
    });
  });
});

describe('defaultTitle', () => {
  it.each([
    ['meeting.mp3', 'meeting'],
    ['a.long.name.m4a', 'a.long.name'],
    ['no-extension', 'no-extension'],
    ['.hidden', '.hidden'],
  ])('turns %s into %s', (filename, expected) => {
    expect(defaultTitle(filename)).toBe(expected);
  });

  it('trims to the title limit', () => {
    expect(defaultTitle(`${'x'.repeat(400)}.mp3`)).toHaveLength(200);
  });
});

describe('the list cursor', () => {
  const transcript = {
    id: 'transcript-9',
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
  };

  it('round-trips', () => {
    const cursor = encodeCursor(transcript as never);

    expect(decodeCursor(cursor)).toEqual({
      id: 'transcript-9',
      updatedAt: transcript.updatedAt,
    });
  });

  it.each([
    ['undefined', undefined],
    ['garbage', 'not-a-cursor'],
    ['a truncated pair', Buffer.from('2026-01-01T00:00:00.000Z').toString('base64url')],
    ['an unparseable date', Buffer.from('never|abc').toString('base64url')],
  ] as Array<[string, string | undefined]>)(
    'restarts the list from the top for %s rather than throwing',
    (_label, value) => {
      expect(decodeCursor(value)).toBeNull();
    },
  );
});

describe('readWords', () => {
  it('reads the terse word shape back', () => {
    expect(readWords([{ t: 'hi', s: 0, e: 10, c: 0.9 }] as never)).toEqual([
      { t: 'hi', s: 0, e: 10, c: 0.9 },
    ]);
  });

  it('defaults a missing confidence to null rather than inventing one', () => {
    expect(readWords([{ t: 'hi', s: 0, e: 10 }] as never)[0].c).toBeNull();
  });

  it.each([
    ['a non-array', { t: 'hi' }],
    ['null', null],
  ] as Array<[string, unknown]>)('is empty for %s', (_label, value) => {
    expect(readWords(value as never)).toEqual([]);
  });

  it('drops only the malformed entries, keeping the rest', () => {
    const words = readWords([
      { t: 'good', s: 0, e: 1, c: null },
      { t: 'no-timings' },
      'not an object',
    ] as never);

    expect(words).toHaveLength(1);
  });
});
