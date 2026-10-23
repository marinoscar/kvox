import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { TEST_DEFAULT_ORG_ID, setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser, createMockViewerUser } from '../helpers/auth-mock.helper';
import { createMembershipContributor } from '../helpers/membership-user.helper';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { APP_SLUG } from '@app/shared';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/settings/registry/default-system-settings';
import { markdownFile, multiPagePdf } from '@marinoscar/kvox-api/notes/testing';

// =============================================================================
// Note source documents, over the wire (issue #51, epic #45)
// =============================================================================
//
// HTTP-level coverage for the acceptance criteria that are about the WIRE
// rather than about the extractor:
//
//   * the upload creates a storage object owned by `notes` (a
//     `kvox_object_ownership` row) — which is what hides it from the app's file
//     list (`GET /api/<app>/files`) and makes its generic `DELETE` answer
//     **409 naming this module** (the Fastify veto hook), both asserted here
//     against the real routes rather than trusted;
//   * a rejected MIME type is refused with the accepted list in the message and
//     **no object row is created** — because a row created here could neither
//     be listed nor deleted by the user who caused it;
//   * the size ceiling comes from `ai.maxDocumentBytes`, and over it is a 413;
//   * `notes:write` gates it, and it is seeded to Viewer too, because writing a
//     note is the action this epic exists for.
//
// Everything except `PrismaService` and the storage provider is what
// `AppModule` wires — the same boundary a production request crosses, including
// the global validation pipe, the guards and the response envelope.
// =============================================================================

const DOCUMENTS = '/api/notes/sources/documents';
const OBJECT_ID = '11111111-2222-4333-8444-555555555555';

/** A ready, notes-managed storage object, as the generic endpoints would see it. */
const managedObject = (overrides: Record<string, unknown> = {}) => ({
  id: OBJECT_ID,
  name: 'proposal.pdf',
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

describe('Note source documents (#51)', () => {
  let context: TestContext;
  let mockStorage: ReturnType<typeof createMockStorageProvider>;

  beforeAll(async () => {
    mockStorage = createMockStorageProvider();

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: STORAGE_PROVIDER, useValue: mockStorage }],
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

    // No object exists at the key yet, so `put` writes and records one.
    prismaMock.storageObject.findFirst.mockResolvedValue(null);
    prismaMock.storageObject.create.mockResolvedValue(managedObject());
    prismaMock.job.create.mockResolvedValue({ id: 'job-1', type: 'note.source.extract' });
  });

  // ==========================================================================
  // Upload
  // ==========================================================================

  describe('POST /api/notes/sources/documents', () => {
    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .attach('file', Buffer.from('hello', 'utf8'), {
          filename: 'brief.txt',
          contentType: 'text/plain',
        })
        .expect(401);
    });

    it('stores a PDF as a NOTES-MANAGED object and queues extraction', async () => {
      const user = await createMockTestUser(context);
      const pdf = await multiPagePdf();

      const response = await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .attach('file', pdf, { filename: 'proposal.pdf', contentType: 'application/pdf' })
        .expect(201);

      expect(response.body.data.objectId).toBe(OBJECT_ID);
      expect(response.body.data.status).toBe('extracting');
      expect(response.body.data.jobId).toBe('job-1');
      expect(response.body.data.mimeType).toBe('application/pdf');

      // ⚠ THE CLAIM THAT MAKES EVERY OTHER ASSERTION IN THIS FILE WORK. A
      // managed object is invisible to the generic listing and refuses the
      // generic DELETE — see the specs below, which drive the REAL routes
      // rather than trusting this flag. The ownership row is written in the
      // same org-scoped transaction as the insert.
      expect(prismaMock.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ uploadedById: user.id, orgId: TEST_DEFAULT_ORG_ID }),
        }),
      );
      expect(prismaMock.kvoxObjectOwnership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ objectId: OBJECT_ID, orgId: TEST_DEFAULT_ORG_ID, managedBy: 'notes' }),
        }),
      );

      // The extraction is a QUEUE JOB, not an inline step: a document outlives
      // the request that uploaded it.
      expect(prismaMock.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'note.source.extract',
            subjectType: 'storage_object',
            subjectId: OBJECT_ID,
          }),
        }),
      );
    });

    it('accepts Markdown, including the parameterised type a browser sends', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .attach('file', markdownFile(), {
          filename: 'brief.md',
          contentType: 'text/markdown; charset=utf-8',
        })
        .expect(201);

      expect(response.body.data.mimeType).toBe('text/markdown');
    });

    it('is reachable by a Viewer — `notes:write` is seeded to every role', async () => {
      // Writing a note from a document is the action this epic exists for, and
      // a brand-new account's default role is Viewer. A permission model that
      // made a fresh signup unable to do it would contradict the onboarding.
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(viewer.accessToken))
        .attach('file', Buffer.from('a brief', 'utf8'), {
          filename: 'brief.txt',
          contentType: 'text/plain',
        })
        .expect(201);
    });

    it('refuses an unaccepted type WITH the accepted list, and creates no row', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .attach('file', Buffer.from('PK', 'utf8'), {
          filename: 'notes.xlsx',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
        .expect(400);

      const body = JSON.stringify(response.body);

      expect(body).toContain('application/pdf');
      expect(body).toContain('text/plain');
      expect(body).toContain('text/markdown');
      expect(body).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(body).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');

      // ⚠ NOTHING HALF-STARTED IS LEFT BEHIND. An object created here would be
      // `managed_by: 'notes'` — invisible to the user and undeletable by them.
      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
      expect(mockStorage.upload).not.toHaveBeenCalled();
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('refuses `application/octet-stream` rather than guessing from the name', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .attach('file', Buffer.from('hello', 'utf8'), {
          filename: 'brief.txt',
          contentType: 'application/octet-stream',
        })
        .expect(400);

      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
    });

    it('is 413 over the `ai.maxDocumentBytes` ceiling, and creates no row', async () => {
      const user = await createMockTestUser(context);

      prismaMock.systemSettings.findUnique.mockResolvedValue({
        key: 'global',
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, maxDocumentBytes: 65_536 },
        },
        version: 1,
        updatedAt: new Date(),
        updatedByUser: null,
      });

      await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .attach('file', Buffer.alloc(200_000, 0x41), {
          filename: 'huge.txt',
          contentType: 'text/plain',
        })
        .expect(413);

      expect(prismaMock.storageObject.create).not.toHaveBeenCalled();
    });

    it('is 400 with no file part at all', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(DOCUMENTS)
        .set(authHeader(user.accessToken))
        .send({ nothing: true })
        .expect(400);
    });
  });

  // ==========================================================================
  // Extraction status (#596)
  // ==========================================================================

  describe('GET /api/notes/sources/documents/:objectId', () => {
    const statusUrl = (id = OBJECT_ID) => `${DOCUMENTS}/${id}`;

    const stage = (row: Record<string, unknown> | null, managedBy: string | null = 'notes') => {
      prismaMock.storageObject.findMany.mockResolvedValue(row ? [row] : []);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue(
        row && managedBy ? [{ objectId: OBJECT_ID, managedBy }] : [],
      );
    };

    it('is 401 without auth', async () => {
      await request(context.app.getHttpServer()).get(statusUrl()).expect(401);
    });

    it('is 400 for an id that is not a UUID, without touching the store', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(statusUrl('not-a-uuid'))
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(prismaMock.storageObject.findMany).not.toHaveBeenCalled();
    });

    it('reports the recorded extraction result to the owner', async () => {
      const user = await createMockTestUser(context);

      stage(
        managedObject({
          uploadedById: user.id,
          metadata: { noteSourceExtraction: { status: 'extracted', message: 'Read 2 pages.', characters: 812 } },
        }),
      );

      const response = await request(context.app.getHttpServer())
        .get(statusUrl())
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        objectId: OBJECT_ID,
        status: 'extracted',
        message: 'Read 2 pages.',
        characters: 812,
      });
    });

    it('reports `extracting` while no result is recorded', async () => {
      const user = await createMockTestUser(context);

      stage(managedObject({ uploadedById: user.id, metadata: {} }));

      const response = await request(context.app.getHttpServer())
        .get(statusUrl())
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        objectId: OBJECT_ID,
        status: 'extracting',
        message: null,
        characters: null,
      });
    });

    it('is reachable by a Viewer — `notes:read` is seeded to every role', async () => {
      const viewer = await createMockViewerUser(context);

      stage(managedObject({ uploadedById: viewer.id }));

      await request(context.app.getHttpServer())
        .get(statusUrl())
        .set(authHeader(viewer.accessToken))
        .expect(200);
    });

    it.each([
      ['missing', (_me: string) => stage(null)],
      ['uploaded by another user', (_me: string) => stage(managedObject({ uploadedById: 'someone-else' }))],
      ['owned by another module', (me: string) => stage(managedObject({ uploadedById: me }), 'transcripts')],
      ['owned by no module', (me: string) => stage(managedObject({ uploadedById: me }), null)],
    ])('is the same 404 for an object that is %s', async (_label, arrange) => {
      const user = await createMockTestUser(context);

      arrange(user.id);

      const response = await request(context.app.getHttpServer())
        .get(statusUrl())
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(JSON.stringify(response.body)).toContain('Source document not found');
    });
  });

  // ==========================================================================
  // What notes ownership actually buys, through the REAL routes
  // ==========================================================================

  describe('the uploaded object is owned by this module', () => {
    it('is excluded from `GET /api/<app>/files`', async () => {
      const user = await createMembershipContributor(context);

      prismaMock.storageObject.findMany.mockResolvedValue([]);
      prismaMock.storageObject.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(`/api/${APP_SLUG}/files`)
        .set(authHeader(user.accessToken))
        .expect(200);

      // The list filters on "no ownership row", so a notes document is not
      // merely absent from this fixture: it is unreachable by construction.
      expect(prismaMock.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ uploadedById: user.id, kvoxOwnership: { is: null } }),
        }),
      );
    });

    it('answers 409 NAMING this module on a generic DELETE', async () => {
      // ⚠ 409, NOT 403. The caller genuinely owns the bytes; the refusal is
      // about the object's STATE — a note points at it — which is what 409
      // means. Deleting it through the generic endpoint would leave a note
      // pointing at a document that no longer exists.
      const user = await createMembershipContributor(context);

      prismaMock.storageObject.findUnique.mockResolvedValue(
        managedObject({ uploadedById: user.id }),
      );
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([{ objectId: OBJECT_ID, managedBy: 'notes' }]);

      const response = await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${OBJECT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(409);

      expect(JSON.stringify(response.body)).toContain('notes');
      expect(mockStorage.delete).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.delete).not.toHaveBeenCalled();
    });

    it('is still readable by its owner — only list and delete change', async () => {
      const user = await createMembershipContributor(context);

      prismaMock.storageObject.findUnique.mockResolvedValue(
        managedObject({ uploadedById: user.id }),
      );

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${OBJECT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);
    });
  });
});
