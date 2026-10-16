// =============================================================================
// The allowlist reminder (issue #301, epic #271; registered through the
// platform by issue #470, epic #467)
// =============================================================================
//
// Raised by `POST /api/allowlist/:id/reminder`
// (`allowlist-reminders/allowlist-reminders.service.ts`). The platform has no
// reminder, so the event and its email template (`allowlist-invitation-reminder`,
// in `email-templates/`) are this app's.
//
// A SEPARATE KEY FROM `allowlist.invitation`, NOT A FLAG: a key is the unit of
// preference, so somebody who wants to be told they were invited but not to be
// chased about it can only say so if the two messages travel under two keys.
//
// MANUAL, NOT SCHEDULED: it fires when an administrator presses a button; there
// is no cron, job type or settings namespace behind it.
// =============================================================================

import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';

export const ALLOWLIST_REMINDER_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: 'allowlist.invitation_reminder',
      label: 'Invitation reminder',
      description:
        'Sent when an administrator reminds you that your email address was allowlisted and you have not signed in yet.',
      // Email only, for the identical reason the invitation declares it: the
      // recipient still has no account, no session and no open tab.
      channels: ['email'],
      defaultEnabled: true,
    },
    emailTemplate: 'allowlist-invitation-reminder',
  },
];
