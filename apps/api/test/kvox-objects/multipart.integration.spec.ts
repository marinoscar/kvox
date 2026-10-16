// =============================================================================
// KVox multipart routes, over the wire (issue #469)
// =============================================================================
//
// The platform's objects API presigns only the first ten parts of an upload and
// its provider has no ListParts, so a multi-GB upload from a browser (which never
// reads the ETag of a cross-origin PUT) needs two routes of the app's own on the
// same path prefix:
//
//   POST /api/storage/objects/:id/upload/parts   sign the next batch (1..100)
//   GET  /api/storage/objects/:id/upload/parts   list what the provider holds
//
// and then the PLATFORM's `POST :id/upload/complete` with exactly that list.
//
// This suite boots the full `AppModule` (real guards, real pipes, the real
// platform handlers and the real `KvoxS3PartLister`) over a mocked database. What
// is stubbed is the outside world: the storage provider (no bytes move), the
// resolved storage configuration, and the S3 client's `send` (the ListParts wire
// call). Every assertion is about a value that reached the response or the
// provider.
//
// The unit specs next to the controller (`src/kvox-objects/*.spec.ts`) own the
// controller's and the lister's branches; this file owns "do the platform handler
// and the app routes agree on one upload".
// =============================================================================

import request from 'supertest';
import { S3Client } from '@aws-sdk/client-s3';
import { STORAGE_PROVIDER, StorageConfigService } from '@marinoscar/platform-api/storage';

import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import { createMembershipContributor, createMembershipViewer } from '../helpers/membership-user.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { TEST_DEFAULT_ORG_ID, setupBaseMocks } from '../fixtures/mock-setup.helper';

const OBJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const MIB = 1024 * 1024;
/** The platform's default part size, 10 MiB: 1,500 MiB is 150 parts. */
const SIZE = 1500 * MIB;
const KEY = `uploads/${TEST_DEFAULT_ORG_ID}/1760000000000/abc.pdf`;
const UPLOAD_ID = 'mpu-1';

const PARTS = (id: string = OBJECT_ID) => `/api/storage/objects/${id}/upload/parts`;

describe('KVox multipart routes (full app, mocked database)', () => {
  let context: TestContext;
  let storage: ReturnType<typeof createMockStorageProvider>;
  let storageConfig: { resolve: jest.Mock };
  let send: jest.SpyInstance;

  /** The configuration the part lister resolves: S3 by default. */
  const s3Resolution = {
    configured: true,
    provider: 's3',
    config: {
      provider: 's3',
      settings: { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKIATEST' },
      secrets: { secretAccessKey: 'not-a-real-secret' },
    },
  };

  /** An upload row in the shape the generated client returns. */
  const uploadRow = (overrides: Record<string, unknown> = {}) => ({
    id: OBJECT_ID,
    orgId: TEST_DEFAULT_ORG_ID,
    name: 'recording.pdf',
    size: BigInt(SIZE),
    mimeType: 'application/pdf',
    storageKey: KEY,
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'uploading',
    s3UploadId: UPLOAD_ID,
    uploadedById: 'someone',
    metadata: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  });

  beforeAll(async () => {
    storage = createMockStorageProvider();
    storageConfig = { resolve: jest.fn() };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: STORAGE_PROVIDER, useValue: storage },
        { provide: StorageConfigService, useValue: storageConfig },
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

    storage.getBucket.mockReturnValue('test-bucket');
    storage.getSignedUploadUrl.mockImplementation(
      async (_key: string, _uploadId: string, partNumber: number) => `https://s3.test/part/${partNumber}`,
    );
    storageConfig.resolve.mockResolvedValue(s3Resolution);
    send = jest.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => {
    send.mockRestore();
  });

  // ===========================================================================
  // Init (the platform) -> sign the rest (KVox)
  // ===========================================================================

  describe('an upload of 150 parts', () => {
    it('is initialized by the platform with only the first ten parts presigned', async () => {
      const user = await createMembershipContributor(context);

      storage.initMultipartUpload.mockResolvedValue({ uploadId: UPLOAD_ID, key: KEY });
      prismaMock.storageObject.create.mockResolvedValue(uploadRow({ status: 'pending', uploadedById: user.id }));

      const response = await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send({ name: 'recording.pdf', size: SIZE, mimeType: 'application/pdf' })
        .expect(201);

      // The limit that makes the KVox route necessary at all.
      expect(response.body.data.totalParts).toBe(150);
      expect(response.body.data.presignedUrls).toHaveLength(10);
      expect(response.body.data.partSize).toBe(10 * MIB);
    });

    it('signs parts 11 to 120 through the KVox route, 100 at a time', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));

      const first = await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(user.accessToken))
        .send({ partNumbers: Array.from({ length: 100 }, (_, i) => i + 11) })
        .expect(200);

      const second = await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(user.accessToken))
        .send({ partNumbers: Array.from({ length: 10 }, (_, i) => i + 111) })
        .expect(200);

      const signed = [...first.body.data, ...second.body.data] as Array<{ partNumber: number; url: string }>;

      expect(signed).toHaveLength(110);
      expect(signed.map((part) => part.partNumber)).toEqual(Array.from({ length: 110 }, (_, i) => i + 11));
      expect(signed[0]).toEqual({ partNumber: 11, url: 'https://s3.test/part/11' });
      expect(signed[109]).toEqual({ partNumber: 120, url: 'https://s3.test/part/120' });

      // Signed against the stored key and the provider's own upload id.
      expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(KEY, UPLOAD_ID, 11);
      expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(KEY, UPLOAD_ID, 120);
      expect(storage.getSignedUploadUrl).toHaveBeenCalledTimes(110);
    });

    it('refuses a part beyond the upload\'s part count, 101 numbers, and duplicates', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));

      const post = (partNumbers: number[]) =>
        request(context.app.getHttpServer()).post(PARTS()).set(authHeader(user.accessToken)).send({ partNumbers });

      await post([151]).expect(400);
      await post(Array.from({ length: 101 }, (_, i) => i + 1)).expect(400);
      await post([3, 3]).expect(400);
      await post([0]).expect(400);
      await post([]).expect(400);

      expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // List -> complete (the platform) with no client ETags
  // ===========================================================================

  describe('listing the parts and completing', () => {
    it('lists every page S3 holds, ascending, with the ETags the browser never saw', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));

      send
        .mockResolvedValueOnce({
          Parts: [
            { PartNumber: 2, ETag: '"e2"', Size: 10 * MIB },
            { PartNumber: 1, ETag: '"e1"', Size: 10 * MIB },
          ],
          IsTruncated: true,
          NextPartNumberMarker: '2',
        })
        .mockResolvedValueOnce({ Parts: [{ PartNumber: 3, ETag: '"e3"', Size: 5 * MIB }], IsTruncated: false });

      const response = await request(context.app.getHttpServer())
        .get(PARTS())
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual([
        { partNumber: 1, etag: '"e1"', size: 10 * MIB },
        { partNumber: 2, etag: '"e2"', size: 10 * MIB },
        { partNumber: 3, etag: '"e3"', size: 5 * MIB },
      ]);

      // The wire call: this bucket, this key, this upload, and the second page resumes at the marker.
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'test-bucket', Key: KEY, UploadId: UPLOAD_ID });
      expect(send.mock.calls[1][0].input).toMatchObject({ PartNumberMarker: '2' });
    });

    it('completes through the platform with exactly the parts the list returned', async () => {
      const user = await createMembershipContributor(context);
      const row = uploadRow({ uploadedById: user.id });
      prismaMock.storageObject.findUnique.mockResolvedValue(row);
      prismaMock.storageObject.update.mockResolvedValue({ ...row, status: 'processing' });
      prismaMock.storageObjectChunk.upsert.mockResolvedValue({});
      storage.completeMultipartUpload.mockResolvedValue({ key: KEY, bucket: 'test-bucket', location: 's3://x', eTag: '"final"' });

      send.mockResolvedValueOnce({
        Parts: [
          { PartNumber: 1, ETag: '"e1"', Size: 10 * MIB },
          { PartNumber: 2, ETag: '"e2"', Size: 10 * MIB },
        ],
        IsTruncated: false,
      });

      const listed = await request(context.app.getHttpServer())
        .get(PARTS())
        .set(authHeader(user.accessToken))
        .expect(200);

      // The client maps `{ partNumber, etag }` onto the platform's `{ partNumber, eTag }` and nothing else.
      const parts = (listed.body.data as Array<{ partNumber: number; etag: string }>).map((part) => ({
        partNumber: part.partNumber,
        eTag: part.etag,
      }));

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${OBJECT_ID}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send({ parts })
        .expect(201);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(KEY, UPLOAD_ID, [
        { partNumber: 1, eTag: '"e1"' },
        { partNumber: 2, eTag: '"e2"' },
      ]);
    });

    it('answers 501 list_parts_unsupported when the active driver is not in the S3 family', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));
      storageConfig.resolve.mockResolvedValue({
        configured: true,
        provider: 'local',
        config: { provider: 'local', settings: {}, secrets: {} },
      });

      const response = await request(context.app.getHttpServer())
        .get(PARTS())
        .set(authHeader(user.accessToken))
        .expect(501);

      expect(response.body.details).toMatchObject({ reason: 'list_parts_unsupported' });
      expect(send).not.toHaveBeenCalled();
    });

    it('maps a provider failure to a 502 that carries none of the provider\'s text', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));
      send.mockRejectedValue(Object.assign(new Error(`AccessDenied on bucket test-bucket key ${KEY}`), { name: 'AccessDenied' }));

      const response = await request(context.app.getHttpServer())
        .get(PARTS())
        .set(authHeader(user.accessToken))
        .expect(502);

      expect(JSON.stringify(response.body)).not.toContain('AccessDenied');
      expect(JSON.stringify(response.body)).not.toContain(KEY);
      expect(JSON.stringify(response.body)).not.toContain('not-a-real-secret');
    });

    it('answers 404 when the provider no longer knows the upload', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: user.id }));
      send.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));

      await request(context.app.getHttpServer()).get(PARTS()).set(authHeader(user.accessToken)).expect(404);
    });
  });

  // ===========================================================================
  // Who may touch an upload
  // ===========================================================================

  describe('access', () => {
    it('answers 404, never 403, for another user\'s upload on both routes', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(uploadRow({ uploadedById: 'someone-else' }));

      await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [11] })
        .expect(404);

      await request(context.app.getHttpServer()).get(PARTS()).set(authHeader(user.accessToken)).expect(404);

      expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('answers 404 for an object that does not exist', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [11] })
        .expect(404);
    });

    it('answers 400 once the upload has settled', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.storageObject.findUnique.mockResolvedValue(
        uploadRow({ uploadedById: user.id, status: 'ready', s3UploadId: null }),
      );

      await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [11] })
        .expect(400);

      await request(context.app.getHttpServer()).get(PARTS()).set(authHeader(user.accessToken)).expect(400);
    });

    it('answers 401 without a token and 403 for a caller without storage:write', async () => {
      const viewer = await createMembershipViewer(context);

      await request(context.app.getHttpServer()).post(PARTS()).send({ partNumbers: [11] }).expect(401);
      await request(context.app.getHttpServer()).get(PARTS()).expect(401);

      await request(context.app.getHttpServer())
        .post(PARTS())
        .set(authHeader(viewer.accessToken))
        .send({ partNumbers: [11] })
        .expect(403);
      await request(context.app.getHttpServer()).get(PARTS()).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('answers 400 for an id that is not a UUID', async () => {
      const user = await createMembershipContributor(context);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/not-a-uuid/upload/parts')
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });
});
