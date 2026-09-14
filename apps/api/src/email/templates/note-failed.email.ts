import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// `notes.note_failed` (issue #49, epic #45)
// =============================================================================
//
// Sent to the OWNER ONLY, on any terminal failure of `note.generate`
// (docs/specs/notes.md §2.2). A rate-limit deferral is NOT one: that is an
// invisible backoff the queue handles, and mailing somebody about it would
// report a delay as a failure.
//
// ⚠ IT CARRIES THE REASON, AND THE REASON IS THE MESSAGE — the same argument
// `transcript-failed.email.ts` makes, with one addition specific to this epic:
// the most common failures here are the USER'S OWN to fix (their key was
// revoked, their source is too large for the model they chose), and a message
// that said "something went wrong" would send them to an administrator who
// cannot help. `reason` is written by this application from `ai-errors.ts`'s
// taxonomy — never a raw vendor string, and NEVER anything derived from a key.
//
// ⚠ `reason` IS INTERPOLATED INTO HTML AND IS ESCAPED BY CONSTRUCTION, through
// the `html` tagged literal. Do not "improve" this with string concatenation.
//
// The CTA opens the note, which is where Regenerate lives. A retry link in an
// email would be a state-changing GET reachable by anything that prefetches a
// URL — and here it would spend the user's own money when it did.
// =============================================================================

/** Everything the failure message renders. */
export interface NoteFailedEmailData {
  /** The note row's id. Used for the CTA path. */
  noteId: string;
  /** The owner's own title. Escaped on the way into the html. */
  title: string;
  /** `notes.failure_reason`, verbatim. See the header. */
  reason: string;
  /**
   * What KIND of failure it was, in words a reader recognises ("Your API key",
   * "Too large", "Declined by the provider"). Not the enum value.
   */
  category: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. */
const notePath = (id: string): string => `/notes/${id}`;

/** One row of the detail table. `value` is escaped by the `html` tag. */
function detailRow(label: string, value: string): SafeHtml {
  return html`<tr>
    <td
      style="padding:6px 16px 6px 0;font-size:14px;line-height:20px;color:#4b5563;white-space:nowrap;vertical-align:top;"
    >
      ${label}
    </td>
    <td style="padding:6px 0;font-size:14px;line-height:20px;color:#1f2937;vertical-align:top;">
      <strong>${value}</strong>
    </td>
  </tr>`;
}

/** Render the "your note could not be generated" message. */
export function noteFailedEmail(data: NoteFailedEmailData): RenderedEmail {
  const subject = `${APP_NAME}: "${data.title}" could not be generated`;
  const ctaUrl = data.appUrl ? `${data.appUrl}${notePath(data.noteId)}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Note', data.title),
    detailRow('Problem', data.category),
    detailRow('Reason', data.reason),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      ${APP_NAME} could not finish writing your note.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">
      Nothing was retried automatically: a generation is charged to your own
      provider account and produces different text each time, so asking again is
      deliberately left to you. Open the note and choose Regenerate once the
      cause above is dealt with.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you asked ${APP_NAME} to write this note.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Note generation failed',
    previewText: `${data.title} — ${data.reason}`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open note' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Note generation failed',
    lines: [
      `${APP_NAME} could not finish writing your note.`,
      '',
      `  Note:     ${data.title}`,
      `  Problem:  ${data.category}`,
      `  Reason:   ${data.reason}`,
      '',
      'Nothing was retried automatically: a generation is charged to your own provider',
      'account and produces different text each time, so asking again is deliberately',
      'left to you. Open the note and choose Regenerate once the cause above is dealt',
      'with.',
      '',
      `You are receiving this because you asked ${APP_NAME} to write this note.`,
    ],
    ctaLabel: ctaUrl ? 'Open note' : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
