// =============================================================================
// The identity events (issue #470, epic #467)
// =============================================================================
//
// `user.welcome`, `allowlist.invitation` and `security.role_changed`, raised by
// the platform identity slice through `IDENTITY_NOTIFIER`
// (`platform/identity/identity-notifier.adapter.ts`). The platform ships the
// email templates (`user-welcome`, `allowlist-invitation`, `role-changed`) and
// the role-change browser renderer; this file owns the EVENTS, because the key,
// the label, the description, the channels and the `mandatory` flag are what a
// user's stored `notifications` preferences were written against.
//
// KEYS, CHANNEL IDS AND TEMPLATE NAMES ARE PERSISTED (preferences, delivery
// rows): never rename one.
//
// `allowlist.invitation_reminder` is the app's own and lives in
// `allowlist-reminder.notifications.ts`.
// =============================================================================

import {
  roleChangedBrowserTemplate,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

export const IDENTITY_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: 'user.welcome',
      label: 'Welcome',
      description: 'Sent once, the first time you sign in to this application.',
      // Email only. A browser notification here would fire while the user is
      // looking at the very page that welcomes them: it has no reader.
      channels: ['email'],
      defaultEnabled: true,
    },
    emailTemplate: 'user-welcome',
  },

  {
    event: {
      key: 'allowlist.invitation',
      label: 'Invitation to join',
      description:
        'Sent when an administrator adds your email address to the allowlist, inviting you to sign in.',
      // Email only. The recipient has no account, no session and no open tab at
      // the moment this fires, so no in-app channel can reach them.
      channels: ['email'],
      defaultEnabled: true,
    },
    emailTemplate: 'allowlist-invitation',
  },

  {
    event: {
      key: 'security.role_changed',
      label: 'Your roles changed',
      description:
        'Sent when an administrator changes the roles assigned to your account, which changes what you can access.',
      // Both channels: a privilege change is worth surfacing immediately to an
      // open tab AND leaving a durable record in the user's inbox.
      channels: ['email', 'browser'],
      defaultEnabled: true,
      // A privilege change the user never hears about is the failure mode this
      // flag exists for. Not silenceable.
      mandatory: true,
    },
    emailTemplate: 'role-changed',
    browserTemplate: roleChangedBrowserTemplate,
  },
];
