import { APP_NAME, TAGLINE } from '@app/shared';

import {
  allowlistInvitationEmail,
  type AllowlistInvitationEmailData,
} from './allowlist-invitation.email';
import {
  EMAIL_LOGO_CID,
  emailLogoAttachment,
  resetEmailLogoCacheForTests,
} from './brand-logo';

// =============================================================================
// The invitation — tests
// =============================================================================
//
// `index.spec.ts` already runs the shared contract over every registered
// template (non-empty subject/html/text, escaping, no remote asset, no cid
// without a part). What is asserted HERE is what is specific to the one
// message in this application whose reader has no account and may never have
// heard of this deployment:
//
//   * the three constraints its own header lists — it cannot address them by
//     name, it must say why they are receiving it in the first sentence, and
//     it must not claim an account exists;
//   * the administrator's `notes` are not in it, and cannot be;
//   * the embedded logo and its fallback, in BOTH directions;
//   * ⚠ EVERY CLAIM CHECKED IN BOTH PARTS. There is deliberately no
//     HTML-to-text helper in this module (layout.ts's own header says why), so
//     the two halves are written separately and an edit to one that misses the
//     other ships a message that says two different things. A test that looked
//     only at `rendered.html` would not notice.
// =============================================================================

const data: AllowlistInvitationEmailData = {
  recipientEmail: 'sam@example.test',
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

describe('allowlistInvitationEmail — the three constraints in its header', () => {
  it('names the recipient address in the first sentence of both parts', () => {
    const rendered = allowlistInvitationEmail(data);

    // "Is this actually about me?" is a stranger's first question, and the
    // address is the only thing this message knows about them.
    const firstHtmlParagraph = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(rendered.html);

    expect(firstHtmlParagraph?.[1]).toContain(data.recipientEmail);
    expect(rendered.text).toContain(data.recipientEmail);
    // The preheader carries it too, so the inbox list answers the question
    // before the message is even opened.
    expect(rendered.html).toContain(
      `${data.recipientEmail} has been authorised to sign in.`,
    );
  });

  it('never addresses the recipient by name — there is no profile to read one from', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).not.toMatch(/\bDear\b|\bHi\b|\bHello\b/);
    expect(rendered.text).not.toMatch(/\bDear\b|\bHi\b|\bHello\b/);
  });

  it('does not claim an account exists, in either part', () => {
    // Being allowlisted is PERMISSION TO SIGN IN. The account is created on
    // first successful OAuth login, and "your account is ready" would be a
    // lie that produces a support ticket the first time somebody expects a
    // password.
    for (const part of [allowlistInvitationEmail(data).html, allowlistInvitationEmail(data).text]) {
      expect(part).not.toMatch(/your account is ready/i);
      expect(part).not.toMatch(/account has been created for you/i);
      expect(part).not.toMatch(/set (?:a |your )?password/i);
    }
  });

  it('says there is no password and that the account is created on sign-in, in both parts', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toContain('There is no password to set');
    expect(rendered.text).toContain('There is no password to set');
    expect(rendered.html).toContain('created on the spot');
    expect(rendered.text).toContain('created on the spot');
  });

  it('reassures a reader who has never heard of this deployment, in both parts', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toContain('nothing has been created in your name');
    expect(rendered.text).toContain('nothing has been created in your name');
  });
});

describe('allowlistInvitationEmail — hierarchy and the single call to action', () => {
  it('answers "what is this?" from the shared brand manifest, not from prose typed here', () => {
    // `TAGLINE` comes from `packages/shared/identity.json`, the same manifest
    // the web app and the CLI read, so a rebrand carries this line and nobody
    // has to remember an email template exists.
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toContain(TAGLINE);
    expect(rendered.text).toContain(TAGLINE);
    expect(rendered.html).toContain('Access is by invitation only');
    expect(rendered.text).toContain('Access is by invitation only');
  });

  it('gives the inviting administrator their own block, in both parts', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toContain('Added by <strong>Oscar Marin</strong>');
    expect(rendered.html).toContain(
      'They are the person to ask if you were not expecting this.',
    );
    expect(rendered.text).toContain('Added by Oscar Marin.');
  });

  it('omits the attribution entirely when the administrator is unknown', () => {
    // `allowed_emails.added_by_id` is nullable (`onDelete: SetNull`), so an
    // entry outlives the admin who created it.
    const { invitedBy: _omitted, ...withoutInviter } = data;
    const rendered = allowlistInvitationEmail(withoutInviter);

    expect(rendered.html).not.toContain('Added by');
    expect(rendered.text).not.toContain('Added by');
    expect(rendered.html).not.toContain('person to ask');
    // …and the rest of the message is intact.
    expect(rendered.html).toContain(data.recipientEmail);
    expect(rendered.text).toContain(data.recipientEmail);
  });

  it('carries exactly one link, and it is the sign-in button', () => {
    // A second CTA competes with the only action that does anything. The
    // attribution block already names somebody to ask, in text.
    const rendered = allowlistInvitationEmail(data);

    const anchors = [...rendered.html.matchAll(/<a\b[^>]*href="([^"]*)"/gi)];

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.[1]).toBe(data.signInUrl);
    expect(rendered.text).toContain(`Sign in: ${data.signInUrl}`);
  });

  it('places the sign-in instruction immediately before the button', () => {
    // A CTA whose explanation is three paragraphs further up is a CTA people
    // hesitate on. This pins the ordering the header describes.
    const rendered = allowlistInvitationEmail(data);

    const instruction = rendered.html.indexOf('There is no password to set');
    const button = rendered.html.indexOf(`href="${data.signInUrl}"`);
    const fine = rendered.html.indexOf('nothing has been created in your name');

    expect(instruction).toBeGreaterThan(fine);
    expect(button).toBeGreaterThan(instruction);
  });

  it('drops the button from both parts when no sign-in URL is configured', () => {
    // With no `APP_URL` there is no honest link to offer, and a button
    // pointing nowhere is worse than a message that names the application.
    const { signInUrl: _omitted, ...withoutUrl } = data;
    const rendered = allowlistInvitationEmail(withoutUrl);

    expect(rendered.html).not.toMatch(/<a\b/);
    expect(rendered.text).not.toContain('Sign in:');
    expect(rendered.html).toContain(data.recipientEmail);
  });
});

describe('allowlistInvitationEmail — the embedded logo', () => {
  it('references the logo by content id and attaches the very same bytes', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
    expect(rendered.attachments).toHaveLength(1);

    const [attachment] = rendered.attachments ?? [];

    expect(attachment?.cid).toBe(EMAIL_LOGO_CID);
    expect(attachment?.contentType).toBe('image/png');
    // Identity with what `brand-logo.ts` hands out: the markup and the MIME
    // part come from ONE value, which is what makes them unable to disagree.
    expect(attachment).toBe(emailLogoAttachment());
  });

  it('carries the product name as alt text, for images-off and screen readers', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.html).toMatch(
      new RegExp(`<img\\b[^>]*\\balt="${APP_NAME}"`, 'i'),
    );
  });

  it('falls back to the text wordmark, and attaches nothing, when the asset is unreadable', () => {
    // A real production path (an image built before the assets COPY existed,
    // a fork that deleted the file). Both halves degrade together: no `<img>`,
    // no `cid:`, no `attachments` key — which is exactly the message this
    // template produced before the logo existed.
    jest.spyOn(require('node:fs'), 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    resetEmailLogoCacheForTests();

    const rendered = allowlistInvitationEmail(data);

    expect(rendered.attachments).toBeUndefined();
    expect(rendered.html).not.toContain('cid:');
    expect(rendered.html).not.toMatch(/<img\b/i);
    expect(rendered.html).toContain(APP_NAME);
    // And the message is otherwise unchanged.
    expect(rendered.text).toBe(allowlistInvitationEmail(data).text);
    expect(rendered.subject).toContain(APP_NAME);
  });
});

describe('allowlistInvitationEmail — what must never be in it', () => {
  it('escapes a hostile display name rather than rendering it as markup', () => {
    // `invitedBy` is the one free-text field here and it is administrator-
    // supplied. The `html` tag escapes every interpolation by construction
    // (safe-html.ts); this asserts the invitation actually goes through it.
    const rendered = allowlistInvitationEmail({
      ...data,
      invitedBy: '<script>alert(document.cookie)</script>',
    });

    expect(rendered.html).not.toContain('<script>alert(document.cookie)</script>');
    expect(rendered.html).toContain(
      '&lt;script&gt;alert(document.cookie)&lt;/script&gt;',
    );
    // The text part is not markup and must NOT be escaped — a human reading a
    // text-only client should see the characters, not entities.
    expect(rendered.text).toContain('<script>alert(document.cookie)</script>');
    expect(rendered.text).not.toContain('&lt;script&gt;');
  });

  it('escapes an attribute-breakout payload in the display name', () => {
    const rendered = allowlistInvitationEmail({
      ...data,
      invitedBy: '"><img src=x onerror=alert(1)>',
    });

    expect(rendered.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(rendered.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('cannot render the allowlist entry’s private notes — the payload does not carry them', () => {
    // ⚠ THE OMISSION IS STRUCTURAL, NOT REMEMBERED. `notes` is an
    // administrator's annotation about a person ("contractor, ends in March")
    // written with no expectation that the person will read it. Passing one
    // here is a compile error; this asserts it is not somehow rendered anyway
    // via an excess property at runtime.
    const smuggled = {
      ...data,
      notes: 'CONTRACTOR-ENDS-IN-MARCH',
    } as AllowlistInvitationEmailData;

    const rendered = allowlistInvitationEmail(smuggled);

    expect(rendered.html).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
    expect(rendered.text).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
    expect(rendered.subject).not.toContain('CONTRACTOR-ENDS-IN-MARCH');
  });

  it('marks itself auto-generated so nothing replies to it', () => {
    const rendered = allowlistInvitationEmail(data);

    expect(rendered.headers?.['Auto-Submitted']).toBe('auto-generated');
    expect(rendered.headers?.['X-Auto-Response-Suppress']).toBe('All');
  });
});
