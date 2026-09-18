import {
  GETTING_STARTED_PATH,
  WELCOME_CTA_LABEL,
  userWelcomeEmail,
  type UserWelcomeEmailData,
} from './user-welcome.email';

// =============================================================================
// `user.welcome`'s CTA (issue #280, epic #271)
// =============================================================================
//
// `index.spec.ts` already runs the shared contract over every registered
// template — non-empty subject/html/text, escaping of every interpolated
// field, a subject with no markup in it. What is asserted HERE is the one thing
// #280 changed and the one way it can silently rot:
//
//   * the button lands on `/settings/getting-started` rather than on the app
//     root, because the root is where signing in would have put the recipient
//     anyway and the checklist is the page that states the BYOK fact their
//     first session actually turns on;
//   * ⚠ THE TEXT PART CARRIES THE SAME URL. There is deliberately no
//     HTML-to-text helper in this module (see `layout.ts`'s own header), so the
//     two halves are written separately and a text part left behind is a text
//     part that lies. Every assertion below that touches the URL checks BOTH.
//   * no `appUrl` still means no button, in both parts, rather than a link
//     pointing at a bare relative path no mail client can resolve.
// =============================================================================

const APP_URL = 'https://app.example.test';

const data: UserWelcomeEmailData = {
  recipientEmail: 'new-person@example.test',
  recipientName: 'Ana Rivera',
  roles: ['viewer'],
  appUrl: APP_URL,
};

const EXPECTED_URL = `${APP_URL}${GETTING_STARTED_PATH}`;

describe('userWelcomeEmail — the Get started CTA', () => {
  it('renders a button labelled "Get started"', () => {
    const rendered = userWelcomeEmail(data);

    expect(WELCOME_CTA_LABEL).toBe('Get started');
    expect(rendered.html).toContain(WELCOME_CTA_LABEL);
    expect(rendered.text).toContain(WELCOME_CTA_LABEL);
  });

  it('points at the getting-started checklist, in both parts', () => {
    const rendered = userWelcomeEmail(data);

    // The `href` is what `renderLayout` emitted — the button is never
    // assembled in the template and interpolated in as markup, which is what
    // keeps `safeUrl` in the path.
    expect(rendered.html).toContain(`href="${EXPECTED_URL}"`);
    // `plainText` writes the link out in full: a text part cannot hide a URL
    // behind a label.
    expect(rendered.text).toContain(`${WELCOME_CTA_LABEL}: ${EXPECTED_URL}`);
  });

  it('no longer drops the recipient on the app root', () => {
    const rendered = userWelcomeEmail(data);

    // The failure this change fixes, stated as an assertion: a CTA to the root
    // is a CTA to the page signing in would have produced anyway.
    expect(rendered.html).not.toContain(`href="${APP_URL}"`);
    expect(rendered.text).not.toContain(`${WELCOME_CTA_LABEL}: ${APP_URL}\r\n`);
  });

  it('does not double the slash for a caller that passes a trailing one', () => {
    // `auth.service.ts` already strips one. A template is a pure function of
    // its input, so it must not produce `…//settings/getting-started` for a
    // caller that did not.
    const rendered = userWelcomeEmail({ ...data, appUrl: `${APP_URL}/` });

    expect(rendered.html).toContain(`href="${EXPECTED_URL}"`);
    expect(rendered.html).not.toContain('//settings/getting-started');
    expect(rendered.text).toContain(EXPECTED_URL);
  });

  it('explains what the checklist is, in both parts, so the button is not a bare instruction', () => {
    const rendered = userWelcomeEmail(data);

    expect(rendered.html).toContain('short checklist');
    expect(rendered.text).toContain('short checklist');
  });

  it('omits the button AND its paragraph with no appUrl configured', () => {
    // A deployment with no `APP_URL` has no honest link to offer. Leaving the
    // paragraph behind would promise a checklist with nothing to reach it by.
    const { appUrl: _omitted, ...withoutUrl } = data;
    const rendered = userWelcomeEmail(withoutUrl);

    expect(rendered.html).not.toContain(WELCOME_CTA_LABEL);
    expect(rendered.text).not.toContain(WELCOME_CTA_LABEL);
    expect(rendered.html).not.toContain('short checklist');
    expect(rendered.text).not.toContain('short checklist');

    // And the rest of the message is intact — the CTA is an addition to it,
    // not the thing it is for.
    expect(rendered.html).toContain('new-person@example.test');
    expect(rendered.text).toContain('new-person@example.test');
  });

  it('still says the three things the message was always for', () => {
    const rendered = userWelcomeEmail(data);

    // The account exists, under which address, with what access — the facts
    // #128 wrote this template for. The CTA must not have displaced any of
    // them.
    expect(rendered.text).toContain('Ana Rivera');
    expect(rendered.text).toContain('new-person@example.test');
    expect(rendered.text).toContain('Viewer');
  });
});
