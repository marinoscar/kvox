// =============================================================================
// The transcript pipeline's notifications (issues #25 and #29, epic #19;
// registered through the platform by issue #470, epic #467)
// =============================================================================
//
// The two events and their browser/push renderers. The email templates
// (`transcript-ready`, `transcript-failed`) live in
// `email-templates/` and are registered by `KVOX_EMAIL_TEMPLATES`; a binding may
// only name a template that is already registered, so the manifest registers the
// templates first (`platform/notifications/notification.manifest.ts`).
//
// WHO THEY ARE ADDRESSED TO: `transcript_ready` and `transcript_failed` go to the
// transcript's OWNER with `notify(key, ownerId, ...)`. A transcript is a fact about
// one person (their recording, their private data), so neither is ever raised with
// `notifyPermissionHolders`. (`transcripts.transcript_shared`, issue #29, is retired:
// a share is a platform grant since #485 and the recipient hears about it through
// `sharing.shared_with_you`, `sharing.notifications.ts`.)
//
// NONE IS `mandatory`. Being told your own upload finished is a courtesy, not a
// security-relevant change to your own privileges (the test
// `security.role_changed` and `db_backup.restore_completed` pass and these do
// not). A user who transcribes twenty files a day is entitled to turn them off.
//
// THERE IS DELIBERATELY NO "unshared" COUNTERPART: "your access was removed" mainly
// tells somebody they were discussed, and revocation already takes effect silently
// on the next request.
// =============================================================================

import type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
  NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

import type { TranscriptFailedEmailData } from '../email-templates/transcript-failed.email';
import type { TranscriptReadyEmailData } from '../email-templates/transcript-ready.email';

// Both ready and failed link to `/transcripts/:id`, a REAL destination in both
// cases (for the failure it is where the retry action lives). Root-relative, as
// `sanitizeLink` requires.
const transcriptReadyBrowserTemplate: BrowserNotificationTemplate = (data: never): BrowserNotificationContent => {
  const { transcriptId, title, speakerCount, wordCount } =
    data as TranscriptReadyEmailData;

  return {
    title: 'Transcript ready',
    body:
      `"${title}" finished transcribing: ${speakerCount} speaker(s), ` +
      `${wordCount} words. It is ready to read and correct.`,
    link: `/transcripts/${transcriptId}`,
  };
};

const transcriptFailedBrowserTemplate: BrowserNotificationTemplate = (data: never): BrowserNotificationContent => {
  const { transcriptId, title, reason, retryable } =
    data as TranscriptFailedEmailData;

  return {
    title: 'Transcription failed',
    body:
      `"${title}" could not be transcribed: ${reason}` +
      (retryable ? ' You can try again from the transcript page.' : ''),
    link: `/transcripts/${transcriptId}`,
  };
};

/** The transcript pipeline's notifications, in the order the preferences matrix shows them. */
export const TRANSCRIPTS_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: 'transcripts.transcript_ready',
      label: 'Transcript ready',
      description:
        'Sent when one of your recordings finishes transcribing and can be read, corrected and shared.',
      // Both channels: a transcription takes minutes to hours, so the reader has
      // usually closed the tab (which is what an email is for) while somebody
      // still in the application gets the toast that saves them polling.
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'transcript-ready',
    browserTemplate: transcriptReadyBrowserTemplate,
  },
  {
    event: {
      key: 'transcripts.transcript_failed',
      label: 'Transcription failed',
      description:
        'Sent when one of your recordings could not be transcribed. Carries the reason and a link to retry it.',
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'transcript-failed',
    browserTemplate: transcriptFailedBrowserTemplate,
  },
];
