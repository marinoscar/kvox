import type { KvoxNotificationEventDef } from '../ports/index.js';

// =============================================================================
// The transcript pipeline's notifications (issues #25 and #29, epic #19; moved
// into the slice by issue #493, epic #491)
// =============================================================================
//
// Two events, addressed to the transcript's OWNER with `notify(key, ownerId,
// ...)`: a transcript is a fact about one person (their recording, their private
// data), so neither is ever raised for a permission holder. (`transcripts.
// transcript_shared`, issue #29, is retired: a share is a platform grant since
// #485 and the recipient hears about it from the host's sharing slice.)
//
// NONE IS `mandatory`. Being told your own upload finished is a courtesy, not a
// security-relevant change to your own privileges. A user who transcribes twenty
// files a day is entitled to turn them off.
//
// THE KEYS, THE LABELS AND THE TEMPLATE NAMES ARE PERSISTED: a user's preference
// row names the key and the email-template registry the template. Never rename
// one. The email TEMPLATES themselves are the host's (`emailTemplate` names them).
// =============================================================================

/** The event raised when a transcript is ready. @stability experimental */
export const TRANSCRIPT_READY_EVENT = 'transcripts.transcript_ready';

/** The event raised when a transcript failed. @stability experimental */
export const TRANSCRIPT_FAILED_EVENT = 'transcripts.transcript_failed';

/**
 * What the ready notification renders. The host's email template and the
 * in-app text read exactly these fields.
 *
 * @stability experimental
 */
export interface TranscriptReadyNotificationData {
  /** The transcript row's id. Used for the CTA path. */
  transcriptId: string;
  /** The owner's own title. */
  title: string;
  /** Media length in milliseconds, or null when the provider never reported one. */
  durationMs: number | null;
  /** Distinct speakers the diarization found. */
  speakerCount: number;
  /** Words in the transcript, as ingested. */
  wordCount: number;
  /** Which vendor produced it. Named because the user is always told. */
  providerLabel: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/**
 * What the failed notification renders.
 *
 * @stability experimental
 */
export interface TranscriptFailedNotificationData {
  /** The transcript row's id. */
  transcriptId: string;
  /** The owner's own title. */
  title: string;
  /** Why it failed, written for a person. */
  reason: string;
  /** Which part of the pipeline it failed in. */
  stage: string;
  /** Whether the owner's retry button can plausibly help. */
  retryable: boolean;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/**
 * The pipeline's notification events, in the order the preferences matrix shows
 * them. Both link to `/transcripts/:id`, a REAL destination in both cases (for a
 * failure it is where the retry action lives); root-relative, as a host's link
 * sanitiser requires.
 *
 * @extensionPoint
 * @stability experimental
 */
export const TRANSCRIPTS_NOTIFICATION_EVENTS: KvoxNotificationEventDef[] = [
  {
    key: TRANSCRIPT_READY_EVENT,
    label: 'Transcript ready',
    description:
      'Sent when one of your recordings finishes transcribing and can be read, corrected and shared.',
    // Both channels: a transcription takes minutes to hours, so the reader has
    // usually closed the tab (which is what an email is for) while somebody
    // still in the application gets the toast that saves them polling.
    channels: ['email', 'browser'],
    defaultEnabled: true,
    emailTemplate: 'transcript-ready',
    browserTemplate: (data: never) => {
      const { transcriptId, title, speakerCount, wordCount } = data as TranscriptReadyNotificationData;

      return {
        title: 'Transcript ready',
        body:
          `"${title}" finished transcribing: ${speakerCount} speaker(s), ` +
          `${wordCount} words. It is ready to read and correct.`,
        link: `/transcripts/${transcriptId}`,
      };
    },
  },
  {
    key: TRANSCRIPT_FAILED_EVENT,
    label: 'Transcription failed',
    description:
      'Sent when one of your recordings could not be transcribed. Carries the reason and a link to retry it.',
    channels: ['email', 'browser'],
    defaultEnabled: true,
    emailTemplate: 'transcript-failed',
    browserTemplate: (data: never) => {
      const { transcriptId, title, reason, retryable } = data as TranscriptFailedNotificationData;

      return {
        title: 'Transcription failed',
        body:
          `"${title}" could not be transcribed: ${reason}` +
          (retryable ? ' You can try again from the transcript page.' : ''),
        link: `/transcripts/${transcriptId}`,
      };
    },
  },
];
