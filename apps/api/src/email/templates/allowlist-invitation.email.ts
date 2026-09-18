import { TAGLINE } from '@app/shared';

import { emailLogoAttachment } from './brand-logo';
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
//
// -----------------------------------------------------------------------------
// THE ONE TEMPLATE THAT EMBEDS THE LOGO, AND WHY IT IS THIS ONE
// -----------------------------------------------------------------------------
//
// Every other message in this application goes to somebody who already has an
// account and has seen the product; a text wordmark identifies the sender to
// them perfectly well. This one goes to a stranger, about an application they
// may never have heard of, asking them to click a link — which is the exact
// shape of a phishing email. A recognisable mark is worth more here than
// anywhere else, and a CID part is the only way to show one that is not
// blocked on first open (see `layout.ts`'s header for the full distinction
// between an embedded part and a fetched one).
//
// `emailLogoAttachment()` returns `null` when the committed PNG is unreadable,
// and both halves of this template degrade together: no logo means the layout
// renders the text wordmark and `attachments` is omitted, which is exactly the
// message this template produced before the logo existed. The markup and the
// MIME part come from ONE value, so they cannot disagree.
//
// -----------------------------------------------------------------------------
// THE SHAPE OF THE PAGE
// -----------------------------------------------------------------------------
//
// Five blocks, in the order a stranger's questions actually arrive:
//
//   1. Why am I getting this, and is it about me?  -> the lead, naming the
//      address in the first sentence (constraint 2 above).
//   2. Who sent it?                                -> the attribution callout,
//      when known. Given its own bordered block rather than a sentence buried
//      mid-paragraph, because "a person I recognise put me here" is the single
//      strongest signal that this is not phishing.
//   3. What IS this?                               -> the product line, from
//      `TAGLINE` in `packages/shared` — the same manifest the web app and the
//      CLI read, so a rebrand carries it and nothing here has to be rewritten.
//   4. What if I have never heard of it?           -> the fine print, which
//      says nothing has happened and nothing will.
//   5. What do I do?                               -> the how-to, placed LAST
//      so it sits immediately above the button the layout appends. A CTA whose
//      explanation is three paragraphs further up is a CTA people hesitate on.
//
// ONE call to action, deliberately. A second link ("learn more", "contact the
// administrator") competes with the only action that does anything, and the
// attribution block already names somebody to ask.
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

  // Block 2. A left-accented, tinted cell rather than a paragraph — see the
  // header's note on why the inviter's name is the strongest anti-phishing
  // signal this message has and therefore earns its own block.
  //
  // `bgcolor` accompanies the CSS background and the accent is a BORDER on a
  // `<td>`, both because the Word engine drops CSS backgrounds on table
  // elements and ignores most other ways of drawing a rule. The tint is the
  // page background (#f4f5f7) on the white card, so it reads as a recess under
  // forced dark-mode inversion too: both are extremes, and it is mid-tones
  // that collapse when a client inverts (see `layout.ts`'s palette note).
  const attribution = invitedBy
    ? html`<table
        role="presentation"
        width="100%"
        cellpadding="0"
        cellspacing="0"
        border="0"
        style="margin:0 0 20px 0;"
      >
        <tr>
          <td
            bgcolor="#f4f5f7"
            style="background:#f4f5f7;border-left:3px solid #2f4f8f;border-radius:0 6px 6px 0;padding:12px 16px;font-size:14px;line-height:21px;color:#1f2937;"
          >
            Added by <strong>${invitedBy}</strong><br />
            <span style="color:#4b5563;"
              >They are the person to ask if you were not expecting this.</span
            >
          </td>
        </tr>
      </table>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`
    <p style="margin:0 0 20px 0;">
      Your address <strong>${data.recipientEmail}</strong> has been added to the
      list of people allowed to use ${APP_NAME}. That is why you are receiving
      this message.
    </p>
    ${attribution}
    <p style="margin:0 0 16px 0;">
      <strong>${APP_NAME}</strong> — ${TAGLINE} Access is by invitation only,
      which is why an administrator had to add you before you could sign in.
    </p>
    <p style="margin:0 0 20px 0;font-size:13px;line-height:20px;color:#4b5563;">
      If you do not recognise ${APP_NAME}, nothing has been created in your name
      and you can ignore this message — nothing happens until you sign in.
    </p>
    <!-- The last block before the layout appends the button, which brings only
         8px of its own top padding; a primary action wants more air than that
         and the margin is cheaper than changing the padding for every other
         template that uses the same CTA block. -->
    <p style="margin:0 0 8px 0;">
      There is no password to set and nothing to accept. Sign in with the Google
      account for that same address and your account is created on the spot; any
      other address will be refused.
    </p>
  `;

  // Both halves of the logo come from ONE value: the markup below asks for it
  // by handing `renderLayout` the attachment itself, and the same object is
  // returned as the message's MIME part. `null` (an image built without the
  // asset) renders the text wordmark and attaches nothing — see the header.
  const logo = emailLogoAttachment();

  const htmlDocument = renderLayout({
    title: `You can now sign in to ${APP_NAME}`,
    // The preheader names the address, because the recipient's first question
    // in a crowded inbox is "is this actually about me?".
    previewText: `${data.recipientEmail} has been authorised to sign in.`,
    bodyHtml,
    ...(logo ? { logo } : {}),
    ctaLabel: data.signInUrl ? 'Sign in' : undefined,
    ctaUrl: data.signInUrl,
  });

  // HAND-WRITTEN, in the same five-block order as the HTML — there is
  // deliberately no HTML-to-text helper anywhere in this module (see
  // `layout.ts`'s note above `plainText` for the two reasons). It follows that
  // an edit to the markup above that is not made here ships a message whose
  // two halves say different things, which no test catches unless it asserts
  // on both. `allowlist-invitation.email.spec.ts` does.
  //
  // The logo has no text-part equivalent and needs none: the `alt` covers the
  // HTML reader with images off, and `plainText` already opens with the
  // product name.
  const lines: string[] = [
    `Your address ${data.recipientEmail} has been added to the list of people allowed to use`,
    `${APP_NAME}. That is why you are receiving this message.`,
  ];
  if (invitedBy) {
    lines.push(
      '',
      `Added by ${invitedBy}. They are the person to ask if you were not expecting this.`,
    );
  }
  lines.push(
    '',
    `${APP_NAME} — ${TAGLINE} Access is by invitation only, which is why an administrator`,
    'had to add you before you could sign in.',
    '',
    `If you do not recognise ${APP_NAME}, nothing has been created in your name and you can`,
    'ignore this message — nothing happens until you sign in.',
    '',
    'There is no password to set and nothing to accept. Sign in with the Google account for',
    'that same address and your account is created on the spot; any other address will be',
    'refused.',
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
    // Present only when the asset was readable, and it is the SAME object the
    // markup above was rendered from — so a `cid:` with no part behind it is
    // not a state this template can produce.
    ...(logo ? { attachments: [logo] } : {}),
  };
}
