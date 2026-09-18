import type { EmailAttachment, EmailMessage } from '../email.types';

// =============================================================================
// Email template contract (issue #123, epic #109)
// =============================================================================
//
// ONE SHAPE FOR EVERY TEMPLATE: a pure function from typed data to
// `{ subject, html, text }`. No Nest, no DI, no I/O, no clock, no database —
// a template is called with everything it needs and returns a value, so it can
// be tested by calling it, and #125 can render one without standing up a
// module.
//
// This sits one layer above #122's `EmailMessage` (../email.types.ts):
//
//     RenderedEmail  +  { to, from }  =  EmailMessage
//
// The split is deliberate. A template knows what a message SAYS; it has no
// business knowing who it goes to or which address the admin configured as the
// sender — those are the dispatcher's (#125) to supply, from settings and from
// the recipient list. Keeping `to`/`from` out of here also means a template can
// be rendered once and delivered to several recipients without re-rendering,
// and that a template test never has to invent an address.
// =============================================================================

/**
 * What a template returns: the rendered halves of one message.
 */
export interface RenderedEmail {
  /**
   * The subject line. PLAIN TEXT, never HTML — it is not markup and escaping
   * it would mail the recipient a literal `&amp;`.
   */
  subject: string;

  /** The full HTML document, from `renderLayout`. */
  html: string;

  /**
   * The plain-text alternative. REQUIRED, NOT OPTIONAL, and hand-written per
   * template — see the long note above `plainText` in layout.ts for the
   * deliverability and readability reasons, and for why no HTML-to-text
   * function exists in this module.
   *
   * `EmailMessage.text` is required for the same reason. Making it optional in
   * either place is how it stops being produced.
   */
  text: string;

  /**
   * Extra RFC 5322 headers for this specific message, passed to the transport
   * verbatim. Most templates want {@link TRANSACTIONAL_EMAIL_HEADERS}.
   */
  headers?: Record<string, string>;

  /**
   * Images this template's {@link html} references as `cid:…`, to travel
   * inside the message. Usually absent.
   *
   * A TEMPLATE OWNS BOTH HALVES, and that is the only arrangement that works:
   * the `cid:` is written by `renderLayout` on this template's behalf, so the
   * matching part has to be produced at the same call site. A dispatcher
   * cannot supply it — it has not seen the markup — and a layout cannot
   * attach it, because a layout returns a string.
   *
   * See `email.types.ts`'s `EmailAttachment` for why this is narrow, and
   * `templates/brand-logo.ts` for the one asset that uses it today.
   */
  attachments?: readonly EmailAttachment[];
}

/**
 * Headers every system-generated message should carry.
 *
 * NOT APPLIED AUTOMATICALLY by the layout, because the layout renders a body
 * and headers are not part of one — but exported here so a template spreads it
 * rather than half-remembering the two header names.
 *
 * `Auto-Submitted: auto-generated` (RFC 3834) tells conforming auto-responders
 * not to reply. Without it, a recipient's out-of-office replies to our
 * no-reply address, our bounce handling replies to theirs, and the two
 * generate mail at each other until somebody notices. `X-Auto-Response-
 * Suppress` is Microsoft's non-standard equivalent, honoured by Exchange and
 * Outlook, which predate and ignore RFC 3834. Both are needed to cover the
 * field.
 */
export const TRANSACTIONAL_EMAIL_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-generated',
  'X-Auto-Response-Suppress': 'All',
};

/**
 * The signature every template function satisfies.
 *
 * SYNCHRONOUS AND TOTAL, on purpose. A template that could `await` would
 * invite one to fetch the data it renders, which puts a database round-trip
 * inside the delivery path and gives a template two ways to fail — one of them
 * by rejecting, from a code path (#125's dispatcher) whose defining rule is
 * that a notification failure never fails the action that triggered it. Data
 * is gathered by the caller and passed in.
 */
export type EmailTemplate<TData> = (data: TData) => RenderedEmail;

// -----------------------------------------------------------------------------
// Compile-time proof that a RenderedEmail still fits an EmailMessage
// -----------------------------------------------------------------------------
//
// Mirrors the technique in ../email-settings.schema.ts. These two aliases
// resolve to `never` — and this file stops compiling — if #122's transport
// contract and #123's template contract ever stop lining up.
//
// The check runs in BOTH directions on purpose. One direction alone would
// catch a renamed or retyped field but not a LOOSENED one: if
// `EmailMessage.text` became optional, `RenderedEmail extends
// MessageRenderedPart` would still hold, and the mandatory-text-part rule
// would have quietly become advisory with nothing going red.
//
// ⚠ `attachments` IS IN THIS PICK, and adding a field to `EmailMessage`'s
// rendered half without adding it here is how the two quietly diverge: the
// dispatcher would keep compiling while silently dropping the part on the
// floor, and the only symptom would be a broken-image placeholder in somebody
// else's inbox.

type MessageRenderedPart = Pick<
  EmailMessage,
  'subject' | 'html' | 'text' | 'headers' | 'attachments'
>;

export type RenderedEmailFitsMessage =
  RenderedEmail extends MessageRenderedPart ? true : never;

export type MessageRenderedPartFitsRendered =
  MessageRenderedPart extends RenderedEmail ? true : never;

export const RENDERED_EMAIL_MATCHES_MESSAGE: RenderedEmailFitsMessage &
  MessageRenderedPartFitsRendered = true;

/**
 * Everything a rendered template contributes to an `EmailMessage`.
 *
 * WHY THIS EXISTS RATHER THAN A SPREAD AT EACH CALL SITE. There are exactly
 * two places that turn a `RenderedEmail` into an `EmailMessage` — the
 * notification dispatcher and the "send test email" button — and both used to
 * enumerate the fields by hand. The Pick proof above catches a field that
 * changes SHAPE; it cannot catch a field that a call site simply does not
 * mention, because an optional property left out still typechecks. That is the
 * exact failure `attachments` would produce: a message whose HTML references a
 * `cid:` whose part was dropped between the template and the transport, seen
 * by nobody until it lands as a broken image in somebody's inbox.
 *
 * Conditional spreads rather than `attachments: rendered.attachments`, so a
 * message that carries neither headers nor attachments is the same object it
 * has always been — which is what makes "no attachments changes nothing"
 * assertable rather than merely intended.
 */
export function renderedEmailParts(
  rendered: RenderedEmail,
): MessageRenderedPart {
  return {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(rendered.headers ? { headers: rendered.headers } : {}),
    ...(rendered.attachments && rendered.attachments.length > 0
      ? { attachments: rendered.attachments }
      : {}),
  };
}
