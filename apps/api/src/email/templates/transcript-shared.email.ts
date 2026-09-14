import { APP_NAME, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// `transcripts.transcript_shared` (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// Sent to the RECIPIENT ONLY, once, after the share row has committed. Never to
// the owner — who just performed the action and needs no confirmation of it —
// and never to the other people the transcript is shared with, who have no
// business learning that somebody new was added.
//
// -----------------------------------------------------------------------------
// THE MESSAGE HAS TO CARRY THE ROLE, NOT JUST THE LINK
// -----------------------------------------------------------------------------
//
// "Someone shared a recording with you" leaves the reader to click through to
// discover whether they can fix the misheard name they are about to find. The
// subject and the first line both name the level, in the reader's language
// ("view" vs "view and correct"), so the mail answers the question it raises.
//
// ⚠ NOTHING ABOUT THE RECORDING'S CONTENT IS IN HERE. No excerpt, no speaker
// names, no duration, no word count — unlike `transcript-ready.email.ts`, whose
// reader already owns the recording. This one goes to somebody who has just
// been granted access to a private conversation, over a channel the owner does
// not control the storage of, so it carries the title (which the owner chose
// and is about to show them anyway) and nothing else.
// =============================================================================

/** Everything the share message renders. */
export interface TranscriptSharedEmailData {
  /** The transcript row's id. Used for the CTA path. */
  transcriptId: string;
  /** The owner's own title. Escaped on the way into the html by the `html` tag. */
  title: string;
  /** What the recipient may now do. */
  role: 'viewer' | 'editor';
  /** Who shared it — display name, falling back to their address. */
  ownerName: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. */
const transcriptPath = (id: string): string => `/transcripts/${id}`;

/** The role as a reader sees it, capitalised for the subject line. */
export function shareRoleLabel(role: 'viewer' | 'editor'): string {
  return role === 'editor' ? 'Editor' : 'Viewer';
}

/** What the role actually lets them do, in plain words. */
export function shareRoleSentence(role: 'viewer' | 'editor'): string {
  return role === 'editor'
    ? 'You can listen to the recording, read the transcript, correct it, and export it. Every correction you make is kept as its own version.'
    : 'You can listen to the recording, read the transcript, and export it. You cannot change it.';
}

/** Render the "somebody shared a transcript with you" message. */
export function transcriptSharedEmail(data: TranscriptSharedEmailData): RenderedEmail {
  const roleLabel = shareRoleLabel(data.role);
  // ⚠ THE TITLE IS DELIBERATELY NOT IN THE SUBJECT, unlike
  // `transcript-ready.email.ts` whose reader owns the recording. A subject line
  // is the one part of an email that renders on a lock screen and in a
  // notification preview, and the title of somebody else's private conversation
  // has no business appearing there before the recipient has even opened it.
  // The body carries it, two lines in.
  const subject = `${data.ownerName} shared a recording with you`;
  const ctaUrl = data.appUrl
    ? `${data.appUrl}${transcriptPath(data.transcriptId)}`
    : undefined;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      <strong>${data.ownerName}</strong> shared the recording
      <strong>${data.title}</strong> with you on ${APP_NAME} as
      <strong>${roleLabel}</strong>.
    </p>
    <p style="margin:0 0 16px 0;">${shareRoleSentence(data.role)}</p>
    <p style="margin:0 0 16px 0;">
      The recording is a private conversation. Please treat both the audio and
      the transcript as confidential, and share them no further without asking.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because somebody shared a recording with your
      ${APP_NAME} account. Only they can change or remove your access, and you
      can remove it yourself at any time from the transcript.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'A recording was shared with you',
    previewText: `${data.ownerName} shared "${data.title}" with you as ${roleLabel}.`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open transcript' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'A recording was shared with you',
    lines: [
      `${data.ownerName} shared the recording "${data.title}" with you on`,
      `${APP_NAME} as ${roleLabel}.`,
      '',
      shareRoleSentence(data.role),
      '',
      'The recording is a private conversation. Please treat both the audio and the',
      'transcript as confidential, and share them no further without asking.',
      '',
      `You are receiving this because somebody shared a recording with your ${APP_NAME}`,
      'account. Only they can change or remove your access, and you can remove it',
      'yourself at any time from the transcript.',
    ],
    ctaLabel: ctaUrl ? 'Open transcript' : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
