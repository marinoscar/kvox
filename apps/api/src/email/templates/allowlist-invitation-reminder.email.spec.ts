import { APP_NAME, TAGLINE } from '@app/shared';

import {
  allowlistInvitationReminderEmail,
  type AllowlistInvitationReminderEmailData,
} from './allowlist-invitation-reminder.email';
import { allowlistInvitationEmail } from './allowlist-invitation.email';
import {
  EMAIL_LOGO_CID,
  emailLogoAttachment,
  resetEmailLogoCacheForTests,
} from './brand-logo';

// =============================================================================
// The invitation reminder — tests (#301, epic #271)
// =============================================================================
//
// `index.spec.ts` already runs the shared contract over every registered
// template (non-empty subject/html/text, escaping, no remote asset, no cid
// without a part). What is asserted HERE is what is specific to the reminder:
//
//   * the three constraints its header re-states from the invitation — it
//     cannot address the reader by name, it must say why they are receiving it
//     in the first sentence, and it must not claim an account exists;
//   * the date it adds, and the count it REFUSES to add;
//   * the administrator's `notes` are not in it, and cannot be;
//   * ⚠ EVERY CLAIM CHECKED IN BOTH PARTS, for the reason the invitation's own
//     suite gives: there is deliberately no HTML-to-text helper in this module,
//     so the two halves are written separately and an edit to one that misses
//     the other ships a message that says two different things.
// =============================================================================

/**
 * Collapse runs of whitespace before asserting on PROSE.
 *
 * The markup is written across source lines for readability, so a sentence in
 * the rendered document carries whatever newline and indentation the template
 * literal happened to put inside it. Asserting on the copy without this passes
 * or fails on where a line wrapped, which is not a property worth pinning —
 * the markup-shaped assertions below deliberately do NOT go through it.
 */
const squish = (value: string): string => value.replace(/\s+/g, ' ');

const data: AllowlistInvitationReminderEmailData = {
  recipientEmail: 'sam@example.test',
  invitedAt: new Date('2026-01-15T10:00:00.000Z'),
  invitedBy: 'Oscar Marin',
  signInUrl: 'https://app.example.test/login',
};

beforeEach(() => {
  resetEmailLogoCacheForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetEmailLogoCacheForTests();
});

describe('allowlistInvitationReminderEmail — the three constraints it inherits', () => {
  it('names the recipient address in the first sentence of both parts', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    const firstHtmlParagraph = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(rendered.html);

    expect(firstHtmlParagraph?.[1]).toContain(data.recipientEmail);
    expect(rendered.text).toContain(data.recipientEmail);
    // The preheader carries it too, so the inbox list answers "is this about
    // me, and have I seen it already?" before the message is opened.
    expect(squish(rendered.html)).toContain(
      `${data.recipientEmail} was invited on 15 January 2026 and has not signed in yet.`,
    );
  });

  it('says in the first sentence why this mail is arriving', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain('That is why you are receiving this reminder.');
    expect(rendered.text).toContain('receiving this reminder.');
  });

  it('never addresses the recipient by name — there is still no profile to read one from', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.html).not.toMatch(/\bDear\b|\bHi\b|\bHello\b/);
    expect(rendered.text).not.toMatch(/\bDear\b|\bHi\b|\bHello\b/);
  });

  it('does not claim an account exists, in either part', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    for (const part of [rendered.html, rendered.text]) {
      expect(part).not.toMatch(/your account is ready/i);
      expect(part).not.toMatch(/account has been created for you/i);
      expect(part).not.toMatch(/account (?:is )?waiting/i);
      expect(part).not.toMatch(/set (?:a |your )?password/i);
    }
  });

  it('says there is still no password and that the account is created on sign-in, in both parts', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain('There is still no password to set');
    expect(rendered.text).toContain('There is still no password to set');
    expect(squish(rendered.html)).toContain('created on the spot');
    expect(rendered.text).toContain('created on the spot');
  });

  it('reassures a reader who has never heard of this deployment, in both parts', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain('nothing has been created in your name');
    expect(rendered.text).toContain('nothing has been created in your name');
  });

  it('promises no further mail without a human sending it — true, because there is no scheduler', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain(
      'No further mail follows unless an administrator sends it by hand.',
    );
    expect(rendered.text).toContain('No further mail follows unless');
  });
});

describe('allowlistInvitationReminderEmail — the date it says, and the count it does not', () => {
  it('states when the invitation was issued, in both parts, as a human date', () => {
    // "A while ago" is the entire reason this message exists; a reminder that
    // cannot say when is just the invitation sent twice.
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain('on 15 January 2026');
    expect(rendered.text).toContain('on 15 January 2026');
    // NOT an ISO timestamp: the operational templates render those because
    // they are matched against audit rows; this one is read by a stranger.
    expect(rendered.html).not.toContain('2026-01-15T10:00:00.000Z');
    expect(rendered.text).not.toContain('2026-01-15T10:00:00.000Z');
  });

  it('renders the same date regardless of the server time zone', () => {
    // The zone is pinned to UTC inside the template, so the rendered string is
    // a pure function of the payload rather than of the host's `TZ`.
    const rendered = allowlistInvitationReminderEmail({
      ...data,
      invitedAt: new Date('2026-01-15T23:30:00.000Z'),
    });

    expect(squish(rendered.html)).toContain('on 15 January 2026');
  });

  it('says nothing about how many reminders have been sent, in any part', () => {
    // ⚠ THE DELIBERATE OMISSION. `reminderCount` is internal bookkeeping for
    // the admin console: telling somebody "this is the third time we have
    // emailed you" reads as an accusation, makes the message about the
    // sender's persistence rather than the reader's next step, and would be a
    // claim this application cannot honestly make — the counter records
    // reminders HANDED OFF, not delivered. The payload type does not carry it,
    // so this asserts the copy has not grown a way to imply it either.
    const rendered = allowlistInvitationReminderEmail(data);

    for (const part of [rendered.html, rendered.text, rendered.subject]) {
      expect(part).not.toMatch(/\b(?:second|third|fourth|\d+(?:st|nd|rd|th))\s+(?:time|reminder|email)/i);
      expect(part).not.toMatch(/we have (?:already )?(?:emailed|contacted|reminded)/i);
      expect(part).not.toMatch(/reminder(?:s)? (?:number|#|sent)/i);
    }
  });

  it('cannot be handed a reminder count at all — the payload type does not carry one', () => {
    // Structural, not remembered: passing `reminderCount` is a compile error,
    // and this pins that an excess property at runtime renders nowhere either.
    const smuggled = {
      ...data,
      reminderCount: 7,
    } as AllowlistInvitationReminderEmailData;

    // Compared against the same payload WITHOUT the excess property rather
    // than grepping for "7" — the layout's own palette is full of hex colours
    // containing that digit, so a substring check would pass for the wrong
    // reason. Byte-identical output is the honest assertion: the field changes
    // nothing at all.
    expect(allowlistInvitationReminderEmail(smuggled)).toEqual(
      allowlistInvitationReminderEmail(data),
    );
  });
});

describe('allowlistInvitationReminderEmail — hierarchy and the single call to action', () => {
  it('announces itself as a reminder in the subject line', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.subject).toBe(`Reminder: your invitation to ${APP_NAME}`);
    // …and is therefore distinguishable in an inbox from the original message.
    expect(rendered.subject).not.toBe(
      allowlistInvitationEmail({
        recipientEmail: data.recipientEmail,
        invitedBy: data.invitedBy as string,
        signInUrl: data.signInUrl as string,
      }).subject,
    );
  });

  it('answers "what is this?" from the shared brand manifest, not from prose typed here', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(squish(rendered.html)).toContain(TAGLINE);
    expect(rendered.text).toContain(TAGLINE);
    expect(squish(rendered.html)).toContain('Access is by invitation only');
    expect(rendered.text).toContain('Access is by invitation only');
  });

  it('gives the inviting administrator their own block, in both parts', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.html).toContain('Added by <strong>Oscar Marin</strong>');
    expect(rendered.html).toContain(
      'They are the person to ask if you were not expecting this.',
    );
    expect(rendered.text).toContain('Added by Oscar Marin.');
  });

  it('omits the attribution entirely when the administrator is unknown', () => {
    const { invitedBy: _omitted, ...withoutInviter } = data;
    const rendered = allowlistInvitationReminderEmail(withoutInviter);

    expect(rendered.html).not.toContain('Added by');
    expect(rendered.text).not.toContain('Added by');
    expect(rendered.html).toContain(data.recipientEmail);
    expect(rendered.text).toContain(data.recipientEmail);
  });

  it('carries exactly one link, and it is the sign-in button', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    const anchors = [...rendered.html.matchAll(/<a\b[^>]*href="([^"]*)"/gi)];

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.[1]).toBe(data.signInUrl);
    expect(rendered.text).toContain(`Sign in: ${data.signInUrl}`);
  });

  it('places the sign-in instruction immediately before the button', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    const instruction = rendered.html.indexOf('There is still no password to set');
    const button = rendered.html.indexOf(`href="${data.signInUrl}"`);
    const fine = rendered.html.indexOf('nothing has been created in your name');

    expect(instruction).toBeGreaterThan(fine);
    expect(button).toBeGreaterThan(instruction);
  });

  it('drops the button from both parts when no sign-in URL is configured', () => {
    const { signInUrl: _omitted, ...withoutUrl } = data;
    const rendered = allowlistInvitationReminderEmail(withoutUrl);

    expect(rendered.html).not.toMatch(/<a\b/);
    expect(rendered.text).not.toContain('Sign in:');
    expect(rendered.html).toContain(data.recipientEmail);
  });
});

describe('allowlistInvitationReminderEmail — the embedded logo', () => {
  it('references the logo by content id and attaches the very same bytes', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
    expect(rendered.attachments).toHaveLength(1);

    const [attachment] = rendered.attachments ?? [];

    expect(attachment?.cid).toBe(EMAIL_LOGO_CID);
    expect(attachment?.contentType).toBe('image/png');
    expect(attachment).toBe(emailLogoAttachment());
  });

  it('falls back to the text wordmark, and attaches nothing, when the asset is unreadable', () => {
    jest.spyOn(require('node:fs'), 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    resetEmailLogoCacheForTests();

    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.attachments).toBeUndefined();
    expect(rendered.html).not.toContain('cid:');
    expect(rendered.html).not.toMatch(/<img\b/i);
    expect(rendered.html).toContain(APP_NAME);
    expect(rendered.text).toBe(allowlistInvitationReminderEmail(data).text);
  });
});

describe('allowlistInvitationReminderEmail — what must never be in it', () => {
  it('escapes a hostile display name rather than rendering it as markup', () => {
    const rendered = allowlistInvitationReminderEmail({
      ...data,
      invitedBy: '<script>alert(document.cookie)</script>',
    });

    expect(rendered.html).not.toContain('<script>alert(document.cookie)</script>');
    expect(rendered.html).toContain(
      '&lt;script&gt;alert(document.cookie)&lt;/script&gt;',
    );
    // The text part is not markup and must NOT be escaped.
    expect(rendered.text).toContain('<script>alert(document.cookie)</script>');
    expect(rendered.text).not.toContain('&lt;script&gt;');
  });

  it('cannot render the allowlist entry’s private notes — the payload does not carry them', () => {
    const smuggled = {
      ...data,
      notes: 'CONTRACTOR-ENDS-IN-MARCH',
    } as AllowlistInvitationReminderEmailData;

    const rendered = allowlistInvitationReminderEmail(smuggled);

    expect(rendered.html).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
    expect(rendered.text).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
    expect(rendered.subject).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
  });

  it('marks itself auto-generated so nothing replies to it', () => {
    const rendered = allowlistInvitationReminderEmail(data);

    expect(rendered.headers?.['Auto-Submitted']).toBe('auto-generated');
    expect(rendered.headers?.['X-Auto-Response-Suppress']).toBe('All');
  });
});
