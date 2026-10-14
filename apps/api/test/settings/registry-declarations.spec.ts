import { z } from 'zod';

import { AI_SYSTEM_SETTINGS } from '../../src/ai/ai.system-settings';
import {
  DEFAULT_SYSTEM_SETTINGS,
  DEFAULT_USER_SETTINGS,
} from '../../src/common/types/settings.types';
import {
  systemSettingsPatchSchema,
  systemSettingsSchema,
  userSettingsPatchSchema,
  userSettingsSchema,
} from '../../src/common/schemas/settings.schema';
import { GRAPH_USER_SETTINGS } from '../../src/graph/preferences/graph.user-settings';
import {
  composeDefaultSystemSettings,
  composePatchSystemSettingsSchema,
  composePatchUserSettingsSchema,
  composeSystemSettingsPatchSchema,
  composeSystemSettingsResponseSchema,
  composeSystemSettingsSchema,
  composeUpdateSystemSettingsSchema,
  composeUpdateUserSettingsSchema,
  composeUserSettingsPatchSchema,
  composeUserSettingsResponseSchema,
  composeUserSettingsSchema,
  systemSettingsNamespaceRegistry,
  userSettingsNamespaceRegistry,
} from '../../src/settings/registry';
import { CORE_SYSTEM_NAMESPACES } from '../../src/settings/registry/core-system-namespaces';
import { CORE_USER_NAMESPACES } from '../../src/settings/registry/core-user-namespaces';
import {
  patchSystemSettingsSchema,
  updateSystemSettingsSchema,
} from '../../src/settings/dto/update-system-settings.dto';
import { systemSettingsResponseSchema } from '../../src/settings/dto/system-settings-response.dto';
import {
  patchUserSettingsSchema,
  updateUserSettingsSchema,
} from '../../src/settings/dto/update-user-settings.dto';
import { userSettingsResponseSchema } from '../../src/settings/dto/user-settings-response.dto';
import { UserSettingsService } from '../../src/settings/user-settings/user-settings.service';
import { TRANSCRIPTION_SYSTEM_SETTINGS } from '../../src/transcription/transcription.system-settings';

// =============================================================================
// Namespace declarations vs. the hand-written composites (issue #459, steps 5-7)
// =============================================================================
//
// Until the composite schemas and DTOs are recomposed from the registries, the
// old hand-written objects and the new declarations both exist. They must stay
// IDENTICAL: same keys, same order, same bounds, same defaults, because the
// wire shape (and the OpenAPI document generated from it) may not change.
//
// Each pair is compared as JSON Schema with key order preserved; `io: 'input'`
// and `unrepresentable: 'any'` let the schemas that carry a transform
// (`ai.allowedModels`) render. The composers are called with an explicit
// namespace list, so nothing here touches the module-level registries.
//
// Lives under test/ rather than next to the registry because it imports domain
// folders, which base code may not (test/architecture/base-domain-boundary).
// =============================================================================

const SYSTEM = [...CORE_SYSTEM_NAMESPACES, TRANSCRIPTION_SYSTEM_SETTINGS, AI_SYSTEM_SETTINGS];
const USER = [...CORE_USER_NAMESPACES, GRAPH_USER_SETTINGS];

const render = (schema: z.ZodType): string =>
  JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));

describe('system settings declarations', () => {
  it.each([
    ['stored', () => composeSystemSettingsSchema(SYSTEM), systemSettingsSchema],
    ['patch', () => composeSystemSettingsPatchSchema(SYSTEM), systemSettingsPatchSchema],
    ['PUT body', () => composeUpdateSystemSettingsSchema(SYSTEM), updateSystemSettingsSchema],
    ['PATCH body', () => composePatchSystemSettingsSchema(SYSTEM), patchSystemSettingsSchema],
    ['response', () => composeSystemSettingsResponseSchema(SYSTEM), systemSettingsResponseSchema],
  ] as const)('compose the %s schema identically to the hand-written one', (_name, composed, existing) => {
    expect(render(composed())).toBe(render(existing));
  });

  it('compose DEFAULT_SYSTEM_SETTINGS with identical values', () => {
    expect(composeDefaultSystemSettings(SYSTEM)).toEqual(DEFAULT_SYSTEM_SETTINGS);
  });

  // ⚠ DEFAULT_SYSTEM_SETTINGS lists `transcription` BEFORE `maintenance` (the
  // characterization snapshot pins that), while every schema, DTO and the
  // manifest order put `maintenance` first. The defaults' key order is not
  // wire-visible (responses are shaped by the schemas, and JSONB does not keep
  // key order), but it is pinned, so whoever recomposes DEFAULT_SYSTEM_SETTINGS
  // from the registry must re-key it to the historical order. See the report
  // of issue #459 steps 5-7.
  it('declare the namespaces in the schemas key order', () => {
    expect(SYSTEM.map((ns) => ns.key)).toEqual(Object.keys(systemSettingsSchema.shape));
    expect(Object.keys(DEFAULT_SYSTEM_SETTINGS).sort()).toEqual(SYSTEM.map((ns) => ns.key).sort());
  });

  it('declare notifications as the only namespace a PUT must carry', () => {
    expect(SYSTEM.filter((ns) => ns.requiredOnPut).map((ns) => ns.key)).toEqual(['notifications']);
  });

  it('start from defaults that the stored schema accepts', () => {
    expect(composeSystemSettingsSchema(SYSTEM).safeParse(DEFAULT_SYSTEM_SETTINGS).success).toBe(true);
  });

  it('register without tripping the secret-field or defaults checks', () => {
    // The real registry is empty in this process (the manifest is a later
    // step), so registering here is safe in this file and proves every
    // declaration passes the registry's own validation.
    expect(systemSettingsNamespaceRegistry.size).toBe(0);
    expect(() => systemSettingsNamespaceRegistry.registerAll(SYSTEM)).not.toThrow();
    expect(systemSettingsNamespaceRegistry.ids()).toEqual(SYSTEM.map((ns) => ns.key));
  });
});

describe('user settings declarations', () => {
  it.each([
    ['stored', () => composeUserSettingsSchema(USER), userSettingsSchema],
    ['patch', () => composeUserSettingsPatchSchema(USER), userSettingsPatchSchema],
    ['PUT body', () => composeUpdateUserSettingsSchema(USER), updateUserSettingsSchema],
    ['PATCH body', () => composePatchUserSettingsSchema(USER), patchUserSettingsSchema],
    ['response', () => composeUserSettingsResponseSchema(USER), userSettingsResponseSchema],
  ] as const)('compose the %s schema identically to the hand-written one', (_name, composed, existing) => {
    expect(render(composed())).toBe(render(existing));
  });

  it('keep theme and profile as core fields ahead of the namespaces', () => {
    expect(Object.keys(composeUserSettingsSchema(USER).shape)).toEqual([
      'theme',
      'profile',
      ...USER.map((ns) => ns.key),
    ]);
    expect(Object.keys(DEFAULT_USER_SETTINGS)).toEqual(['theme', 'profile']);
  });

  it('register without tripping the .default() or secret-field checks', () => {
    expect(userSettingsNamespaceRegistry.size).toBe(0);
    expect(() => userSettingsNamespaceRegistry.registerAll(USER)).not.toThrow();
    expect(userSettingsNamespaceRegistry.ids()).toEqual(['dataTables', 'navigation', 'notifications', 'onboarding', 'graph']);
  });
});

// -----------------------------------------------------------------------------
// merge / assertLimits: the declarations carry the service's own logic
// -----------------------------------------------------------------------------
//
// `UserSettingsService` still merges with its private methods until it is
// rewired to the registry. Until then the declarations' copies must behave
// exactly like them, input for input, errors included.

type Merger = (current: unknown, patch: unknown) => unknown;

const service = new UserSettingsService({} as never, {} as never) as unknown as Record<string, Merger>;

const outcome = (fn: () => unknown): unknown => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).constructor.name, message: (error as Error).message };
  }
};

const MERGE_CASES: Record<string, { service: string; current: unknown; patches: unknown[] }> = {
  dataTables: {
    service: 'mergeDataTables',
    current: { jobs: { density: 'compact', pageSize: 50 }, users: { pageSize: 10 } },
    patches: [undefined, null, {}, { jobs: null }, { jobs: { pageSize: 25 } }, { users: null, jobs: null }],
  },
  navigation: {
    service: 'mergeNavigation',
    current: { railCollapsed: true },
    patches: [undefined, null, {}, { railCollapsed: null }, { railCollapsed: false }],
  },
  notifications: {
    service: 'mergeNotifications',
    current: { email: { 'user.welcome': false, 'a.b': true }, browser: { 'a.b': false } },
    patches: [
      undefined,
      null,
      {},
      { email: null },
      { email: { 'user.welcome': null } },
      { email: { 'a.b': null, 'user.welcome': null } },
      { browser: { 'x.y': true } },
    ],
  },
  onboarding: {
    service: 'mergeOnboarding',
    current: { welcomeSeenAt: '2026-01-01T00:00:00.000Z', skipped: ['a.b'] },
    patches: [
      undefined,
      null,
      {},
      { welcomeSeenAt: null },
      { dismissedAt: '2026-02-01T00:00:00.000Z' },
      { skipped: null },
      { skipped: [] },
      { skipped: ['c.d'] },
    ],
  },
  graph: {
    service: 'mergeGraph',
    current: {
      extraction: { autoExtract: false },
      resolution: { mode: 'review_all', autoLinkThreshold: 0.9, newThreshold: 0.6, adjudication: 'off' },
    },
    patches: [
      undefined,
      null,
      {},
      { extraction: null },
      { resolution: null },
      { resolution: { mode: null } },
      { resolution: { autoLinkThreshold: 0.8 } },
      { resolution: { newThreshold: 0.88 } },
      { domains: { personal: true } },
      { domains: null, extraction: { autoExtract: null } },
    ],
  },
};

describe('user namespace merges', () => {
  const declarations = new Map(USER.map((ns) => [ns.key, ns]));

  for (const [key, spec] of Object.entries(MERGE_CASES)) {
    it(`${key}: merge matches UserSettingsService.${spec.service}`, () => {
      const declaration = declarations.get(key)!;
      for (const patch of spec.patches) {
        for (const current of [undefined, spec.current]) {
          expect(outcome(() => declaration.merge(current, patch))).toEqual(
            outcome(() => service[spec.service](current, patch)),
          );
        }
      }
    });
  }

  it('graph: assertLimits throws the BadRequestException text the merge throws today', () => {
    const graph = declarations.get('graph')!;
    const crossed = { resolution: { mode: 'review_all', autoLinkThreshold: 0.8, newThreshold: 0.8, adjudication: 'off' } };

    const viaMerge = outcome(() => service.mergeGraph(undefined, { resolution: { autoLinkThreshold: 0.8, newThreshold: 0.8 } }));
    const viaLimits = outcome(() => graph.assertLimits!(crossed));

    expect(viaLimits).toEqual(viaMerge);
    expect((viaLimits as { error: string }).error).toBe('BadRequestException');
    expect((viaLimits as { message: string }).message).toBe(
      'graph.resolution: newThreshold must be at least 0.05 below autoLinkThreshold (would store newThreshold 0.8, autoLinkThreshold 0.8).',
    );
    expect(() => graph.assertLimits!(undefined)).not.toThrow();
    expect(() => graph.assertLimits!({})).not.toThrow();
  });

  it('dataTables and notifications: assertLimits reject an over-cap value with the service text', () => {
    const tooManyTables = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`t${i}`, {}]));
    const tooManyEvents = { email: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`e.k${i}`, true])) };
    const limits = service as unknown as Record<string, (value: unknown) => void>;

    expect(outcome(() => declarations.get('dataTables')!.assertLimits!(tooManyTables))).toEqual(
      outcome(() => limits.assertDataTableLimit(tooManyTables)),
    );
    expect(outcome(() => declarations.get('notifications')!.assertLimits!(tooManyEvents))).toEqual(
      outcome(() => limits.assertNotificationLimit(tooManyEvents)),
    );
    expect((outcome(() => declarations.get('dataTables')!.assertLimits!(tooManyTables)) as { error: string }).error).toBe(
      'BadRequestException',
    );
  });
});
