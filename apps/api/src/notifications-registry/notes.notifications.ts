// =============================================================================
// The note pipeline's notifications (issue #49, epic #45; registered through
// the platform by issue #470, epic #467)
// =============================================================================
//
// Both are raised by `note.generate` and addressed to the note's OWNER (the
// person who asked for the work), never to a permission. The email templates
// (`note-ready`, `note-failed`) live in `email-templates/`.
//
// NEITHER IS `mandatory`: being told your own requested work finished (or did
// not) is a courtesy about your own action, not a security-relevant change to
// your account.
//
// THERE IS DELIBERATELY NO EVENT FOR A RATE-LIMITED GENERATION: a 429 is a
// deferral the queue handles invisibly, not a failure.
// =============================================================================

import type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
  NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

import type { NoteFailedEmailData } from '../email-templates/note-failed.email';
import type { NoteReadyEmailData } from '../email-templates/note-ready.email';

// Both link to `/notes/:id` (root-relative, as `sanitizeLink` requires); for the
// failure that is where Regenerate lives.
const noteReadyBrowserTemplate: BrowserNotificationTemplate = (data: never): BrowserNotificationContent => {
  const { noteId, title, templateName, wordCount } = data as NoteReadyEmailData;

  return {
    title: 'Note ready',
    body: `"${title}" is ready: ${wordCount} words from the ${templateName} template.`,
    link: `/notes/${noteId}`,
  };
};

const noteFailedBrowserTemplate: BrowserNotificationTemplate = (data: never): BrowserNotificationContent => {
  const { noteId, title, reason } = data as NoteFailedEmailData;

  return {
    title: 'Note generation failed',
    // NO "we will try again": nothing retries this automatically, by design
    // (`maxAttempts: 1`), so a body that implied otherwise would leave the user
    // waiting for something that is never coming.
    body: `"${title}" could not be generated: ${reason}`,
    link: `/notes/${noteId}`,
  };
};

/** The note pipeline's notifications, in the order the preferences matrix shows them. */
export const NOTES_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: 'notes.note_ready',
      label: 'Note ready',
      description:
        'Sent when a note you asked for finishes generating and can be read and edited.',
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'note-ready',
    browserTemplate: noteReadyBrowserTemplate,
  },
  {
    event: {
      key: 'notes.note_failed',
      label: 'Note generation failed',
      description:
        'Sent when a note could not be generated. Carries the reason and a link to the Regenerate action.',
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'note-failed',
    browserTemplate: noteFailedBrowserTemplate,
  },
];
