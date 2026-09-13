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
