// =============================================================================
// Storage routes on the real app: what is KVox's (issue #469)
// =============================================================================
//
// `/api/storage/*`, `/api/admin/storage-config` and the profile-image routes are
// the PLATFORM's (`@marinoscar/platform-api/storage`); their behaviour (init,
// status, complete, list, download, metadata, the config page, the part-size
// rule, key building, MIME checks) is that package's to test and is not repeated
// here. What this file pins is what the APP adds or relies on:
//
//   * the slice is MOUNTED: its routes exist at the paths clients use and are
//     behind authentication and the storage permissions the app's roles grant;
//   * `GET /api/<app>/files` lists a caller's plain uploads and never the objects
//     a module owns (the platform list, hit directly, still shows the caller's
//     own managed objects: a documented, accepted disclosure of their own rows);
//   * a plain upload takes no ownership row, so the generic routes treat it as
//     the caller's to delete;
//   * the app's two routes next to the platform's `/upload/parts` path.
//
// The multipart routes themselves are covered in `test/kvox-objects/
// multipart.integration.spec.ts`, the delete veto and the abort forward in
// `test/kvox-objects/managed-delete.integration.spec.ts`.
// =============================================================================

import request from 'supertest';
import { APP_SLUG } from '@app/shared';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import {
  createMembershipAdmin,
  createMembershipContributor,
  createMembershipViewer,
} from '../helpers/membership-user.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { TEST_DEFAULT_ORG_ID, setupBaseMocks } from '../fixtures/mock-setup.helper';

const OBJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const FILES = `/api/${APP_SLUG}/files`;

describe('Storage routes (full app, mocked database)', () => {
  let context: TestContext;
  let storage: ReturnType<typeof createMockStorageProvider>;

  const objectRow = (overrides: Record<string, unknown> = {}) => ({
    id: OBJECT_ID,
    orgId: TEST_DEFAULT_ORG_ID,
    name: 'report.pdf',
    size: BigInt(1_024_000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/org/1760000000000/abc.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: 'someone',
    metadata: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  });

  beforeAll(async () => {
    storage = createMockStorageProvider();

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: STORAGE_PROVIDER, useValue: storage }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    storage.getBucket.mockReturnValue('test-bucket');
  });

  // ===========================================================================
  // The slice is mounted, behind auth
  // ===========================================================================

  describe('mounting and authentication', () => {
    it('requires a token on the platform routes at the paths clients use', async () => {
      const server = context.app.getHttpServer();

      await request(server).get('/api/storage/objects').expect(401);
      await request(server).post('/api/storage/objects/upload/init').send({ name: 'a.pdf', size: 1, mimeType: 'application/pdf' }).expect(401);
      await request(server).get(`/api/storage/objects/${OBJECT_ID}`).expect(401);
      await request(server).delete(`/api/storage/objects/${OBJECT_ID}`).expect(401);
      await request(server).post(`/api/storage/objects/${OBJECT_ID}/upload/complete`).send({ parts: [] }).expect(401);
      await request(server).delete(`/api/storage/objects/${OBJECT_ID}/upload/abort`).expect(401);
    });

    it('requires a token on the app\'s routes', async () => {
      const server = context.app.getHttpServer();

      await request(server).get(FILES).expect(401);
      await request(server).post(`/api/storage/objects/${OBJECT_ID}/upload/parts`).send({ partNumbers: [1] }).expect(401);
      await request(server).get(`/api/storage/objects/${OBJECT_ID}/upload/parts`).expect(401);
    });

    it('serves the storage configuration page to administrators only', async () => {
      const server = context.app.getHttpServer();
      const contributor = await createMembershipContributor(context);

      await request(server).get('/api/admin/storage-config').expect(401);
      // `storage_config:read` is an administrator permission; an org contributor does not hold it.
      await request(server).get('/api/admin/storage-config').set(authHeader(contributor.accessToken)).expect(403);
    });

    it('lets a contributor start an upload and a viewer not', async () => {
      const server = context.app.getHttpServer();
      const contributor = await createMembershipContributor(context);
      const viewer = await createMembershipViewer(context);
      const body = { name: 'report.pdf', size: 52_428_800, mimeType: 'application/pdf' };

      storage.initMultipartUpload.mockResolvedValue({ uploadId: 'mpu-1', key: 'uploads/org/1/abc.pdf' });
      prismaMock.storageObject.create.mockResolvedValue(objectRow({ status: 'pending', uploadedById: contributor.id, s3UploadId: 'mpu-1' }));

      await request(server).post('/api/storage/objects/upload/init').set(authHeader(viewer.accessToken)).send(body).expect(403);
      await request(server).post('/api/storage/objects/upload/init').set(authHeader(contributor.accessToken)).send(body).expect(201);
    });
  });

  // ===========================================================================
  // A plain upload belongs to nobody but its uploader
  // ===========================================================================

  describe('a plain upload', () => {
    it('is initialized by the platform and takes no ownership row', async () => {
      const user = await createMembershipContributor(context);

      storage.initMultipartUpload.mockResolvedValue({ uploadId: 'mpu-1', key: 'uploads/org/1/abc.pdf' });
      prismaMock.storageObject.create.mockResolvedValue(objectRow({ status: 'pending', uploadedById: user.id, s3UploadId: 'mpu-1' }));

      const response = await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send({ name: 'report.pdf', size: 52_428_800, mimeType: 'application/pdf' })
        .expect(201);

      expect(response.body.data).toMatchObject({ objectId: OBJECT_ID, uploadId: 'mpu-1', partSize: 10 * 1024 * 1024, totalParts: 5 });
      // Only a module's `initManagedUpload` stamps ownership; the generic route does not.
      expect(prismaMock.kvoxObjectOwnership.upsert).not.toHaveBeenCalled();
      expect(prismaMock.kvoxObjectOwnership.create).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /api/<app>/files
  // ===========================================================================

  describe(`GET ${FILES}`, () => {
    it('lists the caller\'s plain uploads in the platform\'s list shape, never a module-owned object', async () => {
      const user = await createMembershipViewer(context);
      prismaMock.storageObject.findMany.mockResolvedValue([
        objectRow({ id: 'obj-1', uploadedById: user.id }),
        objectRow({ id: 'obj-2', uploadedById: user.id }),
      ]);
      prismaMock.storageObject.count.mockResolvedValue(2);

      const response = await request(context.app.getHttpServer())
        .get(FILES)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data.items[0]).toMatchObject({ id: 'obj-1', name: 'report.pdf', size: '1024000', status: 'ready' });
      expect(response.body.data.meta).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });

      // THE FILTER IS THE FEATURE: a transcript's source audio and every export are rows uploaded in
      // this same user's name; "has no ownership row" is what keeps them out of a generic file list.
      const expected = { uploadedById: user.id, kvoxOwnership: { is: null } };
      expect(prismaMock.storageObject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }));
      expect(prismaMock.storageObject.count).toHaveBeenCalledWith({ where: expected });
    });

    it('applies the platform list query: page, size, status and sort', async () => {
      const user = await createMembershipViewer(context);
      prismaMock.storageObject.findMany.mockResolvedValue([]);
      prismaMock.storageObject.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get(`${FILES}?page=2&pageSize=10&status=ready&sortBy=name&sortOrder=asc`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.meta).toEqual({ page: 2, pageSize: 10, totalItems: 50, totalPages: 5 });
      expect(prismaMock.storageObject.findMany).toHaveBeenCalledWith({
        where: { uploadedById: user.id, kvoxOwnership: { is: null }, status: 'ready' },
        orderBy: { name: 'asc' },
        skip: 10,
        take: 10,
      });
    });

    it('is scoped to the caller: another user\'s id never reaches the query', async () => {
      const user = await createMembershipViewer(context);
      prismaMock.storageObject.findMany.mockResolvedValue([]);
      prismaMock.storageObject.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(`${FILES}?uploadedById=someone-else`)
        .set(authHeader(user.accessToken))
        .expect(200);

      for (const [args] of prismaMock.storageObject.findMany.mock.calls) {
        expect(args.where.uploadedById).toBe(user.id);
      }
    });

    it('rejects an out-of-range page size at the pipe', async () => {
      const user = await createMembershipViewer(context);

      await request(context.app.getHttpServer())
        .get(`${FILES}?pageSize=101`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  // ===========================================================================
  // The platform list, hit directly (a documented exception)
  // ===========================================================================

  describe('GET /api/storage/objects', () => {
    it('still lists the caller\'s OWN objects, owned or not: the app\'s clients list through the files route', async () => {
      const user = await createMembershipViewer(context);
      prismaMock.storageObject.findMany.mockResolvedValue([objectRow({ uploadedById: user.id })]);
      prismaMock.storageObject.count.mockResolvedValue(1);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .set(authHeader(user.accessToken))
        .expect(200);

      // Scoped to the caller (a disclosure of their own rows at most) and carrying no ownership filter.
      const where = prismaMock.storageObject.findMany.mock.calls[0][0].where;
      expect(where.uploadedById).toBe(user.id);
      expect(JSON.stringify(where)).not.toContain('kvoxOwnership');
    });
  });

  // ===========================================================================
  // Administrators
  // ===========================================================================

  describe('an administrator', () => {
    it('list files through their org_admin membership, like any other member', async () => {
      const admin = await createMembershipAdmin(context);

      prismaMock.storageObject.findMany.mockResolvedValue([]);
      prismaMock.storageObject.count.mockResolvedValue(0);

      await request(context.app.getHttpServer())
        .get(FILES)
        .set(authHeader(admin.accessToken))
        .expect(200);
    });
  });
});
