// =============================================================================
// The note pipeline's notifications (issue #49, epic #45; registered through
// the registry by issue #460)
// =============================================================================
//
// The two events, their email bindings and their browser/push renderers, moved
// here verbatim from `notifications/notification-events.ts`,
// `notifications/channels/email-notification.channel.ts` and
// `notifications/channels/browser-notification.channel.ts`. The base declares
// neither: `kvox.manifest.ts` registers `NOTES_EMAIL_TEMPLATES` and then
// `NOTES_NOTIFICATIONS`.
// =============================================================================


import type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
} from '../../notifications/channels/browser-notification.channel';
import type { NotificationRegistration } from '../../notifications/notification-registry';
import type { EmailTemplateRegistrations } from '../../email/templates';
import { noteFailedEmail, type NoteFailedEmailData } from './note-failed.email';
import { noteReadyEmail, type NoteReadyEmailData } from './note-ready.email';

// ---------------------------------------------------------------------------
// THE NOTE PIPELINE (#49, epic #45)
// ---------------------------------------------------------------------------
//
// Both link to `/notes/:id` — root-relative, as `sanitizeLink` requires — and
// for the failure that is specifically where Regenerate lives, so the row
// answers the question it raises rather than only raising it.
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
    // NO "we will try again" — nothing retries this automatically, by
    // design (`maxAttempts: 1`), so a body that implied otherwise would
    // leave the user waiting for something that is never coming.
    body: `"${title}" could not be generated: ${reason}`,
    link: `/notes/${noteId}`,
  };
};

/** The note pipeline's email templates, in registration order. */
export const NOTES_EMAIL_TEMPLATES: EmailTemplateRegistrations = {
  'note-ready': noteReadyEmail,
  'note-failed': noteFailedEmail,
};

/** The note pipeline's notifications, in the order the preferences matrix shows them. */
export const NOTES_NOTIFICATIONS: NotificationRegistration[] = [
  // ===========================================================================
  // NOTES (#49, epic #45)
  // ===========================================================================
  //
  // Both are raised by `note.generate` and addressed to the note's OWNER — the
  // person who asked for the work — never to a permission the way
  // `jobs.job_failed` is. They are what make "close the tab and walk away"
  // actually work: a generation runs for ten seconds to several minutes on
  // somebody else's infrastructure, and the durable buffer (spec §5.1) is only
  // half of the promise. Without these, a user who closed the tab has no way to
  // learn their note exists short of going back to look.
  //
  // ⚠ A PURE APPEND. Two entries, two templates, two call sites — no table, no
  // column, no migration, exactly as `operational-events-no-migration.spec.ts`
  // exists to prove. See CLAUDE.md's "Adding a Notification".
  //
  // NEITHER IS `mandatory`. Being told your own requested work finished (or
  // did not) is a courtesy about your own action, not a security-relevant
  // change to your account — the line `security.role_changed` and
  // `db_backup.restore_completed` are on the other side of.
  //
  // ⚠ THERE IS DELIBERATELY NO EVENT FOR A RATE-LIMITED GENERATION. A 429 is a
  // deferral the queue handles invisibly (spec §2.2), not a failure; mailing
  // somebody about it would report a delay as something to act on.
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
