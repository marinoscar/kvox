import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// `notes.note_ready` (issue #49, epic #45)
// =============================================================================
//
// Sent to the OWNER ONLY, once, after `note.generate`'s commit transaction has
// written the body, appended the `ai_generated` version and set the note
// `ready`. Not when the provider's stream ends — that is a fact about a socket,
// and a note whose version has not committed cannot be opened.
//
// ⚠ THIS EMAIL IS HALF OF WHAT MAKES "CLOSE THE TAB AND WALK AWAY" REAL. A
// generation runs for ten seconds to several minutes on somebody else's
// infrastructure; the durable buffer is what lets a returning reader find the
// finished note, and this message is what tells them it is there without them
// having to look.
//
// It names the TEMPLATE and the MODEL because they are the two things a reader
// deciding whether to regenerate actually wants (spec §9: the user is always
// told which vendor their content reached), and the body is deliberately NOT
// included — a note is the user's document, and mailing a copy of it puts
// content they chose to keep in this application into an inbox they did not
// choose.
// =============================================================================

/** Everything the ready message renders. */
export interface NoteReadyEmailData {
  /** The note row's id. Used for the CTA path. */
  noteId: string;
  /** The owner's own title. Escaped on the way into the html by the `html` tag. */
  title: string;
  /** `note_generations.template_name_snapshot` — the recipe that produced it. */
  templateName: string;
  /** Which vendor produced it. Named because §9 says the user is always told. */
  providerLabel: string;
  /** The model id, verbatim. */
  model: string;
  /** Words in the generated note. A size cue, not a quality one. */
  wordCount: number;
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

/** Render the "your note is ready" message. */
export function noteReadyEmail(data: NoteReadyEmailData): RenderedEmail {
  const subject = `${APP_NAME}: "${data.title}" is ready`;
  const ctaUrl = data.appUrl ? `${data.appUrl}${notePath(data.noteId)}` : undefined;

  const rows: SafeHtml[] = [
    detailRow('Note', data.title),
    detailRow('Template', data.templateName),
    detailRow('Written by', `${data.providerLabel} (${data.model})`),
    detailRow('Words', String(data.wordCount)),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      Your note has finished generating and is ready to read and edit.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">
      This is a first draft written by a model from the source you chose. Every
      edit you make is kept as its own version, and you can regenerate it with a
      different template at any time.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      You are receiving this because you asked ${APP_NAME} to write this note.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your note is ready',
    previewText: `${data.title} — ${data.templateName}, ${data.wordCount} words.`,
    bodyHtml,
    ctaLabel: ctaUrl ? 'Open note' : undefined,
    ctaUrl,
  });

  const text = plainText({
    title: 'Your note is ready',
    lines: [
      'Your note has finished generating and is ready to read and edit.',
      '',
      `  Note:        ${data.title}`,
      `  Template:    ${data.templateName}`,
      `  Written by:  ${data.providerLabel} (${data.model})`,
      `  Words:       ${data.wordCount}`,
      '',
      'This is a first draft written by a model from the source you chose. Every edit',
      'you make is kept as its own version, and you can regenerate it with a different',
      'template at any time.',
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
