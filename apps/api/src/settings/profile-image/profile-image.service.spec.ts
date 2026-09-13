import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';

import { ProfileImageService } from './profile-image.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { UserSettingsService } from '../user-settings/user-settings.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import { AVATAR_MAX_BYTES } from '../../common/profile-image/profile-image';

// Real magic bytes so `detectImageType` (exercised for real, not mocked)
// classifies these as valid avatars.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

describe('ProfileImageService (#367)', () => {
  let service: ProfileImageService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockUserSettings: {
    getSettings: jest.Mock;
    patchSettings: jest.Mock;
  };

  const userId = 'user-1';
  const previousObjectId = '11111111-1111-4111-8111-111111111111';
  const newObjectId = '22222222-2222-4222-8222-222222222222';

  const baseSettings = (overrides: Record<string, unknown> = {}) => ({
    theme: 'system',
    profile: {
      imageSource: 'provider',
      imageObjectId: null,
      ...overrides,
    },
    updatedAt: new Date(),
    version: 1,
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
    mockUserSettings = {
      getSettings: jest.fn(),
      patchSettings: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileImageService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: UserSettingsService, useValue: mockUserSettings },
      ],
    }).compile();

    service = module.get<ProfileImageService>(ProfileImageService);

    // resolveFor's user lookup — used by both upload() and remove().
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      providerProfileImageUrl: 'https://provider.example.com/pic.jpg',
    } as any);

    mockPrisma.auditEvent.create.mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('upload', () => {
    it('rejects a buffer over AVATAR_MAX_BYTES with 413, before touching storage', async () => {
      const bigBuffer = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0xff);

      await expect(service.upload(userId, bigBuffer)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(mockStorageProvider.upload).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised image type with 400 (magic-byte sniffing)', async () => {
      const svgBuffer = Buffer.from('<svg></svg>', 'utf8');

      await expect(service.upload(userId, svgBuffer)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockStorageProvider.upload).not.toHaveBeenCalled();
    });

    it('stores a valid PNG, selects it, and returns the resolved profileImageUrl', async () => {
      mockUserSettings.getSettings.mockResolvedValue(baseSettings());
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );

      const result = await service.upload(userId, PNG_BYTES);

      expect(mockStorageProvider.upload).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^avatars/${userId}/.+\\.png$`)),
        expect.anything(),
        expect.objectContaining({
          mimeType: 'image/png',
          contentLength: PNG_BYTES.length,
          metadata: { purpose: 'avatar' },
        }),
      );
      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mimeType: 'image/png',
            status: 'ready',
            uploadedById: userId,
            metadata: { purpose: 'avatar' },
          }),
        }),
      );
      expect(mockUserSettings.patchSettings).toHaveBeenCalledWith(userId, {
        profile: { imageSource: 'upload', imageObjectId: newObjectId },
      });
      expect(result.profileImageUrl).toBe(
        `/api/users/${userId}/avatar/${newObjectId}`,
      );
      expect(result.settings.profile.imageObjectId).toBe(newObjectId);
    });

    it('writes a user_settings:profile_image:upload audit event on success', async () => {
      mockUserSettings.getSettings.mockResolvedValue(baseSettings());
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );

      await service.upload(userId, PNG_BYTES);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: userId,
            action: 'user_settings:profile_image:upload',
            targetType: 'user',
            targetId: userId,
          }),
        }),
      );
    });

    it('replacing an existing avatar deletes the previous stored object (bytes + row + audit event)', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: previousObjectId }),
      );
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);

      await service.upload(userId, PNG_BYTES);

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        `avatars/${userId}/old.png`,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: previousObjectId },
      });
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'storage:object:delete',
            targetId: previousObjectId,
          }),
        }),
      );
    });

    it('does not attempt to delete a "previous" object when it is the same object id', async () => {
      // Defensive: if a settings read raced and returned the just-written id,
      // the replaced-avatar cleanup path must not fire against itself.
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );

      await service.upload(userId, PNG_BYTES);

      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });

    it('best-effort deletion: keeps the previous row and does not fail the upload when byte deletion fails', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: previousObjectId }),
      );
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: newObjectId }),
      );
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      mockStorageProvider.delete.mockRejectedValue(new Error('storage down'));

      const result = await service.upload(userId, PNG_BYTES);

      // The upload itself still succeeded.
      expect(result.settings.profile.imageObjectId).toBe(newObjectId);
      // The previous row is KEPT because its bytes could not be deleted.
      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });

    it('deletes the newly-created object and rethrows when patchSettings fails', async () => {
      mockUserSettings.getSettings.mockResolvedValue(baseSettings());
      mockStorageProvider.upload.mockResolvedValue({
        key: `avatars/${userId}/uuid.png`,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: '"etag"',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        id: newObjectId,
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: newObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/uuid.png`,
        name: 'avatar.png',
        size: BigInt(PNG_BYTES.length),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      const settingsError = new Error('settings write failed');
      mockUserSettings.patchSettings.mockRejectedValue(settingsError);

      await expect(service.upload(userId, PNG_BYTES)).rejects.toThrow(
        settingsError,
      );

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        `avatars/${userId}/uuid.png`,
      );
    });
  });

  describe('remove', () => {
    it('is idempotent when the user has no avatar (no imageObjectId, source not upload)', async () => {
      mockUserSettings.getSettings.mockResolvedValue(baseSettings());

      const result = await service.remove(userId);

      expect(mockUserSettings.patchSettings).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
      expect(result.settings.profile.imageSource).toBe('provider');
    });

    it('clears imageObjectId and falls back imageSource to "provider" when removing an active upload', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: previousObjectId }),
      );
      mockUserSettings.patchSettings.mockResolvedValue(baseSettings());
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);

      const result = await service.remove(userId);

      expect(mockUserSettings.patchSettings).toHaveBeenCalledWith(userId, {
        profile: { imageObjectId: null, imageSource: 'provider' },
      });
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        `avatars/${userId}/old.png`,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: previousObjectId },
      });
      expect(result.settings.profile.imageSource).toBe('provider');
    });

    it('clears a leftover imageObjectId without touching imageSource when the source is already not "upload"', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'none', imageObjectId: previousObjectId }),
      );
      mockUserSettings.patchSettings.mockResolvedValue(
        baseSettings({ imageSource: 'none' }),
      );
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await service.remove(userId);

      expect(mockUserSettings.patchSettings).toHaveBeenCalledWith(userId, {
        profile: { imageObjectId: null },
      });
    });

    it('writes a user_settings:profile_image:delete audit event when an avatar is removed', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: previousObjectId }),
      );
      mockUserSettings.patchSettings.mockResolvedValue(baseSettings());
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await service.remove(userId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: userId,
            action: 'user_settings:profile_image:delete',
            targetType: 'user',
            targetId: userId,
          }),
        }),
      );
    });

    it('does not throw and does not delete the row when best-effort byte deletion fails', async () => {
      mockUserSettings.getSettings.mockResolvedValue(
        baseSettings({ imageSource: 'upload', imageObjectId: previousObjectId }),
      );
      mockUserSettings.patchSettings.mockResolvedValue(baseSettings());
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: previousObjectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/old.png`,
        name: 'avatar.png',
        size: BigInt(100),
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
      mockStorageProvider.delete.mockRejectedValue(new Error('storage down'));

      await expect(service.remove(userId)).resolves.toBeDefined();
      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });
  });
});
