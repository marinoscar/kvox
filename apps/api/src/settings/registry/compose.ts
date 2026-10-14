// =============================================================================
// Settings composition: pure functions of the namespace registries (issue #459,
// mirrors EnterpriseAppBase `settings/registry/compose.ts`)
// =============================================================================
//
// Every top-level settings object that used to be written out by hand
// (`systemSettingsSchema`, its partial, the PUT and PATCH request bodies, the
// response, `DEFAULT_SYSTEM_SETTINGS` and the user-settings equivalents) is a
// fold over a registry's entries, in registration order. Zod object key order
// drives the OpenAPI document and the stored JSON's key order, so
// "registration order" is a contract (see `kvox.manifest.ts`).
//
// FAIL LOUD. Every composer throws when its registry is empty: composing from
// nothing would silently strip every namespace from every PATCH (the "silent
// no-op" the parity specs' headers describe). An empty registry means an entry
// point evaluated a DTO before `kvox.manifest` ran.
//
// This file never imports a manifest or a declaration: it composes whatever the
// registry holds when it is called.
// =============================================================================

import { z } from 'zod';

import {
  themePreferenceSchema,
  userProfileResponseSchema,
  userProfileSettingsPatchSchema,
  userProfileSettingsSchema,
} from './core-user-fields';
import { systemSettingsNamespaceRegistry, type SystemSettingsNamespace } from './system-settings-namespace';
import { userSettingsNamespaceRegistry, type UserSettingsNamespace } from './user-settings-namespace';
import type { SystemSettingsNamespaces } from './index';

/** The message every composer throws when its registry is empty. */
export const SETTINGS_NAMESPACES_NOT_REGISTERED_MESSAGE =
  'Settings namespaces are not registered: import apps/api/src/kvox.manifest first';

/** A composed top-level settings object. Its keys are the registered namespaces. */
export type ComposedObjectSchema = z.ZodObject<Record<string, z.ZodType>>;

type Shape = Record<string, z.ZodType>;

function systemNamespaces(namespaces?: readonly SystemSettingsNamespace[]): readonly SystemSettingsNamespace[] {
  const list = namespaces ?? systemSettingsNamespaceRegistry.list();
  if (list.length === 0) throw new Error(SETTINGS_NAMESPACES_NOT_REGISTERED_MESSAGE);
  return list;
}

function userNamespaces(namespaces?: readonly UserSettingsNamespace[]): readonly UserSettingsNamespace[] {
  const list = namespaces ?? userSettingsNamespaceRegistry.list();
  if (list.length === 0) throw new Error(SETTINGS_NAMESPACES_NOT_REGISTERED_MESSAGE);
  return list;
}

function shapeOf<N>(namespaces: readonly N[], keyOf: (ns: N) => string, branch: (ns: N) => z.ZodType | null): Shape {
  const shape: Shape = {};
  for (const ns of namespaces) {
    const schema = branch(ns);
    if (schema !== null) shape[keyOf(ns)] = schema;
  }
  return shape;
}

/**
 * Memoise `build` on the registry's current entries: recomputed only when an
 * entry is added, removed or replaced. Only called with the live registry (no
 * explicit `namespaces`), so a composer called twice returns one schema object.
 */
function memoOnEntries<N, R>(list: () => readonly N[], build: (entries: readonly N[]) => R): () => R {
  let cachedEntries: readonly N[] | undefined;
  let cached: R | undefined;
  return () => {
    const entries = list();
    const same =
      cachedEntries !== undefined &&
      cachedEntries.length === entries.length &&
      cachedEntries.every((entry, index) => entry === entries[index]);
    if (!same) {
      cached = build(entries);
      cachedEntries = entries;
    }
    return cached as R;
  };
}

/** `memoOnEntries` over a registry, usable as `composeX(namespaces?)`. */
function composer<N, R>(
  live: () => readonly N[],
  build: (entries: readonly N[]) => R,
): (namespaces?: readonly N[]) => R {
  const memo = memoOnEntries(live, build);
  return (namespaces) => (namespaces === undefined ? memo() : build(namespaces));
}

// -----------------------------------------------------------------------------
// System settings
// -----------------------------------------------------------------------------

const liveSystem = () => systemSettingsNamespaceRegistry.list();

/** `systemSettingsSchema`: every namespace's `storedSchema`, required, in registration order. */
export const composeSystemSettingsSchema = composer(liveSystem, (entries): ComposedObjectSchema =>
  z.object(
    shapeOf(
      systemNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.storedSchema,
    ),
  ),
);

/** `systemSettingsPatchSchema`: every namespace's `patchSchema.optional()`. */
export const composeSystemSettingsPatchSchema = composer(liveSystem, (entries): ComposedObjectSchema =>
  z.object(
    shapeOf(
      systemNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.patchSchema.optional(),
    ),
  ),
);

/** `updateSystemSettingsSchema` (PUT body): `requiredOnPut ? putSchema : putSchema.optional()`. */
export const composeUpdateSystemSettingsSchema = composer(liveSystem, (entries): ComposedObjectSchema =>
  z.object(
    shapeOf(
      systemNamespaces(entries),
      (ns) => ns.key,
      (ns) => (ns.requiredOnPut ? ns.putSchema : ns.putSchema.optional()),
    ),
  ),
);

/** `patchSystemSettingsSchema` (PATCH body): every namespace's `wirePatchSchema.optional()`. */
export const composePatchSystemSettingsSchema = composer(liveSystem, (entries): ComposedObjectSchema =>
  z.object(
    shapeOf(
      systemNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.wirePatchSchema.optional(),
    ),
  ),
);

/**
 * `systemSettingsResponseSchema`: the `GET /api/system-settings` payload, the
 * derived `security` block first, every documented namespace branch in
 * registration order (a `null` `responseSchema` is left out), then the audit
 * fields and the version.
 */
export const composeSystemSettingsResponseSchema = composer(liveSystem, (entries): ComposedObjectSchema =>
  z.object({
    security: z.object({
      jwtAccessTtlMinutes: z.number(),
      refreshTtlDays: z.number(),
    }),
    ...shapeOf(
      systemNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.responseSchema,
    ),
    updatedAt: z.iso.datetime(),
    updatedBy: z
      .object({
        id: z.string().uuid(),
        email: z.string().email(),
      })
      .nullable(),
    version: z.number(),
  }),
);

/**
 * `DEFAULT_SYSTEM_SETTINGS`: every namespace's `defaults`, in registration
 * order. The values are NOT cloned: callers that mutate must clone.
 */
export const composeDefaultSystemSettings = composer(liveSystem, (entries): SystemSettingsNamespaces => {
  const value: Record<string, unknown> = {};
  for (const ns of systemNamespaces(entries)) value[ns.key] = ns.defaults;
  return value as unknown as SystemSettingsNamespaces;
});

// -----------------------------------------------------------------------------
// User settings (`theme` and `profile` are core fields placed ahead of the
// optional namespaces)
// -----------------------------------------------------------------------------

const liveUser = () => userSettingsNamespaceRegistry.list();

/** `userSettingsSchema`: core fields, then every namespace's `schema.optional()`. */
export const composeUserSettingsSchema = composer(liveUser, (entries): ComposedObjectSchema =>
  z.object({
    theme: themePreferenceSchema,
    profile: userProfileSettingsSchema,
    // Absent means "use built-in defaults": never `.default()`.
    ...shapeOf(
      userNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.schema.optional(),
    ),
  }),
);

/**
 * `userSettingsPatchSchema`: the canonical partial. The outer `.nullable()` is
 * what lets `{ "dataTables": null }` clear a whole namespace.
 */
export const composeUserSettingsPatchSchema = composer(liveUser, (entries): ComposedObjectSchema =>
  z.object({
    theme: themePreferenceSchema.optional(),
    profile: userProfileSettingsPatchSchema.optional(),
    ...shapeOf(
      userNamespaces(entries),
      (ns) => ns.key,
      (ns) => ns.patchSchema.nullable().optional(),
    ),
  }),
);

/**
 * `updateUserSettingsSchema` (PUT body): `theme` and `profile` required, every
 * namespace `(putSchema ?? schema).optional()` (a PUT states the settings in
 * full, so `null` has no "delete" meaning).
 */
export const composeUpdateUserSettingsSchema = composer(liveUser, (entries): ComposedObjectSchema =>
  z.object({
    theme: themePreferenceSchema,
    profile: userProfileSettingsSchema,
    ...shapeOf(
      userNamespaces(entries),
      (ns) => ns.key,
      (ns) => (ns.putSchema ?? ns.schema).optional(),
    ),
  }),
);

/**
 * `patchUserSettingsSchema` (PATCH body, JSON Merge Patch style): every
 * namespace `(wirePatchSchema ?? patchSchema).nullable().optional()`.
 */
export const composePatchUserSettingsSchema = composer(liveUser, (entries): ComposedObjectSchema =>
  z.object({
    theme: themePreferenceSchema.optional(),
    profile: userProfileSettingsPatchSchema.optional(),
    ...shapeOf(
      userNamespaces(entries),
      (ns) => ns.key,
      (ns) => (ns.wirePatchSchema ?? ns.patchSchema).nullable().optional(),
    ),
  }),
);

/**
 * `userSettingsResponseSchema`: a namespace is emitted only when the user
 * stored something for it (absent is information, not an omission). A `null`
 * `responseSchema` leaves the namespace out of the documented response.
 */
export const composeUserSettingsResponseSchema = composer(liveUser, (entries): ComposedObjectSchema =>
  z.object({
    theme: themePreferenceSchema,
    profile: userProfileResponseSchema,
    ...shapeOf(
      userNamespaces(entries),
      (ns) => ns.key,
      (ns) => (ns.responseSchema === null ? null : (ns.responseSchema ?? ns.schema).optional()),
    ),
    updatedAt: z.iso.datetime(),
    version: z.number(),
  }),
);
