import { BadRequestException } from '@nestjs/common';
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
import { TRANSCRIPTION_SYSTEM_SETTINGS } from '../../src/transcription/transcription.system-settings';

// =============================================================================
// Namespace declarations vs. what the manifest registers (issue #459, steps 5-7)
// =============================================================================
//
// `test/setup.ts` imports `src/kvox.manifest`, so by the time this file runs the
// module-level registries hold every declaration and the exported composites
// (`systemSettingsSchema`, the DTO bodies, `DEFAULT_SYSTEM_SETTINGS`, ...) have
// been composed from them. This spec does not re-register anything. It pins two
// things the characterization snapshots (`settings-shape.characterization.spec`)
// cannot say on their own:
//
//   1. THE MANIFEST REGISTERS EXACTLY THESE DECLARATIONS, IN THIS ORDER. Each
//      composite is rebuilt here from an explicit list (core + the two domain
//      declarations) and compared, as JSON Schema with key order preserved,
//      with the composite the app actually uses. A declaration dropped from or
//      inserted into the middle of `kvox.manifest.ts` fails here, naming the
//      schema it changed. (`io: 'input'` and `unrepresentable: 'any'` let the
//      schemas that carry a transform, `ai.allowedModels`, render.) The composers
//      are called with an explicit namespace list, so nothing here touches the
//      registries.
//   2. EVERY USER NAMESPACE'S `merge` AND `assertLimits` HONOUR THE CONTRACT the
//      service relies on, independent of what the namespace means: an absent
//      patch changes nothing, `null` clears, an emptied namespace collapses to
//      absent rather than `{}`, the result still satisfies the namespace's own
//      schema, and the input is never mutated. The per-namespace PATCH rules
//      themselves (deep vs. wholesale merge, the caps and their 400 text) are
//      exercised through the public API in `user-settings.service.spec.ts`.
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
  // key order), so it is compared as a set here.
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

  it('are exactly what the manifest registered, in order', () => {
    expect(systemSettingsNamespaceRegistry.ids()).toEqual(SYSTEM.map((ns) => ns.key));
    expect(systemSettingsNamespaceRegistry.list()).toEqual(SYSTEM);
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

  it('are exactly what the manifest registered, in order', () => {
    expect(userSettingsNamespaceRegistry.ids()).toEqual(['dataTables', 'navigation', 'notifications', 'onboarding', 'graph']);
    expect(userSettingsNamespaceRegistry.list()).toEqual(USER);
  });
});

// -----------------------------------------------------------------------------
// merge / assertLimits: the contract the service relies on
// -----------------------------------------------------------------------------

const CASES: Record<string, { current: unknown; patches: unknown[] }> = {
  dataTables: {
    current: { jobs: { density: 'compact', pageSize: 50 }, users: { pageSize: 10 } },
    patches: [{}, { jobs: null }, { jobs: { pageSize: 25 } }, { users: null, jobs: null }],
  },
  navigation: {
    current: { railCollapsed: true },
    patches: [{}, { railCollapsed: null }, { railCollapsed: false }],
  },
  notifications: {
    current: { email: { 'user.welcome': false, 'a.b': true }, browser: { 'a.b': false } },
    patches: [
      {},
      { email: null },
      { email: { 'user.welcome': null } },
      { email: { 'a.b': null, 'user.welcome': null } },
      { browser: { 'x.y': true } },
    ],
  },
  onboarding: {
    current: { welcomeSeenAt: '2026-01-01T00:00:00.000Z', skipped: ['a.b'] },
    patches: [
      {},
      { welcomeSeenAt: null },
      { dismissedAt: '2026-02-01T00:00:00.000Z' },
      { skipped: null },
      { skipped: [] },
      { skipped: ['c.d'] },
    ],
  },
  graph: {
    current: {
      extraction: { autoExtract: false },
      resolution: { mode: 'review_all', autoLinkThreshold: 0.9, newThreshold: 0.6, adjudication: 'off' },
    },
    patches: [
      {},
      { extraction: null },
      { resolution: null },
      { resolution: { mode: null } },
      { resolution: { autoLinkThreshold: 0.95 } },
      { domains: { personal: true } },
      { domains: null, extraction: { autoExtract: null } },
    ],
  },
};

describe('user namespace merges', () => {
  const declarations = new Map(USER.map((ns) => [ns.key, ns]));

  it('has a case for every registered user namespace', () => {
    expect(Object.keys(CASES)).toEqual(USER.map((ns) => ns.key));
  });

  describe.each(Object.entries(CASES))('%s', (key, spec) => {
    const declaration = declarations.get(key)!;
    const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

    it('leaves the namespace untouched when the patch omits it', () => {
      expect(declaration.merge(clone(spec.current) as never, undefined)).toEqual(spec.current);
      expect(declaration.merge(undefined, undefined)).toBeUndefined();
    });

    it('clears the namespace on null', () => {
      expect(declaration.merge(clone(spec.current) as never, null)).toBeUndefined();
      expect(declaration.merge(undefined, null)).toBeUndefined();
    });

    it.each(spec.patches.map((patch) => [JSON.stringify(patch), patch]))(
      'merges %s into a stored value and into nothing, never storing {} and always satisfying its own schema',
      (_label, patch) => {
        for (const current of [undefined, spec.current]) {
          const input = clone(current);
          const result = declaration.merge(input as never, patch as never);

          // The input is a read of the stored row; merging must not write to it.
          expect(input).toEqual(current);

          if (result === undefined) continue;
          expect(Object.keys(result as object).length).toBeGreaterThan(0);
          expect(declaration.schema.safeParse(result).success).toBe(true);
        }
      },
    );

    it('accepts an absent value in assertLimits', () => {
      if (declaration.assertLimits === undefined) return;
      expect(() => declaration.assertLimits!(undefined)).not.toThrow();
    });
  });

  it('graph: assertLimits refuses crossed thresholds with a BadRequestException', () => {
    const graph = declarations.get('graph')!;
    const crossed = { resolution: { mode: 'review_all', autoLinkThreshold: 0.8, newThreshold: 0.8, adjudication: 'off' } };

    expect(() => graph.assertLimits!(crossed as never)).toThrow(BadRequestException);
    expect(() => graph.assertLimits!(crossed as never)).toThrow(
      'graph.resolution: newThreshold must be at least 0.05 below autoLinkThreshold (would store newThreshold 0.8, autoLinkThreshold 0.8).',
    );
    expect(() => graph.assertLimits!({} as never)).not.toThrow();
  });

  it('dataTables and notifications: assertLimits answer an over-cap value with a BadRequestException', () => {
    const tooManyTables = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`t${i}`, {}]));
    const tooManyEvents = { email: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`e.k${i}`, true])) };

    expect(() => declarations.get('dataTables')!.assertLimits!(tooManyTables as never)).toThrow(BadRequestException);
    expect(() => declarations.get('notifications')!.assertLimits!(tooManyEvents as never)).toThrow(BadRequestException);
  });

  it('the namespaces that declare no cap are the ones that need none', () => {
    expect(USER.filter((ns) => ns.assertLimits === undefined).map((ns) => ns.key)).toEqual(['navigation', 'onboarding']);
  });
});
