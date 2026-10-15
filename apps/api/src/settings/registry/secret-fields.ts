// =============================================================================
// The settings secret deny-list (mirrors EnterpriseAppBase `secret-fields.ts`)
// =============================================================================
//
// A settings document is returned wholesale by its GET route and copied into
// every settings audit row, so no namespace may declare a field that could hold
// a secret. The namespace registries walk every registered schema (any depth,
// any case) against this list at registration time. Secrets belong in the
// encrypted credential store (`credentials`), a user's in their own encrypted
// table (`user_ai_credentials`), never in settings.
//
// The owning modules keep their compile-time proofs
// (`TRANSCRIPTION_SETTINGS_CARRIES_NO_SECRET`, `ai-settings.schema.ts`); this
// list is the run-time generalisation every namespace is held to.
//
// Framework-free and import-free.
// =============================================================================

/**
 * Field names no settings namespace may declare, at any depth, compared
 * case-insensitively. A namespace adds its own with `forbiddenKeys`.
 */
export const SETTINGS_SECRET_FIELD_NAMES = [
  'secretAccessKey',
  'secretKey',
  'sessionToken',
  'secret',
  'password',
  'apiKey',
  'token',
  'privateKey',
] as const;

/** One name of {@link SETTINGS_SECRET_FIELD_NAMES}. */
export type SettingsSecretFieldName = (typeof SETTINGS_SECRET_FIELD_NAMES)[number];

/**
 * The message a registry throws for a secret-named field. Names the field and
 * points to the credential store.
 *
 * @param field - the namespace part that declares it (`storedSchema`, ...).
 * @param paths - the offending field paths.
 * @param scope - `system` or `user`.
 */
export function secretFieldMessage(field: string, paths: readonly string[], scope: 'system' | 'user'): string {
  const where =
    scope === 'user'
      ? "a user's secrets go in their own encrypted table (see user_ai_credentials), never in user settings; a deployment-wide secret goes in the credential store"
      : 'secrets go in the encrypted credential store (the `credentials` table), never in system settings';
  return `${field} declares secret-named field(s) ${paths.join(', ')}; ${where}`;
}
