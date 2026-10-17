// =============================================================================
// The notification registries, filled (issue #470, epic #467)
// =============================================================================
//
// IMPORTED BY `notifications.config.ts` BEFORE `NotificationsModule.forRoot`
// composes, and it must run before the application is created: the registries
// freeze when it bootstraps. A side-effect module, idempotent per process (a
// second registration of one key is a `DUPLICATE_ID` error and Jest may import
// this from several specs).
//
// ORDER IS LOAD-BEARING, because each step validates against the one before it:
//
//   1. the platform channels (`email`, `browser`, `push`); no Android channel,
//      this app has no Android client;
//   2. the email rendering context (layout theme and the brand mark);
//   3. the platform email templates (`user-welcome`, `broadcast`,
//      `backup-failed`, ...);
//   4. this app's email templates;
//   5. the notifications. A binding may only name a template registered in 3 or
//      4, and the array order is the order of the `/settings/notifications`
//      preferences matrix.
//
// KEYS, CHANNEL IDS AND TEMPLATE NAMES ARE PERSISTED in users' stored
// `notifications` preferences and in delivery rows: never rename one.
// =============================================================================

import {
  BROADCASTS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  OPS_NOTIFICATIONS,
  registerNotifications,
  registerPlatformNotificationChannels,
} from '@marinoscar/platform-api/notifications';
import {
  configureEmailRendering,
  registerEmailTemplates,
  registerPlatformEmailTemplates,
} from '@marinoscar/platform-api/email';

import { KVOX_EMAIL_TEMPLATES, registerKvoxEmailTemplateOverrides } from '../../email-templates';
import { ALLOWLIST_REMINDER_NOTIFICATIONS } from '../../notifications-registry/allowlist-reminder.notifications';
import { DB_BACKUP_NOTIFICATIONS } from '../../notifications-registry/db-backup.notifications';
import { IDENTITY_NOTIFICATIONS } from '../../notifications-registry/identity.notifications';
import { NOTES_NOTIFICATIONS } from '../../notifications-registry/notes.notifications';
import { SHARING_NOTIFICATIONS } from '../../notifications-registry/sharing.notifications';
import { TRANSCRIPTS_NOTIFICATIONS } from '../../kvox/transcripts/notification-templates';
import { EMAIL_MODULE_OPTIONS } from '../email/email.options';

let registered = false;

if (!registered) {
  registered = true;

  registerPlatformNotificationChannels();
  configureEmailRendering(EMAIL_MODULE_OPTIONS);
  registerPlatformEmailTemplates();
  registerEmailTemplates(KVOX_EMAIL_TEMPLATES);
  // This app's wording for `user-welcome` and `allowlist-invitation` (#470).
  registerKvoxEmailTemplateOverrides();

  registerNotifications([
    ...IDENTITY_NOTIFICATIONS,
    ...ALLOWLIST_REMINDER_NOTIFICATIONS,
    ...BROADCASTS_NOTIFICATIONS,
    ...OPS_NOTIFICATIONS,
    ...NODES_NOTIFICATIONS,
    ...DB_BACKUP_NOTIFICATIONS,
    ...TRANSCRIPTS_NOTIFICATIONS,
    ...SHARING_NOTIFICATIONS,
    ...NOTES_NOTIFICATIONS,
  ]);
}
