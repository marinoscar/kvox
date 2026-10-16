import type { EmailProviderKind } from '../email-settings.schema';
import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Test email" template (issue #123, epic #109)
// =============================================================================
//
// The message behind #124's "Send test email" button. It ships in #123 rather
// than with the button because the button needs something to send, and because
// it is the first exercise of the layout, the escaping mechanism and the
// mandatory text part — if any of the three is wrong, this is where it shows.
//
// THIS IS A DIAGNOSTIC, NOT A GREETING. #124's entire purpose is telling an
// admin why their mail configuration does not work; epic #109 calls that out
// as the page's whole job. So the body states WHICH transport carried this
// message, WHEN, TO WHOM and AT WHOSE REQUEST. An admin debugging "the test
// said it sent but nothing arrived" needs to know whether the message in front
// of them came from the SES they just switched to or from the SMTP relay they
// switched away from — and a message that only says "it works" cannot answer
// that.
//
// The three real event templates (`user.welcome`, `allowlist.invitation`,
// `security.role_changed`) are #128, deliberately not here.
// =============================================================================

/**
 * Everything the test message renders.
 *
 * NOTE THE ABSENT CLOCK: `sentAt` is passed in rather than read from `new
 * Date()` inside the template. A template that reads the clock is not a pure
 * function of its input, which makes its output untestable without freezing
 * time and makes "what exactly did we send?" unanswerable after the fact.
 * Every template in this module follows the same rule.
 */
export interface TestEmailData {
  /** Address the admin typed into the test form. Echoed back as a check. */
  recipientEmail: string;

  /** Transport that actually carried this message. The key diagnostic fact. */
  providerKind: EmailProviderKind;

  /** When the send was initiated. Rendered as UTC — see `formatTimestamp`. */
  sentAt: Date;

  /**
   * Who pressed the button, if known — display name or email.
   *
   * Optional because the caller may not have it, not because it is
   * decorative: on a system with several admins, "who triggered this" is the
   * difference between a test and an unexplained message in an inbox.
   */
  triggeredBy?: string;

  /**
   * Absolute URL of the admin email settings page, for the CTA.
   *
   * PASSED IN, NOT BUILT HERE. A template that knows the web app's route table
   * is a template that breaks silently when a route moves, and it would have
   * to know `APP_URL` too — configuration a pure renderer has no business
   * reading. #124 has both and supplies the finished URL.
   */
  settingsUrl?: string;
}

/**
 * Human labels for the transports. The stored value (`ses`) is an
 * implementation key; an admin reading their inbox should see the product name
 * they chose in the dropdown.
 *
 * TYPED `Record<EmailProviderKind, string>`, so adding a transport to
 * `EMAIL_PROVIDER_KINDS` fails to compile here until it is named — rather than
 * rendering a blank where the diagnostic fact should be.
 */
const PROVIDER_LABELS: Record<EmailProviderKind, string> = {
  ses: 'Amazon SES',
  smtp: 'SMTP',
};

/**
 * ISO 8601, in UTC, with the `Z` left on.
 *
 * NOT LOCALISED, deliberately. The server does not know the reader's time
 * zone, and a locale-formatted timestamp with no offset ("31/08/2026, 14:05")
 * is ambiguous in exactly the situation this email exists for — correlating a
 * message against a log line or a delivery record, both of which are UTC.
 * An unfamiliar format the reader can match against a log beats a familiar one
 * they cannot.
 */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/**
 * One row of the diagnostic fact table.
 *
 * `value` is interpolated through the `html` tag, so it is escaped — which
 * matters here because `triggeredBy` is a display name that came from an OAuth
 * profile and `recipientEmail` came straight off an admin form.
 */
function factRow(label: string, value: string): SafeHtml {
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

/**
 * Render the test message.
 */
export function testEmail(data: TestEmailData): RenderedEmail {
  const providerLabel = PROVIDER_LABELS[data.providerKind];
  const timestamp = formatTimestamp(data.sentAt);

  // The timestamp is IN THE SUBJECT, which looks like clutter and is not.
  // Gmail and Outlook both thread on identical subject lines, so a second test
  // send collapses into the first one's conversation and is easy to miss
  // entirely — turning "I fixed the config and retried, nothing arrived" into
  // a false negative at the exact moment the admin is trying to tell whether
  // their change worked. Distinct subjects keep each attempt a separate row.
  const subject = `Test email from ${APP_NAME} (${timestamp})`;

  const facts: SafeHtml[] = [
    factRow('Provider', providerLabel),
    factRow('Sent at', timestamp),
    factRow('Delivered to', data.recipientEmail),
  ];
  if (data.triggeredBy) {
    facts.push(factRow('Requested by', data.triggeredBy));
  }

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      Your email configuration works. This message was sent by the
      <strong>Send test email</strong> button on the admin email settings page,
      and its arrival confirms the whole path — settings, credentials,
      transport and delivery.
    </p>
    <p style="margin:0 0 8px 0;">Details of this send:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${facts}
    </table>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      Nobody else received this message, and no further email is sent as a
      result of it.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your email configuration works',
    // The preheader repeats the transport rather than the good news, because
    // the inbox list is where an admin comparing two test sends is looking.
    previewText: `Test message delivered via ${providerLabel} at ${timestamp}.`,
    bodyHtml,
    ctaLabel: data.settingsUrl ? 'Open email settings' : undefined,
    ctaUrl: data.settingsUrl,
  });

  // Hand-written, not stripped from the markup above. Same facts, same order,
  // shaped for a reader with no HTML — see the note above `plainText` in
  // layout.ts.
  const factLines: string[] = [
    `  Provider:      ${providerLabel}`,
    `  Sent at:       ${timestamp}`,
    `  Delivered to:  ${data.recipientEmail}`,
  ];
  if (data.triggeredBy) {
    factLines.push(`  Requested by:  ${data.triggeredBy}`);
  }

  // Split so the leading element is a literal: `PlainTextOptions.lines` is a
  // non-empty tuple, and an array literal whose length TypeScript cannot see
  // (because of the spread) widens to `string[]` and stops satisfying it. That
  // is the type doing its job — it is refusing an argument that might be empty.
  const restLines: string[] = [
    'Its arrival confirms the whole path: settings, credentials, transport and delivery.',
    '',
    'Details of this send:',
    ...factLines,
    '',
    'Nobody else received this message, and no further email is sent as a result of it.',
  ];

  const text = plainText({
    title: 'Your email configuration works',
    lines: [
      'This message was sent by the "Send test email" button on the admin email settings page.',
      ...restLines,
    ],
    ctaLabel: data.settingsUrl ? 'Open email settings' : undefined,
    ctaUrl: data.settingsUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
