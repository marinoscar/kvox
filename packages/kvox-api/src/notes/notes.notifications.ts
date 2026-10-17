import type { KvoxNotificationEventDef } from '../ports/index.js';

// =============================================================================
// The note pipeline's notifications (issue #49, epic #45; registered through the
// platform by issue #470, epic #467; the event definitions moved into the slice by
// issue #495, epic #491)
// =============================================================================
//
// Both are raised by `note.generate` and addressed to the note's OWNER (the person who
// asked for the work), never to a permission. The email TEMPLATES (`note-ready`,
// `note-failed`) are the host's: the events name them.
//
// NEITHER IS `mandatory`: being told your own requested work finished (or did not) is a
// courtesy about your own action, not a security-relevant change to your account.
//
// THERE IS DELIBERATELY NO EVENT FOR A RATE-LIMITED GENERATION: a 429 is a deferral the
// queue handles invisibly, not a failure.
//
// THE KEYS, THE LABELS AND THE TEMPLATE NAMES ARE PERSISTED: a user's preference row names
// the key and the email-template registry the template. Never rename one.
// =============================================================================

/** The event raised when a note finished generating. @stability experimental */
export const NOTE_READY_NOTIFICATION = 'notes.note_ready';

/** The event raised when a note could not be generated. @stability experimental */
export const NOTE_FAILED_NOTIFICATION = 'notes.note_failed';

/**
 * What the ready notification renders. The host's email template and the in-app
 * text read exactly these fields.
 *
 * @stability experimental
 */
export interface NoteReadyNotificationData {
  /** The note row's id. Used for the CTA path. */
  noteId: string;
  /** The owner's own title. */
  title: string;
  /** `note_generations.template_name_snapshot` - the recipe that produced it. */
  templateName: string;
  /** Which vendor produced it. Named because the user is always told. */
  providerLabel: string;
  /** The model id, verbatim. */
  model: string;
  /** Words in the generated note. A size cue, not a quality one. */
  wordCount: number;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/**
 * What the failed notification renders.
 *
 * @stability experimental
 */
export interface NoteFailedNotificationData {
  /** The note row's id. */
  noteId: string;
  /** The owner's own title. */
  title: string;
  /** `notes.failure_reason`, verbatim. */
  reason: string;
  /** What KIND of failure it was, in words a reader recognises (not the enum value). */
  category: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/**
 * The pipeline's notification events, in the order the preferences matrix shows them.
 * Both link to `/notes/:id` (root-relative); for the failure that is where Regenerate
 * lives.
 *
 * @extensionPoint
 * @stability experimental
 */
export const NOTES_NOTIFICATION_EVENTS: KvoxNotificationEventDef[] = [
  {
    key: NOTE_READY_NOTIFICATION,
    label: 'Note ready',
    description: 'Sent when a note you asked for finishes generating and can be read and edited.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
    emailTemplate: 'note-ready',
    browserTemplate: (data: never) => {
      const { noteId, title, templateName, wordCount } = data as NoteReadyNotificationData;

      return {
        title: 'Note ready',
        body: `"${title}" is ready: ${wordCount} words from the ${templateName} template.`,
        link: `/notes/${noteId}`,
      };
    },
  },
  {
    key: NOTE_FAILED_NOTIFICATION,
    label: 'Note generation failed',
    description:
      'Sent when a note could not be generated. Carries the reason and a link to the Regenerate action.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
    emailTemplate: 'note-failed',
    browserTemplate: (data: never) => {
      const { noteId, title, reason } = data as NoteFailedNotificationData;

      return {
        title: 'Note generation failed',
        // NO "we will try again": nothing retries this automatically, by design
        // (`maxAttempts: 1`), so a body that implied otherwise would leave the user
        // waiting for something that is never coming.
        body: `"${title}" could not be generated: ${reason}`,
        link: `/notes/${noteId}`,
      };
    },
  },
];
