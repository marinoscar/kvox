import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';
import {
  NOTES_NOTIFICATION_EVENTS,
  type NoteFailedNotificationData,
  type NoteReadyNotificationData,
} from '@marinoscar/kvox-api/notes';

// =============================================================================
// The note pipeline's notifications, as the platform registers them (issues #49, epic #45;
// registered through the platform by issue #470, epic #467; the event definitions moved into
// `@marinoscar/kvox-api/notes` by issue #495, epic #491)
// =============================================================================
//
// The slice owns the two events (`notes.note_ready` and `notes.note_failed`: key, label,
// description, channels, default, the email template NAME and the browser/push renderer). This
// file only turns them into the platform's `NotificationRegistration`s, in the order the
// preferences matrix shows them.
//
// The email TEMPLATES (`note-ready`, `note-failed`) stay in `email-templates/` and are
// registered by `KVOX_EMAIL_TEMPLATES`; a binding may only name a template that is already
// registered, so the manifest registers the templates first
// (`platform/notifications/notification.manifest.ts`).
//
// THE REGISTRATION HAPPENS HERE, AT IMPORT TIME, AND NOT ONLY WHEN THE SLICE STARTS: the
// platform's notification registry freezes when the application bootstraps, so an event the
// module declared from `onModuleInit` would arrive too late. The slice still declares them
// through `KVOX_NOTIFY.registerEvents` when it starts, which is a no-op for a key already
// registered here.
//
// WHO THEY ARE ADDRESSED TO: the note's OWNER (the person who asked for the work), never a
// permission. NEITHER IS `mandatory`. Event keys, channel ids and template names are persisted:
// never rename one.
// =============================================================================

/** The email-data types the templates render are the slice's notification data. */
export type { NoteFailedNotificationData, NoteReadyNotificationData };

/** The note pipeline's notifications, in the order the preferences matrix shows them. */
export const NOTES_NOTIFICATIONS: readonly NotificationRegistration[] = NOTES_NOTIFICATION_EVENTS.map(
  (event) => ({
    event: {
      key: event.key,
      label: event.label,
      description: event.description,
      channels: [...event.channels] as NotificationRegistration['event']['channels'],
      defaultEnabled: event.defaultEnabled ?? true,
      ...(event.mandatory !== undefined ? { mandatory: event.mandatory } : {}),
    },
    ...(event.emailTemplate !== undefined ? { emailTemplate: event.emailTemplate } : {}),
    ...(event.browserTemplate !== undefined ? { browserTemplate: event.browserTemplate } : {}),
  }),
);
