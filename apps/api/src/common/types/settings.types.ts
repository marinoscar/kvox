import {
  composeDefaultSystemSettings,
  type SystemSettingsNamespaces,
  type UserSettingsNamespaces,
} from '../../settings/registry';
import type { UserProfileSettingsValue } from '../schemas/settings.schema';

// =============================================================================
// Settings Type Definitions (issue #459)
// =============================================================================
//
// The settings documents are no longer written out field by field here. Each
// namespace is declared once, beside the module that owns it, and AUGMENTS the
// two maps in `settings/registry/index.ts` (`SystemSettingsNamespaces`,
// `UserSettingsNamespaces`); the types below are those maps plus the core
// fields. Adding a namespace is therefore one declaration and one line in
// `apps/api/src/kvox.manifest.ts`, with no edit here.
//
// The long per-field commentary that used to sit on this interface now sits on
// the declarations it described:
//
//   * user:   `settings/registry/core-user-namespaces.ts`
//             (`dataTables`, `navigation`, `notifications`, `onboarding`) and
//             `graph/preferences/graph.user-settings.ts` (`graph`);
//   * system: `settings/registry/core-system-namespaces.ts`
//             (`notifications`, `jobs`, `nodes`, `databaseBackup`,
//             `maintenance`), `transcription/transcription.system-settings.ts`
//             and `ai/ai.system-settings.ts`.
// =============================================================================

/**
 * The fields every user's settings document carries, whatever namespaces are
 * registered.
 */
export type CoreUserSettingsValue = {
  theme: 'light' | 'dark' | 'system';
  /**
   * Profile preferences (#367). `imageSource` chooses which picture represents
   * the user: none, the OAuth provider's picture, or one they uploaded.
   * `imageObjectId` is the uploaded avatar's `storage_objects` id and is kept
   * when the source is switched away from `upload`, so switching back does not
   * need a second upload. Derived from the zod schema so the two cannot drift.
   *
   * Rows written before #367 carry `useProviderImage`/`customImageUrl` instead;
   * they are normalised on read by `normalizeProfileSettings`
   * (common/profile-image/profile-image.ts), never migrated.
   */
  profile: UserProfileSettingsValue;
};

/**
 * User settings schema - stored in user_settings.value JSONB.
 *
 * Written as a mapped type over the augmentable `UserSettingsNamespaces`
 * interface (not the interface itself) so the result is an anonymous object
 * type, which TypeScript accepts where a `Record<string, unknown>` is wanted;
 * an interface would not be.
 *
 * Every registered namespace is OPTIONAL, and absent is load-bearing: it means
 * "the user has expressed no preference", which is not the same thing as an
 * empty object (see `user-settings-namespaces.schema.ts`).
 */
export type UserSettingsValue = CoreUserSettingsValue & {
  [K in keyof UserSettingsNamespaces]?: UserSettingsNamespaces[K];
};

/**
 * The fields every system settings document carries, whatever namespaces are
 * registered. None: `security` is derived configuration on the response, never
 * stored (see `SystemSettingsService.buildSecurityBlock`).
 */
export type CoreSystemSettingsValue = Record<never, never>;

/**
 * System settings schema - stored in system_settings.value JSONB.
 *
 * Every registered namespace is REQUIRED here, not optional: this type
 * describes the value this code works with, and every read of the column goes
 * through `readKnownSettings`, which fills each block from the composed
 * defaults when storage has nothing. A consumer therefore never has to ask
 * whether a block is there. A row on disk may genuinely lack a key; that is not
 * a contradiction, because `readKnownSettings` is the boundary where "what is
 * on disk" becomes "what this type promises".
 */
export type SystemSettingsValue = CoreSystemSettingsValue & {
  [K in keyof SystemSettingsNamespaces]: SystemSettingsNamespaces[K];
};

/**
 * Default user settings
 */
// NOTE: `dataTables`, `navigation`, `notifications`, `onboarding` and `graph` are
// intentionally NOT listed here.
// Seeding them would turn "absent" into "explicitly empty", which is exactly
// the failure mode the namespaces are designed to avoid (a frozen column set
// that silently hides every column added later, a notification preference map
// that freezes a user at the defaults of the day they first saved, or — for
// `onboarding`, #272 — an account being told it has already been through a
// first run it has never seen, silently disabling the welcome dialog for every
// user created after the feature shipped).
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    imageSource: 'provider',
    imageObjectId: null,
  },
};

/**
 * The key order this constant has always had. It is NOT the registration order:
 * `transcription` was declared ahead of `maintenance` here, while the schemas,
 * the request bodies and the OpenAPI document list `maintenance` first. Both
 * orders are wire-visible (this object is what `GET /api/system-settings`
 * falls back to and what a fresh row is created from), and the
 * characterization snapshot pins this one, so the composed defaults are
 * re-keyed into it. A namespace registered later is appended after these.
 */
const HISTORICAL_DEFAULT_KEY_ORDER: readonly string[] = [
  'notifications',
  'jobs',
  'nodes',
  'databaseBackup',
  'transcription',
  'maintenance',
  'ai',
];

function inHistoricalOrder(
  composed: SystemSettingsNamespaces,
): SystemSettingsValue {
  const source = composed as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of HISTORICAL_DEFAULT_KEY_ORDER) {
    if (key in source) ordered[key] = structuredClone(source[key]);
  }
  for (const key of Object.keys(source)) {
    if (!(key in ordered)) ordered[key] = structuredClone(source[key]);
  }
  return ordered as unknown as SystemSettingsValue;
}

/**
 * Default system settings: every registered namespace's `defaults`
 * (`settings/registry/*`, `ai/ai.system-settings.ts`,
 * `transcription/transcription.system-settings.ts`), composed at import time.
 *
 * THE ONE PLACE EACH NUMBER LIVES is its namespace declaration's `defaults`.
 * None of the schemas carries a `.default()`, deliberately: a default in zod is
 * applied by whichever `parse` runs first, which makes "what does a fresh
 * deployment do?" a question you answer by reading parse call sites. Here it is
 * a question you answer by reading the declaration.
 *
 * ⚠ Evaluating this module requires `kvox.manifest` to have run (the composer
 * throws otherwise). A COPY, so a consumer that mutates what it was handed
 * cannot corrupt the declaration the registry holds.
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = inHistoricalOrder(
  composeDefaultSystemSettings(),
);
