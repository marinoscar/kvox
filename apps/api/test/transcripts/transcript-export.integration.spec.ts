import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';

// =============================================================================
// Transcript exports over HTTP (issue #28, epic #19, spec §8)
// =============================================================================
//
// The acceptance criteria that are about the WIRE rather than about a renderer:
//
//   * `GET /api/transcripts/exporters` lists the formats and their options —
//     and resolves as a LITERAL path rather than being eaten by `:id`;
//   * an export is **202** when it queues a render and **200** when an
//     identical, unexpired one already exists;
//   * a **viewer share can export** — taking a conversation you were shown out
//     of this application is a read;
//   * no access is **404**, with the same message a non-existent transcript
//     gets, because the two must stay indistinguishable;
//   * an unknown format and an unknown option are both **400**, through the
//     global `ZodValidationPipe` and the exporter's own schema respectively.
//
// Everything except `PrismaService`, `CredentialsService` and the storage
// provider is what `AppModule` wires — the same boundary a production request
// crosses, including the guards and the response-envelope interceptor.
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const OWNER_ID = 'owner-user-id';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';
const EXPORT_ID = '99999999-8888-4777-8666-555555555555';

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

const exportRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXPORT_ID,
  transcriptId: TRANSCRIPT_ID,
  version: 3,
  format: 'markdown',
  options: { includeTimestamps: true, mergeConsecutive: false },
  optionsHash: 'hash',
  status: 'pending',
  objectId: null,
  jobId: null,
  requestedById: OWNER_ID,
  error: null,
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('Transcript exports integration', () => {
  let context: TestContext;
  let mockCredentials: { describe: jest.Mock; getSecret: jest.Mock };
  let mockStorage: Record<string, jest.Mock>;

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn().mockResolvedValue({ name: 'assemblyai' }),
      getSecret: jest.fn().mockResolvedValue('aai-key'),
    };

    mockStorage = {
      initMultipartUpload: jest.fn(),
      getSignedUploadUrl: jest.fn(),
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

    mockStorage.getBucket.mockReturnValue('test-bucket');
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
  // GET /api/transcripts/exporters
  // ==========================================================================

  describe('GET /api/transcripts/exporters', () => {
    it('lists every format with the options the dialog renders', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/exporters`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const formats = response.body.data.exporters.map(
        (exporter: { format: string }) => exporter.format,
      );

      expect(formats).toEqual(['json', 'markdown', 'pdf']);

      const pdf = response.body.data.exporters.find(
        (exporter: { format: string }) => exporter.format === 'pdf',
      );

      expect(pdf).toMatchObject({ mimeType: 'application/pdf', extension: 'pdf' });
      expect(pdf.options[0]).toMatchObject({ type: 'boolean' });
      expect(pdf.options[0].description.length).toBeGreaterThan(0);
    });

    it('resolves as a literal path, not as a transcript id', async () => {
      // Declared before `@Get(':id')` in the controller; without that ordering
      // Fastify matches the uuid route and `ParseUUIDPipe` answers 400 for a
      // path that exists.
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/exporters`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.transcript.findUnique).not.toHaveBeenCalled();
    });

    it('needs authentication', async () => {
      await request(context.app.getHttpServer()).get(`${TRANSCRIPTS}/exporters`).expect(401);
    });
  });

  // ==========================================================================
  // POST /api/transcripts/:id/exports
  // ==========================================================================

  describe('POST /api/transcripts/:id/exports', () => {
    it('is 202 with the queued export', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      prismaMock.transcriptExport.findFirst.mockResolvedValue(null);
      prismaMock.transcriptExport.create.mockResolvedValue(exportRow());
      prismaMock.transcriptExport.update.mockResolvedValue(exportRow({ jobId: 'job-1' }));
      prismaMock.job.create.mockResolvedValue({ id: 'job-1' });

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown' })
        .expect(202);

      expect(response.body.data).toMatchObject({
        id: EXPORT_ID,
        format: 'markdown',
        status: 'pending',
        reused: false,
        version: 3,
        filename: 'A recording (v3).md',
        downloadUrl: null,
      });
    });

    it('is 200 with the existing export for an identical repeat request', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      prismaMock.transcriptExport.findFirst.mockResolvedValue(
        exportRow({ status: 'ready', objectId: 'obj-export' }),
      );
      prismaMock.storageObject.findUnique.mockResolvedValue({
        id: 'obj-export',
        status: 'ready',
        storageKey: 'transcripts/x/exports/y.md',
        size: BigInt(1234),
        mimeType: 'text/markdown; charset=utf-8',
      });

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown' })
        .expect(200);

      expect(response.body.data.reused).toBe(true);
      expect(response.body.data.downloadUrl).toBe('https://signed/get');
      expect(prismaMock.transcriptExport.create).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('signs the download with an attachment disposition', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      prismaMock.transcriptExport.findFirst.mockResolvedValue(
        exportRow({ status: 'ready', objectId: 'obj-export' }),
      );
      prismaMock.storageObject.findUnique.mockResolvedValue({
        id: 'obj-export',
        status: 'ready',
        storageKey: 'transcripts/x/exports/y.md',
        size: BigInt(1234),
        mimeType: 'text/markdown; charset=utf-8',
      });

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown' })
        .expect(200);

      expect(mockStorage.getSignedDownloadUrl).toHaveBeenCalledWith(
        'transcripts/x/exports/y.md',
        expect.objectContaining({
          responseContentDisposition: expect.stringContaining(
            'attachment; filename="A recording (v3).md"',
          ),
        }),
      );
    });

    it('lets a VIEWER share export', async () => {
      // Spec §8's premise: a user should never need this application in order
      // to reach information they were given access to.
      const sharee = await createMockTestUser(context, { email: 'sharee@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow());
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' });
      prismaMock.transcriptExport.findFirst.mockResolvedValue(null);
      prismaMock.transcriptExport.create.mockResolvedValue(
        exportRow({ requestedById: sharee.id }),
      );
      prismaMock.transcriptExport.update.mockResolvedValue(exportRow({ jobId: 'job-1' }));
      prismaMock.job.create.mockResolvedValue({ id: 'job-1' });

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(sharee.accessToken))
        .send({ format: 'json' })
        .expect(202);
    });

    it('gives a stranger 404 with the same message a missing transcript gets', async () => {
      const stranger = await createMockTestUser(context, { email: 'stranger@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow());
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null);

      const denied = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(stranger.accessToken))
        .send({ format: 'markdown' })
        .expect(404);

      prismaMock.transcript.findUnique.mockResolvedValue(null);

      const missing = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(stranger.accessToken))
        .send({ format: 'markdown' })
        .expect(404);

      expect(denied.body.message).toBe('Transcript not found');
      expect(missing.body.message).toBe(denied.body.message);
    });

    it('is 400 for an unknown format, naming the ones that exist', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'docx' })
        .expect(400);

      expect(response.body.message).toMatch(/json, markdown, pdf/);
    });

    it('is 400 for an option the chosen format does not accept', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown', options: { includeWords: true } })
        .expect(400);
    });

    it('is 400 for a malformed envelope, through the global pipe', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown', version: 'three' })
        .expect(400);
    });

    it('is 404 for a version past the current one', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports`)
        .set(authHeader(user.accessToken))
        .send({ format: 'markdown', version: 99 })
        .expect(404);
    });
  });

  // ==========================================================================
  // GET /api/transcripts/:id/exports/:exportId
  // ==========================================================================

  describe('GET /api/transcripts/:id/exports/:exportId', () => {
    it('reports a pending export with no download URL', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      prismaMock.transcriptExport.findFirst.mockResolvedValue(exportRow());

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports/${EXPORT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({ status: 'pending', downloadUrl: null });
    });

    it('reports a failed export with its reason', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      prismaMock.transcriptExport.findFirst.mockResolvedValue(
        exportRow({ status: 'failed', error: 'the snapshot is missing from storage' }),
      );

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports/${EXPORT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.status).toBe('failed');
      expect(response.body.data.error).toMatch(/snapshot/);
    });

    it('is 404 for an export belonging to another transcript', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }),
      );
      // Scoped by `transcriptId` in the query itself, which IS the check.
      prismaMock.transcriptExport.findFirst.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/exports/${EXPORT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });
});
