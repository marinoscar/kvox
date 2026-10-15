// =============================================================================
// The user settings manifest (issue #466, epic #462)
// =============================================================================
//
// Which optional `user_settings` namespaces exist, in stored key order (append,
// never insert):
//
//   dataTables, navigation, notifications, onboarding, graph
//
// `theme` and `profile` are core FIELDS the platform composes ahead of these.
// The first three are the platform's declarations; `onboarding` and `graph` are
// this app's (`app-registrations/settings.ts`).
// =============================================================================

import { NOTIFICATIONS_USER_SETTINGS } from '@marinoscar/platform-api/notifications';
import {
  DATA_TABLES_USER_SETTINGS,
  NAVIGATION_USER_SETTINGS,
  assembleUserSettingsNamespaces,
  registerUserSettingsNamespaces,
  type UserSettingsNamespace,
} from '@marinoscar/platform-api/settings';

import {
  APP_USER_SETTINGS_EXTENSIONS,
  APP_USER_SETTINGS_NAMESPACES,
} from '../../app-registrations/settings';

/** The platform's user namespaces this deployment uses, in stored key order. */
export const PLATFORM_USER_SETTINGS_NAMESPACES: readonly UserSettingsNamespace[] = [
  DATA_TABLES_USER_SETTINGS as UserSettingsNamespace,
  NAVIGATION_USER_SETTINGS as UserSettingsNamespace,
  NOTIFICATIONS_USER_SETTINGS as UserSettingsNamespace,
];

/** The final, ordered list this deployment registers. */
export function assembleKvoxUserSettingsNamespaces(): UserSettingsNamespace[] {
  return assembleUserSettingsNamespaces({
    platform: PLATFORM_USER_SETTINGS_NAMESPACES,
    app: APP_USER_SETTINGS_NAMESPACES,
    appExtensions: APP_USER_SETTINGS_EXTENSIONS,
  });
}

let registered = false;

/** Registers the user namespaces. Idempotent per process (see the system manifest). */
export function registerKvoxUserSettings(): void {
  if (registered) return;
  registered = true;
  registerUserSettingsNamespaces(assembleKvoxUserSettingsNamespaces());
}
