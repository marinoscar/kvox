// =============================================================================
// The transcript pipeline's notifications (issues #25 and #29, epic #19;
// registered through the registry by issue #460)
// =============================================================================
//
// The three events, their email bindings and their browser/push renderers,
// moved here verbatim from `notifications/notification-events.ts`,
// `notifications/channels/email-notification.channel.ts` and
// `notifications/channels/browser-notification.channel.ts`. The base declares
// none of them: `kvox.manifest.ts` registers `TRANSCRIPTS_EMAIL_TEMPLATES` and
// then `TRANSCRIPTS_NOTIFICATIONS` (a binding may only name a template that is
// already registered).
// =============================================================================


import type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
} from '../../notifications/channels/browser-notification.channel';
import type { NotificationRegistration } from '../../notifications/notification-registry';
import type { EmailTemplateRegistrations } from '../../email/templates';
import {
  transcriptFailedEmail,
  type TranscriptFailedEmailData,
} from './transcript-failed.email';
import {
  transcriptReadyEmail,
  type TranscriptReadyEmailData,
} from './transcript-ready.email';
import {
  shareRoleLabel,
  transcriptSharedEmail,
  type TranscriptSharedEmailData,
} from './transcript-shared.email';

// ---------------------------------------------------------------------------
// THE TRANSCRIPT PIPELINE (#25, epic #19)
// ---------------------------------------------------------------------------
//
// Both link to `/transcripts/:id`, which is a REAL destination in both
// cases — and for the failure it is specifically where the retry action
// lives, so the row answers the question it raises. It is root-relative, as
// `sanitizeLink` requires, and it is the path issue #30's router declares.
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

// Sharing (#29, epic #19). The body NAMES THE ROLE rather than leaving the
// reader to click through and find out whether they can correct what they are
// about to read — the same reason the email's subject carries it.
const transcriptSharedBrowserTemplate: BrowserNotificationTemplate = (data: never): BrowserNotificationContent => {
  const { transcriptId, title, role, ownerName } =
    data as TranscriptSharedEmailData;

  return {
    title: 'A recording was shared with you',
    body: `${ownerName} shared "${title}" with you (${shareRoleLabel(role)}).`,
    link: `/transcripts/${transcriptId}`,
  };
};

/** The transcript pipeline's email templates, in registration order. */
export const TRANSCRIPTS_EMAIL_TEMPLATES: EmailTemplateRegistrations = {
  'transcript-ready': transcriptReadyEmail,
  'transcript-failed': transcriptFailedEmail,
  'transcript-shared': transcriptSharedEmail,
};

/** The transcript pipeline's notifications, in the order the preferences matrix shows them. */
export const TRANSCRIPTS_NOTIFICATIONS: NotificationRegistration[] = [
  // ===========================================================================
  // THE TRANSCRIPT PIPELINE (#25, epic #19)
  // ===========================================================================
  //
  // Two events, and the thing that makes them different from the four
  // operational ones above is WHO THEY ARE ADDRESSED TO. `jobs.job_failed` and
  // its neighbours are addressed to a PERMISSION — anybody who can see the
  // queue should learn that it gave up — because a failed job is a fact about
  // the deployment. A transcript is a fact about one person: their recording,
  // their conversation, their private data. So both of these are raised with
  // `notify(key, ownerId, …)` to the OWNER ALONE, and never with
  // `notifyPermissionHolders`.
  //
  // NEITHER IS `mandatory`. Being told your own upload finished is a courtesy,
  // not a security-relevant change to your own privileges — the test
  // `security.role_changed` and `db_backup.restore_completed` pass and these
  // two do not. A user who transcribes twenty files a day and watches the
  // in-app list is entitled to turn both off.
  // ===========================================================================
  {
    event: {
      key: 'transcripts.transcript_ready',
      label: 'Transcript ready',
      description:
        'Sent when one of your recordings finishes transcribing and can be read, corrected and shared.',
      // Both channels: a transcription takes minutes to hours, so the reader has
      // usually closed the tab — which is what an email is for — while somebody
      // who is still in the application gets the toast that saves them polling.
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
  // ===========================================================================
  // SHARING (#29, epic #19)
  // ===========================================================================
  //
  // The one transcript event addressed to somebody OTHER than the owner. It
  // goes to the RECIPIENT of a share, with `notify(key, recipientId, ...)`, and
  // to nobody else — not the owner (who just performed the action), not the
  // other people the transcript is already shared with (who have no business
  // learning that somebody new was added).
  //
  // NOT `mandatory`, and that is the same test the two events above pass:
  // `security.role_changed` is mandatory because it is a change to the reader's
  // OWN privileges inside this application, which they must not be able to
  // miss. Being handed access to somebody else's recording is an offer, not a
  // change to what the reader is trusted with — the transcript also simply
  // appears in their "Shared with me" list, so silencing the message loses
  // nobody any access. A user who is shared thirty recordings a week is
  // entitled to turn it off.
  //
  // ⚠ THERE IS DELIBERATELY NO `transcript_unshared` COUNTERPART. "Your access
  // was removed" is a message whose main effect is to tell somebody they were
  // discussed; an owner is entitled to un-share a private conversation without
  // composing an explanation, and revocation already takes effect silently on
  // the next request.
  {
    event: {
      key: 'transcripts.transcript_shared',
      label: 'A recording was shared with you',
      description:
        'Sent when another user shares one of their recordings with you, as a viewer or an editor.',
      // Both channels, like the two above: the reader is usually not in the
      // application when somebody shares with them, which is what the email is
      // for, while somebody who is gets the toast instead of finding it later.
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'transcript-shared',
    browserTemplate: transcriptSharedBrowserTemplate,
  },
];
