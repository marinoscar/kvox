import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';

import { AvatarService } from './avatar.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';

/**
 * The public avatar route (#367) must answer an IDENTICAL 404 for every miss
 * case — malformed id, wrong source, wrong object, missing bytes — so it
 * cannot be used as an oracle. Every "not found" test below asserts both the
 * exception type and that no case leaks a different shape or message.
 */
describe('AvatarService (#367)', () => {
  let service: AvatarService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;

  const userId = '11111111-1111-4111-8111-111111111111';
  const objectId = '22222222-2222-4222-8222-222222222222';

  const validObject = {
    id: objectId,
    uploadedById: userId,
    storageKey: `avatars/${userId}/pic.png`,
    status: 'ready',
    mimeType: 'image/png',
    metadata: { purpose: 'avatar' },
    size: BigInt(1234),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvatarService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
      ],
    }).compile();

    service = module.get<AvatarService>(AvatarService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('opens the currently-selected avatar and streams it back', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
    const stream = Readable.from(['bytes']);
    mockStorageProvider.download.mockResolvedValue(stream);

    const result = await service.open(userId, objectId);

    expect(result.stream).toBe(stream);
    expect(result.mimeType).toBe('image/png');
    expect(result.size).toBe(BigInt(1234));
    expect(mockStorageProvider.download).toHaveBeenCalledWith(
      validObject.storageKey,
    );
  });

  it('404s on a malformed userId', async () => {
    await expect(service.open('not-a-uuid', objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
  });

  it('404s on a malformed objectId', async () => {
    await expect(service.open(userId, 'not-a-uuid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the user has no settings row (defaults to "provider", never "upload")', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue(null);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the user\'s current source is not "upload"', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'provider', imageObjectId: objectId },
      },
    } as any);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the requested objectId does not match the currently-selected one', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: 'some-other-id' },
      },
    } as any);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the storage object cannot be found', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue(null);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockStorageProvider.download).not.toHaveBeenCalled();
  });

  it('404s when the object fails the avatar-validity check (e.g. wrong key prefix)', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue({
      ...validObject,
      storageKey: `uploads/${userId}/pic.png`,
    } as any);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockStorageProvider.download).not.toHaveBeenCalled();
  });

  it('404s when the object is not owned by this user', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue({
      ...validObject,
      uploadedById: 'someone-else',
    } as any);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the object is not "ready"', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue({
      ...validObject,
      status: 'processing',
    } as any);

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the underlying bytes are missing from storage', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'upload', imageObjectId: objectId },
      },
    } as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
    mockStorageProvider.download.mockRejectedValue(new Error('NoSuchKey'));

    await expect(service.open(userId, objectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('every 404 case carries the exact same message, so no case is distinguishable from another', async () => {
    mockPrisma.userSettings.findUnique.mockResolvedValue(null);
    let noSettingsMessage: string | undefined;
    try {
      await service.open(userId, objectId);
    } catch (error) {
      noSettingsMessage = (error as NotFoundException).message;
    }

    mockPrisma.userSettings.findUnique.mockResolvedValue({
      value: {
        profile: { imageSource: 'provider', imageObjectId: objectId },
      },
    } as any);
    let wrongSourceMessage: string | undefined;
    try {
      await service.open(userId, objectId);
    } catch (error) {
      wrongSourceMessage = (error as NotFoundException).message;
    }

    let malformedIdMessage: string | undefined;
    try {
      await service.open('not-a-uuid', objectId);
    } catch (error) {
      malformedIdMessage = (error as NotFoundException).message;
    }

    expect(noSettingsMessage).toBeDefined();
    expect(noSettingsMessage).toBe(wrongSourceMessage);
    expect(noSettingsMessage).toBe(malformedIdMessage);
  });

  // ===========================================================================
  // openStored — the authenticated preview (issue #367 follow-up)
  // ===========================================================================
  describe('openStored', () => {
    it('serves the stored upload when imageSource is "none" (the core new behavior)', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'none', imageObjectId: objectId },
        },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
      const stream = Readable.from(['bytes']);
      mockStorageProvider.download.mockResolvedValue(stream);

      const result = await service.openStored(userId);

      expect(result.stream).toBe(stream);
      expect(result.mimeType).toBe('image/png');
      expect(result.size).toBe(BigInt(1234));
      expect(mockStorageProvider.download).toHaveBeenCalledWith(
        validObject.storageKey,
      );
    });

    it('serves the stored upload when imageSource is "provider" but an imageObjectId is set', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'provider', imageObjectId: objectId },
        },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
      mockStorageProvider.download.mockResolvedValue(Readable.from(['bytes']));

      const result = await service.openStored(userId);

      expect(result.mimeType).toBe('image/png');
    });

    it('serves the stored upload when imageSource is "upload" with a matching imageObjectId', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: {
          profile: { imageSource: 'upload', imageObjectId: objectId },
        },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
      mockStorageProvider.download.mockResolvedValue(Readable.from(['bytes']));

      const result = await service.openStored(userId);

      expect(result.mimeType).toBe('image/png');
    });

    it('404s when no imageObjectId is stored', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: null } },
      } as any);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('404s when the user has no settings row at all', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(null);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('404s when the referenced storage object cannot be found', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: objectId } },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });

    it('404s when the object belongs to a different user', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: objectId } },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...validObject,
        uploadedById: 'someone-else',
      } as any);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });

    it('404s when the object has the wrong storage key prefix', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: objectId } },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...validObject,
        storageKey: `uploads/${userId}/pic.png`,
      } as any);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the object metadata purpose is not "avatar"', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: objectId } },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...validObject,
        metadata: { purpose: 'other' },
      } as any);

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when storageProvider.download() throws', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: objectId } },
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(validObject as any);
      mockStorageProvider.download.mockRejectedValue(new Error('NoSuchKey'));

      await expect(service.openStored(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s on a malformed (non-uuid) userId', async () => {
      await expect(service.openStored('not-a-uuid')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
    });

    it('every 404 case carries the identical message', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        value: { profile: { imageSource: 'none', imageObjectId: null } },
      } as any);
      let noObjectIdMessage: string | undefined;
      try {
        await service.openStored(userId);
      } catch (error) {
        noObjectIdMessage = (error as NotFoundException).message;
      }

      let malformedIdMessage: string | undefined;
      try {
        await service.openStored('not-a-uuid');
      } catch (error) {
        malformedIdMessage = (error as NotFoundException).message;
      }

      expect(noObjectIdMessage).toBeDefined();
      expect(noObjectIdMessage).toBe(malformedIdMessage);
      expect(noObjectIdMessage).toBe('Not found');
    });
  });
});
