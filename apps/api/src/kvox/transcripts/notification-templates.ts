import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';
import {
  TRANSCRIPTS_NOTIFICATION_EVENTS,
  type TranscriptFailedNotificationData,
  type TranscriptReadyNotificationData,
} from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// The transcript pipeline's notifications, as the platform registers them (issues #25
// and #29, epic #19; registered through the platform by issue #470, epic #467; the
// event definitions moved into `@marinoscar/kvox-api/transcripts` by issue #493)
// =============================================================================
//
// The slice owns the two events (`transcripts.transcript_ready` and
// `transcripts.transcript_failed`: key, label, description, channels, default, the email
// template NAME and the browser/push renderer). This file only turns them into the
// platform's `NotificationRegistration`s, in the order the preferences matrix shows them.
//
// The email TEMPLATES (`transcript-ready`, `transcript-failed`) stay in `email-templates/`
// and are registered by `KVOX_EMAIL_TEMPLATES`; a binding may only name a template that is
// already registered, so the manifest registers the templates first
// (`platform/notifications/notification.manifest.ts`).
//
// THE REGISTRATION HAPPENS HERE, AT IMPORT TIME, AND NOT ONLY WHEN THE SLICE STARTS:
// the platform's notification registry freezes when the application bootstraps, so an
// event the module declared from `onModuleInit` would arrive too late. The slice still
// declares them through `KVOX_NOTIFY.registerEvents` when it starts, which is a no-op for
// a key already registered here and is what a host with no import-time registry relies on.
//
// WHO THEY ARE ADDRESSED TO: the transcript's OWNER, never a permission holder. NONE IS
// `mandatory`. There is deliberately no "unshared" counterpart. Event keys, channel ids and
// template names are persisted: never rename one.
// =============================================================================

/** The email-data types the templates render are the slice's notification data. */
export type { TranscriptFailedNotificationData, TranscriptReadyNotificationData };

/** The transcript pipeline's notifications, in the order the preferences matrix shows them. */
export const TRANSCRIPTS_NOTIFICATIONS: readonly NotificationRegistration[] = TRANSCRIPTS_NOTIFICATION_EVENTS.map(
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
