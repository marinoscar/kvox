import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Welcome" template — `user.welcome` (issue #128, epic #109)
// =============================================================================
//
// The first of the three real event templates. It renders the message sent
// ONCE, at the moment a user record is first created through OAuth — not on
// every login, and not before that row is committed. Both of those are
// properties of the TRIGGER, not of this file; see the call site in
// `auth.service.ts`, which is where the fire-once condition is enforced and
// documented.
//
// WHAT THIS MESSAGE IS FOR. The recipient has just signed in successfully, so
// it is not an activation step and it must not read like one — there is
// nothing for them to click to "finish setting up". Its job is to leave a
// durable record in their inbox that an account now exists here, under which
// address, and with what level of access. That last part is the one fact they
// cannot discover for themselves without signing in and hunting: a Viewer who
// expected Contributor learns it here rather than by finding a button missing.
//
// It is also the ONE email in this system whose absence is harmless, which is
// why `user.welcome` is opt-out (`mandatory` is absent in the registry) while
// `security.role_changed` is not.
//
// -----------------------------------------------------------------------------
// THE CTA POINTS AT THE CHECKLIST (issue #280, epic #271)
// -----------------------------------------------------------------------------
//
// The paragraph above says this message must not read like an activation step,
// and that is still true — but "there is nothing to click" and "the one link in
// it should lead somewhere useful" are different claims, and only the first was
// ever argued for. Until #271 there was no useful destination: the CTA said
// "Open <app>" and dropped the recipient on the home page, which is exactly
// where signing in would have put them anyway.
//
// `/settings/getting-started` (#279) now exists and is a genuinely better
// landing place for somebody opening this message: it states the one fact this
// product's first session actually surprises people with — AI features run on
// the recipient's OWN provider key — and lists what is left to do. So the
// button is relabelled and re-pointed, rather than a SECOND button being added:
// `renderLayout` renders one CTA by design, two buttons in a welcome email is
// a choice nobody wants to make on arrival, and the home page is one tap away
// from the checklist in the app's own navigation.
//
// ⚠ NO NEW EVENT KEY AND NO REGISTRY CHANGE. `user.welcome` already exists, is
// `defaultEnabled: true`, fires exactly once per account by construction, and
// already carries `appUrl`. A second event would be a second thing for a user
// to have to mute.
//
// ⚠ AND THE TEXT PART SAYS THE SAME URL. `plainText` is handed the same
// label/URL pair (it scheme-checks and writes the link out in full), so the two
// parts cannot disagree — see the note above `plainText` in layout.ts for why
// no HTML-to-text helper exists to do this automatically, and why a text part
// left behind is a text part that lies.
// =============================================================================

/**
 * Everything the welcome message renders.
 *
 * NO CLOCK AND NO CONFIGURATION READ, per the rule stated on `TestEmailData`:
 * a template is a pure function of this object. The absolute `appUrl` is
 * supplied by the caller for the same reason — a template that built it would
 * have to know both `APP_URL` and the web app's route table.
 */
export interface UserWelcomeEmailData {
  /** The address the account was created under. Stated back as the fact it is. */
  recipientEmail: string;

  /**
   * Display name from the OAuth profile, when the provider supplied one.
   *
   * Optional because Google does not guarantee it. Interpolated through the
   * `html` tag, so it is ESCAPED — this string came from a third party's
   * profile and is the most obviously attacker-influenced value in the
   * payload.
   */
  recipientName?: string;

  /**
   * Roles the new account was given, as stored (`viewer`, `admin`).
   *
   * Rendered because "what can I actually do here?" is the only question a
   * welcome message is uniquely placed to answer. May be empty — a seeding
   * failure would produce that — in which case the sentence is omitted rather
   * than rendered as an empty list.
   */
  roles: string[];

  /**
   * Absolute URL of the application root, for the CTA. Optional: with no
   * `APP_URL` configured there is no honest link to offer, and the layout
   * omits the button rather than rendering one that goes nowhere.
   *
   * ⚠ THE ROOT, NOT THE CTA's OWN URL. The route is appended here (see
   * {@link GETTING_STARTED_PATH}) rather than being asked of the caller,
   * because `auth.service.ts` supplies this from `APP_URL` and has no business
   * knowing the web app's route table — the same reason stated above for why
   * the template does not build the base URL itself.
   */
  appUrl?: string;
}

/**
 * Where the CTA lands, relative to {@link UserWelcomeEmailData.appUrl}.
 *
 * ⚠ THIS STRING IS ALSO SPELLED IN `apps/web/src/components/onboarding/onboardingPaths.ts`
 * (`GETTING_STARTED_PATH`), and the two cannot be shared: `apps/api` does not
 * depend on `apps/web`, and `@app/shared` carries brand identity rather than
 * the web app's route table. So it is restated once, here, next to the only
 * place in this service that needs it — and a divergence lands the recipient on
 * `App.tsx`'s `*` catch-all, which shows them the home page with no
 * explanation rather than a 404 anybody would notice.
 */
export const GETTING_STARTED_PATH = '/settings/getting-started';

/**
 * The CTA label. Exported so the suite asserts the button by name rather than
 * by position in the rendered table.
 */
export const WELCOME_CTA_LABEL = 'Get started';

/**
 * The absolute CTA URL, or `undefined` when there is no `appUrl` to build it
 * from — in which case `renderLayout` and `plainText` both omit the button
 * rather than rendering one pointing at a relative path no mail client can
 * resolve.
 *
 * The trailing-slash strip is defensive duplication: `auth.service.ts` already
 * strips one before it calls, and a template is a pure function of its input,
 * so it must not produce `https://app.example.com//settings/getting-started`
 * for a caller that did not.
 */
function welcomeCtaUrl(appUrl?: string): string | undefined {
  if (!appUrl) return undefined;
  return `${appUrl.replace(/\/+$/, '')}${GETTING_STARTED_PATH}`;
}

/**
 * Role names as a reader should see them.
 *
 * Stored names are lower-case identifiers (`admin`); an email is product copy,
 * not a database dump. Shared with `role-changed.email.ts` would be the
 * obvious move and is deliberately NOT made: these are two independent pieces
 * of copy and a shared formatter is how one template's wording change silently
 * edits another's.
 */
function formatRoles(roles: string[]): string {
  return roles
    .map((role) => role.charAt(0).toUpperCase() + role.slice(1))
    .join(', ');
}

/**
 * Render the welcome message.
 */
export function userWelcomeEmail(data: UserWelcomeEmailData): RenderedEmail {
  const greetingName = data.recipientName?.trim();
  const roleList = data.roles.length > 0 ? formatRoles(data.roles) : null;
  // Built ONCE and handed to both halves, so the button and the text part
  // cannot end up pointing at different places. `renderLayout` scheme-checks it
  // through `safeUrl`, and `plainText` checks it again for the text part.
  const ctaUrl = welcomeCtaUrl(data.appUrl);

  // No timestamp in the subject, unlike the test email. That one is sent
  // repeatedly at an admin's request and must not thread; this one is sent
  // exactly once per account, so there is nothing for it to collapse into.
  const subject = `Welcome to ${APP_NAME}`;

  const greeting = greetingName
    ? html`<p style="margin:0 0 16px 0;">Hello ${greetingName},</p>`
    : SafeHtml.EMPTY;

  const rolesParagraph = roleList
    ? html`<p style="margin:0 0 16px 0;">
        Your account has been given the <strong>${roleList}</strong> role. If
        that is not the access you expected, ask an administrator to change it
        — you will get an email when they do.
      </p>`
    : SafeHtml.EMPTY;

  // The sentence the button needs in order not to read like an instruction.
  // Omitted with the button, so a deployment with no `APP_URL` does not promise
  // a page there is no link to. Built with the `html` tag like everything else
  // here, so any future interpolation into it is escaped by construction.
  const ctaParagraph = ctaUrl
    ? html`<p style="margin:0 0 16px 0;">
        There is a short checklist waiting for you — what AI features need from
        you, and the couple of things that make this account yours. It takes a
        minute, and nothing on it is urgent.
      </p>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`
    ${greeting}
    <p style="margin:0 0 16px 0;">
      Your account on ${APP_NAME} has been created and is ready to use. You are
      signed in with <strong>${data.recipientEmail}</strong>, and that is the
      address to use every time you sign in.
    </p>
    ${rolesParagraph}
    ${ctaParagraph}
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      This message is sent once, when an account is first created. You can turn
      it off — along with the other notifications this application sends — in
      your notification settings.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: `Welcome to ${APP_NAME}`,
    // The preheader names the account rather than repeating the subject, which
    // the inbox list already shows immediately to its left.
    previewText: `Your account for ${data.recipientEmail} is ready.`,
    bodyHtml,
    // ⚠ THROUGH `renderLayout`, which is what applies `safeUrl` — the button is
    // never assembled here and interpolated in as markup.
    ctaLabel: ctaUrl ? WELCOME_CTA_LABEL : undefined,
    ctaUrl,
  });

  // Hand-written, same facts in the same order. Not stripped from the markup
  // above — see the note above `plainText` in layout.ts for why no such
  // function exists in this module.
  const lines: string[] = [];
  if (greetingName) {
    lines.push(`Hello ${greetingName},`, '');
  }
  lines.push(
    `Your account on ${APP_NAME} has been created and is ready to use.`,
    `You are signed in with ${data.recipientEmail}, and that is the address to use every time you sign in.`,
  );
  if (roleList) {
    lines.push(
      '',
      `Your account has been given the ${roleList} role. If that is not the access you expected,`,
      'ask an administrator to change it — you will get an email when they do.',
    );
  }
  // ⚠ THE SAME PARAGRAPH THE HTML ADDS, UNDER THE SAME CONDITION. A text part
  // that omits it would leave `plainText`'s "Get started: <url>" line stranded
  // at the end of the message with nothing explaining what it leads to — which
  // is exactly the "a text part left behind is a text part that lies" failure
  // layout.ts's own header describes.
  if (ctaUrl) {
    lines.push(
      '',
      'There is a short checklist waiting for you — what AI features need from you, and the',
      'couple of things that make this account yours. It takes a minute, and nothing on it is urgent.',
    );
  }
  lines.push(
    '',
    'This message is sent once, when an account is first created. You can turn it off,',
    'along with the other notifications this application sends, in your notification settings.',
  );

  const text = plainText({
    title: `Welcome to ${APP_NAME}`,
    // Split so the leading element is a literal: `PlainTextOptions.lines` is a
    // non-empty tuple, and an array whose length TypeScript cannot see widens
    // to `string[]` and stops satisfying it.
    lines: [lines[0]!, ...lines.slice(1)],
    // ⚠ THE SAME PAIR THE HTML BUTTON CARRIES. `plainText` writes the URL out
    // in full — a text part cannot hide a link behind a label — so this is
    // where the "the text part contains the same URL" criterion is actually
    // satisfied, and it is satisfied by construction rather than by two
    // literals being kept in step.
    ctaLabel: ctaUrl ? WELCOME_CTA_LABEL : undefined,
    ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
