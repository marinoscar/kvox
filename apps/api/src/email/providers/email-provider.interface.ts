import type { EmailMessage, EmailSendResult } from '../email.types';

// =============================================================================
// EmailProvider (issue #122, epic #109)
// =============================================================================
//
// One interface, two transports (SES and SMTP), so the dispatcher (#125) never
// knows or cares which is configured. Adding a third — a hosted API, a
// file-writing transport for local development — is a new class implementing
// this and a line in the module, with nothing above it to change.
// =============================================================================

/**
 * A concrete email transport.
 *
 * ## `send` MUST NOT THROW. Ever. For any reason.
 *
 * Every failure — bad credentials, an unreachable host, an unverified sender,
 * a DNS failure, a missing or corrupt configuration, a bug in the transport
 * library — comes back as `{ success: false, error }`.
 *
 * WHY, concretely: notifications are fired from the middle of business
 * actions. A role change that succeeds and then 500s because the SMTP host is
 * down is a strictly worse outcome than a role change with no email — the
 * admin sees a failure, retries, and the second attempt is either a no-op or a
 * duplicate. Worse, if the send sits inside a transaction, an exception rolls
 * the role change back: mail-server availability would decide whether RBAC
 * changes persist.
 *
 * The alternative — throw, and let callers wrap — puts a try/catch obligation
 * on every call site in the codebase forever, and it only takes one missing
 * one to couple a business action to a mail server.
 *
 * THIS IS NOT ENFORCED BY DOCUMENTATION. Implementations extend
 * {@link ../base-email.provider.BaseEmailProvider}, which implements `send`
 * once, as a `try`/`catch` around an abstract `deliver`. A subclass has no
 * `send` to get wrong. If you are writing a provider that implements this
 * interface directly, you are about to reintroduce the bug this note exists
 * to prevent.
 */
export interface EmailProvider {
  /**
   * Attempt to deliver one message.
   *
   * @returns the outcome. NEVER rejects — a rejected promise from an
   *          implementation is a bug in that implementation, not a case for
   *          callers to handle.
   */
  send(msg: EmailMessage): Promise<EmailSendResult>;
}
