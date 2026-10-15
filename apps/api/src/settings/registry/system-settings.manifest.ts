// =============================================================================
// The system settings manifest (issue #466, epic #462)
// =============================================================================
//
// Which `system_settings` namespaces this deployment has, and in what order.
// ORDER IS THE STORED KEY ORDER (and the OpenAPI order): append, never insert.
//
//   notifications, jobs, nodes, databaseBackup, maintenance, transcription, ai
//
// The first five are the PLATFORM's declarations. They are registered here even
// though the slices that own them (`JobsModule`, `NodesModule`, the db-backup
// slice, the host slice) are not mounted yet: the services this app still runs read
// them through `SystemSettingsService.getNamespace`. When a platform slice's
// `forRoot()` later tries to register its own key, `ensureSystemSettingsNamespaces`
// leaves it alone because this manifest registered it first. KEEP THAT ORDER.
//
// `transcription` and `ai` are this app's (`app-registrations/settings.ts`). `ai` is
// this app's own declaration until #473 (PLATFORM-ADOPTION-SHIM(3.1)).
//
// A namespace the platform declares WITHOUT a field this app stores would drop that
// field on the next write; `APP_SYSTEM_SETTINGS_EXTENSIONS` is where such a
// field is added. It is empty: the stored-schema diff found none.
// =============================================================================

import { DATABASE_BACKUP_SYSTEM_SETTINGS } from '@marinoscar/platform-api/db-backup';
import { MAINTENANCE_SYSTEM_SETTINGS } from '@marinoscar/platform-api/host';
import { JOBS_SYSTEM_SETTINGS } from '@marinoscar/platform-api/jobs';
import { NODES_SYSTEM_SETTINGS } from '@marinoscar/platform-api/nodes';
import { NOTIFICATIONS_SYSTEM_SETTINGS } from '@marinoscar/platform-api/notifications';
import {
  assembleSystemSettingsNamespaces,
  registerSystemSettingsNamespaces,
  type SystemSettingsNamespace,
} from '@marinoscar/platform-api/settings';

import {
  APP_SYSTEM_SETTINGS_DEFAULTS,
  APP_SYSTEM_SETTINGS_EXTENSIONS,
  APP_SYSTEM_SETTINGS_NAMESPACES,
} from '../../app-registrations/settings';

/** The platform's system namespaces this deployment uses, in stored key order. */
export const PLATFORM_SYSTEM_SETTINGS_NAMESPACES: readonly SystemSettingsNamespace[] = [
  NOTIFICATIONS_SYSTEM_SETTINGS as SystemSettingsNamespace, // /notifications
  JOBS_SYSTEM_SETTINGS as SystemSettingsNamespace, // /jobs
  NODES_SYSTEM_SETTINGS as SystemSettingsNamespace, // /nodes
  DATABASE_BACKUP_SYSTEM_SETTINGS as SystemSettingsNamespace, // /db-backup
  MAINTENANCE_SYSTEM_SETTINGS as SystemSettingsNamespace, // /host
];

/** The final, ordered list this deployment registers. */
export function assembleKvoxSystemSettingsNamespaces(): SystemSettingsNamespace[] {
  return assembleSystemSettingsNamespaces({
    platform: PLATFORM_SYSTEM_SETTINGS_NAMESPACES,
    app: APP_SYSTEM_SETTINGS_NAMESPACES,
    appExtensions: APP_SYSTEM_SETTINGS_EXTENSIONS,
    appDefaults: APP_SYSTEM_SETTINGS_DEFAULTS,
  });
}

let registered = false;

/**
 * Registers the system namespaces. Idempotent per process: Jest imports the
 * manifest from `test/setup.ts` and a spec may import it again, and registering
 * a namespace twice is a `DUPLICATE_ID` error.
 */
export function registerKvoxSystemSettings(): void {
  if (registered) return;
  registered = true;
  registerSystemSettingsNamespaces(assembleKvoxSystemSettingsNamespaces());
}
