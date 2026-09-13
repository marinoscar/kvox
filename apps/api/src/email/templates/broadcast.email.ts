import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// Broadcast template — `admin.broadcast` / `admin.broadcast_critical`
// (issue #322, epic #319)
// =============================================================================
//
// THE FIRST TEMPLATE THAT RENDERS CONTENT THIS CODEBASE DID NOT WRITE.
//
// Every other template in this directory knows what it is saying.
// `role-changed.email.ts` renders a before/after role table; the only
// caller-supplied values are role names and an address, and the *sentences*
// around them were written here, reviewed here, and cannot change. This one
// renders a title and a body an administrator typed minutes earlier through
// the composer in #325, and it has no idea what is in them.
//
// That inverts the trust question, and three decisions follow from it.
//
// -----------------------------------------------------------------------------
// 1. EVERY CHARACTER OF ADMIN INPUT PASSES THROUGH `escapeHtml`, BY
//    CONSTRUCTION — THE ESCAPE HATCH IS NEVER CALLED HERE
// -----------------------------------------------------------------------------
//
// The body is PLAIN TEXT. It is split into paragraphs and each paragraph is
// interpolated as a VALUE into the `html` tag, which escapes it (safe-html.ts).
// Paragraphs are assembled as an ARRAY of `SafeHtml` and interpolated in one
// go — `renderValue` flattens and concatenates arrays — so there is no point
// in this file where markup is built by string concatenation, and therefore no
// point at which the escape hatch would even be reachable.
//
// `SafeHtml.unsafeFromTrustedString` — the one escape hatch in safe-html.ts —
// occurs in this file exactly once, on the line above, in a sentence saying
// that it is never called. A reviewer greps for a CALL, and there is none.
// That is not a style rule, it is THE security property of this file: an
// admin account compromise must not become stored XSS in every user's mailbox.
// #322 rejected raw-HTML bodies and a markdown subset for exactly this reason —
// both require the escape hatch on admin-supplied input, and a hand-rolled
// inline-HTML emitter is a new injection surface with no meaning at all on the
// browser and push channels, whose content is plain strings.
//
// -----------------------------------------------------------------------------
// 2. THE SUBJECT IS THE ADMIN'S TITLE, VERBATIM
// -----------------------------------------------------------------------------
//
// Not `[${APP_NAME}] ${title}`, and not `${title} — ${APP_NAME}`. The layout
// already puts the wordmark above the card and the "automated message from
// ${APP_NAME}" line beneath it, so a prefix adds no information the recipient
// does not already have the moment they open the message — and it costs the
// only thing that decides whether they open it. Inbox lists truncate the
// subject at something like 35–50 characters on a phone, so a prefix eats the
// front of every announcement and turns "Planned maintenance this Saturday"
// into "[Acme Portal] Planned maintenan…". An admin who wrote a subject gets
// that subject.
//
// -----------------------------------------------------------------------------
// 3. IT IS ONE TEMPLATE FOR TWO EVENT KEYS
// -----------------------------------------------------------------------------
//
// `admin.broadcast` and `admin.broadcast_critical` both map here
// (`EVENT_EMAIL_TEMPLATES`). They differ in whether a user may MUTE them, not
// in how the message READS — `mandatory` is a property of the recipient's
// preferences gate, not of the copy. `critical` adds one footer line saying so;
// a second template would be a copy of this one that drifts from it.
//
// Like every other template here it is PURE: no clock, no config, no I/O. The
// CTA URL arrives ABSOLUTE, already joined from `APP_URL` and the broadcast's
// stored root-relative link by the caller, because `safeUrl` rejects relative
// URLs (an email has no document base to resolve one against) and because a
// template that read configuration would stop being answerable to "what
// exactly did we send?".
// =============================================================================

/**
 * Everything a broadcast renders — and, deliberately, nothing about who it is
 * going to. This message is identical for every recipient, which is what lets
 * the fan-out in #323 render it once per chunk rather than once per person.
 */
export interface BroadcastEmailData {
  /**
   * The admin's headline. Becomes BOTH the subject line and the heading at the
   * top of the card, so the message a recipient picked out of a list is the
   * one they see when it opens.
   */
  title: string;

  /**
   * The admin's message. PLAIN TEXT, never markup.
   *
   * Blank lines separate paragraphs; a single newline inside a paragraph is a
   * soft wrap from the composer's textarea and is joined with a space, because
   * mail clients reflow to the reader's window width and a hard-wrapped
   * paragraph double-wraps into a ragged column on a phone.
   */
  body: string;

  /**
   * Label for the optional call-to-action button. Rendered only together with
   * {@link ctaUrl} — a label on its own has nothing to point at.
   */
  ctaLabel?: string;

  /**
   * Absolute `http(s)` URL for the call-to-action button.
   *
   * BUILT BY THE CALLER from `APP_URL` plus the broadcast's stored
   * root-relative link. Absolute because `safeUrl` rejects anything else, and
   * built by the caller because this template reads no configuration.
   * Anything `safeUrl` refuses causes the button to be DROPPED from both parts
   * rather than rendered pointing nowhere — see layout.ts.
   */
  ctaUrl?: string;

  /**
   * The same destination as {@link ctaUrl}, ROOT-RELATIVE.
   *
   * NOT USED BY THIS TEMPLATE, and present on purpose: one `notify()` call
   * carries one payload to every channel, and the browser and push channels
   * need the root-relative form (they render an in-app link, validated by
   * `sanitizeLink`). Splitting the payload per channel would put the burden of
   * building both on every call site and let the two drift.
   */
  link?: string;

  /**
   * True for `admin.broadcast_critical`, which is `mandatory: true` in the
   * registry and therefore cannot be switched off at `/settings/notifications`.
   *
   * Adds the footer that says so. A recipient who cannot find the off switch
   * should be told why it is missing, in the message itself, rather than
   * discovering an empty toggle on the preferences page.
   */
  critical?: boolean;
}

/**
 * Hidden preheader budget.
 *
 * The inbox snippet is the one line that decides whether an announcement is
 * opened, and clients cut it around here. Longer costs nothing but says
 * nothing either — the tail is never displayed.
 */
const PREVIEW_TEXT_MAX_LENGTH = 140;

/**
 * The footer for a critical broadcast, in the style of the last paragraph of
 * `role-changed.email.ts` — and for the same reason. Both are unmuteable, and
 * a message a recipient cannot stop receiving owes them a sentence explaining
 * why.
 */
const CRITICAL_NOTICE =
  'This notification cannot be turned off, because it carries information ' +
  'everyone using this application needs.';

/**
 * Split the admin's plain-text body into display paragraphs.
 *
 * Blank lines (any amount of intervening whitespace) separate paragraphs;
 * single newlines within one are soft wraps and become spaces. Empty
 * paragraphs are dropped, so a body that ends in three newlines does not
 * render as trailing empty `<p>` elements.
 *
 * `\s*` between the two line breaks is what makes a "blank" line that contains
 * spaces or a stray `\r` — which is most of them, since this text arrives from
 * a browser textarea — behave the way the author saw it on screen.
 *
 * Returns plain STRINGS, not `SafeHtml`. This function does no escaping and
 * must not: escaping happens at exactly one place, the interpolation in
 * {@link broadcastEmail}, and a helper that returned pre-escaped markup would
 * be the first step towards assembling a body by concatenation.
 */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' '),
    )
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Cut `value` to `max` characters, marking the cut.
 *
 * The ellipsis matters for the same reason it does in
 * `browser-notification.channel.ts`: a silently truncated sentence reads as a
 * bug in the message, a marked one reads as a message that was too long.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Render an administrator's broadcast.
 */
export function broadcastEmail(data: BroadcastEmailData): RenderedEmail {
  const paragraphs = splitParagraphs(data.body);
  const critical = data.critical === true;

  // VERBATIM — see decision 2 in the header block. Not trimmed, not prefixed,
  // not truncated: the composer's DTO (#324) validates and bounds it, and this
  // is a subject line rather than markup, so there is nothing to escape (see
  // `RenderedEmail.subject`).
  const subject = data.title;

  // The CTA needs BOTH halves or the layout omits the button. An admin who
  // supplied a URL and no label meant to link somewhere, so a default label is
  // used rather than silently dropping the link they configured; a label with
  // no URL is dropped, because there is nothing to point it at.
  const ctaLabel = data.ctaUrl
    ? (data.ctaLabel?.trim() ?? '') || `Open ${APP_NAME}`
    : undefined;

  // THE ESCAPING BOUNDARY, and the only one. Each paragraph is interpolated as
  // a VALUE, so the `html` tag escapes it (safe-html.ts). The result is an
  // array of `SafeHtml`, which `renderValue` flattens and concatenates when the
  // array itself is interpolated below — so the body is composed of fragments
  // the type system knows are safe, never of strings.
  //
  // The last paragraph loses its bottom margin unless the critical footer
  // follows it, so the card's own padding is not doubled at the end.
  const bodyParagraphs: SafeHtml[] = paragraphs.map((paragraph, index) => {
    const isLast = index === paragraphs.length - 1;
    const margin = isLast && !critical ? '0' : '0 0 16px 0';

    return html`<p style="margin:${margin};">${paragraph}</p>`;
  });

  const criticalNotice = critical
    ? html`<p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
        ${CRITICAL_NOTICE}
      </p>`
    : SafeHtml.EMPTY;

  const bodyHtml = html`${bodyParagraphs}${criticalNotice}`;

  const htmlDocument = renderLayout({
    title: data.title,
    // The first paragraph, which is where an author puts the point. There is
    // no better generic choice: unlike every other template here, nothing in
    // this file knows what the message is about, so anything else would be a
    // guess about content it cannot read.
    previewText: paragraphs[0]
      ? truncate(paragraphs[0], PREVIEW_TEXT_MAX_LENGTH)
      : undefined,
    bodyHtml,
    ctaLabel,
    ctaUrl: data.ctaUrl,
  });

  // The text part is HAND-WRITTEN from the same paragraphs, never derived from
  // the HTML above — there is deliberately no HTML-to-text helper in this
  // module (see the long note above `plainText` in layout.ts). Here that costs
  // almost nothing, because the source really is plain text; the HTML half is
  // the derived one.
  const textLines: string[] = [];
  for (const paragraph of paragraphs) {
    if (textLines.length > 0) textLines.push('');
    textLines.push(paragraph);
  }
  if (critical) {
    textLines.push('', CRITICAL_NOTICE);
  }

  // `PlainTextOptions.lines` is a NON-EMPTY TUPLE, so it is built after an
  // explicit check rather than cast: a cast would compile and then ship an
  // empty text part, which is the exact failure the tuple type exists to
  // prevent and which is invisible unless somebody opens the message in a
  // text-only client.
  //
  // THE DEGENERATE CASE — a body that is only whitespace — renders as a
  // message with a heading and no body, not as a throw. It is unreachable in
  // production (the composer's DTO requires a non-empty body, and every
  // paragraph here is non-empty by construction), and if it ever becomes
  // reachable, delivering a titled but empty announcement is a better outcome
  // than a recorded delivery FAILURE for a message an admin did compose —
  // epic #109's rule is that a notification failure never fails the action
  // that triggered it, and the same instinct applies to the content.
  const first = textLines[0];
  const lines: [string, ...string[]] =
    first === undefined ? [''] : [first, ...textLines.slice(1)];

  const text = plainText({
    title: data.title,
    lines,
    ctaLabel,
    ctaUrl: data.ctaUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
