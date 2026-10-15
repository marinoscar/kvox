import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { UserSettingsService } from './user-settings.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { USER_SETTINGS_NAMESPACE_CHANGED_EVENT } from './user-settings.events';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';

describe('UserSettingsService', () => {
  let service: UserSettingsService;
  let mockPrisma: MockPrismaService;
  let mockEvents: { emit: jest.Mock };

  const mockUserId = 'user-123';

  const mockUserSettings = {
    id: 'settings-1',
    userId: mockUserId,
    value: DEFAULT_USER_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockEvents = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<UserSettingsService>(UserSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return settings for current user', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledWith({
        where: { userId: mockUserId },
      });
    });

    it('should create and return default settings if none exist', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(null);
      mockPrisma.userSettings.create.mockResolvedValue(mockUserSettings as any);

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
        version: 1,
      });
      expect(mockPrisma.userSettings.create).toHaveBeenCalledWith({
        data: {
          userId: mockUserId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace user settings', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'dark',
        profile: {
          displayName: 'John Doe',
          imageSource: 'none',
          imageObjectId: null,
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, newSettings);

      expect(result).toMatchObject({
        theme: newSettings.theme,
        profile: newSettings.profile,
        version: 2,
      });
      expect(mockPrisma.userSettings.upsert).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        update: {
          value: newSettings as any,
          version: { increment: 1 },
        },
        create: {
          userId: mockUserId,
          value: newSettings as any,
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'light',
        profile: {
          imageSource: 'provider',
          imageObjectId: null,
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, newSettings);

      expect(result.version).toBe(5);
      expect(mockPrisma.userSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should sync displayName to user table when changed', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'system',
        profile: {
          displayName: 'Jane Smith',
          imageSource: 'provider',
          imageObjectId: null,
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: 'Jane Smith' },
      });
    });

    it('should handle displayName set to empty string', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'system',
        profile: {
          displayName: '', // Empty string
          imageSource: 'provider',
          imageObjectId: null,
        },
      };

      // The validated result contains displayName as empty string
      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: {
            displayName: '',
            imageSource: 'provider',
            imageObjectId: null,
          },
        } as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      // Empty string is converted to null via displayName || null logic
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: null },
      });
    });

    it('should not sync displayName when not provided in settings', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'dark',
        profile: {
          imageSource: 'none',
          imageObjectId: null,
        },
      };

      // When displayName is not provided, Zod schema validation won't include it
      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: {
          ...newSettings,
          profile: {
            ...newSettings.profile,
            // displayName is not present in the validated result
          },
        } as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      // displayName is not in the validated result (not undefined, just missing),
      // so it should not be synced
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.theme).toBe('dark');
      expect(result.profile).toEqual(DEFAULT_USER_SETTINGS.profile);
      expect(result.version).toBe(2);
    });

    it('should handle nested profile updates', async () => {
      const partialUpdate = {
        profile: {
          displayName: 'Updated Name',
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Updated Name',
            imageSource: DEFAULT_USER_SETTINGS.profile.imageSource,
            imageObjectId: DEFAULT_USER_SETTINGS.profile.imageObjectId,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.profile.displayName).toBe('Updated Name');
      expect(result.profile.imageSource).toBe(
        DEFAULT_USER_SETTINGS.profile.imageSource,
      );
    });

    it('should sync displayName when updated via patch', async () => {
      const partialUpdate = {
        profile: {
          displayName: 'Patched Name',
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Patched Name',
            imageSource: DEFAULT_USER_SETTINGS.profile.imageSource,
            imageObjectId: DEFAULT_USER_SETTINGS.profile.imageObjectId,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.patchSettings(mockUserId, partialUpdate);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: 'Patched Name' },
      });
    });

    it('should throw ConflictException on version mismatch', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(mockUserId, partialUpdate, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(mockUserId, partialUpdate, 2),
      ).rejects.toThrow('Settings version mismatch. Expected 2, found 1');

      // Should not call update when version mismatch
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when expected version matches', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        mockUserId,
        partialUpdate,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.userSettings.update).toHaveBeenCalled();
    });

    it('should handle multiple profile field updates', async () => {
      // `imageSource` and `displayName` change together; `imageObjectId`
      // stays null throughout (source moves to `none`, not `upload`), so this
      // does not need to satisfy `assertProfileImageReference`'s avatar check
      // (see the dedicated `assertProfileImageReference` describe block below
      // for that machinery).
      const partialUpdate = {
        profile: {
          displayName: 'Multi Update',
          imageSource: 'none' as const,
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Multi Update',
            imageSource: 'none',
            imageObjectId: null,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.profile.imageSource).toBe('none');
      expect(result.profile.displayName).toBe('Multi Update');
    });
  });

  describe('profile image reference validation (assertProfileImageReference, #367)', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
      mockPrisma.user.update.mockResolvedValue({} as any);
    });

    const avatarObjectId = '11111111-1111-4111-8111-111111111111';

    function mockValidAvatarObject(userId: string, objectId: string) {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: objectId,
        uploadedById: userId,
        storageKey: `avatars/${userId}/${objectId}.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);
    }

    it('rejects imageSource "upload" with no imageObjectId (PATCH)', async () => {
      await expect(
        service.patchSettings(mockUserId, {
          profile: { imageSource: 'upload' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('rejects imageSource "upload" with no imageObjectId (PUT)', async () => {
      await expect(
        service.replaceSettings(mockUserId, {
          theme: 'light',
          profile: { imageSource: 'upload' },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockPrisma.userSettings.upsert).not.toHaveBeenCalled();
    });

    it('accepts imageSource "upload" when imageObjectId names an avatar the caller owns', async () => {
      mockValidAvatarObject(mockUserId, avatarObjectId);
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        } as any,
        version: 2,
      } as any);

      const result = await service.patchSettings(mockUserId, {
        profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
      });

      expect(result.profile.imageSource).toBe('upload');
      expect(mockPrisma.storageObject.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: avatarObjectId } }),
      );
    });

    it('rejects imageObjectId pointing at an object the caller does not own', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: avatarObjectId,
        uploadedById: 'someone-else',
        storageKey: `avatars/someone-else/${avatarObjectId}.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await expect(
        service.patchSettings(mockUserId, {
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('rejects an imageObjectId that is not a ready avatar (e.g. still processing)', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: avatarObjectId,
        uploadedById: mockUserId,
        storageKey: `avatars/${mockUserId}/${avatarObjectId}.png`,
        status: 'processing',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await expect(
        service.patchSettings(mockUserId, {
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an imageObjectId for an object that is not under the avatar key prefix', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        id: avatarObjectId,
        uploadedById: mockUserId,
        storageKey: `uploads/${mockUserId}/${avatarObjectId}.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: 'avatar' },
      } as any);

      await expect(
        service.patchSettings(mockUserId, {
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the avatar check when the image fields do not change (an unrelated theme PATCH)', async () => {
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: { theme: 'dark', profile: DEFAULT_USER_SETTINGS.profile } as any,
        version: 2,
      } as any);

      await service.patchSettings(mockUserId, { theme: 'dark' });

      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('keeps the stored imageObjectId when switching source to "none" without re-checking it', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        } as any,
      } as any);
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'none', imageObjectId: avatarObjectId },
        } as any,
        version: 2,
      } as any);

      const result = await service.patchSettings(mockUserId, {
        profile: { imageSource: 'none' },
      });

      expect(result.profile.imageSource).toBe('none');
      expect(result.profile.imageObjectId).toBe(avatarObjectId);
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('a PATCH omitting imageObjectId keeps the previously stored id (does not orphan it)', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        } as any,
      } as any);
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'upload', imageObjectId: avatarObjectId },
        } as any,
        version: 2,
      } as any);

      const result = await service.patchSettings(mockUserId, {
        profile: { displayName: 'Still Uploaded' },
      });

      expect(result.profile.imageObjectId).toBe(avatarObjectId);
      // imageObjectId is unchanged and imageSource stays "upload" (not newly
      // set), so `needsCheck` is false — no re-validation against storage.
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('a PUT with null imageObjectId clears it without a storage check', async () => {
      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'light',
          profile: { imageSource: 'provider', imageObjectId: null },
        } as any,
        version: 2,
      } as any);

      const result = await service.replaceSettings(mockUserId, {
        theme: 'light',
        profile: { imageSource: 'provider', imageObjectId: null },
      } as any);

      expect(result.profile.imageObjectId).toBeNull();
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('legacy removal: updateProfileImage no longer exists (#367)', () => {
    it('does not expose an updateProfileImage method', () => {
      expect((service as any).updateProfileImage).toBeUndefined();
    });
  });

  describe('updateTheme', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          ...DEFAULT_USER_SETTINGS,
          theme: 'dark',
        } as any,
        version: 2,
      } as any);
      mockPrisma.user.update.mockResolvedValue({} as any);
    });

    it('should update theme preference', async () => {
      const result = await service.updateTheme(mockUserId, 'dark');

      expect(result.theme).toBe('dark');
      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: mockUserId },
          data: expect.objectContaining({
            value: expect.objectContaining({
              theme: 'dark',
            }),
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // Namespace merge and limit semantics, driven through the public API
  // ===========================================================================
  //
  // Since #459 each namespace's PATCH merge and its caps live in the user
  // settings namespace registry (`settings/registry/core-user-namespaces.ts`),
  // not in private methods of this service. What this service owns, and what
  // these cases pin, is the loop around them: every registered namespace
  // merges its own patch, an emptied namespace is left OUT of the stored value
  // (absent means "use built-in defaults"; `{}` would not), the caps are
  // checked against the MERGED result, and the post-merge
  // `userSettingsSchema.parse` does not strip a registered key. Each case
  // therefore asserts against what actually reached Prisma, which is the only
  // place all four behaviours are visible together.

  const BASE_VALUE = { theme: 'system', profile: { imageSource: 'provider' } };

  /** Make Prisma hold `BASE_VALUE` plus the given namespaces. */
  function stored(namespaces: Record<string, unknown>) {
    mockPrisma.userSettings.findUnique.mockResolvedValue({
      ...mockUserSettings,
      value: { ...BASE_VALUE, ...namespaces } as any,
    } as any);
  }

  /** Capture what a PATCH writes (`update`) and echo it back as the row. */
  function captureStoredValue() {
    const captured: { value?: any } = {};
    (mockPrisma.userSettings.update as any).mockImplementation(
      async ({ data }: any) => {
        captured.value = data.value;
        return { ...mockUserSettings, value: data.value, version: 2 };
      },
    );
    mockPrisma.user.update.mockResolvedValue({} as any);
    return captured;
  }

  /** Capture what a PUT writes (`upsert`) and echo it back as the row. */
  function captureUpsertedValue() {
    const captured: { value?: any } = {};
    (mockPrisma.userSettings.upsert as any).mockImplementation(
      async ({ update }: any) => {
        captured.value = update.value;
        return { ...mockUserSettings, value: update.value, version: 2 };
      },
    );
    mockPrisma.user.update.mockResolvedValue({} as any);
    return captured;
  }

  /**
   * PATCH `patch` on top of a stored value holding `current`, and resolve to
   * the value that reached Prisma.
   */
  async function patchOn(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    stored(current);
    const captured = captureStoredValue();
    await service.patchSettings(mockUserId, patch as any);
    return captured.value;
  }

  describe('dataTables namespace merge (JSON Merge Patch semantics)', () => {
    it('a patch that omits the namespace leaves it untouched', async () => {
      const current = { jobs: { density: 'compact' as const } };

      const result = await patchOn({ dataTables: current }, { theme: 'dark' });

      expect(result.dataTables).toEqual(current);
    });

    it('a non-null entry REPLACES the stored entry wholesale, leaving other entries untouched', async () => {
      const current = {
        jobs: { density: 'compact' as const, pageSize: 10 },
        users: { pageSize: 50 },
      };

      const result = await patchOn(
        { dataTables: current },
        { dataTables: { jobs: { pageSize: 25 } } },
      );

      // The previously stored `density` for jobs is gone - not deep-merged.
      expect(result.dataTables.jobs).toEqual({ pageSize: 25 });
      expect(result.dataTables.jobs).not.toHaveProperty('density');
      // The `users` entry was never touched.
      expect(result.dataTables.users).toEqual({ pageSize: 50 });
    });

    it('{ jobs: null } deletes only the jobs entry, leaving other entries untouched', async () => {
      const current = { jobs: { pageSize: 10 }, users: { pageSize: 50 } };

      const result = await patchOn(
        { dataTables: current },
        { dataTables: { jobs: null } },
      );

      expect(result.dataTables).toEqual({ users: { pageSize: 50 } });
    });

    it('dataTables: null clears the whole namespace', async () => {
      const current = { jobs: { pageSize: 10 }, users: { pageSize: 50 } };

      const result = await patchOn(
        { dataTables: current },
        { dataTables: null },
      );

      expect('dataTables' in result).toBe(false);
    });

    it('emptying the last entry collapses the namespace back to absent, not {}', async () => {
      const result = await patchOn(
        { dataTables: { jobs: { pageSize: 10 } } },
        { dataTables: { jobs: null } },
      );

      expect('dataTables' in result).toBe(false);
    });
  });

  describe('navigation namespace merge', () => {
    it('a patch that omits the namespace leaves it untouched', async () => {
      const result = await patchOn(
        { navigation: { railCollapsed: true } },
        { theme: 'dark' },
      );

      expect(result.navigation).toEqual({ railCollapsed: true });
    });

    it('an omitted field is left untouched', async () => {
      const result = await patchOn(
        { navigation: { railCollapsed: true } },
        { navigation: {} },
      );

      expect(result.navigation).toEqual({ railCollapsed: true });
    });

    it('a listed field is replaced', async () => {
      const result = await patchOn(
        { navigation: { railCollapsed: true } },
        { navigation: { railCollapsed: false } },
      );

      expect(result.navigation).toEqual({ railCollapsed: false });
    });

    it('railCollapsed: null deletes the field, and with it the emptied namespace', async () => {
      const result = await patchOn(
        { navigation: { railCollapsed: true } },
        { navigation: { railCollapsed: null } },
      );

      expect('navigation' in result).toBe(false);
    });

    it('navigation: null clears the whole namespace', async () => {
      const result = await patchOn(
        { navigation: { railCollapsed: true } },
        { navigation: null },
      );

      expect('navigation' in result).toBe(false);
    });

    it('nulling a field of an absent namespace stays absent, not {}', async () => {
      const result = await patchOn({}, { navigation: { railCollapsed: null } });

      expect('navigation' in result).toBe(false);
    });
  });

  // ===========================================================================
  // onboarding namespace merge logic (issue #272, epic #271)
  // ===========================================================================
  //
  // Field-wise like navigation, NOT wholesale like dataTables: the four fields
  // are independent decisions about four different surfaces, and the client
  // writes exactly the one that just happened. A wholesale replace would drop
  // the stored `skipped` list the first time a dialog was closed.
  //
  // Collapsing matters more here than anywhere else in this service: the epic
  // reads the PRESENCE of the namespace to decide whether this user has ever
  // been onboarded, so a stored `{}` would say "already onboarded" while
  // containing nothing.

  describe('onboarding namespace merge', () => {
    const SEEN = '2026-09-17T10:00:00.000Z';
    const DISMISSED = '2026-09-17T11:00:00.000Z';
    const ADMIN_DISMISSED = '2026-09-17T12:00:00.000Z';

    it('a patch that omits the namespace leaves it untouched', async () => {
      const current = { welcomeSeenAt: SEEN };

      const result = await patchOn({ onboarding: current }, { theme: 'dark' });

      expect(result.onboarding).toEqual(current);
    });

    it('an omitted field is left untouched', async () => {
      const current = { welcomeSeenAt: SEEN, dismissedAt: DISMISSED };

      const result = await patchOn({ onboarding: current }, { onboarding: {} });

      expect(result.onboarding).toEqual(current);
    });

    it('setting one field leaves the other three alone', async () => {
      const current = { welcomeSeenAt: SEEN, skipped: ['configure_oauth'] };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { dismissedAt: DISMISSED } },
      );

      expect(result.onboarding).toEqual({
        welcomeSeenAt: SEEN,
        dismissedAt: DISMISSED,
        skipped: ['configure_oauth'],
      });
    });

    // THE `!== undefined` CONVENTION, not `??`. With `??` an explicit `null`
    // would read as "not provided" and the stored value would survive - an
    // un-dismiss request that returns 200 and changes nothing.
    it('dismissedAt: null deletes ONLY that field, leaving the others', async () => {
      const current = {
        welcomeSeenAt: SEEN,
        dismissedAt: DISMISSED,
        adminDismissedAt: ADMIN_DISMISSED,
        skipped: ['configure_oauth'],
      };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { dismissedAt: null } },
      );

      expect(result.onboarding).toEqual({
        welcomeSeenAt: SEEN,
        adminDismissedAt: ADMIN_DISMISSED,
        skipped: ['configure_oauth'],
      });
    });

    it('adminDismissedAt: null does not disturb dismissedAt - the two surfaces are separate', async () => {
      const current = {
        dismissedAt: DISMISSED,
        adminDismissedAt: ADMIN_DISMISSED,
      };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { adminDismissedAt: null } },
      );

      expect(result.onboarding).toEqual({ dismissedAt: DISMISSED });
    });

    it('skipped is REPLACED wholesale when present - it is one list, not a set of independent keys', async () => {
      const current = { skipped: ['configure_oauth', 'invite_users'] };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { skipped: ['add_ai_key'] } },
      );

      expect(result.onboarding).toEqual({ skipped: ['add_ai_key'] });
    });

    it('skipped: null deletes the list, leaving the timestamps', async () => {
      const current = { welcomeSeenAt: SEEN, skipped: ['configure_oauth'] };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { skipped: null } },
      );

      expect(result.onboarding).toEqual({ welcomeSeenAt: SEEN });
    });

    // "Has skipped nothing" and "has never skipped anything" are the same
    // fact; storing `[]` would be a second spelling of it for the read path to
    // disagree with.
    it('an empty skipped array is normalised to absent rather than stored as []', async () => {
      const current = { welcomeSeenAt: SEEN, skipped: ['configure_oauth'] };

      const result = await patchOn(
        { onboarding: current },
        { onboarding: { skipped: [] } },
      );

      expect(result.onboarding).toEqual({ welcomeSeenAt: SEEN });
      expect(result.onboarding).not.toHaveProperty('skipped');
    });

    it('onboarding: null clears the whole namespace, restoring "never onboarded"', async () => {
      const result = await patchOn(
        { onboarding: { welcomeSeenAt: SEEN, dismissedAt: DISMISSED } },
        { onboarding: null },
      );

      expect('onboarding' in result).toBe(false);
    });

    it('emptying the namespace collapses it back to absent, not {}', async () => {
      const result = await patchOn(
        { onboarding: { welcomeSeenAt: SEEN } },
        { onboarding: { welcomeSeenAt: null } },
      );

      expect('onboarding' in result).toBe(false);
    });

    it('a patch of only nulls against an absent namespace stays absent', async () => {
      const result = await patchOn(
        {},
        { onboarding: { welcomeSeenAt: null, skipped: null } },
      );

      expect('onboarding' in result).toBe(false);
    });

    it('does not mutate the stored value it read', async () => {
      const current = { welcomeSeenAt: SEEN, dismissedAt: DISMISSED };

      await patchOn({ onboarding: current }, { onboarding: { dismissedAt: null } });

      expect(current).toEqual({ welcomeSeenAt: SEEN, dismissedAt: DISMISSED });
    });
  });

  // ===========================================================================
  // notifications namespace merge logic (issue #126, epic #109)
  // ===========================================================================
  //
  // The load-bearing difference from dataTables: a channel's preferences are
  // DEEP-MERGED per event key, not replaced wholesale. A wholesale replace here
  // would be a regression (it would silently re-enable mail a user had already
  // turned off on every unrelated toggle).

  describe('notifications namespace merge', () => {
    it('a patch that omits the namespace leaves it untouched', async () => {
      const current = { email: { 'user.welcome': false } };

      const result = await patchOn({ notifications: current }, { theme: 'dark' });

      expect(result.notifications).toEqual(current);
    });

    it('setting one key writes only that key - other channels and events remain absent', async () => {
      const result = await patchOn(
        {},
        { notifications: { email: { 'user.welcome': false } } },
      );

      expect(result.notifications).toEqual({ email: { 'user.welcome': false } });
      expect(result.notifications).not.toHaveProperty('browser');
    });

    it("{ email: { 'user.welcome': null } } deletes that key, leaving sibling event keys on the same channel untouched", async () => {
      const current = {
        email: { 'user.welcome': false, 'security.role_changed': true },
      };

      const result = await patchOn(
        { notifications: current },
        { notifications: { email: { 'user.welcome': null } } },
      );

      expect(result.notifications).toEqual({
        email: { 'security.role_changed': true },
      });
    });

    it('deleting the last key in a channel removes the channel entirely, not {}', async () => {
      const current = {
        email: { 'user.welcome': false },
        browser: { 'security.role_changed': true },
      };

      const result = await patchOn(
        { notifications: current },
        { notifications: { email: { 'user.welcome': null } } },
      );

      expect(result.notifications).toEqual({
        browser: { 'security.role_changed': true },
      });
      expect(result.notifications).not.toHaveProperty('email');
    });

    it('deleting the last key in the whole namespace collapses it to absent, not {}', async () => {
      const result = await patchOn(
        { notifications: { email: { 'user.welcome': false } } },
        { notifications: { email: { 'user.welcome': null } } },
      );

      expect('notifications' in result).toBe(false);
    });

    it('{ email: null } clears one channel, leaving other channels untouched', async () => {
      const current = {
        email: { 'user.welcome': false },
        browser: { 'security.role_changed': true },
      };

      const result = await patchOn(
        { notifications: current },
        { notifications: { email: null } },
      );

      expect(result.notifications).toEqual({
        browser: { 'security.role_changed': true },
      });
    });

    it('notifications: null clears the whole namespace', async () => {
      const result = await patchOn(
        { notifications: { email: { 'user.welcome': false } } },
        { notifications: null },
      );

      expect('notifications' in result).toBe(false);
    });

    // THE DIVERGENCE FROM dataTables. A data table entry is replaced wholesale
    // because it is one coherent view state; a channel's preferences are the
    // opposite - a row of INDEPENDENT per-event choices - so setting one key
    // must never disturb another already stored on the same channel. Modelled
    // as two separate PATCHes because that is the actual shape #126's UI
    // produces: one PATCH per toggle.
    it('a channel is deep-merged per event across two separate PATCHes, not replaced wholesale', async () => {
      const first = await patchOn(
        {},
        { notifications: { email: { 'user.welcome': false } } },
      );

      expect(first.notifications).toEqual({ email: { 'user.welcome': false } });

      // Second, independent PATCH - a different key on the SAME channel,
      // on top of what the first one stored.
      const second = await patchOn(
        { notifications: first.notifications },
        { notifications: { email: { 'security.role_changed': false } } },
      );

      // Both keys survive - a wholesale replace would have dropped the first.
      expect(second.notifications).toEqual({
        email: { 'user.welcome': false, 'security.role_changed': false },
      });
    });

    // The merge copies the stored namespace ONE LEVEL DEEP before mutating,
    // because a shallow `{ ...current }` would still share each per-channel
    // object by reference, and `delete` on the copy would then mutate the
    // caller's stored value in place.
    it('does not mutate the stored value it read - the per-channel object is copied before delete', async () => {
      const current = {
        email: { 'user.welcome': false, 'security.role_changed': true },
      };
      const originalEmailRef = current.email;

      const result = await patchOn(
        { notifications: current },
        { notifications: { email: { 'user.welcome': null } } },
      );

      expect(current.email).toBe(originalEmailRef);
      expect(current.email).toEqual({
        'user.welcome': false,
        'security.role_changed': true,
      });
      // What was written is a DIFFERENT object from the one that was read.
      expect(result.notifications.email).not.toBe(originalEmailRef);
      expect(result.notifications).toEqual({
        email: { 'security.role_changed': true },
      });
    });

    // A stored preference disabling a mandatory event is accepted by the merge
    // without complaint - `mandatory` is enforced only at read time by the
    // dispatcher's resolver (#125), never here.
    it('stores a false preference for a mandatory event key without complaint - it is simply never consulted here', async () => {
      const result = await patchOn(
        {},
        { notifications: { email: { 'security.role_changed': false } } },
      );

      expect(result.notifications).toEqual({
        email: { 'security.role_changed': false },
      });
    });
  });

  describe('dataTables cap (checked against the merged result)', () => {
    function buildTables(count: number): Record<string, {}> {
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`table${i}`, {}]),
      );
    }

    it('accepts exactly the cap (40 entries) on PATCH', async () => {
      const result = await patchOn({}, { dataTables: buildTables(40) });

      expect(Object.keys(result.dataTables)).toHaveLength(40);
    });

    it('accepts exactly the cap (40 entries) on PUT', async () => {
      stored({});
      const captured = captureUpsertedValue();

      await service.replaceSettings(mockUserId, {
        theme: 'light',
        profile: { imageSource: 'provider' },
        dataTables: buildTables(40),
      } as any);

      expect(Object.keys(captured.value.dataTables)).toHaveLength(40);
    });

    it('answers 400 - not a ZodError/500 - when the cap is exceeded', async () => {
      stored({});
      captureStoredValue();

      await expect(
        service.patchSettings(mockUserId, {
          dataTables: buildTables(41),
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // This is the scenario the cap actually exists for: the REQUEST BODY
    // alone is under the cap, but merging it on top of what is already
    // stored pushes the total over. The check therefore has to run on the
    // service's merged result, not on the incoming DTO.
    it('fires on the PATCH path: a 3-entry patch on top of 39 stored entries exceeds the cap', async () => {
      stored({ dataTables: buildTables(39) });

      const patch = {
        dataTables: { newtable0: {}, newtable1: {}, newtable2: {} },
      };

      await expect(
        service.patchSettings(mockUserId, patch as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The 400 must be raised before any write is attempted.
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('fires on the PUT path too', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'light',
        profile: { imageSource: 'provider' },
        dataTables: buildTables(41),
      };

      await expect(
        service.replaceSettings(mockUserId, newSettings),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockPrisma.userSettings.upsert).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // notifications namespace cap enforcement (issue #126, epic #109)
  // ===========================================================================
  //
  // Same rationale as the dataTables cap above: the event key level of
  // `notifications` is an OPEN map (see the schema file's header on why event
  // keys are not validated against the registry), so without a cap a user can
  // inflate their own row without limit. Enforced PER CHANNEL, since the
  // channel level is closed by the enum and therefore already bounded.

  describe('notifications cap (checked against the merged result)', () => {
    function buildEvents(count: number): Record<string, boolean> {
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`area.event${i}`, true]),
      );
    }

    it('accepts exactly the cap (100 events for one channel)', async () => {
      const result = await patchOn(
        {},
        { notifications: { email: buildEvents(100) } },
      );

      expect(Object.keys(result.notifications.email)).toHaveLength(100);
    });

    it('answers 400 - not a ZodError/500 - when one channel exceeds the cap', async () => {
      stored({});

      await expect(
        service.patchSettings(mockUserId, {
          notifications: { email: buildEvents(101) },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checks each channel independently - one channel over the cap is refused even while another stays small', async () => {
      stored({});

      await expect(
        service.patchSettings(mockUserId, {
          notifications: { email: buildEvents(101), browser: buildEvents(1) },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Issue #228 (epic #215) widened NOTIFICATION_CHANNELS from 2 members
    // (email, browser) to 3 (adding push), which moves the EFFECTIVE ceiling
    // on a user's total persisted notification preferences from 200 (100 x 2)
    // to 300 (100 x 3). That is not a bug: the cap has no aggregate/total
    // check anywhere - it is enforced PER CHANNEL and never sums across
    // channels - so a third channel simply adds its own independent 100-item
    // budget rather than eating into a shared one. This test pins that
    // behaviour down: every channel sitting exactly at the per-channel cap
    // simultaneously (300 preferences total) must be accepted.
    it('has no aggregate cap across channels - all three channels at the 100 cap simultaneously (300 total) is accepted', async () => {
      const result = await patchOn(
        {},
        {
          notifications: {
            email: buildEvents(100),
            browser: buildEvents(100),
            push: buildEvents(100),
          },
        },
      );

      expect(Object.keys(result.notifications)).toEqual([
        'email',
        'browser',
        'push',
      ]);
    });

    // Same scenario as the dataTables PATCH test: the REQUEST BODY alone is
    // under the cap, but merging it on top of what is already stored pushes
    // the channel's total over, so the check has to run on the MERGED result
    // rather than the incoming DTO.
    it('fires on the PATCH path: a 2-key patch on top of 99 stored email preferences exceeds the cap', async () => {
      stored({ notifications: { email: buildEvents(99) } });

      const patch = {
        notifications: { email: { 'new.event1': true, 'new.event2': true } },
      };

      await expect(
        service.patchSettings(mockUserId, patch as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The 400 must be raised before any write is attempted.
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('fires on the PUT path too', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'light',
        profile: { imageSource: 'provider' },
        notifications: { email: buildEvents(101) },
      };

      await expect(
        service.replaceSettings(mockUserId, newSettings),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockPrisma.userSettings.upsert).not.toHaveBeenCalled();
    });
  });


  describe('toResponse (private, exercised via getSettings)', () => {
    it('omits dataTables and navigation from the response body when absent, rather than emitting them as undefined', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any, // DEFAULT_USER_SETTINGS has neither namespace
      );

      const result = await service.getSettings(mockUserId);

      expect(Object.prototype.hasOwnProperty.call(result, 'dataTables')).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(result, 'navigation')).toBe(
        false,
      );
      // `'notifications' in result`, not a truthiness check on
      // `result.notifications` - `{}` and absent are two different states
      // (see the notifications merge), so the assertion has to distinguish them
      // too, not just accept `undefined` either way.
      expect('notifications' in result).toBe(false);
      // The same distinction, and the one the whole of epic #271 reads: a
      // never-written user must have NO `onboarding` key at all, because that
      // absence is what means "has never been onboarded". An emitted `{}`
      // would say the opposite of nothing.
      expect('onboarding' in result).toBe(false);
    });

    it('includes dataTables, navigation and notifications in the response body when present', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          dataTables: { jobs: { pageSize: 25 } },
          navigation: { railCollapsed: true },
          notifications: { email: { 'user.welcome': false } },
          onboarding: { welcomeSeenAt: '2026-09-17T10:00:00.000Z' },
        } as any,
      } as any);

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        dataTables: { jobs: { pageSize: 25 } },
        navigation: { railCollapsed: true },
        notifications: { email: { 'user.welcome': false } },
        onboarding: { welcomeSeenAt: '2026-09-17T10:00:00.000Z' },
      });
    });
  });

  // ===========================================================================
  // Full PATCH round trip through the namespace-collapse rule (issue #126)
  // ===========================================================================
  //
  // The merge cases above prove an emptied notifications namespace is left out
  // of the stored value. This test pins the same thing on the full-object
  // collapse: `patchSettings` only assigns a namespace when its merge produced
  // something (see the `mergedNamespace !== undefined` guard), so an emptied one
  // must be genuinely ABSENT from what is written to Prisma - not merely
  // falsy, and not `{}`, which the read path treats as a different state.
  describe('notifications: full-object collapse on the PATCH path (issue #126)', () => {
    it("deleting the last key in the namespace removes 'notifications' entirely from the stored value", async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          notifications: { email: { 'user.welcome': false } },
        } as any,
      } as any);

      let storedValue: any;
      (mockPrisma.userSettings.update as any).mockImplementation(async ({ data }: any) => {
        storedValue = data.value;
        return { ...mockUserSettings, value: data.value, version: 2 };
      });
      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.patchSettings(mockUserId, {
        notifications: { email: { 'user.welcome': null } },
      } as any);

      expect('notifications' in storedValue).toBe(false);
    });
  });

  // ===========================================================================
  // onboarding on the full PATCH path (issue #272, epic #271)
  // ===========================================================================
  //
  // The onboarding merge cases above cover the merge rules. These cover the
  // rest of `patchSettings`, which is where the namespace has to survive the
  // step the merge cannot see: `userSettingsSchema.parse(merged)`. That call
  // silently STRIPS any key the canonical schema does not declare, so a
  // namespace wired into the merge but missing from the schema would pass every
  // merge test above and still persist nothing. These cases assert against what
  // actually reached Prisma.
  describe('onboarding on the PATCH path (issue #272)', () => {
    const SEEN = '2026-09-17T10:00:00.000Z';
    const DISMISSED = '2026-09-17T11:00:00.000Z';

    function captureStoredValue() {
      const captured: { value?: any } = {};
      (mockPrisma.userSettings.update as any).mockImplementation(
        async ({ data }: any) => {
          captured.value = data.value;
          return { ...mockUserSettings, value: data.value, version: 2 };
        },
      );
      mockPrisma.user.update.mockResolvedValue({} as any);
      return captured;
    }

    it('persists and returns onboarding.welcomeSeenAt, with the version incremented', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
        } as any,
        version: 1,
      } as any);

      const captured = captureStoredValue();

      const result = await service.patchSettings(mockUserId, {
        onboarding: { welcomeSeenAt: SEEN },
      } as any);

      // Survived the post-merge `parse` rather than being stripped by it.
      expect(captured.value.onboarding).toEqual({ welcomeSeenAt: SEEN });
      expect(result).toMatchObject({
        onboarding: { welcomeSeenAt: SEEN },
        version: 2,
      });
      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: { increment: 1 } }),
        }),
      );
    });

    it('clears one field with null and leaves the others stored', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          onboarding: {
            welcomeSeenAt: SEEN,
            dismissedAt: DISMISSED,
            skipped: ['configure_oauth'],
          },
        } as any,
      } as any);

      const captured = captureStoredValue();

      const result = await service.patchSettings(mockUserId, {
        onboarding: { dismissedAt: null },
      } as any);

      expect(captured.value.onboarding).toEqual({
        welcomeSeenAt: SEEN,
        skipped: ['configure_oauth'],
      });
      expect(result.onboarding).not.toHaveProperty('dismissedAt');
    });

    it("emptying the namespace removes 'onboarding' entirely from the stored value", async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          onboarding: { welcomeSeenAt: SEEN },
        } as any,
      } as any);

      const captured = captureStoredValue();

      const result = await service.patchSettings(mockUserId, {
        onboarding: { welcomeSeenAt: null },
      } as any);

      // Absent, not `{}` - the state the epic reads as "never onboarded".
      expect('onboarding' in captured.value).toBe(false);
      expect('onboarding' in result).toBe(false);
    });

    it('onboarding: null clears the namespace outright', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          onboarding: { welcomeSeenAt: SEEN, dismissedAt: DISMISSED },
        } as any,
      } as any);

      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        onboarding: null,
      } as any);

      expect('onboarding' in captured.value).toBe(false);
    });

    it('an unrelated PATCH leaves a stored onboarding namespace untouched', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          onboarding: { welcomeSeenAt: SEEN, skipped: ['configure_oauth'] },
        } as any,
      } as any);

      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, { theme: 'dark' } as any);

      expect(captured.value.onboarding).toEqual({
        welcomeSeenAt: SEEN,
        skipped: ['configure_oauth'],
      });
    });
  });
  // ===========================================================================
  // graph namespace (issue #369, epic #346; declared in the graph module, #459)
  // ===========================================================================
  //
  // Driven through the whole of `patchSettings`/`replaceSettings`, asserting
  // against what reached Prisma - the post-merge `userSettingsSchema.parse`
  // would silently strip a namespace the composed schema forgot. This service
  // knows `graph` only as a key the registry hands it; its `graph.preferences_
  // changed` emission is the graph module's forwarder's job and is specified in
  // `graph/preferences/graph-preferences-change.forwarder.spec.ts`.
  describe('graph preferences namespace (issue #369)', () => {
    const DEFAULT_RESOLUTION = {
      mode: 'precheck_confident',
      autoLinkThreshold: 0.9,
      newThreshold: 0.55,
      adjudication: 'llm',
    };

    it('persists a single threshold, filling the rest of the sub-object from defaults', async () => {
      stored({});
      const captured = captureStoredValue();

      const result = await service.patchSettings(mockUserId, {
        graph: { resolution: { autoLinkThreshold: 0.93 } },
      } as any);

      expect(captured.value.graph).toEqual({
        resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.93 },
      });
      expect(result.graph).toEqual(captured.value.graph);
    });

    it('deep-merges per sub-object, leaving the others untouched', async () => {
      stored({
        graph: {
          extraction: { autoExtract: false },
          resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.95 },
        },
      });
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { resolution: { mode: 'review_all' }, domains: { work: false } },
      } as any);

      expect(captured.value.graph).toEqual({
        extraction: { autoExtract: false },
        resolution: {
          ...DEFAULT_RESOLUTION,
          autoLinkThreshold: 0.95,
          mode: 'review_all',
        },
        domains: { work: false, personal: false },
      });
    });

    it('a null field restores that field\'s default', async () => {
      stored({
        graph: {
          resolution: { ...DEFAULT_RESOLUTION, mode: 'review_all', adjudication: 'off' },
        },
      });
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { resolution: { adjudication: null } },
      } as any);

      expect(captured.value.graph.resolution).toEqual({
        ...DEFAULT_RESOLUTION,
        mode: 'review_all',
      });
    });

    it('`resolution: null` resets the sub-object; an emptied namespace is removed', async () => {
      stored({
        graph: { resolution: { ...DEFAULT_RESOLUTION, autoLinkThreshold: 0.93 } },
      });
      const captured = captureStoredValue();

      const result = await service.patchSettings(mockUserId, {
        graph: { resolution: null },
      } as any);

      expect('graph' in captured.value).toBe(false);
      expect('graph' in result).toBe(false);
    });

    it('`graph: null` deletes the whole namespace', async () => {
      stored({
        graph: {
          extraction: { autoExtract: false },
          domains: { work: false, personal: false },
        },
      });
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, { graph: null } as any);

      expect('graph' in captured.value).toBe(false);
    });

    it('an unrelated PATCH leaves the stored graph namespace alone and announces no change', async () => {
      const graph = { extraction: { autoExtract: false } };
      stored({ graph });
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, { theme: 'dark' } as any);

      expect(captured.value.graph).toEqual(graph);
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('refuses with 400 a merge whose thresholds end up too close together', async () => {
      stored({
        graph: { resolution: { ...DEFAULT_RESOLUTION, newThreshold: 0.8 } },
      });
      captureStoredValue();

      await expect(
        service.patchSettings(mockUserId, {
          graph: { resolution: { autoLinkThreshold: 0.82 } },
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('keeps the 400 message for crossed thresholds', async () => {
      stored({});
      captureStoredValue();

      await expect(
        service.patchSettings(mockUserId, {
          graph: { resolution: { autoLinkThreshold: 0.8, newThreshold: 0.8 } },
        } as any),
      ).rejects.toThrow(
        'graph.resolution: newThreshold must be at least 0.05 below autoLinkThreshold (would store newThreshold 0.8, autoLinkThreshold 0.8).',
      );
    });

    it('accepts the exact 0.05 boundary despite floating-point subtraction', async () => {
      stored({});
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { resolution: { autoLinkThreshold: 0.9, newThreshold: 0.85 } },
      } as any);

      expect(captured.value.graph.resolution.newThreshold).toBe(0.85);
    });

    it('merges domains.personal like work: true enables it, null restores the default (#383)', async () => {
      stored({ graph: { domains: { work: false, personal: false } } });
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { domains: { personal: true } },
      } as any);

      expect(captured.value.graph.domains).toEqual({ work: false, personal: true });

      stored({ graph: { domains: { work: true, personal: true } } });
      const again = captureStoredValue();
      await service.patchSettings(mockUserId, {
        graph: { domains: { personal: null } },
      } as any);
      expect(again.value.graph.domains).toEqual({ work: true, personal: false });
    });

    it('turning personal on from an absent namespace keeps work at its default', async () => {
      stored({});
      const captured = captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { domains: { personal: true } },
      } as any);

      expect(captured.value.graph).toEqual({ domains: { work: true, personal: true } });
    });

    it('PUT stores the namespace', async () => {
      stored({ graph: { extraction: { autoExtract: false } } });
      captureUpsertedValue();

      const result = await service.replaceSettings(mockUserId, {
        theme: 'system',
        profile: { imageSource: 'provider' },
        graph: { domains: { work: false, personal: false } },
      } as any);

      expect(result.graph).toEqual({ domains: { work: false, personal: false } });
    });
  });

  // ===========================================================================
  // user-settings.namespace-changed (issue #459)
  // ===========================================================================
  //
  // The service no longer knows what any namespace means. After a successful
  // PUT or PATCH it announces ONCE per registered namespace whose stored value
  // changed (compared on `JSON.stringify` before and after), and subscribers
  // (the graph module's forwarder) decide whether the change matters to them.
  describe('namespace change event', () => {
    const emitted = () =>
      mockEvents.emit.mock.calls.map(([name, payload]) => ({ name, payload }));

    it('PATCH emits once for the namespace it changed, carrying the stored before and after', async () => {
      stored({ navigation: { railCollapsed: false } });
      captureStoredValue();

      await service.patchSettings(mockUserId, {
        navigation: { railCollapsed: true },
      } as any);

      expect(emitted()).toEqual([
        {
          name: USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
          payload: {
            userId: mockUserId,
            key: 'navigation',
            previous: { railCollapsed: false },
            next: { railCollapsed: true },
          },
        },
      ]);
    });

    it('announces a namespace that was absent as previous: undefined', async () => {
      stored({});
      captureStoredValue();

      await service.patchSettings(mockUserId, {
        graph: { extraction: { autoExtract: false } },
      } as any);

      expect(emitted()).toHaveLength(1);
      expect(emitted()[0].payload).toEqual({
        userId: mockUserId,
        key: 'graph',
        previous: undefined,
        next: { extraction: { autoExtract: false } },
      });
    });

    it('announces a cleared namespace as next: undefined', async () => {
      stored({ navigation: { railCollapsed: true } });
      captureStoredValue();

      await service.patchSettings(mockUserId, { navigation: null } as any);

      expect(emitted()).toHaveLength(1);
      expect(emitted()[0].payload).toMatchObject({
        key: 'navigation',
        previous: { railCollapsed: true },
        next: undefined,
      });
    });

    it('emits once per changed namespace, in registration order, and not for the untouched ones', async () => {
      stored({ navigation: { railCollapsed: true } });
      captureStoredValue();

      await service.patchSettings(mockUserId, {
        // Deliberately listed out of registration order.
        graph: { extraction: { autoExtract: false } },
        dataTables: { jobs: { pageSize: 25 } },
      } as any);

      expect(emitted().map((e) => e.name)).toEqual([
        USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
        USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
      ]);
      expect(emitted().map((e: any) => e.payload.key)).toEqual([
        'dataTables',
        'graph',
      ]);
    });

    it('emits nothing for a PATCH that changes no namespace (a theme toggle)', async () => {
      stored({ navigation: { railCollapsed: true } });
      captureStoredValue();

      await service.patchSettings(mockUserId, { theme: 'dark' } as any);

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('emits nothing when a PATCH restates the stored value', async () => {
      stored({ navigation: { railCollapsed: true } });
      captureStoredValue();

      await service.patchSettings(mockUserId, {
        navigation: { railCollapsed: true },
      } as any);

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('PUT emits for each namespace it changes, including one it drops', async () => {
      stored({
        navigation: { railCollapsed: true },
        graph: { extraction: { autoExtract: false } },
      });
      captureUpsertedValue();

      await service.replaceSettings(mockUserId, {
        theme: 'system',
        profile: { imageSource: 'provider' },
        graph: { domains: { work: false, personal: false } },
      } as any);

      expect(emitted().map((e: any) => e.payload.key)).toEqual([
        'navigation',
        'graph',
      ]);
      expect(emitted()[0].payload).toMatchObject({
        previous: { railCollapsed: true },
        next: undefined,
      });
    });

    it('PUT emits nothing when it restates the stored namespaces', async () => {
      stored({ navigation: { railCollapsed: true } });
      captureUpsertedValue();

      await service.replaceSettings(mockUserId, {
        theme: 'system',
        profile: { imageSource: 'provider' },
        navigation: { railCollapsed: true },
      } as any);

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('emits only after the write succeeded: a refused write announces nothing', async () => {
      stored({});

      await expect(
        service.patchSettings(mockUserId, {
          graph: { resolution: { autoLinkThreshold: 0.8, newThreshold: 0.8 } },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('a throwing listener does not fail the write', async () => {
      stored({});
      captureStoredValue();
      mockEvents.emit.mockImplementation(() => {
        throw new Error('listener boom');
      });

      await expect(
        service.patchSettings(mockUserId, {
          graph: { extraction: { autoExtract: false } },
        } as any),
      ).resolves.toMatchObject({ graph: { extraction: { autoExtract: false } } });
    });
  });
});
