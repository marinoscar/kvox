import request from 'supertest';

import { NOTE_CONTEXT_ATTACHMENT_REASONS } from '@marinoscar/kvox-contract/notes';
import { NoteSourceService } from '@marinoscar/kvox-api/notes';
import { multiPagePdf, markdownFile } from '@marinoscar/kvox-api/notes/testing';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { primeAiReadiness, invalidateAiResolverCache } from '../helpers/ai-readiness.fixtures';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { TEST_DEFAULT_ORG_ID, setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';

// =============================================================================
// Note context attachments, over the wire (issue #810)
// =============================================================================
//
//   POST /api/notes/context/attachments            upload (`notes:write`)
//   GET  /api/notes/context/attachments/:objectId  readiness (owner-scoped 404)
//   POST /api/notes  { contextAttachmentIds }      409 not ready, 400 over the cap, rows persisted
//
// Only `PrismaService`, the storage provider and `NoteSourceService` are stand-ins.
// =============================================================================

const ATTACHMENTS = '/api/notes/context/attachments';
const NOTES = '/api/notes';
const OBJECT_ID = '11111111-2222-4333-8444-555555555555';
const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPT_ID = '44444444-4444-4444-8444-444444444444';
const GENERATION_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '66666666-6666-4666-8666-666666666666';

// 1x1 PNG (valid magic bytes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const storageRow = (overrides: Record<string, unknown> = {}) => ({
  id: OBJECT_ID,
  name: 'file.bin',
  size: BigInt(2048),
  mimeType: 'application/pdf',
  storageKey: 'notes/sources/uploads/abc/source.pdf',
  storageProvider: 's3',
  bucket: 'test-bucket',
  status: 'ready',
  uploadedById: 'owner-1',
  metadata: {},
  s3UploadId: null,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T00:00:00.000Z'),
  ...overrides,
});

const templateRow = () => ({
  id: TEMPLATE_ID,
  ownerId: null,
  name: 'Concise Meeting Notes',
  description: 'A short, scannable summary.',
  instructions: 'Write meeting notes.',
  outputFormat: 'meeting_notes',
  structure: ['Overview'],
  tone: 'neutral',
  length: 'short',
  model: null,
  isArchived: false,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T00:00:00.000Z'),
});

const noteRow = (ownerId: string) => ({
  id: NOTE_ID,
  ownerId,
  title: 'Weekly',
  body: '',
  status: 'draft',
  currentVersion: 0,
  provider: 'openai',
  model: 'gpt-4o',
  currentGenerationId: GENERATION_ID,
  sourceType: 'transcript',
  sourceTranscriptId: TRANSCRIPT_ID,
  sourceNoteId: null,
  sourceObjectId: null,
  templateId: TEMPLATE_ID,
  contextText: null,
  failureReason: null,
  deletedAt: null,
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T00:00:00.000Z'),
});

describe('Note context attachments (#810)', () => {
  let context: TestContext;
  let mockStorage: ReturnType<typeof createMockStorageProvider>;
  const sources = { resolve: jest.fn() };

  beforeAll(async () => {
    mockStorage = createMockStorageProvider();
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: STORAGE_PROVIDER, useValue: mockStorage },
        { provide: NoteSourceService, useValue: sources },
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

    sources.resolve.mockResolvedValue({ text: 'We ship on Friday.', describe: 'transcript at version 3' });
    mockStorage.getBucket.mockReturnValue('test-bucket');
    mockStorage.upload.mockResolvedValue({
      key: 'notes/sources/uploads/abc/source.pdf',
      bucket: 'test-bucket',
      location: 's3://test-bucket/key',
      eTag: '"etag"',
    });
    prismaMock.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS,
      version: 1,
      updatedAt: new Date(),
      updatedByUser: null,
    });
    prismaMock.storageObject.findFirst.mockResolvedValue(null);
    prismaMock.job.create.mockResolvedValue({ id: 'job-1', type: 'note.source.extract' });
  });

  // ==========================================================================
  // Upload
  // ==========================================================================

  describe('POST /api/notes/context/attachments', () => {
    const post = (token: string | undefined, body: Buffer, filename: string, contentType: string) => {
      const req = request(context.app.getHttpServer()).post(ATTACHMENTS);

      return (token ? req.set(authHeader(token)) : req).attach('file', body, { filename, contentType });
    };

    it('is 401 without auth', async () => {
      await post(undefined, PNG, 'a.png', 'image/png').expect(401);
    });

    it('is 403 without notes:write, before anything is stored', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      const original = prismaMock.user.findUnique.getMockImplementation();

      prismaMock.user.findUnique.mockImplementation((async (args: never) => {
        const found = (await original?.(args)) as
          | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
          | null;

        if (!found || found.id !== user.id || !found.userRoles) return found as never;

        return {
          ...found,
          userRoles: found.userRoles.map((userRole) => ({
            ...userRole,
            role: {
              ...userRole.role,
              rolePermissions: userRole.role.rolePermissions.filter((rp) => rp.permission.name !== 'notes:write'),
            },
          })),
        } as never;
      }) as never);

      await post(user.accessToken, PNG, 'a.png', 'image/png').expect(403);
      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
      expect(mockStorage.upload).not.toHaveBeenCalled();
    });

    it('stores a PNG and reports it ready at once, with no extraction job', async () => {
      const user = await createMockTestUser(context);

      prismaMock.storageObject.create.mockResolvedValue(
        storageRow({ id: OBJECT_ID, name: 'a.png', mimeType: 'image/png', uploadedById: user.id }),
      );

      const response = await post(user.accessToken, PNG, 'a.png', 'image/png').expect(201);

      expect(response.body.data).toMatchObject({
        objectId: OBJECT_ID,
        kind: 'image',
        mimeType: 'image/png',
        status: 'ready',
        jobId: null,
      });
      expect(prismaMock.kvoxObjectOwnership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ objectId: OBJECT_ID, orgId: TEST_DEFAULT_ORG_ID, managedBy: 'notes' }),
        }),
      );
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('stores a PDF as a document and queues extraction', async () => {
      const user = await createMockTestUser(context);

      prismaMock.storageObject.create.mockResolvedValue(storageRow({ uploadedById: user.id, name: 'p.pdf' }));

      const response = await post(user.accessToken, await multiPagePdf(), 'p.pdf', 'application/pdf').expect(201);

      expect(response.body.data).toMatchObject({
        objectId: OBJECT_ID,
        kind: 'document',
        status: 'extracting',
        jobId: 'job-1',
      });
      expect(prismaMock.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'note.source.extract', subjectId: OBJECT_ID }),
        }),
      );
    });

    it('stores Markdown as a document and queues extraction', async () => {
      const user = await createMockTestUser(context);

      prismaMock.storageObject.create.mockResolvedValue(
        storageRow({ uploadedById: user.id, name: 'b.md', mimeType: 'text/markdown' }),
      );

      const response = await post(user.accessToken, markdownFile(), 'b.md', 'text/markdown').expect(201);

      expect(response.body.data).toMatchObject({ kind: 'document', status: 'extracting', jobId: 'job-1' });
      expect(prismaMock.job.create).toHaveBeenCalledTimes(1);
    });

    it('refuses an unsupported type with the branchable reason, and stores nothing', async () => {
      const user = await createMockTestUser(context);

      const response = await post(user.accessToken, Buffer.from('MZ'), 'run.exe', 'application/x-msdownload').expect(400);

      expect(JSON.stringify(response.body)).toContain(NOTE_CONTEXT_ATTACHMENT_REASONS.UNSUPPORTED_TYPE);
      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
      expect(mockStorage.upload).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('refuses a PNG whose bytes are not a PNG, and stores nothing', async () => {
      const user = await createMockTestUser(context);

      const response = await post(user.accessToken, Buffer.from('definitely not an image'), 'a.png', 'image/png').expect(400);

      expect(JSON.stringify(response.body)).toContain(NOTE_CONTEXT_ATTACHMENT_REASONS.UNSUPPORTED_TYPE);
      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
      expect(mockStorage.upload).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Status
  // ==========================================================================

  describe('GET /api/notes/context/attachments/:objectId', () => {
    const url = (id = OBJECT_ID) => `${ATTACHMENTS}/${id}`;

    const stage = (row: Record<string, unknown> | null, managedBy: string | null = 'notes') => {
      prismaMock.storageObject.findMany.mockResolvedValue(row ? [row] : []);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue(
        row && managedBy ? [{ objectId: OBJECT_ID, managedBy }] : [],
      );
    };

    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(url()).expect(401);
    });

    it('reports an owned image as ready', async () => {
      const user = await createMockTestUser(context);

      stage(storageRow({ uploadedById: user.id, mimeType: 'image/png', name: 'a.png' }));

      const response = await request(context.app.getHttpServer())
        .get(url())
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        objectId: OBJECT_ID,
        kind: 'image',
        status: 'ready',
        message: null,
        characters: null,
      });
    });

    it('is 404 for another user\'s attachment', async () => {
      const user = await createMockTestUser(context);

      stage(storageRow({ uploadedById: 'someone-else', mimeType: 'image/png' }));

      await request(context.app.getHttpServer()).get(url()).set(authHeader(user.accessToken)).expect(404);
    });
  });

  // ==========================================================================
  // Create a note with attachments
  // ==========================================================================

  describe('POST /api/notes with contextAttachmentIds', () => {
    const body = (ids: string[]) => ({
      templateId: TEMPLATE_ID,
      source: { type: 'transcript', transcriptId: TRANSCRIPT_ID },
      contextAttachmentIds: ids,
    });

    beforeEach(() => {
      invalidateAiResolverCache(context);
      primeAiReadiness();
      prismaMock.noteTemplate.findUnique.mockResolvedValue(templateRow());
      prismaMock.noteContextAttachment.findMany.mockResolvedValue([]);
      prismaMock.organization.findFirst.mockResolvedValue({ id: TEST_DEFAULT_ORG_ID } as never);
      prismaMock.noteGeneration.create.mockResolvedValue({ id: GENERATION_ID });
      prismaMock.noteGeneration.update.mockResolvedValue({ id: GENERATION_ID });
      prismaMock.job.create.mockResolvedValue({ id: JOB_ID });
    });

    const ownTranscript = (userId: string) =>
      prismaMock.transcript.findUnique.mockResolvedValue({
        id: TRANSCRIPT_ID,
        orgId: TEST_DEFAULT_ORG_ID,
        ownerId: userId,
        deletedAt: null,
        currentVersion: 3,
      });

    const stageObjects = (rows: Array<Record<string, unknown>>) => {
      prismaMock.storageObject.findMany.mockResolvedValue(rows);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue(
        rows.map((row) => ({ objectId: row.id, managedBy: 'notes' })),
      );
    };

    it('is 409 not_ready while a document is still extracting, and creates no note', async () => {
      const user = await createMockTestUser(context);

      ownTranscript(user.id);
      stageObjects([storageRow({ uploadedById: user.id, metadata: {} })]);

      const response = await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body([OBJECT_ID]))
        .expect(409);

      expect(response.body.details.reason).toBe(NOTE_CONTEXT_ATTACHMENT_REASONS.NOT_READY);
      expect(prismaMock.note.create).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('is 400 for more than 10 ids, at the validation pipe', async () => {
      const user = await createMockTestUser(context);

      ownTranscript(user.id);

      const ids = Array.from({ length: 11 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body(ids))
        .expect(400);

      expect(prismaMock.note.create).not.toHaveBeenCalled();
    });

    it('persists one row per ready attachment, in order, and queues the generation', async () => {
      const user = await createMockTestUser(context);

      ownTranscript(user.id);
      stageObjects([storageRow({ uploadedById: user.id, mimeType: 'image/png', name: 'a.png' })]);
      prismaMock.note.create.mockResolvedValue(noteRow(user.id));
      prismaMock.note.update.mockResolvedValue(noteRow(user.id));
      prismaMock.note.findUnique.mockResolvedValue(noteRow(user.id));

      await request(context.app.getHttpServer())
        .post(NOTES)
        .set(authHeader(user.accessToken))
        .send(body([OBJECT_ID]))
        .expect(201);

      expect(prismaMock.noteContextAttachment.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.noteContextAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            noteId: NOTE_ID,
            objectId: OBJECT_ID,
            kind: 'image',
            filename: 'a.png',
            mimeType: 'image/png',
            ordinal: 0,
          }),
        }),
      );
      expect(prismaMock.job.create).toHaveBeenCalledTimes(1);
    });
  });
});
