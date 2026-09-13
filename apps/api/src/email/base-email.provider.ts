import type { Logger } from '@nestjs/common';

import type { EmailMessage, EmailSendResult } from './email.types';
import type { EmailProvider } from './providers/email-provider.interface';

// =============================================================================
// BaseEmailProvider — the never-throw guarantee, implemented once (issue #122)
// =============================================================================
//
// `EmailProvider.send` must never throw (see email-provider.interface.ts for
// the argument). A comment saying so is not a guarantee: the SES and SMTP
// providers each do configuration lookups, a decrypt, a DNS resolution, a TCP
// connect, a TLS handshake and an SDK call, and any of them can throw or
// reject. One `try` block that someone later narrows to "just the send call"
// while refactoring is all it takes.
//
// So `send` is implemented HERE, once, `final` by convention, and subclasses
// implement `deliver` instead. A provider subclass contains no try/catch at
// all and has no `send` to get wrong; the entire never-throw contract is this
// one method, in a file whose only job is that method.
//
// The catch is deliberately bare `catch` over EVERYTHING — not
// `catch (e: Error)`, not a filtered rethrow. There is no error class from
// which the right answer is "let it propagate": a bug in nodemailer and an
// unverified SES sender are the same thing to a caller in the middle of a role
// change, namely "no email went out".
// =============================================================================

/**
 * The maximum length of an error string we will return or log.
 *
 * AWS SDK errors in particular can carry a serialised response body; an SMTP
 * server can answer with an arbitrarily long banner. #124 renders this text in
 * an admin dialog, and it also goes into a delivery record (#125), so it is
 * capped at something a human can actually read.
 */
const MAX_ERROR_LENGTH = 2000;

/**
 * Shortest secret we will redact by substring.
 *
 * Below this a secret is indistinguishable from ordinary words in an error
 * ("smtp", "true"), and blanket-replacing it would corrupt the message into
 * uselessness while still not proving the secret is gone. Under the floor we
 * take the other branch — see {@link SecretRedactor.apply}.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Collects the secrets in play during one send so that ANY error raised
 * afterwards can be scrubbed before it is logged or returned.
 *
 * WHY THIS EXISTS RATHER THAN "just don't put the password in the error":
 * we do not write most of these errors. nodemailer builds its own error text,
 * and an SMTP server's rejection is echoed back to us verbatim; a server that
 * quotes the offending AUTH line, or a transport bug that stringifies its own
 * options, would put the password into a string we then hand to an admin
 * screen (#124) and a database row (#125). Registering the secret the moment
 * we hold it means the scrub happens even for errors from code we do not own.
 *
 * The plaintext lives in this object for the duration of one send. That is the
 * same lifetime the transport itself needs it for, so it adds no new exposure
 * window; it is dropped when the send returns.
 */
export class SecretRedactor {
  private readonly secrets: string[] = [];

  /**
   * Register a value that must never appear in an error string.
   *
   * Call this at the instant the secret is obtained — BEFORE the code that
   * might throw while holding it, not in the failure path, where a throw
   * would have skipped it.
   */
  protect(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length > 0) {
      this.secrets.push(secret);
    }
  }

  /**
   * Scrub every registered secret out of `text`.
   *
   * Long secrets are replaced in place, keeping the rest of the message —
   * which is the whole point of showing the provider's real error. A secret
   * too short to replace safely (see {@link MIN_REDACTABLE_SECRET_LENGTH})
   * costs the caller the entire message instead: an unreadable error is a bad
   * outcome, a leaked password is a worse one, and the choice is not close.
   */
  apply(text: string): string {
    let out = text;

    for (const secret of this.secrets) {
      if (!out.includes(secret)) continue;

      if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) {
        return '[error withheld: it contained the configured credential]';
      }

      out = out.split(secret).join('[redacted]');
    }

    return out;
  }
}

/**
 * Base class for every email transport in this app.
 *
 * Subclasses implement {@link deliver}; they do not implement `send` and must
 * not override it.
 */
export abstract class BaseEmailProvider implements EmailProvider {
  /** Subclass's logger, so failures are attributed to the real transport. */
  protected abstract readonly logger: Logger;

  /** Short transport name for log lines and error prefixes: 'SES', 'SMTP'. */
  protected abstract readonly transportName: string;

  /**
   * Do the actual work: resolve configuration, build a client, put the message
   * on the network.
   *
   * MAY THROW FREELY — that is the point. Throwing here is how a subclass
   * reports "this cannot be done", and {@link send} turns it into a result.
   * A subclass therefore needs no try/catch, and adding one only makes the
   * error message worse than what this class already produces.
   *
   * @param redact register any secret obtained here, immediately, so an error
   *               raised later cannot carry it out of the process.
   */
  protected abstract deliver(
    msg: EmailMessage,
    redact: SecretRedactor,
  ): Promise<EmailSendResult>;

  /**
   * Send one message. NEVER throws. Do not override.
   *
   * @see ./providers/email-provider.interface.ts for why this contract exists.
   */
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const redact = new SecretRedactor();

    try {
      // `await` inside the try, not a returned promise: returning
      // `this.deliver(...)` would resolve the try block before the promise
      // settles, and a rejection would escape this catch entirely. This is
      // the single most likely way for someone to break the contract while
      // "simplifying" this method.
      const result = await this.deliver(msg, redact);

      // Normalise a malformed return. A subclass that falls off the end of a
      // branch yields `undefined`, and a caller reading `.success` on it
      // throws a TypeError one stack frame outside this try — a never-throw
      // violation with this class's name on it. Cheap to rule out here.
      if (!result || typeof result !== 'object') {
        this.logger.error(
          `${this.transportName} provider returned no result object; treating as a failure`,
        );
        return {
          success: false,
          error: `${this.transportName} transport returned no result.`,
        };
      }

      if (result.success) {
        return result;
      }

      // A subclass-authored failure still goes through redaction and
      // truncation, so there is exactly one exit path for error text.
      return {
        success: false,
        error: this.formatError(result.error ?? 'Unknown error.', redact),
      };
    } catch (err) {
      const error = this.formatError(
        err instanceof Error
          ? err.message || err.name
          : typeof err === 'string'
            ? err
            : // Never `JSON.stringify(err)`: a thrown object could be an SDK
              // request context holding the credentials it was built with.
              `Non-Error value of type ${typeof err} thrown.`,
        redact,
      );

      // Body, subject and recipient are absent from this log line on purpose.
      // Bodies carry invitation and password-reset tokens (#123 onwards),
      // subjects carry names, and application logs are shipped, indexed and
      // retained far more widely than mail is. The error and the transport are
      // what makes a misconfiguration diagnosable; the message content adds
      // nothing to that and a great deal to the blast radius of a log leak.
      this.logger.warn(`${this.transportName} send failed: ${error}`);

      return { success: false, error };
    }
  }

  /**
   * Single choke point for every error string this class emits: redact, then
   * truncate, then label with the transport.
   */
  private formatError(raw: string, redact: SecretRedactor): string {
    const scrubbed = redact.apply(raw);
    const truncated =
      scrubbed.length > MAX_ERROR_LENGTH
        ? `${scrubbed.slice(0, MAX_ERROR_LENGTH)}… (truncated)`
        : scrubbed;

    // Always prefixed with the transport: #124 shows this text with no other
    // context, and "Connection timeout" is a different problem depending on
    // whether it came from SES or from an SMTP host.
    return `${this.transportName}: ${truncated}`;
  }
}
