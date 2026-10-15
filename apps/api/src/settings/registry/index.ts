// =============================================================================
// Settings namespace registry (issue #459)
// =============================================================================
//
// Replaces the "six places" a system settings namespace used to cost (and the
// five a user namespace did). A namespace is declared once, beside the module
// that owns it, as a `SystemSettingsNamespace` / `UserSettingsNamespace`,
// registered by `apps/api/src/kvox.manifest.ts`, and the composed schemas,
// request bodies and defaults are derived from the registry (`compose.ts`).
//
// Names and shapes mirror EnterpriseAppBase
// `packages/platform-api/src/settings/registry/` so Epic 1 issue 1.4 can swap
// the import path.
//
// WHY THE MAPS BELOW ARE DECLARED IN THIS FILE. They are augmented from other
// modules with `declare module '<path to this file>'`, and TypeScript merges an
// augmentation only into the file the specifier RESOLVES to. This file is that
// target for every consumer (`'../settings/registry'`), so the interfaces live
// here and not in the sibling files that import this barrel.
// =============================================================================

/**
 * The stored value of every registered system settings namespace, by key.
 * Each declaration augments it:
 *
 * ```ts
 * declare module '../settings/registry' {
 *   interface SystemSettingsNamespaces { transcription: SystemTranscriptionValue }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SystemSettingsNamespaces {}

/**
 * The stored value of every registered user settings namespace, by key. Each
 * declaration augments it (see {@link SystemSettingsNamespaces}). The stored
 * document carries each one optionally: absent means "use the defaults".
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface UserSettingsNamespaces {}

export {
  SETTINGS_SECRET_FIELD_NAMES,
  secretFieldMessage,
  type SettingsSecretFieldName,
} from './secret-fields';
export {
  RESERVED_SYSTEM_SETTINGS_KEYS,
  SETTINGS_NAMESPACE_KEY_PATTERN,
  areSystemSettingsRequestBodiesComposed,
  markSystemSettingsRequestBodiesComposed,
  registerSystemSettingsNamespaces,
  systemSettingsNamespaceRegistry,
  type SystemSettingsNamespace,
} from './system-settings-namespace';
export {
  RESERVED_USER_SETTINGS_KEYS,
  areUserSettingsRequestBodiesComposed,
  markUserSettingsRequestBodiesComposed,
  registerUserSettingsNamespaces,
  userSettingsNamespaceRegistry,
  type UserSettingsNamespace,
} from './user-settings-namespace';
export {
  SETTINGS_NAMESPACES_NOT_REGISTERED_MESSAGE,
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
  type ComposedObjectSchema,
} from './compose';
