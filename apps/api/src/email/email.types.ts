// =============================================================================
// Email transport types (issue #122, epic #109)
// =============================================================================
//
// The wire format between "something that renders a message" (#123 templates,
// #125 dispatcher) and "something that puts it on the network" (the providers
// in ./providers). Deliberately free of Nest, Prisma and the AWS/nodemailer
// SDKs: a template test and a dispatcher test should be able to build an
// `EmailMessage` and assert on an `EmailSendResult` without standing up DI or
// mocking a transport.
// =============================================================================

/**
 * A fully-rendered, ready-to-send email message.
 *
 * Everything here is final. A provider does not render, does not apply the
 * configured from-address, and does not fall back to a default subject — by
 * the time a message reaches a provider, every decision has been made. That
 * keeps "what did we send?" answerable from one place (#123/#125) rather than
 * from whichever transport happened to be selected.
 */
export interface EmailMessage {
  /** Single recipient. Fan-out is the dispatcher's job (#125), not a transport's. */
  to: string;

  /**
   * RFC 5322 From. Either a bare address or `Name <address>`.
   *
   * Required, not defaulted from `email.fromAddress`: a provider that silently
   * substitutes a from-address turns "the admin never configured a sender"
   * into a send that succeeds against SES and then bounces at the recipient,
   * which is a far harder failure to trace than a refused send.
   */
  from: string;

  subject: string;

  /** HTML body. Always present — #123 renders both parts for every template. */
  html: string;

  /**
   * Plain-text alternative. NOT optional: a text part is required both for
   * deliverability scoring and for clients that refuse to render HTML, and
   * making it optional here is how it quietly stops being produced.
   */
  text: string;

  /**
   * Extra RFC 5322 headers, passed to the transport verbatim.
   *
   * For per-RECIPIENT headers that cannot be provider configuration — a
   * `List-Unsubscribe` pair whose token embeds the user id, a correlation id.
   */
  headers?: Record<string, string>;

  /**
   * Images embedded in {@link html} by content id. Usually absent.
   *
   * ⚠ THIS IS NOT A GENERAL FILE-ATTACHMENT FACILITY, and the type is narrow
   * on purpose so it cannot quietly become one. Every field below exists to
   * serve one case: the brand logo in the layout's header
   * (`templates/brand-logo.ts`). Sending a user a report, an export or an
   * invoice belongs on a signed download URL behind authentication — not
   * stapled to a message that gets forwarded, archived by a third party, and
   * re-delivered to whoever the recipient's mailbox rules say. If a future
   * feature needs real attachments, that is a deliberate design conversation
   * with a size limit and a virus-scanning question attached; it is not a
   * matter of passing a bigger array through here.
   *
   * Absent and `[]` mean the same thing and are the ordinary case: every
   * template except the invitation renders a text wordmark and attaches
   * nothing (see `templates/layout.ts`).
   */
  attachments?: readonly EmailAttachment[];
}

/**
 * One image embedded in the HTML body and referenced as `cid:<cid>`.
 *
 * ## Why CID rather than a remote `<img src="https://…">`
 *
 * Gmail, Outlook and Apple Mail block REMOTE content by default until the
 * recipient clicks "display images". A CID part is not remote: it travels
 * inside the message, is never fetched over the network, and is therefore
 * displayed on first open with no click and no tracking-pixel signal to a
 * spam filter. `templates/layout.ts`'s header carries the full argument.
 *
 * ## The cost, so nobody has to discover it
 *
 * Every byte here is base64-encoded (a ~33% overhead) into EVERY copy of the
 * message, once per recipient. That is why {@link content} is a `Buffer` of a
 * committed, deliberately small asset rather than anything a caller composes
 * at send time.
 */
export interface EmailAttachment {
  /**
   * The bytes. A `Buffer`, not a path and not a stream.
   *
   * A path would be resolved by the transport, at send time, against whatever
   * working directory the process happened to have — and the two transports
   * would resolve it differently. A stream cannot be sent twice, and the SES
   * path (see `providers/ses-email.provider.ts`) has to buffer the whole MIME
   * document anyway.
   */
  content: Buffer;

  /**
   * RFC 2392 content id, WITHOUT the angle brackets, exactly as it appears
   * after `cid:` in the HTML.
   *
   * The two must agree or the recipient sees a broken-image placeholder —
   * which is strictly worse than the text wordmark this feature replaced. That
   * is why `renderLayout` takes the whole attachment rather than a bare id
   * string: the markup and the part are produced from one value.
   */
  cid: string;

  /** Reported filename. Shown by clients that list inline parts separately. */
  filename: string;

  /** MIME type, e.g. `image/png`. Set explicitly; never inferred here. */
  contentType: string;
}

/**
 * The outcome of a single send attempt.
 *
 * THIS TYPE IS THE ONLY WAY A PROVIDER REPORTS FAILURE. See
 * {@link ./providers/email-provider.interface.ts} for why `send` must never
 * throw, and `base-email.provider.ts` for how that is enforced structurally.
 */
export interface EmailSendResult {
  success: boolean;

  /** Transport-assigned id, present on success. Recorded by #125's delivery rows. */
  messageId?: string;

  /**
   * Human-readable failure text, present on failure.
   *
   * SURFACED TO AN ADMIN VERBATIM by #124's "Send test email" button —
   * diagnosing a mail misconfiguration is that page's entire purpose, so a
   * generic "send failed" would make it useless. That makes this field a
   * disclosure surface: it must never contain the SMTP password, an AWS
   * secret key, or a message body. The providers redact and truncate before
   * populating it; do not bypass that.
   */
  error?: string;
}
