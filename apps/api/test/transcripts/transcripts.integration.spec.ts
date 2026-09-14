import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockTestUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';

// =============================================================================
// Transcripts integration (issue #25, epic #19)
// =============================================================================
//
// HTTP-level coverage for the acceptance criteria that are about the WIRE
// rather than about a handler:
//
//   * a non-owner with no share gets **404**, not 403 — and the same message a
//     caller gets for a transcript that does not exist;
//   * creation over the provider's size limit gets **400**;
//   * creation with transcription unconfigured gets **409**;
//   * `GET /:id` and `GET /:id/segments` carry a weak ETag and answer `304`
//     with **no body** on a matching `If-None-Match`;
//   * `DELETE /:id` is **409** while a note still names this transcript as its
//     source, and the transcript is NOT moved to `deleting` (issue #48, epic
//     #45 — `notes.source_transcript_id` is `Restrict`, so without the
//     pre-check the refusal arrives later as a foreign-key violation inside
//     `transcript.purge`).
//
// Everything except `PrismaService`, `CredentialsService` and the storage
// provider is what `AppModule` wires — the same boundary a production request
// crosses, including the global `ZodValidationPipe`, the guards and the
// response-envelope interceptor.
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const OWNER_ID = 'owner-user-id';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';

/** The stored `transcription` namespace of a CONFIGURED deployment. */
const configuredSettings = {
  ...DEFAULT_SYSTEM_SETTINGS,
  transcription: {
    ...DEFAULT_SYSTEM_SETTINGS.transcription,
    enabled: true,
    provider: 'assemblyai' as const,
  },
};

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: OWNER_ID,
  title: 'A recording',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'ready',
  language: 'en',
  durationMs: 120_000,
  speakerCount: 2,
  wordCount: 400,
  currentVersion: 3,
  failureReason: null,
  provider: 'assemblyai',
  providerJobId: 'remote-1',
  providerOptions: {},
  sourceObjectId: 'obj-source',
  playbackObjectId: 'obj-playback',
  rawResultObjectId: null,
  remoteDeletedAt: null,
  submittedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-01T00:10:00.000Z'),
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:10:00.000Z'),
  ...overrides,
});

describe('Transcripts Integration', () => {
  let context: TestContext;
  let mockCredentials: { describe: jest.Mock; getSecret: jest.Mock };
  let mockStorage: Record<string, jest.Mock>;

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn().mockResolvedValue({ name: 'assemblyai' }),
      getSecret: jest.fn().mockResolvedValue('aai-key'),
    };

    mockStorage = {
      initMultipartUpload: jest.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      getSignedUploadUrl: jest.fn().mockResolvedValue('https://signed/put'),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed/get'),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      listParts: jest.fn(),
      getMetadata: jest.fn(),
      setMetadata: jest.fn(),
      getSignedPutUrl: jest.fn(),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: CredentialsService, useValue: mockCredentials },
        { provide: STORAGE_PROVIDER, useValue: mockStorage },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    mockCredentials.describe.mockResolvedValue({ name: 'assemblyai' });
    mockCredentials.getSecret.mockResolvedValue('aai-key');
    mockStorage.getBucket.mockReturnValue('test-bucket');
    mockStorage.initMultipartUpload.mockResolvedValue({ uploadId: 'upload-1' });
    mockStorage.getSignedUploadUrl.mockResolvedValue('https://signed/put');
    mockStorage.getSignedDownloadUrl.mockResolvedValue('https://signed/get');

    prismaMock.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: configuredSettings,
      version: 1,
      updatedAt: new Date(),
      updatedByUser: null,
    });
  });

  // ==========================================================================
  // Create
  // ==========================================================================

  describe('POST /api/transcripts', () => {
    const body = {
      source: { name: 'meeting.mp3', size: 5_000_000, mimeType: 'audio/mpeg' },
    };

    it('creates the transcript and its upload in one 201', async () => {
      const user = await createMockTestUser(context);

      prismaMock.storageObject.create.mockResolvedValue({
        id: 'obj-source',
        name: 'meeting.mp3',
        size: BigInt(5_000_000),
        mimeType: 'audio/mpeg',
      });
      prismaMock.transcript.create.mockResolvedValue(
        transcriptRow({ ownerId: user.id, status: 'uploading', currentVersion: 0 }),
      );
      prismaMock.transcriptSpeaker.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue({
        name: 'meeting.mp3',
        mimeType: 'audio/mpeg',
        size: BigInt(5_000_000),
      });

      const response = await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(201);

      expect(response.body.data.transcript.id).toBe(TRANSCRIPT_ID);
      expect(response.body.data.upload.objectId).toBe('obj-source');

      // The upload object is claimed by this module, which makes it invisible
      // to the generic storage listing and undeletable through the generic
      // DELETE (spec §9.3).
      expect(prismaMock.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ managedBy: 'transcripts' }),
        }),
      );
    });

    it('is 400 for a file above the active provider\'s ceiling', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(user.accessToken))
        // AssemblyAI's declared ceiling is 5 GB.
        .send({ source: { name: 'huge.mp3', size: 6_000_000_000, mimeType: 'audio/mpeg' } })
        .expect(400);

      expect(response.body.message).toMatch(/limit/i);
      // Nothing half-started is left behind for the stale sweep to find.
      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
    });

    it('is 409 when transcription is not configured for this deployment', async () => {
      // The request was well-formed; the DEPLOYMENT is not ready. A 400 would
      // blame the caller for an administrator's unfinished setup.
      const user = await createMockTestUser(context);

      prismaMock.systemSettings.findUnique.mockResolvedValue({
        key: 'global',
        value: DEFAULT_SYSTEM_SETTINGS,
        version: 1,
        updatedAt: new Date(),
        updatedByUser: null,
      });

      await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(409);
    });

    it('is 409 when a provider is chosen but no API key is stored', async () => {
      const user = await createMockTestUser(context);

      mockCredentials.describe.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(409);
    });

    it('is 400 for a body the Zod schema refuses', async () => {
      // Proof the global `ZodValidationPipe` is actually mounted on this
      // route — a class-validator decorator here would be inert metadata.
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(user.accessToken))
        .send({ source: { name: '', size: -1 } })
        .expect(400);
    });

    it('is 401 without a token', async () => {
      await request(context.app.getHttpServer()).post(TRANSCRIPTS).send(body).expect(401);
    });

    it('lets a VIEWER create one — the action the whole feature exists for', async () => {
      // `transcripts:write` is seeded to all three roles, because a brand-new
      // account's default role is Viewer.
      const viewer = await createMockViewerUser(context);

      prismaMock.storageObject.create.mockResolvedValue({ id: 'obj-source' });
      prismaMock.transcript.create.mockResolvedValue(
        transcriptRow({ ownerId: viewer.id, status: 'uploading' }),
      );
      prismaMock.transcriptSpeaker.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue({
        name: 'meeting.mp3',
        mimeType: 'audio/mpeg',
        size: BigInt(5_000_000),
      });

      await request(context.app.getHttpServer())
        .post(TRANSCRIPTS)
        .set(authHeader(viewer.accessToken))
        .send(body)
        .expect(201);
    });
  });

  // ==========================================================================
  // Access
  // ==========================================================================

  describe('access', () => {
    it('gives a non-owner with no share a 404, not a 403', async () => {
      const stranger = await createMockTestUser(context, { email: 'stranger@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow());
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(stranger.accessToken))
        .expect(404);

      expect(response.body.message).toBe('Transcript not found');
    });

    it('answers identically for a transcript that does not exist', async () => {
      // If the two ever diverge, the status code stops meaning anything.
      const stranger = await createMockTestUser(context, { email: 'stranger@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(stranger.accessToken))
        .expect(404);

      expect(response.body.message).toBe('Transcript not found');
    });

    it('lets a viewer share read, and refuses it the delete with a 404', async () => {
      const sharee = await createMockTestUser(context, { email: 'sharee@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow());
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' });
      prismaMock.transcriptSpeaker.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue({
        name: 'meeting.mp3',
        mimeType: 'audio/mpeg',
        size: BigInt(5_000_000),
      });

      const read = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(sharee.accessToken))
        .expect(200);

      expect(read.body.data.access).toBe('viewer');

      await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(sharee.accessToken))
        .expect(404);
    });
  });

  // ==========================================================================
  // The weak ETag
  // ==========================================================================

  describe('conditional reads', () => {
    /** Make the caller the owner of a v3 transcript. */
    const asOwner = async () => {
      const owner = await createMockTestUser(context, { email: 'owner@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: owner.id }),
      );
      prismaMock.transcriptSpeaker.findMany.mockResolvedValue([]);
      prismaMock.transcriptSegment.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue({
        name: 'meeting.mp3',
        mimeType: 'audio/mpeg',
        size: BigInt(5_000_000),
      });

      return owner;
    };

    it.each([
      ['the detail route', `${TRANSCRIPTS}/${TRANSCRIPT_ID}`],
      ['the segments route', `${TRANSCRIPTS}/${TRANSCRIPT_ID}/segments`],
    ])('stamps a weak version ETag on %s', async (_label, path) => {
      const owner = await asOwner();

      const response = await request(context.app.getHttpServer())
        .get(path)
        .set(authHeader(owner.accessToken))
        .expect(200);

      expect(response.headers.etag).toBe('W/"v3"');
      expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it.each([
      ['the detail route', `${TRANSCRIPTS}/${TRANSCRIPT_ID}`],
      ['the segments route', `${TRANSCRIPTS}/${TRANSCRIPT_ID}/segments`],
    ])('answers 304 with NO BODY on a matching If-None-Match, on %s', async (_label, path) => {
      const owner = await asOwner();

      const response = await request(context.app.getHttpServer())
        .get(path)
        .set(authHeader(owner.accessToken))
        .set('If-None-Match', 'W/"v3"')
        .expect(304);

      // RFC 9110: a 304 must carry no body. Without the interceptor's own
      // guard, the envelope would ship `{"meta":{"timestamp":…}}` here and a
      // client trusting Content-Length would read a fresh timestamp as the
      // resource.
      expect(response.body).toEqual({});
      expect(response.text).toBeFalsy();
    });

    it('serves the body again once the version has moved on', async () => {
      const owner = await asOwner();

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .set('If-None-Match', 'W/"v2"')
        .expect(200);
    });

    it('accepts a validator whose weak prefix a proxy stripped', async () => {
      // Weak comparison is the ONLY comparison RFC 9110 permits for
      // If-None-Match, so `"v3"` and `W/"v3"` match.
      const owner = await asOwner();

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .set('If-None-Match', '"v3"')
        .expect(304);
    });

    it('accepts `*`, and a list containing the current validator', async () => {
      const owner = await asOwner();

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .set('If-None-Match', '*')
        .expect(304);

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .set('If-None-Match', 'W/"v1", W/"v3"')
        .expect(304);
    });
  });

  // ==========================================================================
  // Audio
  // ==========================================================================

  describe('GET /api/transcripts/:id/audio', () => {
    it('signs the playback rendition when one is ready', async () => {
      const owner = await createMockTestUser(context, { email: 'owner@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: owner.id }),
      );
      prismaMock.storageObject.findUnique.mockResolvedValue({
        id: 'obj-playback',
        status: 'ready',
        storageKey: 'transcripts/1/renditions/a.m4a',
        mimeType: 'audio/mp4',
      });

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/audio`)
        .set(authHeader(owner.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: 'https://signed/get',
        kind: 'playback',
        mimeType: 'audio/mp4',
      });
    });

    it('falls back to the original when no rendition is ready', async () => {
      // A failed or unfinished transcode must not mean the audio is
      // unplayable — most browsers can play most uploads directly.
      const owner = await createMockTestUser(context, { email: 'owner@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: owner.id, playbackStatus: 'failed' }),
      );
      prismaMock.storageObject.findUnique.mockResolvedValue({
        id: 'obj-source',
        status: 'ready',
        storageKey: 'uploads/1/a.mp3',
        mimeType: 'audio/mpeg',
      });

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/audio`)
        .set(authHeader(owner.accessToken))
        .expect(200);

      expect(response.body.data.kind).toBe('original');
    });
  });

  // ==========================================================================
  // Delete, and the notes that block it (issue #48, epic #45)
  // ==========================================================================

  describe('DELETE /api/transcripts/:id', () => {
    const NOTE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const NOTE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

    /** An owner of the stock `ready` transcript. */
    const asOwner = async () => {
      const owner = await createMockTestUser(context, { email: 'deleter@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: owner.id }),
      );
      prismaMock.transcript.update.mockResolvedValue(
        transcriptRow({ ownerId: owner.id, status: 'deleting' }),
      );

      return owner;
    };

    it('deletes as before when nothing was generated from it', async () => {
      const owner = await asOwner();
      prismaMock.note.findMany.mockResolvedValue([]);

      await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .expect(204);

      expect(prismaMock.transcript.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'deleting' }),
        }),
      );
    });

    it('is 409 naming the blocking notes, and does NOT move the transcript to `deleting`', async () => {
      const owner = await asOwner();

      prismaMock.note.findMany.mockResolvedValue([
        { id: NOTE_A, title: 'Action items', deletedAt: null },
        { id: NOTE_B, title: 'Exec summary', deletedAt: null },
      ]);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .expect(409);

      // The ids AND titles travel in `details` — the web app lists the notes
      // standing in the way rather than only reporting a refusal.
      expect(response.body.details).toEqual({
        blockingCount: 2,
        pendingPurgeCount: 0,
        notes: [
          { id: NOTE_A, title: 'Action items', pendingPurge: false },
          { id: NOTE_B, title: 'Exec summary', pendingPurge: false },
        ],
      });
      expect(response.body.message).toMatch(/2 notes/);

      // A refused delete leaves the transcript exactly as it was.
      expect(prismaMock.transcript.update).not.toHaveBeenCalled();
    });

    it('still blocks — and says so honestly — when every blocking note is soft-deleted', async () => {
      // A note's soft delete sets `deleted_at` and leaves the foreign key in
      // place, so the database-level delete would STILL fail. Counting only
      // live notes here would hand `transcript.purge` the violation this
      // pre-check exists to prevent.
      const owner = await asOwner();

      prismaMock.note.findMany.mockResolvedValue([
        { id: NOTE_A, title: 'Action items', deletedAt: new Date('2026-09-14T00:00:00.000Z') },
      ]);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(owner.accessToken))
        .expect(409);

      expect(response.body.message).toMatch(/deleted note/i);
      expect(response.body.message).toMatch(/try again shortly/i);
      expect(response.body.details).toEqual({
        blockingCount: 1,
        pendingPurgeCount: 1,
        notes: [{ id: NOTE_A, title: 'Action items', pendingPurge: true }],
      });
      expect(prismaMock.transcript.update).not.toHaveBeenCalled();
    });

    it('leaves a non-owner on 404, never 403 and never a 409 (spec §6.1)', async () => {
      // The pre-check must not become a way to learn that a stranger's
      // transcript exists — access is decided first, and its answer is 404.
      const stranger = await createMockTestUser(context, { email: 'nosy@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow());
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);
      prismaMock.note.findMany.mockResolvedValue([
        { id: NOTE_A, title: 'Action items', deletedAt: null },
      ]);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}`)
        .set(authHeader(stranger.accessToken))
        .expect(404);

      expect(response.body.message).toBe('Transcript not found');
      expect(prismaMock.note.findMany).not.toHaveBeenCalled();
      expect(prismaMock.transcript.update).not.toHaveBeenCalled();
    });
  });
});
