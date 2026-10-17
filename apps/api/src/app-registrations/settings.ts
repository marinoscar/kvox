// =============================================================================
// This app's settings namespaces (issue #466, epic #462)
// =============================================================================
//
// What this app adds to the platform's settings registries, and the type
// augmentation that makes `SystemSettingsService.getNamespace('transcription')`
// and `UserSettingsService` responses typed. `settings/registry/` folds these
// lists with the platform's own declarations (`assembleSystemSettingsNamespaces`,
// `assembleUserSettingsNamespaces`) and registers the result.
//
//   system (app list): transcription, ai, telemetry
//   user   (app list): onboarding (the platform's), graph
//
// The PLATFORM list (notifications, jobs, nodes, databaseBackup, maintenance /
// dataTables, navigation, notifications) is in `settings/registry/`. this app
// registers those declarations even though the slices that own them are not
// mounted yet (#464, #467): the services this app still runs read them through
// `getNamespace`.
//
// STORED SHAPE: NO FIELD IS RENAMED. Every stored key the platform declaration
// of a shared namespace lacks would be dropped on the next write, so
// `APP_SYSTEM_SETTINGS_EXTENSIONS` carries one `extendSystemSettingsNamespace`
// per this app-only field. The diff run for #466 found none (every platform
// declaration is a superset of this app's stored schema), so it is empty.
// =============================================================================

import { AI_SYSTEM_SETTINGS } from '@marinoscar/platform-api/ai';
import { ONBOARDING_USER_SETTINGS } from '@marinoscar/platform-api/onboarding';
import type {
  SettingsDefaultsOverride,
  SystemSettingsNamespace,
  SystemSettingsNamespaceExtension,
  UserSettingsNamespace,
  UserSettingsNamespaceExtension,
} from '@marinoscar/platform-api/settings';

import type { GraphPreferencesValue } from '@marinoscar/kvox-api/graph';
import { GRAPH_USER_SETTINGS } from '../kvox/graph/graph.user-settings';
import type { SystemTranscriptionValue } from '@marinoscar/kvox-api/transcription';
import { KVOX_AI_SETTINGS_EXTENSION } from '../platform/ai/ai-settings.extension';
import { TELEMETRY_SYSTEM_SETTINGS } from '../platform/telemetry/telemetry.system-settings';
import { TRANSCRIPTION_SYSTEM_SETTINGS } from '../kvox/transcription/transcription.system-settings';

/** this app's system namespaces, in stored key order (after the platform's five). */
export const APP_SYSTEM_SETTINGS_NAMESPACES: readonly SystemSettingsNamespace[] = [
  TRANSCRIPTION_SYSTEM_SETTINGS as SystemSettingsNamespace,
  // The platform AI slice's policy (#473), listed here and not in the platform list so the
  // stored key order of the `global` row stays transcription, ai, telemetry. This app's
  // task models, switch and limits are folded in by `KVOX_AI_SETTINGS_EXTENSION` below.
  AI_SYSTEM_SETTINGS as SystemSettingsNamespace,
  // The platform telemetry slice's policy (#471). The package ships the schema, the
  // defaults and the merge; the declaration is this app's (see the file). Appended
  // last: the stored key order never changes for an existing deployment.
  TELEMETRY_SYSTEM_SETTINGS as SystemSettingsNamespace,
];

/** this app's user namespaces, in stored key order (after the platform's three). */
export const APP_USER_SETTINGS_NAMESPACES: readonly UserSettingsNamespace[] = [
  // The platform onboarding slice's namespace (#481): welcomeSeenAt, checklistDismissedAt,
  // adminDismissedAt, skipped. Listed here, not in the platform list, so the stored key order
  // stays dataTables, navigation, notifications, onboarding, graph. The slice's merge refuses a
  // `skipped` id that is not a registered, skippable step (`platform/onboarding/onboarding.manifest.ts`).
  ONBOARDING_USER_SETTINGS as UserSettingsNamespace,
  GRAPH_USER_SETTINGS as UserSettingsNamespace,
];

/**
 * Fields this app stores in a platform-declared system namespace that the platform lacks.
 *
 * `ai` (#473): task models, the connected-knowledge switch, the default model and the
 * request limits are added to the platform's `ai` namespace; the stored names are the
 * ones this app has always used, so the `ai` key of the `global` row is the same row.
 */
export const APP_SYSTEM_SETTINGS_EXTENSIONS: readonly SystemSettingsNamespaceExtension[] = [
  KVOX_AI_SETTINGS_EXTENSION,
];

/** Fields this app stores in a platform-declared user namespace that the platform lacks. */
export const APP_USER_SETTINGS_EXTENSIONS: readonly UserSettingsNamespaceExtension[] = [];

/**
 * this app's defaults where they differ from the platform's declaration. Only
 * defaults change: the shape, the merge and every schema stay the platform's.
 *
 * `databaseBackup.storageProvider`: the platform defaults to `''` ("whatever
 * provider is active"); this app has always defaulted to `'s3'`, and a row with no
 * `databaseBackup` block reads as the default.
 */
export const APP_SYSTEM_SETTINGS_DEFAULTS: readonly SettingsDefaultsOverride[] = [
  { key: 'databaseBackup', defaults: { storageProvider: 's3' } },
];

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    transcription: SystemTranscriptionValue;
  }

  // The precise static types of the composed request bodies (a PATCH naming
  // `onboarding` or `transcription` type-checks).
  interface SystemSettingsNamespaceDeclarations {
    transcription: typeof TRANSCRIPTION_SYSTEM_SETTINGS;
  }

  // `onboarding` is declared by `@marinoscar/platform-api/onboarding` itself.
  interface UserSettingsNamespaces {
    graph: GraphPreferencesValue;
  }

  interface UserSettingsNamespaceDeclarations {
    graph: typeof GRAPH_USER_SETTINGS;
  }
}
