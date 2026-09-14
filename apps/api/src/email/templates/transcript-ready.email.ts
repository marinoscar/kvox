import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// `transcripts.transcript_ready` (issue #25, epic #19)
// =============================================================================
//
// Sent to the OWNER ONLY, once, when `transcription.ingest`'s write
// transaction has committed and version 1 exists. Not when the provider says
// "completed" — that is the provider's word, and a transcript nobody has
// ingested yet cannot be opened.
//
// The body states the three facts that decide whether the reader opens it now
// or later: how long the recording was, how many people were in it, and how
// much text came out. A CTA that opens straight to the transcript is the whole
// point of the message; everything else is context for the moment before the
// click.
// =============================================================================

/** Everything the ready message renders. */
export interface TranscriptReadyEmailData {
  /** The transcript row's id. Used for the CTA path. */
  transcriptId: string;
  /** The owner's own title. Escaped on the way into the html by the `html` tag. */
  title: string;
  /** Media length in milliseconds, or null when the provider never reported one. */
  durationMs: number | null;
  /** Distinct speakers the diarization found. */
  speakerCount: number;
  /** Words in the transcript, as ingested. */
  wordCount: number;
  /** Which vendor produced it. Named because §10 says the user is always told. */
  providerLabel: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. */
const transcriptPath = (id: string): string => `/transcripts/${id}`;

/** `3 h 07 m`, `7 m 12 s`, `48 s`, or a dash when nobody measured it. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 'Not reported';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} m`;
  if (minutes > 0) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;

  return `${seconds} s`;
}

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

/** Render the "your transcript is ready" message. */
export function transcriptReadyEmail(data: TranscriptReadyEmailData): RenderedEmail {
  const duration = formatDuration(data.durationMs);
  const subject = `${APP_NAME}: "${data.title}" is ready`;
  const ctaUrl = data.appUrl
    ? `${data.appUrl}${transcriptPath(data.transcriptId)}`
    : undefined;

  const rows: SafeHtml[] = [
    detailRow('Recording', data.title),
    detailRow('Length', duration),
    detailRow('Speakers', String(data.speakerCount)),
    detailRow('Words', String(data.wordCount)),
    detailRow('Transcribed by', data.providerLabel),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      Your recording has finished transcribing and is ready to read, correct and
      share.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">
      Speaker labels come from automatic diarization and are a starting point —
      you can rename them, correct the text, and every change is kept as its own
      version.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you uploaded this recording to ${APP_NAME}.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your transcript is ready',
    previewText: `${data.title} — ${duration}, ${data.speakerCount} speaker(s).`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open transcript' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Your transcript is ready',
    lines: [
      'Your recording has finished transcribing and is ready to read, correct and',
      'share.',
      '',
      `  Recording:       ${data.title}`,
      `  Length:          ${duration}`,
      `  Speakers:        ${data.speakerCount}`,
      `  Words:           ${data.wordCount}`,
      `  Transcribed by:  ${data.providerLabel}`,
      '',
      'Speaker labels come from automatic diarization and are a starting point - you',
      'can rename them, correct the text, and every change is kept as its own version.',
      '',
      `You are receiving this because you uploaded this recording to ${APP_NAME}.`,
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
