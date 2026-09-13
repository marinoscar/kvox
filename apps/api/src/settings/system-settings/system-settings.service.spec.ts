import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';
import { systemSettingsResponseSchema } from '../dto/system-settings-response.dto';

/**
 * The operations namespaces (#256, epic #254) with their defaults.
 *
 * Spread into the "exactly this value reached Prisma" assertions below rather
 * than written out in each of them. Every write path materialises these four
 * blocks — `readKnownSettings` fills them from `DEFAULT_SYSTEM_SETTINGS` for a
 * row that predates them, and the merge then writes them back — so what reaches
 * storage always carries all four, whatever the caller sent. Spreading keeps
 * each assertion about the one thing it was written to prove (unknown-key
 * preservation, audit meta, the closed-body rule) instead of restating
 * twenty-three defaults five times.
 */
const OPERATIONS_DEFAULTS = {
  jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
  nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
  databaseBackup: DEFAULT_SYSTEM_SETTINGS.databaseBackup,
  maintenance: DEFAULT_SYSTEM_SETTINGS.maintenance,
};

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let mockPrisma: MockPrismaService;
  let mockConfigService: { get: jest.Mock };

  const mockUserId = 'user-123';
  const mockUser = {
    id: mockUserId,
    email: 'admin@example.com',
  };

  const mockSystemSettings = {
    id: 'settings-1',
    key: 'global',
    value: DEFAULT_SYSTEM_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: mockUserId,
    updatedByUser: mockUser,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    // Pass-through by default: `get(key, defaultValue)` returns `defaultValue`,
    // which mirrors ConfigService's real behaviour when nothing overrides the
    // key. Individual #148 tests below replace this with a table of real
    // values to prove the security block is read FROM config, not hardcoded.
    mockConfigService = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<SystemSettingsService>(SystemSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return current system settings with version', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result).toMatchObject({
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(result.updatedBy).toEqual(mockUser);
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: { key: 'global' },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should create and return default settings when none exist', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUserId: null,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(result).toMatchObject({
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        version: 1,
      });
      expect(mockPrisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          key: 'global',
          value: DEFAULT_SYSTEM_SETTINGS as any,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace entire settings', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
        nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result).toMatchObject({
        jobs: newSettings.jobs,
        nodes: newSettings.nodes,
        version: 2,
      });
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'global' },
        update: {
          value: newSettings as any,
          updatedByUserId: mockUserId,
          version: { increment: 1 },
        },
        create: {
          key: 'global',
          value: newSettings as any,
          updatedByUserId: mockUserId,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 10 },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result.version).toBe(5);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on replace', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.replaceSettings(newSettings, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:replace',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: {
            newValue: newSettings,
          } as any,
        },
      });
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.nodes.jobSecretBrokerEnabled).toBe(true);
      expect(result.jobs).toEqual(DEFAULT_SYSTEM_SETTINGS.jobs);
    });

    it('should merge a nested jobs.history field, leaving its sibling untouched', async () => {
      const existingWithJobs = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            history: { retentionDays: 60, purgeEnabled: false },
            stuckThresholdMinutes: 30,
          },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        existingWithJobs as any,
      );

      const partialUpdate = {
        jobs: { stuckThresholdMinutes: 99 },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            history: { retentionDays: 60, purgeEnabled: false },
            stuckThresholdMinutes: 99,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.jobs).toEqual({
        history: { retentionDays: 60, purgeEnabled: false },
        stuckThresholdMinutes: 99,
      });
    });

    it('should throw ConflictException when If-Match version mismatch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(
        'Settings version mismatch. Expected 2, found 1',
      );

      // Should not call update when version mismatch
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when If-Match version matches', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        partialUpdate,
        mockUserId,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalled();
    });

    it('should increment version on patch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on patch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(partialUpdate, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:patch',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: expect.objectContaining({
            changes: partialUpdate,
            resultingValue: expect.any(Object),
          }) as any,
        },
      });
    });
  });

  // ===========================================================================
  // #130 — unknown keys in the 'global' row must survive a save.
  //
  // The rule pinned here: REQUEST BODIES STAY CLOSED; THE STORED VALUE IS
  // NEVER NARROWED. Two independent guarantees, tested separately on purpose
  // — proving only one would let a later change collapse them back together.
  //
  // `jobs`/`nodes` stand in as "a known namespace" throughout this section —
  // the same role `ui`/`features` played before #366 removed them — because
  // the point of every test here is the PRESERVATION MECHANISM, not any one
  // namespace's business meaning.
  // ===========================================================================
  describe('#130 unknown key preservation', () => {
    describe('the stored value is preserved (never narrowed)', () => {
      it('PATCH preserves an unknown top-level key while changing a known namespace', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                nodes: {
                  ...DEFAULT_SYSTEM_SETTINGS.nodes,
                  jobSecretBrokerEnabled: true,
                },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('PATCH preserves an unknown key nested under jobs (a closed nested object)', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: {
              ...DEFAULT_SYSTEM_SETTINGS.jobs,
              stuckThresholdMinutes: 10,
              extraKnob: 'legacy-value',
            },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { jobs: { stuckThresholdMinutes: 10 } },
          mockUserId,
        );

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                jobs: {
                  ...DEFAULT_SYSTEM_SETTINGS.jobs,
                  stuckThresholdMinutes: 10,
                  extraKnob: 'legacy-value',
                },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['jobs.extraKnob'],
              }),
            }),
          }),
        );
      });

      it('PUT preserves unknown stored keys while replacing the known ones', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: false },
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const expectedValue = {
          branding: { logoUrl: 'https://example.com/logo.png' },
          ...newSettings,
        };

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: expectedValue }),
            create: expect.objectContaining({ value: expectedValue }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('known keys still win the merge — jobs and nodes match the caller byte for byte', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 5 },
          legacyBlob: { untouched: 1 },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 120 },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            legacyBlob: storedValue.legacyBlob,
          } as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;

        // Known keys are the caller's validated values, byte for byte — not
        // the stale stored ones — while the unknown key still survives.
        expect(upsertArgs.update.value.jobs).toEqual(newSettings.jobs);
        expect(upsertArgs.update.value.jobs.stuckThresholdMinutes).toBe(120);
        expect(upsertArgs.update.value.legacyBlob).toEqual({ untouched: 1 });
      });

      it('PUT against a missing row writes exactly the validated body, with no preserved keys', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(null as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: newSettings as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: newSettings }),
            create: expect.objectContaining({ value: newSettings }),
          }),
        );

        // No preservedKeys entry at all — not even an empty array — matching
        // the "should create audit event on replace" contract above.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:replace',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: { newValue: newSettings } as any,
          },
        });
      });

      it.each([
        ['a non-object (string)', 'not-an-object' as unknown],
        ['null', null as unknown],
      ])(
        'PUT does not break the save when the stored value is %s',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            value: malformed,
          } as any);

          const newSettings: SystemSettingsValue = {
            ...DEFAULT_SYSTEM_SETTINGS,
            notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          };

          mockPrisma.systemSettings.upsert.mockResolvedValue({
            ...mockSystemSettings,
            value: newSettings as any,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          await expect(
            service.replaceSettings(newSettings, mockUserId),
          ).resolves.toBeDefined();

          expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({ value: newSettings }),
            }),
          );
        },
      );

      // Was a skipped repro ("BUG: PATCH throws on a null stored value
      // instead of tolerating it") written against the first #130 commit:
      // patchSettings dereferenced the RAW stored value directly —
      // `currentValue.ui.allowUserThemeOverride` and
      // `{ ...currentValue.features }` — to build `merged`, before
      // mergePreservingUnknown (and its defensive collectUnknownKeys guard)
      // ever ran. A malformed `system_settings.value` made PATCH throw an
      // unhandled TypeError instead of tolerating it. Fixed in a287737:
      // every read of the column now goes through the guarded
      // `readKnownSettings`/`asPlainObject` accessors, so this is now a
      // guarantee, not a defect — renamed and un-skipped accordingly.
      it.each([
        ['null', null as unknown],
        ['a string', 'not-an-object' as unknown],
        ['a number', 42 as unknown],
        ['an array', ['a', 'b'] as unknown],
      ])(
        'PATCH tolerates a stored value that is %s and falls back to defaults',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            ...mockSystemSettings,
            value: malformed as any,
          } as any);

          mockPrisma.systemSettings.update.mockResolvedValue({
            ...mockSystemSettings,
            value: {
              ...DEFAULT_SYSTEM_SETTINGS,
              nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            } as any,
            version: 2,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          const result = await service.patchSettings(
            { nodes: { jobSecretBrokerEnabled: true } },
            mockUserId,
          );

          expect(result).toBeDefined();
          expect(result.jobs).toEqual(DEFAULT_SYSTEM_SETTINGS.jobs);
          expect(result.nodes.jobSecretBrokerEnabled).toBe(true);

          // An array is an object to `typeof` — spreading one would write
          // `{'0':'a'}` into the row. Assert it does not.
          const updateArgs = mockPrisma.systemSettings.update.mock
            .calls[0][0] as any;
          expect(updateArgs.data.value).not.toHaveProperty('0');
          expect(updateArgs.data.value.nodes.jobSecretBrokerEnabled).toBe(true);
        },
      );
    });

    describe('a malformed stored value degrades field by field, not wholesale', () => {
      it('preserves a good nodes value when only jobs is malformed', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: 'garbage' as unknown,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { jobs: { stuckThresholdMinutes: 45 } },
          mockUserId,
        );

        // The malformed half (jobs) fell back to the default and then took
        // the caller's change; the good half (nodes) survived untouched.
        expect(result.jobs.stuckThresholdMinutes).toBe(45);
        expect(result.nodes).toEqual({
          ...DEFAULT_SYSTEM_SETTINGS.nodes,
          jobSecretBrokerEnabled: true,
        });
      });

      it('preserves a good jobs value when only nodes is malformed', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 20 },
          nodes: 'garbage' as unknown,
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 20 },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        // The good half (jobs) survived untouched — a whole-object fallback
        // would have silently discarded it along with the malformed
        // nodes value.
        expect(result.jobs.stuckThresholdMinutes).toBe(20);
        expect(result.nodes.jobSecretBrokerEnabled).toBe(true);
      });
    });

    describe('a partly malformed row still preserves unknown keys', () => {
      it('recovers top-level and jobs.* unknown keys from the raw row even when nodes is unusable', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
          nodes: 'garbage' as unknown,
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        // Preservation reads the RAW row, not the readKnownSettings
        // projection, so the unknown keys survive even though `nodes`
        // itself could not be parsed.
        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
                nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding', 'jobs.extraKnob'],
              }),
            }),
          }),
        );
      });
    });

    describe('the closed-body rule holds on the error path too', () => {
      it('an unknown key in the PATCH body never reaches storage when the stored value is malformed', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: null as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { jobSecretBrokerEnabled: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('request bodies stay closed', () => {
      it('an unknown key in a PUT body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: { ...DEFAULT_SYSTEM_SETTINGS },
        } as any);

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          evilKey: 'should not be stored',
        };

        await service.replaceSettings(dtoWithUnknownKey as any, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;
        // Assert on what was actually PERSISTED, not on the return value —
        // the point is that the write itself is clean.
        expect(upsertArgs.update.value).not.toHaveProperty('evilKey');
        expect(upsertArgs.create.value).not.toHaveProperty('evilKey');
      });

      it('an unknown key in a PATCH body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { jobSecretBrokerEnabled: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock.calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('audit meta reporting', () => {
      it('omits preservedKeys from the audit meta on a normal patch save', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(partialUpdate, mockUserId);

        // Exact match, same contract as "should create audit event on
        // replace" above: an always-present preservedKeys key would litter
        // every audit row, so it must be entirely absent on a normal save.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:patch',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: {
              changes: partialUpdate,
              resultingValue: {
                ...OPERATIONS_DEFAULTS,
                nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
              },
            } as any,
          },
        });
      });
    });
  });

  // ===========================================================================
  // #366 — the removed `ui`/`features` namespaces. A row written before this
  // change genuinely still carries them on disk, and #130's contract ("the
  // stored value is never narrowed") means they must survive exactly like any
  // other key this build no longer models — following the identical
  // preservation pattern proven above with `branding`/`legacyBlob` — while
  // the RESPONSE, which has never included unmodelled keys, continues to omit
  // them. Symmetrically, a caller that still sends them gets nothing back:
  // they are unknown REQUEST keys, stripped like `evilKey` above, never
  // unknown STORED keys.
  // ===========================================================================
  describe('legacy ui/features namespaces (#366)', () => {
    it('a stored row with legacy ui/features data is preserved on write but never surfaces in the response', async () => {
      const storedValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        ui: { allowUserThemeOverride: false },
        features: { oldFlag: true },
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: storedValue as any,
      } as any);

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
          ui: { allowUserThemeOverride: false },
          features: { oldFlag: true },
        } as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(
        { jobs: { stuckThresholdMinutes: 45 } },
        mockUserId,
      );

      // Storage still carries both legacy namespaces forward — the exact
      // #130 guarantee `branding` and `legacyBlob` pin above, applied to the
      // namespaces #366 actually removed.
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            value: expect.objectContaining({
              ui: { allowUserThemeOverride: false },
              features: { oldFlag: true },
            }),
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({
              preservedKeys: expect.arrayContaining(['ui', 'features']),
            }),
          }),
        }),
      );

      // But neither is part of the represented resource any more: the
      // response `getSettings`/PUT/PATCH share never surfaces them.
      expect(result).not.toHaveProperty('ui');
      expect(result).not.toHaveProperty('features');
    });

    it('a PUT/PATCH body carrying legacy ui/features keys does not reintroduce them — they are stripped as unknown request keys', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const dtoWithLegacyKeys = {
        ui: { allowUserThemeOverride: false },
        features: { newFlag: true },
      };

      const result = await service.patchSettings(
        dtoWithLegacyKeys as any,
        mockUserId,
      );

      // The stored row had neither key, so nothing is preserved: the merge
      // never reads `dto.ui`/`dto.features` (the service only reads the
      // namespaces `systemSettingsSchema` still declares), so they never
      // reach the persisted value or the response.
      const updateArgs = mockPrisma.systemSettings.update.mock.calls[0][0] as any;
      expect(updateArgs.data.value).not.toHaveProperty('ui');
      expect(updateArgs.data.value).not.toHaveProperty('features');
      expect(result).not.toHaveProperty('ui');
      expect(result).not.toHaveProperty('features');
    });
  });

  // ===========================================================================
  // #148 — `systemSettingsResponseSchema` has always declared `security`, and
  // nothing ever populated it: GET, PUT and PATCH all omitted the key the
  // published OpenAPI contract promised. Fixed by `toResponse`, the one
  // projection now shared by all three methods, and `readSecurityPolicy`,
  // which reads `jwt.accessTtlMinutes` / `jwt.refreshTtlDays` off
  // ConfigService rather than the stored row.
  //
  // Covered on all three methods on purpose, per the bug: one hand-built
  // response shape wrong in three places at once means a test that only
  // covers GET cannot tell you PUT and PATCH are fixed too.
  // ===========================================================================
  describe('security block (#148)', () => {
    async function callGetSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      return service.getSettings();
    }

    async function callReplaceSettings() {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: DEFAULT_SYSTEM_SETTINGS,
      } as any);
      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.replaceSettings(newSettings, mockUserId);
    }

    async function callPatchSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.patchSettings({}, mockUserId);
    }

    const methods: Array<
      [string, () => ReturnType<typeof callGetSettings>]
    > = [
      ['getSettings', callGetSettings],
      ['replaceSettings (PUT)', callReplaceSettings],
      ['patchSettings (PATCH)', callPatchSettings],
    ];

    describe('the values are read from ConfigService, not hardcoded', () => {
      it.each(methods)(
        '%s surfaces the exact non-default numbers ConfigService returns',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (key: string, defaultValue?: unknown) => {
              if (key === 'jwt.accessTtlMinutes') return 45;
              if (key === 'jwt.refreshTtlDays') return 30;
              return defaultValue;
            },
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 45,
            refreshTtlDays: 30,
          });
        },
      );

      it.each(methods)(
        '%s asks ConfigService for the exact keys jwt.accessTtlMinutes and jwt.refreshTtlDays',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          await call();

          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.accessTtlMinutes',
            15,
          );
          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.refreshTtlDays',
            14,
          );
        },
      );
    });

    describe('the documented defaults (15/14) are used when ConfigService has nothing configured', () => {
      it.each(methods)(
        '%s still returns numbers, never undefined, for a response field typed z.number()',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 15,
            refreshTtlDays: 14,
          });
          expect(result.security.jwtAccessTtlMinutes).not.toBeUndefined();
          expect(result.security.refreshTtlDays).not.toBeUndefined();
        },
      );
    });

    describe('it is read-only: a security block in the request body is discarded, not persisted', () => {
      it('replaceSettings (PUT): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: DEFAULT_SYSTEM_SETTINGS,
        } as any);

        // The malicious/naive body: a client that read the OpenAPI contract
        // and assumed `security` was writable because the DTO declares it.
        const dtoWithSecurity = {
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        // Goes through the REAL validation path: systemSettingsSchema.parse
        // inside replaceSettings, exercised exactly as it is in production —
        // not a standalone assertion about what we assume zod does.
        const result = await service.replaceSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const upsertArgs = mockPrisma.systemSettings.upsert.mock
          .calls[0][0] as any;
        expect(upsertArgs.update.value).not.toHaveProperty('security');
        expect(upsertArgs.create.value).not.toHaveProperty('security');

        // The response carries config's numbers, not the submitted 9999s.
        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });

      it('patchSettings (PATCH): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const dtoWithSecurity = {
          nodes: { jobSecretBrokerEnabled: true },
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('security');

        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });
    });

    describe('the response satisfies systemSettingsResponseSchema', () => {
      it.each(methods)(
        '%s output parses cleanly through the response schema the OpenAPI contract publishes',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          // Mirror the one normalisation a real HTTP response performs that
          // a plain object does not: `updatedAt` travels the wire as JSON,
          // which turns the Date into the ISO string
          // `systemSettingsResponseSchema` (z.iso.datetime()) declares.
          //
          // `updatedBy.id` is swapped for a real UUID for the same reason:
          // `mockUserId` ('user-123') is a fixture convenience used
          // throughout this file for equality checks, not a value meant to
          // satisfy `z.string().uuid()`. Substituting it here tests the
          // shape this change is responsible for — the security block and
          // the rest of the response — without this fixture's id format
          // being what's under test.
          const serialized = {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
            updatedBy: result.updatedBy && {
              ...result.updatedBy,
              id: '11111111-1111-4111-8111-111111111111',
            },
          };

          expect(() =>
            systemSettingsResponseSchema.parse(serialized),
          ).not.toThrow();
        },
      );
    });
  });

  // ===========================================================================
  // #225, epic #215 — the `notifications` block: a MODELLED gate rather than a
  // key in an open record, so it must survive the same treatment every other
  // namespace gets. Nothing consumes these values yet (#226 adds the
  // enforcement); what is under test here is purely that the row can hold
  // them, degrade gracefully, and stay repairable through the API.
  // ===========================================================================
  describe('notifications block (#225)', () => {
    it('defaults to browser notifications ON with nothing suppressed', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result.notifications).toEqual({
        browserEnabled: true,
        disabledEvents: [],
      });
    });

    it('is part of the documented response shape, not just the stored value', async () => {
      // The published contract is what a generated client sees. Asserted
      // against the schema itself rather than a live response because
      // `getSettings` returns a `Date` for `updatedAt` that only becomes the
      // ISO string the schema demands once it is serialised — the end-to-end
      // conformance check lives in the integration suite, over real HTTP.
      expect(systemSettingsResponseSchema.shape.notifications).toBeDefined();

      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(() =>
        systemSettingsResponseSchema.parse({
          ...result,
          updatedAt: result.updatedAt.toISOString(),
        }),
      ).not.toThrow();
    });

    it('PATCH merges the two halves independently: sending one leaves the other stored value alone', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['security.role_changed'],
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { notifications: { browserEnabled: false } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications).toEqual({
        browserEnabled: false,
        disabledEvents: ['security.role_changed'],
      });
    });

    it('PATCH REPLACES disabledEvents rather than merging, so a suppression can actually be lifted', async () => {
      // A merging list could only ever grow. Unchecking the last box on the
      // admin page sends `[]`, and `[]` must mean "suppress nothing".
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['security.role_changed', 'user.welcome'],
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { notifications: { disabledEvents: [] } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications.disabledEvents).toEqual([]);
      // The half that was not sent is still the stored one.
      expect(updateArgs.data.value.notifications.browserEnabled).toBe(true);
    });

    it.each([
      ['missing entirely', undefined],
      ['a string', 'nope'],
      ['null', null],
      ['an array', ['security.role_changed']],
    ])(
      'degrades a stored notifications block that is %s to the defaults instead of throwing',
      async (_label, malformed) => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
            nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
            ...(malformed === undefined ? {} : { notifications: malformed }),
          } as any,
        } as any);

        const result = await service.getSettings();

        expect(result.notifications).toEqual({
          browserEnabled: true,
          disabledEvents: [],
        });
      },
    );

    it('drops stored disabledEvents entries the schema would reject, keeping the row repairable', async () => {
      // Same rule as "non-boolean feature values are dropped": carrying an
      // unparseable entry into the merge would turn a damaged row into a
      // ZodError on every save, and only a hand-edit of JSONB could fix it.
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: false,
            disabledEvents: [
              'security.role_changed',
              'NOT A KEY',
              42,
              null,
              'user.welcome',
            ],
          },
        } as any,
      } as any);

      const result = await service.getSettings();

      expect(result.notifications).toEqual({
        browserEnabled: false,
        disabledEvents: ['security.role_changed', 'user.welcome'],
      });
    });

    it('does not hand out the shared DEFAULT_SYSTEM_SETTINGS array, which a caller could mutate', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
          nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        } as any,
      } as any);

      const result = await service.getSettings();

      expect(result.notifications.disabledEvents).not.toBe(
        DEFAULT_SYSTEM_SETTINGS.notifications.disabledEvents,
      );
    });

    it('preserves an unknown key nested under notifications, the second closed nested object', async () => {
      // Exactly the #130 guarantee `jobs.extraKnob` pins above, on the block
      // this issue adds: a rollback across the addition of a sibling key must
      // not destroy it. `notifications` is closed (unlike an open record), so
      // without its own known-key list it would be narrowed on every write.
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
          nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
          notifications: {
            browserEnabled: false,
            disabledEvents: [],
            pushEnabled: true,
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { nodes: { jobSecretBrokerEnabled: true } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications.pushEnabled).toBe(true);
      expect(updateArgs.data.value.notifications.browserEnabled).toBe(false);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({
              preservedKeys: ['notifications.pushEnabled'],
            }),
          }),
        }),
      );
    });
  });
});
