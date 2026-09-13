import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { EMAIL_PROVIDER_KINDS } from '../email-settings.schema';

// =============================================================================
// POST /api/email-settings/test — response body (issue #124, epic #109)
// =============================================================================
//
// THIS ENDPOINT ANSWERS 200 EVEN WHEN THE SEND FAILED. That is the design, not
// an oversight, and it is the single most important thing in this file.
//
// Epic #109 and issue #124 both state the point of this page in the same
// words: diagnosing a mail misconfiguration is its entire job. A failed test
// send is therefore a SUCCESSFUL DIAGNOSTIC — the endpoint did exactly what it
// was asked to do, and the answer is "SES says the sender is not verified".
//
// Returning 4xx/5xx for that answer loses it. This app's error envelope is
// `{ code, message, details }` produced by `HttpExceptionFilter`, a shape the
// web client funnels into generic failure handling; and the filter suppresses
// detail in production by design. The provider's actual text — the one fact
// worth having — would arrive as "Request failed". So the outcome travels as a
// normal payload, in a body whose `success` field the caller must read.
//
// A real 4xx/5xx still means what it always means here: not authenticated, not
// permitted, a malformed request, or a bug. Those are transport failures of
// the endpoint. A refused send is a result.
//
// `success` IS THE ONLY SUCCESS SIGNAL. A caller that treats HTTP 200 as
// "email works" reports success for every misconfiguration in existence.
// =============================================================================

export const testEmailResultSchema = z.object({
  /**
   * Did the provider accept the message?
   *
   * Copied verbatim from `EmailSendResult.success` — never inferred from the
   * absence of an error, never optimistically defaulted. Issue #124: "never
   * claim success when the provider returned `{ success: false }`".
   *
   * NOTE WHAT THIS DOES NOT MEAN: the provider ACCEPTED the message, which is
   * not the same as the recipient receiving it. SES can accept and then bounce;
   * an SMTP relay can accept and quietly drop. The UI should say "sent", not
   * "delivered" — and the message itself (see test-email.email.ts) exists so
   * the admin can confirm arrival with their own eyes.
   */
  success: z.boolean(),

  /**
   * Where it went: the authenticated caller's own address.
   *
   * Echoed back so the page can say "check <that inbox>" rather than leaving
   * the admin guessing which of their accounts the app knows about — and so a
   * send to an unexpected address is visible immediately.
   *
   * THERE IS NO REQUEST FIELD FOR THIS. The recipient is taken from the
   * session, never from the body. A free-text recipient turns an admin form
   * into a send-arbitrary-mail endpoint (issue #124, "Alternatives
   * Considered"), and this response field is a read-back of a server decision,
   * not an echo of client input.
   */
  sentTo: z.email(),

  /**
   * Which transport carried (or refused) it.
   *
   * Null only when no provider was configured, i.e. nothing was attempted. An
   * admin who has just switched from SMTP to SES needs to know which one
   * produced the error in front of them.
   */
  providerKind: z.enum(EMAIL_PROVIDER_KINDS).nullable(),

  /**
   * The transport's message id, on success. Null on failure.
   *
   * Worth surfacing: it is the string that correlates this attempt with an SES
   * console entry or a relay's log, which is the next step when the provider
   * accepted a message that never arrived.
   */
  messageId: z.string().nullable(),

  /**
   * THE PROVIDER'S ACTUAL ERROR, VERBATIM. Null on success.
   *
   * `MessageRejected: Email address is not verified...`,
   * `535 Authentication failed`, `connection timeout`. Not a category, not a
   * rewritten sentence, not "failed to send" — each of those discards the only
   * information the admin came here for, and a wrong region, a bad password
   * and an unverified sender all collapse into the same useless toast.
   *
   * SAFE TO SURFACE, for two independent reasons:
   *
   *   1. The reader already holds `system_settings:write`. Every value this
   *      text could reveal about the mail configuration is one they can read
   *      and change on the same page. No privilege boundary is crossed.
   *   2. The text has already been through `SecretRedactor` and the length cap
   *      in `BaseEmailProvider.formatError`, which is the ONLY exit path for
   *      provider error strings. Secrets are registered at the instant they
   *      are obtained — before the connect, the TLS handshake and the AUTH
   *      exchange — so even an error authored by nodemailer or the AWS SDK,
   *      code we do not own, is scrubbed. Where a secret is too short to
   *      replace safely the whole message is withheld instead.
   *
   * Do not bypass that path by building an error string here from a caught
   * exception; route it through a provider result so it is redacted.
   */
  error: z.string().nullable(),

  /** When the attempt was made. Matches the timestamp inside the message. */
  attemptedAt: z.iso.datetime(),
});

/** The POST /test response body (inside the global `{ data }` envelope). */
export type TestEmailResult = z.infer<typeof testEmailResultSchema>;

export class TestEmailResultDto extends createZodDto(testEmailResultSchema) {}
