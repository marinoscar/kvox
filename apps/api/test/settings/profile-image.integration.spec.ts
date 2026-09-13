import request from 'supertest';
import { Readable } from 'node:stream';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import {
  setupBaseMocks,
  setupMockUserSettings,
} from '../fixtures/mock-setup.helper';
import { createMockTestUser, authHeader } from '../helpers/auth-mock.helper';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';
import { AVATAR_MAX_BYTES } from '../../src/common/profile-image/profile-image';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'utf8',
);

describe('Profile Image Integration (#367)', () => {
  let context: TestContext;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  beforeAll(async () => {
    mockStorageProvider = createMockStorageProvider();
    context = await createTestApp({ useMockDatabase: true });

    const storageProviderToken = context.module.get(STORAGE_PROVIDER, {
      strict: false,
    });
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

  // ===========================================================================
  // POST /api/user-settings/profile-image
  // ===========================================================================
  describe('POST /api/user-settings/profile-image', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .post('/api/user-settings/profile-image')
        .attach('file', PNG_BYTES, {
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        .expect(401);
    });

    it('uploads a valid PNG and selects it as the profile picture', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const newObjectId = '33333333-3333-4333-8333-333333333333';
      context.prismaMock.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      // `UserSettingsService.patchSettings` (the real service, not mocked
      // here) re-validates the new `imageObjectId` against storage via
      // `assertProfileImageReference` — it must find the object this same
      // request just created and recognise it as this user's avatar.
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: newObjectId,
        uploadedById: user.id,
        storageKey: `avatars/${user.id}/avatar.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      const response = await request(context.app.getHttpServer())
        .post('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .attach('file', PNG_BYTES, {
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        .expect(200);

      expect(response.body.data.settings.profile.imageSource).toBe('upload');
      expect(response.body.data.settings.profile.imageObjectId).toBe(
        newObjectId,
      );
      expect(response.body.data.profileImageUrl).toBe(
        `/api/users/${user.id}/avatar/${newObjectId}`,
      );
      expect(mockStorageProvider.upload).toHaveBeenCalled();
    });

    it('returns 400 for an SVG sent with a spoofed image/png content type (magic-byte sniffing)', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .attach('file', SVG_BYTES, {
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        .expect(400);

      expect(response.body).toHaveProperty('code');
      expect(mockStorageProvider.upload).not.toHaveBeenCalled();
    });

    it('returns 413 when the file exceeds the 5 MB limit', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const oversized = Buffer.concat([
        PNG_BYTES,
        Buffer.alloc(AVATAR_MAX_BYTES, 0),
      ]);
      expect(oversized.length).toBeGreaterThan(AVATAR_MAX_BYTES);

      const response = await request(context.app.getHttpServer())
        .post('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .attach('file', oversized, {
          filename: 'avatar.png',
          contentType: 'image/png',
        })
        .expect(413);

      expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    }, 30000);

    it('returns 400 for a non-multipart request', async () => {
      const user = await createMockTestUser(context);

      const response = await request(context.app.getHttpServer())
        .post('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .send({ notAFile: true })
        .expect(400);

      expect(response.body).toHaveProperty('code');
    });
  });

  // ===========================================================================
  // DELETE /api/user-settings/profile-image
  // ===========================================================================
  describe('DELETE /api/user-settings/profile-image', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .delete('/api/user-settings/profile-image')
        .expect(401);
    });

    it('is idempotent when the user has no uploaded avatar', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const response = await request(context.app.getHttpServer())
        .delete('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.settings.profile.imageObjectId).toBeNull();
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });

    it('removes an existing uploaded avatar and falls back to "provider"', async () => {
      const user = await createMockTestUser(context);
      const objectId = '44444444-4444-4444-8444-444444444444';
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'upload', imageObjectId: objectId },
      });
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: user.id,
        storageKey: `avatars/${user.id}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      context.prismaMock.storageObject.delete.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .delete('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.settings.profile.imageSource).toBe('provider');
      expect(response.body.data.settings.profile.imageObjectId).toBeNull();
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        `avatars/${user.id}/old.png`,
      );
    });
  });

  // ===========================================================================
  // GET /api/users/:userId/avatar/:objectId — public route
  // ===========================================================================
  describe('GET /api/users/:userId/avatar/:objectId', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const objectId = '22222222-2222-4222-8222-222222222222';

    it('serves the currently-selected avatar with no auth header and the required headers', async () => {
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'upload', imageObjectId: objectId },
        },
      } as any);
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
        size: BigInt(4),
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from([Buffer.from([1, 2, 3, 4])]),
      );

      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox",
      );
      expect(response.headers['cache-control']).toBe(
        'private, max-age=86400',
      );
      expect(response.headers['content-length']).toBe('4');
    });

    it('404s on a malformed userId uuid', async () => {
      const response = await request(context.app.getHttpServer()).get(
        `/api/users/not-a-uuid/avatar/${objectId}`,
      );
      expect(response.status).toBe(404);
    });

    it('404s on a malformed objectId uuid', async () => {
      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/not-a-uuid`,
      );
      expect(response.status).toBe(404);
    });

    it('404s when the user\'s current source is not "upload"', async () => {
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'provider', imageObjectId: objectId },
        },
      } as any);

      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      expect(response.status).toBe(404);
    });

    it('404s when the objectId does not match the currently-selected avatar', async () => {
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'upload', imageObjectId: 'some-other-id' },
        },
      } as any);

      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      expect(response.status).toBe(404);
    });

    it('404s when the storage object row cannot be found', async () => {
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'upload', imageObjectId: objectId },
        },
      } as any);
      context.prismaMock.storageObject.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      expect(response.status).toBe(404);
    });

    it('404s when the underlying bytes are missing from storage', async () => {
      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'upload', imageObjectId: objectId },
        },
      } as any);
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
        size: BigInt(4),
      } as any);
      mockStorageProvider.download.mockRejectedValue(new Error('missing'));

      const response = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      expect(response.status).toBe(404);
    });

    it('every 404 case above returns the identical body shape', async () => {
      const responses: any[] = [];

      const bad = await request(context.app.getHttpServer()).get(
        `/api/users/not-a-uuid/avatar/${objectId}`,
      );
      responses.push(bad.body);

      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'provider', imageObjectId: null } },
      } as any);
      const wrongSource = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      responses.push(wrongSource.body);

      context.prismaMock.userSettings.findUnique.mockResolvedValue(null);
      const noSettings = await request(context.app.getHttpServer()).get(
        `/api/users/${userId}/avatar/${objectId}`,
      );
      responses.push(noSettings.body);

      const shapes = responses.map((body) => Object.keys(body).sort());
      expect(shapes[0]).toEqual(shapes[1]);
      expect(shapes[1]).toEqual(shapes[2]);
    });
  });

  // ===========================================================================
  // GET /api/user-settings/profile-image — authenticated preview (#367 follow-up)
  // ===========================================================================
  describe('GET /api/user-settings/profile-image', () => {
    const objectId = '66666666-6666-4666-8666-666666666666';

    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/user-settings/profile-image')
        .expect(401);
    });

    it('200s with the correct headers when imageSource is "provider" but an imageObjectId is also stored', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: objectId },
      });
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: user.id,
        storageKey: `avatars/${user.id}/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
        size: BigInt(4),
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from([Buffer.from([1, 2, 3, 4])]),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox",
      );
      // Authenticated per-user preview: never cached — NOT the public
      // route's `private, max-age=86400`.
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-length']).toBe('4');
    });

    it('200s when imageSource is "none" with an imageObjectId stored', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'none', imageObjectId: objectId },
      });
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: user.id,
        storageKey: `avatars/${user.id}/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
        size: BigInt(4),
      } as any);
      mockStorageProvider.download.mockResolvedValue(
        Readable.from([Buffer.from([1, 2, 3, 4])]),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken));

      expect(response.status).toBe(200);
    });

    it('404s when the user has never uploaded anything', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken));

      expect(response.status).toBe(404);
    });

    it('omits the content-length header when the stored object size is 0', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'upload', imageObjectId: objectId },
      });
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: user.id,
        storageKey: `avatars/${user.id}/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
        size: BigInt(0),
      } as any);
      mockStorageProvider.download.mockResolvedValue(Readable.from(['']));

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings/profile-image')
        .set(authHeader(user.accessToken));

      expect(response.status).toBe(200);
      expect(response.headers['content-length']).toBeUndefined();
    });
  });

  // ===========================================================================
  // GET /api/auth/me — field assertions
  // ===========================================================================
  describe('GET /api/auth/me profile image fields', () => {
    it('includes profileImageUrl, providerProfileImageUrl and hasUploadedProfileImage', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('profileImageUrl');
      expect(response.body.data).toHaveProperty('providerProfileImageUrl');
      // No image was ever uploaded, so this must be false even though
      // "provider" is selected — the dedicated true-case coverage is below,
      // and the full source/imageObjectId matrix lives in auth.service.spec.ts.
      expect(response.body.data.hasUploadedProfileImage).toBe(false);
    });

    it('hasUploadedProfileImage is true once an image has been uploaded, regardless of the selected source', async () => {
      const user = await createMockTestUser(context);
      const objectId = '55555555-5555-4555-8555-555555555555';
      // `GET /api/auth/me` resolves through `AuthService.getCurrentUser`,
      // which reads `userSettings` off `prisma.user.findUnique`'s own
      // `include` — a different lookup than `setupMockUserSettings` feeds
      // (that one backs `prisma.userSettings.findUnique`, used by
      // `UserSettingsService`/`AvatarService`). Stub the user lookup itself
      // so both the guard's call (no `userSettings` in its `include`) and
      // the controller's call (which does) see the same enriched row.
      context.prismaMock.user.findUnique.mockResolvedValue({
        id: user.id,
        email: user.email,
        displayName: null,
        providerDisplayName: 'Test User',
        providerProfileImageUrl: 'https://example.com/photo.jpg',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [{ role: { name: 'viewer', rolePermissions: [] } }],
        userSettings: {
          value: {
            theme: 'system',
            profile: { imageSource: 'provider', imageObjectId: objectId },
          },
        },
      } as any);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.hasUploadedProfileImage).toBe(true);
    });
  });

  // ===========================================================================
  // PATCH /api/user-settings — profile image validation
  // ===========================================================================
  describe('PATCH /api/user-settings profile image validation', () => {
    it('returns 400 when imageSource is "upload" with no imageObjectId', async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ profile: { imageSource: 'upload' } })
        .expect(400);
    });

    it("returns 400 when imageObjectId names another user's storage object", async () => {
      const user = await createMockTestUser(context);
      setupMockUserSettings(user.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
      });
      const someoneElsesObjectId = '55555555-5555-4555-8555-555555555555';
      context.prismaMock.storageObject.findUnique.mockResolvedValue({
        id: someoneElsesObjectId,
        uploadedById: 'someone-else',
        storageKey: `avatars/someone-else/pic.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({
          profile: {
            imageSource: 'upload',
            imageObjectId: someoneElsesObjectId,
          },
        })
        .expect(400);
    });
  });
});
