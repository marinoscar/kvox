import type { TranscriptFailedNotificationData } from '@marinoscar/kvox-api/transcripts';
import { APP_NAME } from '@app/shared';
import {
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  html,
  plainText,
  renderLayout,
  type EmailRenderContext,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

// =============================================================================
// `transcripts.transcript_failed` (issue #25, epic #19)
// =============================================================================
//
// Sent to the OWNER ONLY, by whichever stage set `status: failed` (spec §1.6).
//
// -----------------------------------------------------------------------------
// IT CARRIES THE REASON, AND THE REASON IS THE MESSAGE
// -----------------------------------------------------------------------------
//
// A failure notification that says "something went wrong" costs the reader a
// trip into the application to learn anything at all, and for the two most
// common causes — an unusable file, and a deployment whose provider is not
// configured — the trip tells them nothing they can act on either. So
// `failure_reason` is rendered verbatim. It is written by this application, not
// by the vendor: the taxonomy in `@marinoscar/kvox-api/transcription` (`errors.ts`) is what turns a
// provider's own opaque message into a sentence a person can read.
//
// ⚠ `reason` IS INTERPOLATED INTO HTML AND IS ESCAPED BY CONSTRUCTION. It is
// passed through the `html` tagged literal, which escapes every interpolation,
// so a provider message containing markup cannot become markup. Do not
// "improve" this by building the body with string concatenation.
//
// The CTA opens the transcript, which is where the retry action lives — a
// dedicated retry link in an email would be a state-changing GET reachable by
// anything that prefetches a URL.
// =============================================================================

/** Everything the failure message renders: the slice's notification data (`@marinoscar/kvox-api/transcripts`). */
export type TranscriptFailedEmailData = TranscriptFailedNotificationData;

// Typed registration (issue #460): this domain declares its own template key,
// so the base `EmailTemplateDataMap` names no domain payload.
declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'transcript-failed': TranscriptFailedEmailData;
  }
}

/** Where the CTA points, appended to `appUrl`. */
const transcriptPath = (id: string): string => `/transcripts/${id}`;

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

/** Render the "your transcript failed" message. */
export function transcriptFailedEmail(data: TranscriptFailedEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const subject = `${APP_NAME}: "${data.title}" could not be transcribed`;
  const ctaUrl = data.appUrl
    ? `${data.appUrl}${transcriptPath(data.transcriptId)}`
    : undefined;

  const closing = data.retryable
    ? 'You can try again from the transcript page. The audio you uploaded is still stored, so a retry does not need another upload.'
    : 'This one cannot be retried as it stands. The audio you uploaded is still stored, so you can delete this transcript and start again from the same file.';

  const rows: SafeHtml[] = [
    detailRow('Recording', data.title),
    detailRow('Stage', data.stage),
    detailRow('Reason', data.reason),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      ${APP_NAME} could not finish transcribing your recording.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">${closing}</p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you uploaded this recording to ${APP_NAME}.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Transcription failed',
    previewText: `${data.title} — ${data.reason}`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open transcript' : undefined,
    ctaUrl,
  }, ctx);

  const text = plainText({
    title: 'Transcription failed',
    lines: [
      `${APP_NAME} could not finish transcribing your recording.`,
      '',
      `  Recording:  ${data.title}`,
      `  Stage:      ${data.stage}`,
      `  Reason:     ${data.reason}`,
      '',
      closing,
      '',
      `You are receiving this because you uploaded this recording to ${APP_NAME}.`,
    ],
    ctaLabel: ctaUrl ? 'Open transcript' : undefined,
    ctaUrl,
  }, ctx);

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
