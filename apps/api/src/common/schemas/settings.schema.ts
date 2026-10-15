import type { z } from 'zod';

import {
  composeSystemSettingsPatchSchema,
  composeSystemSettingsSchema,
  composeUserSettingsPatchSchema,
  composeUserSettingsSchema,
  type ComposedObjectSchema,
} from '../../settings/registry/compose';
import {
  PROFILE_IMAGE_SOURCES,
  profileImageSourceSchema,
  userProfileSettingsSchema,
  userProfileSettingsPatchSchema,
} from '../../settings/registry/core-user-fields';
import type {
  SystemSettingsValue,
  UserSettingsValue,
} from '../types/settings.types';

// =============================================================================
// Settings schemas (issue #459)
// =============================================================================
//
// WHAT LIVES HERE NOW. The four top-level schemas this file used to write out by
// hand (`userSettingsSchema`, `userSettingsPatchSchema`, `systemSettingsSchema`,
// `systemSettingsPatchSchema`) are COMPOSED from the settings namespace
// registries (`settings/registry/`), which `apps/api/src/kvox.manifest.ts`
// fills. Their names, and everything else this file exported, are unchanged:
//
//   * the core system namespaces' own schemas moved verbatim to
//     `system-namespaces.schema.ts` and are re-exported below;
//   * `theme` and `profile` live in `settings/registry/core-user-fields.ts`
//     and are re-exported below;
//   * the `ai` schemas are re-exported from `ai/ai-settings.schema.ts`;
//   * `transcription` and `graph` are declared in their own modules and reach
//     these composites through the registry, so nothing here imports them.
//
// ⚠ THIS FILE MAY ONLY BE EVALUATED AFTER `kvox.manifest` HAS RUN. The
// composers throw ("Settings namespaces are not registered: import
// apps/api/src/kvox.manifest first") on an empty registry, so an entry point
// that forgot the manifest fails on start instead of composing a schema with
// no namespaces in it, which would silently strip every namespace from every
// write. The registry declarations themselves must therefore import the
// namespace schemas from `system-namespaces.schema.ts` and
// `user-settings-namespaces.schema.ts` — never from this file.
// =============================================================================

// -----------------------------------------------------------------------------
// User settings
// -----------------------------------------------------------------------------

// `theme` and `profile` are the core fields of the user document. They are
// defined in `settings/registry/core-user-fields.ts` (so the registry composers
// can import them without importing this file) and re-exported here unchanged.

export {
  PROFILE_IMAGE_SOURCES,
  profileImageSourceSchema,
  userProfileSettingsSchema,
  userProfileSettingsPatchSchema,
};

export type {
  ProfileImageSource,
  UserProfileSettingsValue,
  UserProfileSettingsPatchValue,
} from '../../settings/registry/core-user-fields';

/**
 * A composed object schema whose `parse`/`safeParse` are typed to the value the
 * registry's augmentation maps describe. The composers return a schema over
 * `Record<string, ZodType>` (the key set is only known at run time); the cast
 * restores the static type without touching the schema.
 */
export type TypedObjectSchema<V> = Omit<
  ComposedObjectSchema,
  'parse' | 'safeParse' | '_zod'
> & {
  parse(data: unknown): V;
  safeParse(data: unknown): z.ZodSafeParseResult<V>;
  _zod: Omit<ComposedObjectSchema['_zod'], 'output' | 'input'> & {
    output: V;
    input: V;
  };
};

/**
 * The stored shape of a user's settings: `theme`, `profile` and every
 * registered namespace, each namespace optional ("absent means built-in
 * defaults", see `user-settings-namespaces.schema.ts` for why none may ever get
 * a `.default()`).
 */
export const userSettingsSchema = composeUserSettingsSchema() as unknown as TypedObjectSchema<UserSettingsValue>;

export type UserSettingsDto = UserSettingsValue;

/**
 * Partial schema for PATCH operations (zod v4: deepPartial removed). The outer
 * `.nullable()` on every namespace is what lets `{ "dataTables": null }` clear
 * the whole namespace; the inner nullability (in each namespace's patch schema)
 * is what lets `{ "dataTables": { "jobs": null } }` delete a single entry.
 */
export const userSettingsPatchSchema = composeUserSettingsPatchSchema();

// -----------------------------------------------------------------------------
// System settings
// -----------------------------------------------------------------------------

// The core namespaces' schemas (notifications, jobs, nodes, databaseBackup,
// maintenance), moved verbatim to a leaf so the registry declarations can use
// them without importing this file.
export * from './system-namespaces.schema';

/**
 * AI policy (`ai`) — issue #47, epic #45.
 *
 * DEFINED IN `ai/ai-settings.schema.ts` AND RE-EXPORTED HERE: the shape has a
 * nested per-provider block and it carries a COMPILE-TIME PROOF that no
 * secret-bearing field exists, and a proof has to live next to the thing it
 * proves something about. That file imports nothing but zod, so it is a leaf
 * and this import cannot cycle.
 *
 * ⚠ THERE IS NO AI KEY ANYWHERE IN THIS ROW, AND UNLIKE `transcription` THERE
 * IS NOT ONE IN THE SHARED `credentials` TABLE EITHER. Epic #45 is strict BYO:
 * every AI key belongs to an individual user and lives in
 * `user_ai_credentials`, behind a cascading foreign key. A key in this
 * namespace would be both a secret in a wholesale-returned settings blob and
 * the deployment-wide fallback credential docs/specs/notes.md §9 rejected.
 */
export {
  systemAiSchema,
  systemAiPatchSchema,
  AI_PROVIDER_IDS,
} from '../../ai/ai-settings.schema';

export type {
  SystemAiValue,
  SystemAiPatchValue,
  AiProviderId,
} from '../../ai/ai-settings.schema';

/**
 * The stored shape of the 'global' system settings row: every registered
 * namespace's `storedSchema`, required, in registration order. REQUIRED
 * because this schema describes the value as STORED and the stored value is
 * always complete: every write path runs the row through `readKnownSettings`,
 * which fills any missing block from the composed defaults. What a CLIENT may
 * omit is a separate question, answered by the PUT body.
 */
export const systemSettingsSchema = composeSystemSettingsSchema() as unknown as TypedObjectSchema<SystemSettingsValue>;

export type SystemSettingsDto = SystemSettingsValue;

/**
 * Partial schema for PATCH operations (zod v4: deepPartial removed): every
 * registered namespace's canonical partial, optional.
 */
export const systemSettingsPatchSchema = composeSystemSettingsPatchSchema();
