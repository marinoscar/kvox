import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';

describe('Storage Integration', () => {
  let context: TestContext;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  const mockStorageObjectId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID

  const mockStorageObject = {
    id: mockStorageObjectId,
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    partSize: 10485760,
    managedBy: null,
    uploadedById: 'user-123',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    mockStorageProvider = createMockStorageProvider();
    context = await createTestApp({ useMockDatabase: true });

    // Override storage provider with mock
    const storageProviderToken = context.module.get(STORAGE_PROVIDER, { strict: false });
    if (storageProviderToken) {
      Object.assign(storageProviderToken, mockStorageProvider);
    }
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();
  });

  describe('POST /api/storage/objects/upload/init', () => {
    it('should initialize upload for authenticated user', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');

      context.prismaMock.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        objectId: 'new-obj-id',
        uploadId: 'upload-123',
        partSize: expect.any(Number),
        totalParts: expect.any(Number),
        presignedUrls: expect.any(Array),
      });
    });

    it('should return 401 for unauthenticated request', async () => {
      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);
    });

    it('should validate request body', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .set(authHeader(user.accessToken))
        .send({
          // Missing required fields
          name: 'test.pdf',
        })
        .expect(400);
    });
  });

  describe('GET /api/storage/objects/:id/upload/status', () => {
    it('should return upload status', async () => {
      const user = await createMockTestUser(context);

      const chunks = [
        { partNumber: 1, size: BigInt(10485760), eTag: 'etag1' },
        { partNumber: 2, size: BigInt(10485760), eTag: 'etag2' },
      ];

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        chunks,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        objectId: mockStorageObjectId,
        status: 'pending',
        uploadedParts: expect.any(Array),
        totalParts: expect.any(Number),
      });
    });

    it('should report real progress and the persisted part size', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'uploading',
        s3UploadId: 'upload-123',
        partSize: 10485760,
        size: BigInt(26214400), // 25 MiB -> 3 parts
      });
      context.prismaMock.storageObject.update.mockResolvedValue({});
      mockStorageProvider.listParts.mockResolvedValue([
        { partNumber: 1, size: 10485760, etag: '"e1"' },
        { partNumber: 3, size: 5242880, etag: '"e3"' },
      ]);

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'uploading',
        // Part 2 is missing — exactly what a resuming client needs to know.
        uploadedParts: [1, 3],
        totalParts: 3,
        partSize: 10485760,
        uploadedBytes: '15728640',
        totalBytes: '26214400',
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/status')
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    it('should return 403 for non-owner', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/upload/status`)
        .set(authHeader(user.accessToken))
        .expect(403);
    });
  });

  // ===========================================================================
  // POST /api/storage/objects/:id/upload/parts (issue #21)
  // ===========================================================================
  //
  // The route that makes an upload bigger than the first batch possible:
  // initialization signs ten part URLs, and before #21 nothing signed an
  // eleventh, so a 10 MiB part size capped every upload at 100 MB.
  describe('POST /api/storage/objects/:id/upload/parts', () => {
    /** 200 parts at the persisted 10 MiB part size. */
    const activeUpload = {
      ...mockStorageObject,
      status: 'uploading',
      s3UploadId: 'upload-123',
      partSize: 10485760,
      size: BigInt(10485760 * 200),
    };

    it('should sign a batch of part URLs for the owner', async () => {
      const user = await createMockContributorUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...activeUpload,
        uploadedById: user.id,
      });
      context.prismaMock.storageObject.update.mockResolvedValue(activeUpload);
      mockStorageProvider.getSignedUploadUrl.mockResolvedValue(
        'https://signed.example/part',
      );

      const response = await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [11, 12, 13] })
        .expect(200);

      expect(response.body.data.parts).toHaveLength(3);
      expect(response.body.data.parts[0]).toMatchObject({
        partNumber: 11,
        url: expect.any(String),
        expiresAt: expect.any(String),
      });
    });

    it('should return 401 for an unauthenticated request', async () => {
      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .send({ partNumbers: [1] })
        .expect(401);
    });

    // storage:write, which a Viewer does not hold.
    it('should return 403 for a caller without storage:write', async () => {
      const user = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [1] })
        .expect(403);
    });

    it('should reject a batch of more than 100 part numbers at the pipe', async () => {
      const user = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: Array.from({ length: 101 }, (_, i) => i + 1) })
        .expect(400);
    });

    it('should reject duplicate part numbers at the pipe', async () => {
      const user = await createMockContributorUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [1, 2, 1] })
        .expect(400);
    });

    it.each([[[]], [[0]], [[1.5]], [['nope']]])(
      'should reject %p as a partNumbers payload',
      async (partNumbers) => {
        const user = await createMockContributorUser(context);

        await request(context.app.getHttpServer())
          .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
          .set(authHeader(user.accessToken))
          .send({ partNumbers })
          .expect(400);
      },
    );

    it('should return 400 for a part number past the end of the upload', async () => {
      const user = await createMockContributorUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...activeUpload,
        uploadedById: user.id,
      });

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [201] })
        .expect(400);
    });

    it('should return 400 once the upload is no longer in progress', async () => {
      const user = await createMockContributorUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...activeUpload,
        uploadedById: user.id,
        status: 'ready',
      });

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [1] })
        .expect(400);
    });

    it('should return 403 for a non-owner', async () => {
      const user = await createMockContributorUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...activeUpload,
        uploadedById: 'someone-else',
      });

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/parts`)
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [1] })
        .expect(403);
    });

    it('should return 404 for an unknown upload', async () => {
      const user = await createMockContributorUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/parts')
        .set(authHeader(user.accessToken))
        .send({ partNumbers: [1] })
        .expect(404);
    });
  });

  describe('POST /api/storage/objects/:id/upload/complete', () => {
    it('should complete upload', async () => {
      const user = await createMockTestUser(context);

      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      });
      context.prismaMock.storageObjectChunk.upsert.mockResolvedValue({});
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send(dto)
        .expect(201);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        status: 'processing',
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/complete')
        .set(authHeader(user.accessToken))
        .send({
          parts: [{ partNumber: 1, eTag: 'etag1' }],
        })
        .expect(404);
    });

    // ⚠ THE BROWSER PATH (#21). Omitting `parts` makes the server read the
    // ETags back from the provider, so a page never has to read a header off
    // a cross-origin PUT — which it cannot do unless the bucket exposes it.
    it('should complete without a parts array, reading them from the provider', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'uploading',
        s3UploadId: 'upload-123',
      });
      mockStorageProvider.listParts.mockResolvedValue([
        { partNumber: 2, size: 10485760, etag: '"etag2"' },
        { partNumber: 1, size: 10485760, etag: '"etag1"' },
      ]);
      context.prismaMock.storageObjectChunk.upsert.mockResolvedValue({});
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send({})
        .expect(201);

      expect(response.body.data).toMatchObject({ status: 'processing' });
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        [
          { partNumber: 1, eTag: '"etag1"' },
          { partNumber: 2, eTag: '"etag2"' },
        ],
      );
    });

    it('should validate parts array', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(`/api/storage/objects/${mockStorageObjectId}/upload/complete`)
        .set(authHeader(user.accessToken))
        .send({
          parts: 'invalid', // Should be array
        })
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id/upload/abort', () => {
    it('should abort upload', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        s3UploadId: 'upload-123',
      });
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}/upload/abort`)
        .set(authHeader(user.accessToken))
        .expect(200); // Note: Controller returns void but Fastify may default to 200
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001/upload/abort')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects', () => {
    it('should list user\'s objects', async () => {
      const user = await createMockTestUser(context);

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1', uploadedById: user.id },
        { ...mockStorageObject, id: 'obj-2', uploadedById: user.id },
      ];

      context.prismaMock.storageObject.findMany.mockResolvedValue(mockObjects);
      context.prismaMock.storageObject.count.mockResolvedValue(2);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        totalItems: 2,
        totalPages: 1,
      });

      // ⚠ MANAGED OBJECTS ARE EXCLUDED (#21). A transcript's source audio,
      // its playback rendition and its exports are all rows owned by this same
      // user; without the filter one transcript becomes four entries in a
      // generic file list, none of which the user can act on here.
      expect(context.prismaMock.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ managedBy: null }),
        }),
      );
    });

    it('should support pagination', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([]);
      context.prismaMock.storageObject.count.mockResolvedValue(50);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?page=2&pageSize=10')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.meta).toMatchObject({
        page: 2,
        pageSize: 10,
        totalItems: 50,
        totalPages: 5,
      });
    });

    it('should filter by status', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findMany.mockResolvedValue([
        { ...mockStorageObject, uploadedById: user.id, status: 'ready' },
      ]);
      context.prismaMock.storageObject.count.mockResolvedValue(1);

      const response = await request(context.app.getHttpServer())
        .get('/api/storage/objects?status=ready')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
    });
  });

  describe('GET /api/storage/objects/:id', () => {
    it('should return object metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: mockStorageObjectId,
        name: mockStorageObject.name,
        mimeType: mockStorageObject.mimeType,
      });
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .get('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });
  });

  describe('GET /api/storage/objects/:id/download', () => {
    it('should return signed download URL', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'ready',
      });
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const response = await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        url: 'https://signed-url.com/download',
        expiresIn: expect.any(Number),
      });
    });

    it('should return 400 for non-ready objects', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        status: 'processing',
      });

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  describe('DELETE /api/storage/objects/:id', () => {
    it('should delete object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
      });
      mockStorageProvider.delete.mockResolvedValue(undefined);
      context.prismaMock.storageObject.delete.mockResolvedValue({});
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('should return 404 for non-existent object', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer())
        .delete('/api/storage/objects/550e8400-e29b-41d4-a716-446655440001')
        .set(authHeader(user.accessToken))
        .expect(404);
    });

    // ⚠ 409, NOT 403 (#21). The caller genuinely owns the bytes; the refusal
    // is about the object's STATE — another module depends on it — which is
    // what 409 means. Deleting a transcript's source audio through the generic
    // endpoint leaves the transcript pointing at bytes that no longer exist.
    it('should return 409 for an object managed by another module', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        managedBy: 'transcripts',
      });

      const response = await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(409);

      expect(JSON.stringify(response.body)).toContain('transcripts');
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(context.prismaMock.storageObject.delete).not.toHaveBeenCalled();
    });

    // Only list and delete change for a managed object — the owner still owns
    // the bytes, and the download URL is how the owning module plays them back.
    it('should still serve a managed object to its owner', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        managedBy: 'transcripts',
        status: 'ready',
      });
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed.example/download',
      );

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(200);
    });
  });

  describe('PATCH /api/storage/objects/:id/metadata', () => {
    it('should update metadata', async () => {
      const user = await createMockTestUser(context);

      const newMetadata = {
        custom: 'value',
        tags: ['tag1', 'tag2'],
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { existing: 'data', ...newMetadata },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      const response = await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: newMetadata })
        .expect(200);

      expect(response.body.data.metadata).toMatchObject({
        existing: 'data',
        custom: 'value',
      });
    });

    it('should merge with existing metadata', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1' },
      });
      context.prismaMock.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: user.id,
        metadata: { key1: 'value1', key2: 'value2' },
      });
      context.prismaMock.auditEvent.create.mockResolvedValue({});

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key2: 'value2' } })
        .expect(200);
    });
  });

  describe('Authentication', () => {
    it('should require authentication for all endpoints', async () => {
      // Test key endpoints without auth
      await request(context.app.getHttpServer())
        .get('/api/storage/objects')
        .expect(401);

      await request(context.app.getHttpServer())
        .post('/api/storage/objects/upload/init')
        .send({
          name: 'test.pdf',
          size: 1024000,
          mimeType: 'application/pdf',
        })
        .expect(401);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .expect(401);
    });
  });

  describe('Ownership validation', () => {
    it('should enforce ownership across all operations', async () => {
      const user = await createMockTestUser(context);
      const otherUserId = 'other-user-456';

      // Mock object owned by another user
      const otherUserObject = {
        ...mockStorageObject,
        uploadedById: otherUserId,
      };

      context.prismaMock.storageObject.findUnique.mockResolvedValue(otherUserObject);

      // Test various endpoints
      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .get(`/api/storage/objects/${mockStorageObjectId}/download`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${mockStorageObjectId}`)
        .set(authHeader(user.accessToken))
        .expect(403);

      await request(context.app.getHttpServer())
        .patch(`/api/storage/objects/${mockStorageObjectId}/metadata`)
        .set(authHeader(user.accessToken))
        .send({ metadata: { key: 'value' } })
        .expect(403);
    });
  });
});
