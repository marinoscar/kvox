// =============================================================================
// The managed-object veto and abort forward, over the wire (issue #469)
// =============================================================================
//
// The platform's `DELETE /api/storage/objects/:id` and `.../upload/abort` know
// nothing of this app's ownership: deleting a transcript's source audio would
// leave the transcript pointing at nothing, and the platform abort DELETES the
// object row, which the owning record's `source_object_id` (`ON DELETE
// RESTRICT`) refuses. There is no seam for either in the platform, so a Fastify
// `onRequest` hook (`installManagedDeleteHook`, installed by `main.ts` and by
// `createTestApp`) answers before the platform handler:
//
//   * DELETE of a managed object -> 409 { details: { reason: 'managed_by_module', module } }
//   * abort of a managed upload  -> forwarded in-process to the app's own
//     `DELETE .../upload/abort-managed`: 204, the row survives as `failed`, and
//     a transcript source's transcript becomes `failed / upload_aborted`
//   * anything unmanaged         -> passes straight through to the platform
//
// This suite boots the full `AppModule` (real guards, the real hook, the real
// platform handlers) over a mocked database. The ownership table is the mock's
// `kvoxObjectOwnership`; the provider records what it was asked to do.
// =============================================================================

import request from 'supertest';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import { createMembershipContributor, createMembershipViewer } from '../helpers/membership-user.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { TEST_DEFAULT_ORG_ID, setupBaseMocks } from '../fixtures/mock-setup.helper';

const OBJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_OBJECT_ID = '550e8400-e29b-41d4-a716-446655440001';
const KEY = 'uploads/org/1760000000000/abc.m4a';
const UPLOAD_ID = 'mpu-1';

const DELETE = (id: string = OBJECT_ID) => `/api/storage/objects/${id}`;
const ABORT = (id: string = OBJECT_ID) => `/api/storage/objects/${id}/upload/abort`;

describe('Managed-object delete veto and abort forward (full app, mocked database)', () => {
  let context: TestContext;
  let storage: ReturnType<typeof createMockStorageProvider>;

  const objectRow = (overrides: Record<string, unknown> = {}) => ({
    id: OBJECT_ID,
    orgId: TEST_DEFAULT_ORG_ID,
    name: 'meeting.m4a',
    size: BigInt(5_000_000),
    mimeType: 'audio/mp4',
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

  /** The ownership table answers "this object belongs to `module`". */
  const owned = (module: 'transcripts' | 'notes' | 'graph', id: string = OBJECT_ID) =>
    prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([{ objectId: id, managedBy: module }]);

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
    storage.delete.mockResolvedValue(undefined);
    storage.abortMultipartUpload.mockResolvedValue(undefined);
  });

  // ===========================================================================
  // DELETE /api/storage/objects/:id
  // ===========================================================================

  describe('DELETE /api/storage/objects/:id', () => {
    it.each(['transcripts', 'notes', 'graph'] as const)(
      'answers 409 managed_by_module naming %s, before the platform handler runs',
      async (module) => {
        const user = await createMembershipContributor(context);
        owned(module);
        prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id, status: 'ready' }));

        const response = await request(context.app.getHttpServer())
          .delete(DELETE())
          .set(authHeader(user.accessToken))
          .expect(409);

        expect(response.body.details).toEqual({ reason: 'managed_by_module', module });
        // The platform handler never ran: no read of the row, no bytes removed, no row removed.
        expect(prismaMock.storageObject.findUnique).not.toHaveBeenCalled();
        expect(storage.delete).not.toHaveBeenCalled();
        expect(prismaMock.storageObject.delete).not.toHaveBeenCalled();
      },
    );

    it('succeeds (the platform\'s 204) for a plain upload, and removes bytes and row', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id, status: 'ready', s3UploadId: null }));
      prismaMock.storageObject.delete.mockResolvedValue({});

      await request(context.app.getHttpServer()).delete(DELETE()).set(authHeader(user.accessToken)).expect(204);

      // The veto looked the object up in the ownership table, found nothing, and stepped aside.
      expect(prismaMock.kvoxObjectOwnership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { objectId: { in: [OBJECT_ID] } } }),
      );
      expect(storage.delete).toHaveBeenCalledWith(KEY);
      expect(prismaMock.storageObject.delete).toHaveBeenCalled();
    });

    it('does not tell an anonymous caller which ids are managed: 401, not 409', async () => {
      owned('transcripts');

      await request(context.app.getHttpServer()).delete(DELETE()).expect(401);

      expect(prismaMock.kvoxObjectOwnership.findMany).not.toHaveBeenCalled();
    });

    it('refuses the delete (503) rather than let it through when the ownership read fails', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.kvoxObjectOwnership.findMany.mockRejectedValue(new Error('connection reset'));
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id, status: 'ready' }));

      const response = await request(context.app.getHttpServer())
        .delete(DELETE())
        .set(authHeader(user.accessToken))
        .expect(503);

      expect(JSON.stringify(response.body)).not.toContain('connection reset');
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // DELETE /api/storage/objects/:id/upload/abort
  // ===========================================================================

  describe('DELETE /api/storage/objects/:id/upload/abort', () => {
    it('aborts a transcript source: 204, the row survives as failed, the transcript fails as upload_aborted', async () => {
      const user = await createMembershipContributor(context);
      owned('transcripts');
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id }));

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(204);

      // The provider upload is aborted...
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(KEY, UPLOAD_ID);

      // ...the row is KEPT, as `failed`, with no upload id (the platform abort would have deleted it,
      // and the transcript's `source_object_id` is ON DELETE RESTRICT)...
      expect(prismaMock.storageObject.delete).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.deleteMany).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.updateMany).toHaveBeenCalledWith({
        where: { id: OBJECT_ID, status: { in: ['pending', 'uploading'] } },
        data: { status: 'failed', s3UploadId: null },
      });

      // ...and the transcript still `uploading` on it is failed with the housekeeping reason.
      expect(prismaMock.transcript.updateMany).toHaveBeenCalledWith({
        where: { sourceObjectId: OBJECT_ID, deletedAt: null, status: 'uploading' },
        data: { status: 'failed', failureReason: 'upload_aborted' },
      });
    });

    it('aborts a notes-managed upload without touching any transcript', async () => {
      const user = await createMembershipContributor(context);
      owned('notes');
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id }));

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(204);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(KEY, UPLOAD_ID);
      expect(prismaMock.storageObject.updateMany).toHaveBeenCalled();
      expect(prismaMock.transcript.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.delete).not.toHaveBeenCalled();
    });

    it('is idempotent: aborting an already-failed managed upload answers 204 and aborts nothing at the provider', async () => {
      const user = await createMembershipContributor(context);
      owned('transcripts');
      prismaMock.storageObject.findUnique.mockResolvedValue(
        objectRow({ uploadedById: user.id, status: 'failed', s3UploadId: null }),
      );

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(204);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('answers 404, never 403, for another user\'s managed upload, and aborts nothing', async () => {
      const user = await createMembershipContributor(context);
      owned('transcripts');
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: 'someone-else' }));

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(404);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(prismaMock.storageObject.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('answers 400 once the managed upload has settled', async () => {
      const user = await createMembershipContributor(context);
      owned('transcripts');
      prismaMock.storageObject.findUnique.mockResolvedValue(
        objectRow({ uploadedById: user.id, status: 'ready', s3UploadId: null }),
      );

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(400);

      expect(prismaMock.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('lets an unmanaged upload through to the platform abort, which deletes the row', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id }));
      prismaMock.storageObject.delete.mockResolvedValue({});

      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(user.accessToken)).expect(200);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(KEY, UPLOAD_ID);
      // The platform's behaviour, not the app's: the row goes, and no transcript is involved.
      expect(prismaMock.storageObject.delete).toHaveBeenCalled();
      expect(prismaMock.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('leaves a non-existent object to the platform (404)', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue(null);

      await request(context.app.getHttpServer()).delete(ABORT(OTHER_OBJECT_ID)).set(authHeader(user.accessToken)).expect(404);
    });

    it('answers 401 without a token and 403 (the forwarded route\'s own guard) without storage:write', async () => {
      const viewer = await createMembershipViewer(context);
      owned('transcripts');
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: viewer.id }));

      await request(context.app.getHttpServer()).delete(ABORT()).expect(401);
      await request(context.app.getHttpServer()).delete(ABORT()).set(authHeader(viewer.accessToken)).expect(403);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('does not expose the forward target to a caller who skips the hook: the managed route 404s for an unmanaged object', async () => {
      const user = await createMembershipContributor(context);
      prismaMock.kvoxObjectOwnership.findMany.mockResolvedValue([]);
      prismaMock.storageObject.findUnique.mockResolvedValue(objectRow({ uploadedById: user.id }));

      await request(context.app.getHttpServer())
        .delete(`/api/storage/objects/${OBJECT_ID}/upload/abort-managed`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
