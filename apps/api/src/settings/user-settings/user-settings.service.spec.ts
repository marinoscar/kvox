import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { UserSettingsService } from './user-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
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
  // dataTables / navigation namespace merge logic (JSON Merge Patch semantics)
  // ===========================================================================
  //
  // mergeDataTables, mergeNavigation and assertDataTableLimit are private -
  // reached here via `(service as any)` rather than by adding a public export,
  // since their contract is an internal implementation detail of PATCH
  // semantics, not part of the service's public surface.

  describe('mergeDataTables (private)', () => {
    const mergeDataTables = (current: unknown, patch: unknown) =>
      (service as any).mergeDataTables(current, patch);

    it('patch absent leaves the namespace untouched', () => {
      const current = { jobs: { density: 'compact' as const } };

      expect(mergeDataTables(current, undefined)).toEqual(current);
    });

    it('a non-null entry REPLACES the stored entry wholesale, leaving other entries untouched', () => {
      const current = {
        jobs: { density: 'compact' as const, pageSize: 10 },
        users: { pageSize: 50 },
      };

      const result = mergeDataTables(current, { jobs: { pageSize: 25 } });

      // The previously stored `density` for jobs is gone - not deep-merged.
      expect(result.jobs).toEqual({ pageSize: 25 });
      expect(result.jobs).not.toHaveProperty('density');
      // The `users` entry was never touched.
      expect(result.users).toEqual({ pageSize: 50 });
    });

    it('{ jobs: null } deletes only the jobs entry, leaving other entries untouched', () => {
      const current = {
        jobs: { pageSize: 10 },
        users: { pageSize: 50 },
      };

      const result = mergeDataTables(current, { jobs: null });

      expect(result).toEqual({ users: { pageSize: 50 } });
    });

    it('dataTables: null clears the whole namespace', () => {
      const current = {
        jobs: { pageSize: 10 },
        users: { pageSize: 50 },
      };

      expect(mergeDataTables(current, null)).toBeUndefined();
    });

    it('emptying the last entry collapses the namespace back to absent (undefined), not {}', () => {
      const current = { jobs: { pageSize: 10 } };

      const result = mergeDataTables(current, { jobs: null });

      expect(result).toBeUndefined();
    });
  });

  describe('mergeNavigation (private)', () => {
    const mergeNavigation = (current: unknown, patch: unknown) =>
      (service as any).mergeNavigation(current, patch);

    it('patch absent leaves the namespace untouched', () => {
      const current = { railCollapsed: true };

      expect(mergeNavigation(current, undefined)).toEqual(current);
    });

    it('an omitted field is left untouched', () => {
      const current = { railCollapsed: true };

      expect(mergeNavigation(current, {})).toEqual({ railCollapsed: true });
    });

    it('a listed field is replaced', () => {
      const current = { railCollapsed: true };

      expect(mergeNavigation(current, { railCollapsed: false })).toEqual({
        railCollapsed: false,
      });
    });

    it('railCollapsed: null deletes the field', () => {
      const current = { railCollapsed: true };

      expect(
        mergeNavigation(current, { railCollapsed: null }),
      ).toBeUndefined();
    });

    it('navigation: null clears the whole namespace', () => {
      const current = { railCollapsed: true };

      expect(mergeNavigation(current, null)).toBeUndefined();
    });

    it('emptying the namespace collapses it back to absent (undefined), not {}', () => {
      const result = mergeNavigation(undefined, { railCollapsed: null });

      expect(result).toBeUndefined();
    });
  });

  // ===========================================================================
  // notifications namespace merge logic (issue #126, epic #109)
  // ===========================================================================
  //
  // mergeNotifications is private for the same reason mergeDataTables and
  // mergeNavigation are - reached here via `(service as any)` rather than a
  // public export, since PATCH merge semantics are an implementation detail,
  // not part of the service's public surface.
  //
  // The load-bearing difference from mergeDataTables: a channel's preferences
  // are DEEP-MERGED per event key, not replaced wholesale. See the extensive
  // comment on mergeNotifications itself for why a wholesale replace here
  // would be a regression (it would silently re-enable mail a user had
  // already turned off on every unrelated toggle).

  describe('mergeNotifications (private)', () => {
    const mergeNotifications = (current: unknown, patch: unknown) =>
      (service as any).mergeNotifications(current, patch);

    it('patch absent leaves the namespace untouched', () => {
      const current = { email: { 'user.welcome': false } };

      expect(mergeNotifications(current, undefined)).toEqual(current);
    });

    it('setting one key writes only that key - other channels and events remain absent', () => {
      const result = mergeNotifications(undefined, {
        email: { 'user.welcome': false },
      });

      expect(result).toEqual({ email: { 'user.welcome': false } });
      expect(result).not.toHaveProperty('browser');
    });

    it("{ email: { 'user.welcome': null } } deletes that key, leaving sibling event keys on the same channel untouched", () => {
      const current = {
        email: { 'user.welcome': false, 'security.role_changed': true },
      };

      const result = mergeNotifications(current, {
        email: { 'user.welcome': null },
      });

      expect(result).toEqual({ email: { 'security.role_changed': true } });
    });

    it('deleting the last key in a channel removes the channel entirely, not {}', () => {
      const current = {
        email: { 'user.welcome': false },
        browser: { 'security.role_changed': true },
      };

      const result = mergeNotifications(current, {
        email: { 'user.welcome': null },
      });

      expect(result).toEqual({ browser: { 'security.role_changed': true } });
      expect(result).not.toHaveProperty('email');
    });

    it('deleting the last key in the whole namespace collapses the result to undefined, not {}', () => {
      const current = { email: { 'user.welcome': false } };

      const result = mergeNotifications(current, {
        email: { 'user.welcome': null },
      });

      expect(result).toBeUndefined();
    });

    it('{ email: null } clears one channel, leaving other channels untouched', () => {
      const current = {
        email: { 'user.welcome': false },
        browser: { 'security.role_changed': true },
      };

      const result = mergeNotifications(current, { email: null });

      expect(result).toEqual({ browser: { 'security.role_changed': true } });
    });

    it('notifications: null clears the whole namespace', () => {
      const current = { email: { 'user.welcome': false } };

      expect(mergeNotifications(current, null)).toBeUndefined();
    });

    // THE DIVERGENCE FROM mergeDataTables. A data table entry is replaced
    // wholesale because it is one coherent view state; a channel's
    // preferences are the opposite - a row of INDEPENDENT per-event choices -
    // so setting one key must never disturb another already stored on the
    // same channel. Modelled as two separate PATCHes through the full
    // patchSettings flow (not two arguments to one merge call) because that
    // is the actual shape #126's UI produces: one PATCH per toggle.
    it('a channel is deep-merged per event across two separate PATCHes, not replaced wholesale', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
        } as any,
      } as any);

      let storedValue: any;
      (mockPrisma.userSettings.update as any).mockImplementationOnce(async ({ data }: any) => {
        storedValue = data.value;
        return { ...mockUserSettings, value: data.value, version: 2 };
      });
      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.patchSettings(mockUserId, {
        notifications: { email: { 'user.welcome': false } },
      } as any);

      expect(storedValue.notifications).toEqual({
        email: { 'user.welcome': false },
      });

      // Second, independent PATCH - a different key on the SAME channel.
      mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
        ...mockUserSettings,
        value: storedValue,
      } as any);
      (mockPrisma.userSettings.update as any).mockImplementationOnce(async ({ data }: any) => {
        storedValue = data.value;
        return { ...mockUserSettings, value: data.value, version: 3 };
      });

      await service.patchSettings(mockUserId, {
        notifications: { email: { 'security.role_changed': false } },
      } as any);

      // Both keys survive - a wholesale replace would have dropped the first.
      expect(storedValue.notifications).toEqual({
        email: { 'user.welcome': false, 'security.role_changed': false },
      });
    });

    // The implementation copies the stored namespace ONE LEVEL DEEP before
    // mutating, precisely because a shallow `{ ...current }` would still
    // share each per-channel object by reference, and `delete` on the copy
    // would then mutate the caller's `current` in place.
    it('does not mutate the current value it read - the per-channel object is copied before delete', () => {
      const current = {
        email: { 'user.welcome': false, 'security.role_changed': true },
      };
      const originalEmailRef = current.email;

      const result = mergeNotifications(current, {
        email: { 'user.welcome': null },
      });

      // `current` itself, and specifically the object reference for its
      // `email` channel, must be exactly what was passed in.
      expect(current.email).toBe(originalEmailRef);
      expect(current.email).toEqual({
        'user.welcome': false,
        'security.role_changed': true,
      });
      // The result's `email` is a DIFFERENT object from the one that was read.
      expect(result.email).not.toBe(originalEmailRef);
      expect(result).toEqual({ email: { 'security.role_changed': true } });
    });

    // A stored preference disabling a mandatory event is accepted by the
    // merge without complaint - `mandatory` is enforced only at read time by
    // the dispatcher's resolver (#125), never here. See the extensive comment
    // on mergeNotifications ("`mandatory` IS NOT ENFORCED HERE, DELIBERATELY").
    it('merges a false preference for a mandatory event key without throwing - it is simply never consulted here', () => {
      const result = mergeNotifications(undefined, {
        email: { 'security.role_changed': false },
      });

      expect(result).toEqual({ email: { 'security.role_changed': false } });
    });
  });

  describe('assertDataTableLimit (private)', () => {
    const assertDataTableLimit = (dataTables: unknown) =>
      (service as any).assertDataTableLimit(dataTables);

    function buildTables(count: number): Record<string, {}> {
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`table${i}`, {}]),
      );
    }

    it('does not throw at exactly the cap (40 entries)', () => {
      expect(() => assertDataTableLimit(buildTables(40))).not.toThrow();
    });

    it('does not throw when dataTables is undefined', () => {
      expect(() => assertDataTableLimit(undefined)).not.toThrow();
    });

    it('throws BadRequestException (400) - not a ZodError/500 - when the cap is exceeded', () => {
      let caught: unknown;
      try {
        assertDataTableLimit(buildTables(41));
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
    });

    // This is the scenario the cap actually exists for: the REQUEST BODY
    // alone is under the cap, but merging it on top of what is already
    // stored pushes the total over. The check therefore has to run on the
    // service's merged result, not on the incoming DTO.
    it('fires on the PATCH path: a 3-entry patch on top of 39 stored entries exceeds the cap', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          dataTables: buildTables(39),
        } as any,
      } as any);

      const patch = {
        dataTables: {
          newtable0: {},
          newtable1: {},
          newtable2: {},
        },
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
  // Same rationale as assertDataTableLimit above: the event key level of
  // `notifications` is an OPEN map (see the schema file's header on why event
  // keys are not validated against the registry), so without a cap a user can
  // inflate their own row without limit. Enforced PER CHANNEL, since the
  // channel level is closed by the enum and therefore already bounded.

  describe('assertNotificationLimit (private)', () => {
    const assertNotificationLimit = (notifications: unknown) =>
      (service as any).assertNotificationLimit(notifications);

    function buildEvents(count: number): Record<string, boolean> {
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`area.event${i}`, true]),
      );
    }

    it('does not throw at exactly the cap (100 events for one channel)', () => {
      expect(() =>
        assertNotificationLimit({ email: buildEvents(100) }),
      ).not.toThrow();
    });

    it('does not throw when notifications is undefined', () => {
      expect(() => assertNotificationLimit(undefined)).not.toThrow();
    });

    it('throws BadRequestException (400) - not a ZodError/500 - when one channel exceeds the cap', () => {
      let caught: unknown;
      try {
        assertNotificationLimit({ email: buildEvents(101) });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
    });

    it('checks each channel independently - one channel over the cap throws even while another stays small', () => {
      expect(() =>
        assertNotificationLimit({
          email: buildEvents(101),
          browser: buildEvents(1),
        }),
      ).toThrow(BadRequestException);
    });

    // Issue #228 (epic #215) widened NOTIFICATION_CHANNELS from 2 members
    // (email, browser) to 3 (adding push), which moves the EFFECTIVE ceiling
    // on a user's total persisted notification preferences from 200 (100 x 2)
    // to 300 (100 x 3). That is not a bug: `assertNotificationLimit` has no
    // aggregate/total check anywhere - see the loop above, which enforces the
    // cap PER CHANNEL and never sums across channels - so a third channel
    // simply adds its own independent 100-item budget rather than eating into
    // a shared one. This test pins that behaviour down: every channel sitting
    // exactly at the per-channel cap simultaneously (300 preferences total)
    // must not throw.
    it('has no aggregate cap across channels - all three channels at the 100 cap simultaneously (300 total) does not throw', () => {
      expect(() =>
        assertNotificationLimit({
          email: buildEvents(100),
          browser: buildEvents(100),
          push: buildEvents(100),
        }),
      ).not.toThrow();
    });

    // Same scenario as assertDataTableLimit's PATCH test: the REQUEST BODY
    // alone is under the cap, but merging it on top of what is already stored
    // pushes the channel's total over, so the check has to run on the
    // service's MERGED result rather than the incoming DTO.
    it('fires on the PATCH path: a 2-key patch on top of 99 stored email preferences exceeds the cap', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: { imageSource: 'provider' },
          notifications: { email: buildEvents(99) },
        } as any,
      } as any);

      const patch = {
        notifications: {
          email: { 'new.event1': true, 'new.event2': true },
        },
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
      // (see mergeNotifications), so the assertion has to distinguish them
      // too, not just accept `undefined` either way.
      expect('notifications' in result).toBe(false);
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
        } as any,
      } as any);

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        dataTables: { jobs: { pageSize: 25 } },
        navigation: { railCollapsed: true },
        notifications: { email: { 'user.welcome': false } },
      });
    });
  });

  // ===========================================================================
  // Full PATCH round trip through the namespace-collapse rule (issue #126)
  // ===========================================================================
  //
  // The unit-level `mergeNotifications` tests above prove the private method
  // returns `undefined` when the last key is deleted. This test proves that
  // result actually reaches the PERSISTED value: `patchSettings` only assigns
  // `merged.notifications` when the merge produced something (see the
  // `if (mergedNotifications !== undefined)` guard), so an emptied namespace
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
});
