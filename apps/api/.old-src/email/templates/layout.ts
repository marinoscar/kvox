import { APP_NAME } from '@app/shared';
import type { EmailAttachment } from '../email.types';
import { EMAIL_LOGO_RENDERED_SIZE } from './brand-logo';
import { SafeHtml, html, safeUrl } from './safe-html';

// =============================================================================
// Email layout — the HTML shell every message shares (issue #123, epic #109)
// =============================================================================
//
// EMAIL HTML IS NOT WEB HTML. Every constraint below is here because a real
// client breaks without it, and getting this wrong once means every template
// #128 adds inherits the breakage.
//
//   * **Inline styles and nested tables, no flexbox, no grid, no classes.**
//     Outlook on Windows renders mail with the WORD layout engine, not with a
//     browser engine. It ignores `display:flex`, `display:grid`, most
//     positioning, and — critically — it strips `<style>` blocks in many
//     configurations, so anything not inlined is simply absent. Tables are the
//     only layout primitive with 25 years of consistent behaviour across
//     Gmail, Outlook and Apple Mail.
//
//   * **No REMOTE assets whatsoever** — no `<link>`, no `src` pointing at a
//     URL, no web fonts. Gmail, Outlook and Apple Mail all block remote
//     content by default until the recipient clicks "display images", so a
//     layout that depends on a fetched logo renders broken for the MAJORITY of
//     recipients on first open. A blocked asset is also a tracking-pixel
//     signal to spam filters, which is a second, independent reason not to
//     have one. The "button" below is therefore a coloured table cell rather
//     than an image, and it always will be.
//
//   * **Exactly one EMBEDDED asset is permitted: the brand logo, by CID.**
//     ⚠ READ THIS BEFORE CONCLUDING THE RULE ABOVE WAS ABANDONED, because the
//     `<img>` in this file looks like the thing the previous bullet forbids
//     and is not. A `cid:` reference (RFC 2392) names a MIME part carried
//     INSIDE the message: there is no URL, no host, no request, and therefore
//     nothing for a client to block or for a filter to read as tracking.
//     Gmail, Outlook and Apple Mail all display CID parts on first open with
//     no "display images" click. The distinction is exactly "fetched" versus
//     "delivered", and it is the whole reason the previous bullet's conclusion
//     (text only) no longer follows from its premise (remote content is
//     blocked).
//
//     The cost is real and bounds the rule at one asset: every byte is
//     base64-encoded into every copy of the message, once per recipient. So
//     the logo is a deliberately small committed PNG
//     (`templates/brand-logo.ts`), it is OPT-IN per template rather than
//     automatic, and `EmailMessage.attachments` is typed for embedded images
//     specifically so it cannot drift into being a file-attachment channel.
//
//     ⚠ AND THE TEXT WORDMARK IS STILL HERE, as the branch taken when no logo
//     is supplied — not as dead code. A message can legitimately carry no
//     attachment (the asset is missing from the image, a template has not
//     opted in), and in that case the header must render the product name as
//     text exactly as it always did. The `<img>` also carries a non-empty
//     `alt` for the recipient who turns images off wholesale and for a screen
//     reader, because "the client will display it" is a claim about defaults,
//     not about every reader.
//
//   * **A hidden preheader.** Inbox lists show a snippet beside the subject.
//     With no preheader the client scrapes the first visible text in the body,
//     which is the greeting — so every message in the list previews as "Hello,
//     Oscar" and the recipient learns nothing about which one to open.
//
//   * **A palette that survives forced dark mode.** Outlook.com, the Gmail
//     Android app and others do not ask the message what it wants: they
//     INVERT its colours. The rule that follows is that CONTRAST survives
//     inversion but HUE does not — a dark colour becomes light and vice versa,
//     so a near-black-on-near-white pair stays legible, while any mid-luminance
//     colour inverts to another mid-luminance colour and can land close to its
//     background. So: extremes for anything carrying text, and no mid-greys.
//     The `color-scheme`/`supported-color-schemes` metas additionally opt Apple
//     Mail and iOS out of forced inversion, but they are advisory and several
//     clients ignore them, so the palette has to work either way on its own.
//
// The plain-text renderer lives at the bottom of this same file, deliberately.
// #123 requires BOTH parts for every message, and a template author who opens
// this file to find `renderLayout` cannot miss `plainText` sitting directly
// beneath it. Splitting them across files is how one of them quietly stops
// being produced.
// =============================================================================

/**
 * Wordmark. The fallback the header renders when no logo is embedded, and the
 * `alt` on the `<img>` when one is — see the header note on blocked assets.
 *
 * NOT DEFINED HERE ANY MORE (issue #163, epic #161): the product name has one
 * source of truth, `packages/shared`, which the web app, the CLI and the
 * OpenAPI document read as well. This module re-exports it rather than
 * importing it privately because templates need the same string in their
 * SUBJECT lines, and a subject is not rendered by the layout — so every
 * template already imports `APP_NAME` from here (directly or through
 * `templates/index.ts`), and rerouting the constant instead of the call sites
 * keeps that unchanged. Two copies of the product name is how a rename ships
 * half-applied; so is two import paths for the same constant.
 */
export { APP_NAME };

// Palette. Chosen for contrast at the extremes so forced inversion preserves
// legibility; see the dark-mode note above before changing any of these to
// something mid-toned.
const BG_COLOR = '#f4f5f7';
const CARD_COLOR = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#4b5563';
const BORDER_COLOR = '#e2e5ea';
/** Deep enough that inverting it still yields contrast against white label text. */
const BRAND_COLOR = '#2f4f8f';

/**
 * Font stack. Web fonts are an external asset and therefore unavailable (see
 * header), and the Word engine falls back to Times New Roman for any family it
 * cannot resolve — an unstyled email is recognisably a broken one — so this is
 * restricted to faces present on essentially every mail client host.
 */
const FONT_STACK = 'Arial, Helvetica, sans-serif';

/**
 * Padding that pushes the client's scraped snippet off the end of the
 * preheader.
 *
 * Clients fill the inbox snippet to a fixed length: they take the preheader
 * and then KEEP GOING into the visible body, so a short preheader previews as
 * "Your roles changed <app name> Hello, Oscar..." — the wordmark and the
 * greeting are the layout's chrome bleeding in behind it. These are zero-width
 * non-joiners interleaved with word joiners — invisible in every client, but consumed by
 * the snippet's character budget, so the scrape runs out before it reaches the
 * body. The interleaving matters: a run of identical characters gets collapsed
 * by some clients, and the pair does not.
 */
const PREHEADER_PADDING = '&#847;&zwnj;&nbsp;&#8199;&#65279;&#847;'.repeat(30);

export interface RenderLayoutOptions {
  /** Heading shown at the top of the body card, and the document `<title>`. */
  title: string;

  /**
   * Hidden inbox-preview text. Optional in the signature, but every real
   * template should pass one — see the preheader note in the header block.
   */
  previewText?: string;

  /**
   * The message body.
   *
   * TYPED `SafeHtml`, NOT `string`, AND THAT IS THE POINT. A body assembled by
   * string concatenation — the shape in which an unescaped display name
   * arrives — does not typecheck here. The only ways to produce a `SafeHtml`
   * are the `html` tag, which escapes every interpolation, and the explicitly
   * named `SafeHtml.unsafeFromTrustedString`. The compiler enforces the
   * escaping rule so that no reviewer has to (see safe-html.ts).
   */
  bodyHtml: SafeHtml;

  /**
   * The brand logo to show in the header instead of the text wordmark.
   *
   * TYPED AS THE WHOLE `EmailAttachment`, NOT AS A BARE CID STRING, and that
   * is the point. The `cid:` in the markup and the MIME part in the message
   * have to agree — a reference with no part behind it renders as a
   * broken-image placeholder, which is worse than the wordmark it replaced —
   * so the only way to ask for the markup is to be holding the very object
   * that must also be attached. A caller therefore cannot produce one without
   * the other by forgetting; it has to actively drop a value it already has.
   * `index.spec.ts` closes the remaining gap with a registry-wide assertion
   * that no template's HTML names a cid its `attachments` does not supply.
   *
   * Absent (the default, and every template but the invitation today) renders
   * the text wordmark exactly as before.
   */
  logo?: EmailAttachment;

  /** Call-to-action button label. Rendered only together with `ctaUrl`. */
  ctaLabel?: string;

  /**
   * Call-to-action button URL. Must be an absolute `http(s)`/`mailto` URL;
   * anything else is rejected by `safeUrl` and the button is omitted rather
   * than rendered pointing somewhere useless.
   */
  ctaUrl?: string;
}

/**
 * Render the complete HTML document for one email.
 *
 * Returns a plain `string` because this is the terminal step: the result goes
 * straight into `EmailMessage.html` and is never interpolated into anything
 * else, so there is nothing left for the `SafeHtml` type to protect.
 */
export function renderLayout(opts: RenderLayoutOptions): string {
  const { title, previewText, bodyHtml, logo, ctaLabel, ctaUrl } = opts;

  // The masthead: an embedded logo when the caller supplied one, the text
  // wordmark otherwise. See the CID bullet in the header for why an `<img>`
  // is permitted here and a remote one never is.
  //
  // `width`/`height` are ATTRIBUTES as well as CSS. The Word engine Outlook
  // renders with ignores the CSS pair and, given no attributes, lays the image
  // out at its intrinsic 96x96 — double the intended size, shoving the card
  // down the page. `display:block` kills the descender gap inline images get
  // in Gmail; `border:0` is for the Outlook builds that still draw a border on
  // an image, though this one is not inside a link.
  //
  // The `alt` is the product name, deliberately not "Logo": for a recipient
  // with images off wholesale and for a screen reader this text IS the
  // masthead, and "Logo" tells them nothing the layout was trying to say.
  const masthead = logo
    ? html`<img
        src="cid:${logo.cid}"
        alt="${APP_NAME}"
        width="${EMAIL_LOGO_RENDERED_SIZE}"
        height="${EMAIL_LOGO_RENDERED_SIZE}"
        style="display:block;width:${EMAIL_LOGO_RENDERED_SIZE}px;height:${EMAIL_LOGO_RENDERED_SIZE}px;border:0;outline:none;text-decoration:none;"
      />`
    : html`${APP_NAME}`;

  // The preheader is hidden by six overlapping declarations, not one. Clients
  // disagree about which of them they honour — Gmail respects `display:none`,
  // some Outlook builds do not and need the zero height/width, and a few
  // strip `visibility` — so the belt-and-braces stack is what keeps this text
  // out of the rendered body while leaving it visible to the snippet scraper.
  const preheader = previewText
    ? html`<div
        style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;max-height:0;width:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;"
      >
        ${previewText}${SafeHtml.unsafeFromTrustedString(PREHEADER_PADDING)}
      </div>`
    : SafeHtml.EMPTY;

  // Reject the CTA URL rather than emit an unusable href — see `safeUrl`.
  const checkedCtaUrl = ctaUrl ? safeUrl(ctaUrl) : null;

  // The button is a table cell with a background colour and padding, NOT a
  // styled `<a>`. The Word engine ignores padding and `display:inline-block`
  // on an anchor, which collapses a CSS button down to bare underlined text;
  // it does honour `bgcolor` and cell padding on a `<td>`. `border-radius` is
  // ignored by Outlook and degrades to square corners, which is acceptable.
  const ctaBlock =
    ctaLabel && checkedCtaUrl
      ? html`<tr>
          <td align="center" style="padding:8px 0 4px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${BRAND_COLOR}" style="border-radius:6px;">
                  <a
                    href="${checkedCtaUrl}"
                    style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;"
                    >${ctaLabel}</a
                  >
                </td>
              </tr>
            </table>
          </td>
        </tr>`
      : SafeHtml.EMPTY;

  // `bgcolor` attributes accompany every `background` style below: the Word
  // engine drops the CSS background on table elements often enough that the
  // deprecated presentational attribute is the reliable one.
  //
  // `x-apple-disable-message-reformatting` stops iOS Mail auto-scaling the
  // message, which otherwise resizes text and breaks the fixed 560px column.
  //
  // The `<!--[if mso]>` ghost table exists because Outlook ignores `max-width`
  // entirely: without it the 560px column stretches to the full window width
  // and the layout reads as an unformatted band of text across a 27" monitor.
  // Non-Outlook clients never see it — it is inside a conditional comment.
  const document = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${title}</title>
  </head>
  <body
    style="margin:0;padding:0;width:100%;background:${BG_COLOR};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;"
    bgcolor="${BG_COLOR}"
  >
    ${preheader}
    <table
      role="presentation"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      bgcolor="${BG_COLOR}"
      style="background:${BG_COLOR};"
    >
      <tr>
        <td align="center" style="padding:24px 12px;">
          <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table
            role="presentation"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="max-width:560px;width:100%;"
          >
            <tr>
              <td
                align="center"
                style="padding:0 0 20px 0;font-family:${FONT_STACK};font-size:18px;font-weight:bold;letter-spacing:-0.2px;color:${BRAND_COLOR};"
              >
                ${masthead}
              </td>
            </tr>
            <tr>
              <td
                bgcolor="${CARD_COLOR}"
                style="background:${CARD_COLOR};border:1px solid ${BORDER_COLOR};border-radius:10px;padding:32px 28px;"
              >
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td
                      style="font-family:${FONT_STACK};font-size:20px;font-weight:bold;line-height:28px;color:${TEXT_COLOR};padding:0 0 16px 0;"
                    >
                      ${title}
                    </td>
                  </tr>
                  <tr>
                    <td
                      style="font-family:${FONT_STACK};font-size:15px;line-height:24px;color:${TEXT_COLOR};"
                    >
                      ${bodyHtml}
                    </td>
                  </tr>
                  ${ctaBlock}
                </table>
              </td>
            </tr>
            <tr>
              <td
                align="center"
                style="padding:20px 12px 0 12px;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${MUTED_COLOR};"
              >
                This is an automated message from ${APP_NAME}.<br />
                If you were not expecting it, you can safely ignore it.
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return document.toString();
}

// -----------------------------------------------------------------------------
// The plain-text half
// -----------------------------------------------------------------------------
//
// THE TEXT PART IS MANDATORY AND HAND-WRITTEN. There is deliberately no
// function anywhere in this module that takes HTML and returns text, because
// the moment one exists every template will use it and the text part stops
// being written.
//
// Two independent reasons, both load-bearing:
//
//   1. **Deliverability.** Spam filters score HTML-only multipart-less mail as
//      a signal, because legitimate bulk senders produce both parts and a good
//      deal of unsolicited mail does not. This is not theoretical scoring
//      trivia: it moves messages to the junk folder.
//
//   2. **It is read by humans.** Text-only clients, screen readers in text
//      mode, and previews all render this part. A machine-stripped version
//      reads as debris — bare CTA URLs stranded mid-sentence, table remnants,
//      the footer welded to the greeting, the preheader padding transcribed as
//      a run of nothing. A recipient who sees that concludes the message is
//      broken, which is worse than the HTML they could not read.
//
// So `plainText` composes from STRUCTURE the author supplies — a title and
// lines — rather than from the rendered markup, which it never sees.
// -----------------------------------------------------------------------------

export interface PlainTextOptions {
  /** Same heading as the HTML, so the two parts say the same thing. */
  title: string;

  /**
   * Body paragraphs, one per element; an empty string is a blank line.
   *
   * TYPED AS A NON-EMPTY TUPLE. `[]` does not typecheck, so "I will fill the
   * text part in later" is a compile error rather than a message that ships
   * with an empty alternative part — which is exactly the failure the
   * mandatory-text rule above exists to prevent, and exactly the one that is
   * invisible unless somebody opens the message in a text client.
   */
  lines: readonly [string, ...string[]];

  /** CTA label, matching the HTML button. */
  ctaLabel?: string;

  /** CTA URL. Written out in full — a text part cannot hide a link behind a label. */
  ctaUrl?: string;
}

/**
 * Compose the plain-text alternative for a message.
 *
 * No wrapping, no reflowing, no markdown. Mail clients wrap text parts
 * themselves at the width of the reader's window, and a hard-wrapped body
 * double-wraps into a ragged mess on a phone.
 */
export function plainText(opts: PlainTextOptions): string {
  const parts: string[] = [APP_NAME, '', opts.title, '', ...opts.lines];

  if (opts.ctaLabel && opts.ctaUrl) {
    // The URL is scheme-checked here too. A text part is not markup, so there
    // is no injection to prevent — but a `javascript:` URL that the HTML half
    // refused to render must not reappear here as something the recipient can
    // copy into a browser bar.
    const checked = safeUrl(opts.ctaUrl);
    if (checked) {
      parts.push('', `${opts.ctaLabel}: ${checked}`);
    }
  }

  parts.push(
    '',
    '--',
    `This is an automated message from ${APP_NAME}.`,
    'If you were not expecting it, you can safely ignore it.',
  );

  // CRLF, not LF. RFC 5322 specifies CRLF line endings, and while most
  // transports normalise, some SMTP relays pass bare LF through and the
  // recipient sees the whole body on one line.
  return parts.join('\r\n');
}

// Re-exported so `escapeHtml` is reachable from the module #123 names it in,
// alongside `renderLayout`. It is DEFINED in safe-html.ts next to the `html`
// tag that calls it, so the two cannot drift apart.
export { escapeHtml, html, SafeHtml, safeUrl } from './safe-html';
