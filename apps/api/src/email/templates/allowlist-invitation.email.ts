import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Invitation to join" template — `allowlist.invitation` (issue #128, epic #109)
// =============================================================================
//
// THE ONE MESSAGE IN THIS EPIC WITH OBVIOUS USER VALUE. Today an admin adds an
// address to the allowlist and then tells the person out of band — by chat, by
// hand-written email, or not at all, in which case that person never learns
// they can sign in. This template closes that gap.
//
// -----------------------------------------------------------------------------
// THE RECIPIENT HAS NO ACCOUNT, AND EVERY LINE HERE IS WRITTEN FOR THAT
// -----------------------------------------------------------------------------
//
// This is the only template whose reader is not a user of this system. That
// changes the copy in three specific ways:
//
//   1. **It cannot address them by name.** There is no profile to read one
//      from. The address is the only thing known about them, so the message
//      leads with it.
//   2. **It must say why they are receiving mail from a system they have never
//      heard of**, immediately and in the first sentence, or it reads as spam
//      — which is also how their mail client will treat a click-through.
//   3. **It must not promise an account exists.** Being allowlisted is
//      PERMISSION TO SIGN IN, not a provisioned account: the account is
//      created on their first successful OAuth login (`auth.service.ts`), and
//      until then nothing exists. "Your account is ready" would be a lie that
//      produces a support ticket the first time they expect a password.
//
// WHAT IS DELIBERATELY NOT RENDERED: the allowlist entry's `notes`. That field
// is an administrator's private annotation about a person ("contractor, ends
// in March") written with no expectation that the person will read it. Mailing
// it to them would leak internal commentary to the one reader it was never
// meant for. The payload for this event does not carry it at all, so the
// omission is enforced at the call site rather than remembered here.
// =============================================================================

/**
 * Everything the invitation renders.
 *
 * Note what is absent: no user id, no display name, no preferences, no notes.
 * The recipient is an email address and nothing more, which is exactly what
 * being newly allowlisted means.
 */
export interface AllowlistInvitationEmailData {
  /** The address that was allowlisted, and the one they must sign in with. */
  recipientEmail: string;

  /**
   * The administrator who added them — their display name or email — when
   * known.
   *
   * Optional because `allowed_emails.added_by_id` is nullable (`onDelete:
   * SetNull`), so an entry outlives the admin who created it.
   *
   * DISCLOSED ON PURPOSE, and it is a deliberate trade rather than an
   * oversight. It reveals one internal address to somebody outside the system;
   * in exchange the message is credible ("Oscar added you") instead of
   * anonymous, and the recipient has somebody to ask if they were not
   * expecting it. An unattributed invitation to an unfamiliar application is
   * indistinguishable from a phishing attempt, and the whole point of sending
   * it is that they act on it.
   */
  invitedBy?: string;

  /**
   * Absolute URL of the sign-in page, for the CTA.
   *
   * THE ENTIRE POINT OF THE MESSAGE, and still optional: with no `APP_URL`
   * configured there is no honest link to offer, and a button pointing
   * nowhere is worse than a message that names the application and asks them
   * to find it. The layout omits the button when this is absent.
   */
  signInUrl?: string;
}

/**
 * Render the invitation.
 */
export function allowlistInvitationEmail(
  data: AllowlistInvitationEmailData,
): RenderedEmail {
  const invitedBy = data.invitedBy?.trim();

  const subject = `You have been invited to ${APP_NAME}`;

  const attribution = invitedBy
    ? html`<p style="margin:0 0 16px 0;">
        <strong>${invitedBy}</strong> added your address, so they are the
        person to ask if you were not expecting this.
      </p>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      An administrator has authorised <strong>${data.recipientEmail}</strong>
      to sign in to ${APP_NAME}. You are receiving this message because that
      address was added to the list of people allowed to use the application.
    </p>
    ${attribution}
    <p style="margin:0 0 16px 0;">
      There is no password to set and nothing to accept. Sign in with the Google
      account for that same address and your account is created on the spot. Any
      other address will be refused.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      If you do not recognise ${APP_NAME}, no account has been created and you
      can ignore this message — nothing happens until you sign in.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: `You can now sign in to ${APP_NAME}`,
    // The preheader names the address, because the recipient's first question
    // in a crowded inbox is "is this actually about me?".
    previewText: `${data.recipientEmail} has been authorised to sign in.`,
    bodyHtml,
    ctaLabel: data.signInUrl ? 'Sign in' : undefined,
    ctaUrl: data.signInUrl,
  });

  const lines: string[] = [
    `An administrator has authorised ${data.recipientEmail} to sign in to ${APP_NAME}.`,
    'You are receiving this message because that address was added to the list of people allowed to use the application.',
  ];
  if (invitedBy) {
    lines.push(
      '',
      `${invitedBy} added your address, so they are the person to ask if you were not expecting this.`,
    );
  }
  lines.push(
    '',
    'There is no password to set and nothing to accept. Sign in with the Google account for that',
    'same address and your account is created on the spot. Any other address will be refused.',
    '',
    `If you do not recognise ${APP_NAME}, no account has been created and you can ignore this`,
    'message — nothing happens until you sign in.',
  );

  const text = plainText({
    title: `You can now sign in to ${APP_NAME}`,
    lines: [lines[0]!, ...lines.slice(1)],
    ctaLabel: data.signInUrl ? 'Sign in' : undefined,
    ctaUrl: data.signInUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
