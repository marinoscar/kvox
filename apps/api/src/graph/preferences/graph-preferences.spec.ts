import { patchUserSettingsSchema } from '../../settings/dto/update-user-settings.dto';
import {
  graphPreferencesPatchSchema,
  graphPreferencesSchema,
} from '../../common/schemas/user-settings-namespaces.schema';
import {
  changedGraphSections,
  enabledDomainKeys,
  GRAPH_PREFERENCE_DEFAULTS,
  resolveGraphPreferences,
} from './graph-preferences.defaults';
import { GraphPreferencesService } from './graph-preferences.service';

// =============================================================================
// Graph preferences (#369, epic #346, docs/specs/ontology.md §7, §13, §17.2)
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';

describe('resolveGraphPreferences', () => {
  it('returns every default for an absent namespace', () => {
    expect(resolveGraphPreferences(undefined)).toEqual(GRAPH_PREFERENCE_DEFAULTS);
    expect(resolveGraphPreferences(null)).toEqual(GRAPH_PREFERENCE_DEFAULTS);
    expect(resolveGraphPreferences({})).toEqual(GRAPH_PREFERENCE_DEFAULTS);
  });

  it('matches the spec defaults exactly', () => {
    expect(GRAPH_PREFERENCE_DEFAULTS).toEqual({
      extraction: { autoExtract: true },
      resolution: {
        mode: 'precheck_confident',
        autoLinkThreshold: 0.9,
        newThreshold: 0.55,
        adjudication: 'llm',
      },
      domains: { core: true, work: true, personal: false },
    });
  });

  it('fills absent sub-objects from defaults and keeps stored ones', () => {
    const resolved = resolveGraphPreferences({
      domains: { work: false, personal: false },
    });
    expect(resolved.domains).toEqual({ core: true, work: false, personal: false });
    expect(resolved.resolution).toEqual(GRAPH_PREFERENCE_DEFAULTS.resolution);
    expect(resolved.extraction).toEqual({ autoExtract: true });
  });

  it('maps domains to DomainKey[] with core always first', () => {
    expect(enabledDomainKeys(resolveGraphPreferences(undefined))).toEqual(['core', 'work']);
    expect(
      enabledDomainKeys(resolveGraphPreferences({ domains: { work: false, personal: false } })),
    ).toEqual(['core']);
  });

  it('reports which sub-objects changed, in a stable order', () => {
    const a = resolveGraphPreferences(undefined);
    const b = resolveGraphPreferences({
      domains: { work: false, personal: false },
      extraction: { autoExtract: false },
    });
    expect(changedGraphSections(a, b)).toEqual(['extraction', 'domains']);
    expect(changedGraphSections(a, a)).toEqual([]);
  });
});

describe('graphPreferencesSchema', () => {
  const resolution = {
    mode: 'precheck_confident',
    autoLinkThreshold: 0.9,
    newThreshold: 0.55,
    adjudication: 'llm',
  };

  it('accepts a full value and an empty one', () => {
    expect(graphPreferencesSchema.safeParse({}).success).toBe(true);
    expect(
      graphPreferencesSchema.safeParse({
        extraction: { autoExtract: false },
        resolution,
        domains: { work: true, personal: false },
      }).success,
    ).toBe(true);
  });

  it('refuses personal: true until #383', () => {
    expect(
      graphPreferencesSchema.safeParse({ domains: { work: true, personal: true } }).success,
    ).toBe(false);
    expect(
      graphPreferencesPatchSchema.safeParse({ domains: { personal: true } }).success,
    ).toBe(false);
  });

  it('refuses thresholds closer than 0.05 and accepts the exact boundary', () => {
    const bad = graphPreferencesSchema.safeParse({
      resolution: { ...resolution, autoLinkThreshold: 0.85, newThreshold: 0.81 },
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].path).toEqual(['resolution', 'newThreshold']);

    expect(
      graphPreferencesSchema.safeParse({
        resolution: { ...resolution, autoLinkThreshold: 0.9, newThreshold: 0.85 },
      }).success,
    ).toBe(true);
  });

  it('bounds each threshold', () => {
    for (const r of [
      { ...resolution, autoLinkThreshold: 0.79 },
      { ...resolution, autoLinkThreshold: 1 },
      { ...resolution, newThreshold: 0.29 },
    ]) {
      expect(graphPreferencesSchema.safeParse({ resolution: r }).success).toBe(false);
    }
  });

  it('is strict: an unknown key is refused, not stripped', () => {
    expect(graphPreferencesSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      graphPreferencesSchema.safeParse({ extraction: { autoExtract: true, x: 1 } }).success,
    ).toBe(false);
  });

  it('the PATCH wire DTO accepts partials and nulls at every level', () => {
    for (const graph of [
      null,
      { resolution: null },
      { resolution: { autoLinkThreshold: 0.93 } },
      { resolution: { mode: null } },
      { extraction: { autoExtract: false }, domains: { work: false } },
    ]) {
      expect(patchUserSettingsSchema.safeParse({ graph }).success).toBe(true);
    }
  });

  it('the PATCH wire DTO refuses a patch whose own thresholds are out of order', () => {
    expect(
      patchUserSettingsSchema.safeParse({
        graph: { resolution: { autoLinkThreshold: 0.85, newThreshold: 0.84 } },
      }).success,
    ).toBe(false);
  });
});

describe('GraphPreferencesService', () => {
  it('returns defaults for a user with no settings row, without creating one', async () => {
    const prisma = {
      userSettings: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const service = new GraphPreferencesService(prisma as never);

    await expect(service.get(USER)).resolves.toEqual(GRAPH_PREFERENCE_DEFAULTS);
    expect(prisma.userSettings.create).not.toHaveBeenCalled();
    expect(prisma.userSettings.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
      select: { value: true },
    });
  });

  it('returns defaults for a row with no graph namespace, and resolves a stored one', async () => {
    const prisma = { userSettings: { findUnique: jest.fn() } };
    const service = new GraphPreferencesService(prisma as never);

    prisma.userSettings.findUnique.mockResolvedValueOnce({
      value: { theme: 'dark', profile: { imageSource: 'none' } },
    });
    await expect(service.get(USER)).resolves.toEqual(GRAPH_PREFERENCE_DEFAULTS);

    prisma.userSettings.findUnique.mockResolvedValueOnce({
      value: {
        theme: 'dark',
        profile: { imageSource: 'none' },
        graph: { resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, autoLinkThreshold: 0.93 } },
      },
    });
    const resolved = await service.get(USER);
    expect(resolved.resolution.autoLinkThreshold).toBe(0.93);
    expect(resolved.domains.work).toBe(true);
  });
});
