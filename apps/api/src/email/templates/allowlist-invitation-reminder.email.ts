import { TAGLINE } from '@app/shared';

import { emailLogoAttachment } from './brand-logo';
import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Invitation reminder" template — `allowlist.invitation_reminder` (#301,
// epic #271)
// =============================================================================
//
// THE SIBLING OF `allowlist-invitation.email.ts`, NOT A FORK OF IT. Same
// reader, same five blocks, same logo, same single call to action — the one
// thing that differs is the opening, because the message being sent is no
// longer "you have been invited" but "you were invited a while ago and have
// not signed in yet".
//
// It is sent by an ADMINISTRATOR PRESSING A BUTTON (`POST
// /api/allowlist/:id/reminder`). There is no scheduler, no cron and no job
// type behind it, deliberately — see `AllowlistService.sendReminder`.
//
// -----------------------------------------------------------------------------
// EVERY CONSTRAINT THE INVITATION STATES APPLIES HERE, UNCHANGED
// -----------------------------------------------------------------------------
//
// Re-stated rather than cross-referenced, because a constraint a reader has to
// open another file to learn is a constraint the next edit breaks:
//
//   1. **It cannot address them by name.** There is still no profile to read
//      one from — not signing in is precisely why this message exists, so the
//      address remains the only thing known about them.
//   2. **It must say why they are receiving mail from a system they may not
//      remember**, in the first sentence. This is even sharper here than in
//      the invitation: enough time has passed that an admin felt the need to
//      nudge, so the original message is, at best, far down their inbox.
//   3. **It must not promise an account exists.** Being allowlisted is
//      PERMISSION TO SIGN IN; the account is created on the first successful
//      OAuth login (`auth.service.ts`). A reminder that said "your account is
//      waiting for you" would be a lie that has now been told twice.
//
// WHAT IS DELIBERATELY NOT RENDERED, exactly as in the invitation: the
// allowlist entry's `notes`. It is an administrator's private annotation about
// a person ("contractor, ends in March"), written with no expectation that the
// person will read it. The payload for this event does not carry the field at
// all, so the omission is enforced at the call site rather than remembered
// here.
//
// -----------------------------------------------------------------------------
// WHAT THE REMINDER ADDS: THE DATE. WHAT IT REFUSES TO ADD: THE COUNT.
// -----------------------------------------------------------------------------
//
// `invitedAt` IS RENDERED. "A while ago" is the entire reason this message
// exists, and a reminder that does not say when the invitation was issued asks
// the reader to take the sender's word for the one fact that makes it a
// reminder rather than a duplicate. It also tells somebody who genuinely never
// received the first message how far back to look.
//
// `reminderCount` IS NOT RENDERED, AND THE DECISION IS DELIBERATE. The column
// exists (`allowed_emails.reminder_count`) and this template could easily take
// it, so the reason it does not is worth writing down:
//
//   * It is INTERNAL BOOKKEEPING. The count answers an administrator's
//     question — "have I already chased this person, and how hard?" — and the
//     admin console is where that question is asked. It answers no question
//     the recipient has.
//   * Telling somebody "this is the third time we have emailed you" makes the
//     message about the sender's persistence rather than about the reader's
//     next step, and it reads as an accusation of having ignored the first
//     two. The recipient's most likely truthful answer is that they never saw
//     them — a spam folder, a forwarding rule, a shared mailbox — and a
//     message that opens by counting their failures is one they are less
//     likely to act on, which defeats the only purpose it has.
//   * It would also be a claim this application cannot honestly make. The
//     counter records reminders REQUESTED AND HANDED OFF to the dispatcher,
//     not reminders delivered (see `AllowlistService.sendReminder` — `notify`
//     is detached and a failed send becomes a `notification_deliveries` row).
//     "We have emailed you three times" may therefore be false in the exact
//     case where it matters most: the sends failed and that is why nothing was
//     ever seen.
//
// So the data type below does not carry the count at all, which makes the
// decision structural rather than a line of copy somebody can restore by
// accident.
//
// -----------------------------------------------------------------------------
// THE SHAPE OF THE PAGE
// -----------------------------------------------------------------------------
//
// The invitation's five blocks, in the same order and for the same reasons
// (its header carries the full argument), with block 1 rewritten and block 4
// gaining one sentence:
//
//   1. Why am I getting this, and is it about me?  -> the lead, naming the
//      address AND the date it was allowlisted in the first sentence.
//   2. Who sent it?                                -> the attribution callout,
//      when known — still the strongest anti-phishing signal this message has,
//      and worth more here than in the invitation, since a second unexpected
//      email from an unfamiliar system is more suspicious than the first.
//   3. What IS this?                               -> the product line, from
//      `TAGLINE` in `packages/shared`.
//   4. What if I have never heard of it?           -> the fine print, which
//      says nothing has happened, nothing will, and — new here — that no
//      further mail follows unless an administrator sends it by hand. That is
//      a TRUE statement about this feature (no scheduler exists) and it is the
//      reassurance a reminder specifically owes a reader who wants to ignore
//      it.
//   5. What do I do?                               -> the how-to, immediately
//      above the button the layout appends.
//
// ONE call to action, deliberately, exactly as in the invitation.
// =============================================================================

/**
 * Everything the reminder renders.
 *
 * The invitation's payload plus `invitedAt`, and conspicuously WITHOUT
 * `reminderCount` — see the header for why that omission is enforced by this
 * type rather than by the copy.
 */
export interface AllowlistInvitationReminderEmailData {
  /** The address that was allowlisted, and the one they must sign in with. */
  recipientEmail: string;

  /**
   * When the address was added to the allowlist (`allowed_emails.added_at`).
   *
   * REQUIRED, unlike every other field here: the column is `NOT NULL` with a
   * default, so every row has one, and a reminder that cannot say when the
   * invitation was issued is just the invitation sent twice.
   */
  invitedAt: Date;

  /**
   * The administrator who added them — their display name or email — when
   * known.
   *
   * Optional because `allowed_emails.added_by_id` is nullable (`onDelete:
   * SetNull`), so an entry outlives the admin who created it. Disclosed on
   * purpose, for the credibility reason the invitation's own payload type
   * spells out in full.
   */
  invitedBy?: string;

  /**
   * Absolute URL of the sign-in page, for the CTA.
   *
   * Optional for the same reason as the invitation's: with no `APP_URL`
   * configured there is no honest link to offer, and the layout omits the
   * button rather than rendering one that goes nowhere.
   */
  signInUrl?: string;
}

/**
 * The date the invitation was issued, as a human reads it.
 *
 * NOT `toISOString()`, which is what `role-changed.email.ts`,
 * `test-email.email.ts` and the operational templates use — and the divergence
 * is the point. Those timestamps exist to be matched against an audit row or a
 * log line, so UTC precision beats readability. This one exists to let a
 * stranger think "oh, that was back in January", and `2026-01-15T10:00:00.000Z`
 * is a worse answer to that than `15 January 2026`.
 *
 * `en-GB` with an explicit `UTC` zone: day-before-month is unambiguous where
 * `1/15/2026` versus `15/1/2026` is not, and pinning the zone keeps the
 * rendered string a pure function of its input rather than of the server's
 * `TZ`. The server does not know the reader's zone, and a day's drift does not
 * matter in a sentence whose whole meaning is "a while ago".
 */
function formatInvitedOn(value: Date): string {
  return value.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Render the reminder.
 */
export function allowlistInvitationReminderEmail(
  data: AllowlistInvitationReminderEmailData,
): RenderedEmail {
  const invitedBy = data.invitedBy?.trim();
  const invitedOn = formatInvitedOn(data.invitedAt);

  // "Reminder:" leads the subject line, because the inbox list is where a
  // reader decides whether this is the message they already have. Naming the
  // application rather than the sender keeps it recognisable next to the
  // original invitation, which is the message this one is asking them to
  // remember.
  const subject = `Reminder: your invitation to ${APP_NAME}`;

  // Block 2, identical in markup to the invitation's — same bordered cell,
  // same `bgcolor` beside the CSS background (the Word engine drops CSS
  // backgrounds on table elements), same border-as-accent, same page-background
  // tint that survives forced dark-mode inversion. Copied rather than shared
  // because the two templates are each meant to be readable end to end; if a
  // third message ever needs this cell, that is the moment to lift it into
  // `layout.ts`, not before.
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
      Your address <strong>${data.recipientEmail}</strong> was added to the list
      of people allowed to use ${APP_NAME} on ${invitedOn}, and has not been
      used to sign in yet. That is why you are receiving this reminder.
    </p>
    ${attribution}
    <p style="margin:0 0 16px 0;">
      <strong>${APP_NAME}</strong> — ${TAGLINE} Access is by invitation only,
      which is why an administrator had to add you before you could sign in.
    </p>
    <p style="margin:0 0 20px 0;font-size:13px;line-height:20px;color:#4b5563;">
      If you do not recognise ${APP_NAME}, nothing has been created in your name
      and you can ignore this message — nothing happens until you sign in. No
      further mail follows unless an administrator sends it by hand.
    </p>
    <!-- Last block before the layout appends the button, which brings only 8px
         of its own top padding; see the invitation's note on why the extra
         margin lives here rather than in the shared CTA block. -->
    <p style="margin:0 0 8px 0;">
      There is still no password to set and nothing to accept. Sign in with the
      Google account for that same address and your account is created on the
      spot; any other address will be refused.
    </p>
  `;

  // One value produces both halves of the logo — the markup below and the MIME
  // part returned at the end — so a `cid:` with no part behind it is not a
  // state this template can reach. `null` (the asset unreadable) renders the
  // text wordmark and attaches nothing. Same mechanism, same reasoning, as the
  // invitation: this message goes to a stranger and asks them to click a link,
  // which is the shape of a phishing email, so a recognisable mark that is not
  // blocked on first open is worth more here than anywhere else.
  const logo = emailLogoAttachment();

  const htmlDocument = renderLayout({
    title: `You can still sign in to ${APP_NAME}`,
    // The preheader names the address AND the fact that this is a reminder,
    // because the reader's first question in a crowded inbox is "is this
    // actually about me, and have I seen it already?".
    previewText: `${data.recipientEmail} was invited on ${invitedOn} and has not signed in yet.`,
    bodyHtml,
    ...(logo ? { logo } : {}),
    ctaLabel: data.signInUrl ? 'Sign in' : undefined,
    ctaUrl: data.signInUrl,
  });

  // HAND-WRITTEN, in the same five-block order as the HTML — there is
  // deliberately no HTML-to-text helper in this module (see `layout.ts`'s note
  // above `plainText` for the two reasons). An edit to the markup above that is
  // not made here ships a message whose two halves say different things, which
  // no test catches unless it asserts on both; this template's spec does.
  const lines: string[] = [
    `Your address ${data.recipientEmail} was added to the list of people allowed to use`,
    `${APP_NAME} on ${invitedOn}, and has not been used to sign in yet. That is why you are`,
    'receiving this reminder.',
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
    'ignore this message — nothing happens until you sign in. No further mail follows unless',
    'an administrator sends it by hand.',
    '',
    'There is still no password to set and nothing to accept. Sign in with the Google account',
    'for that same address and your account is created on the spot; any other address will be',
    'refused.',
  );

  const text = plainText({
    title: `You can still sign in to ${APP_NAME}`,
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
    // markup above was rendered from.
    ...(logo ? { attachments: [logo] } : {}),
  };
}
