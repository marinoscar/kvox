import { Injectable, Logger } from '@nestjs/common';

import {
  EmailSettingsService,
  SesEmailProvider,
  SmtpEmailProvider,
  findEmailTemplate,
  formatFromHeader,
} from '../../email';
import type {
  EmailMessage,
  EmailProvider,
  EmailProviderKind,
  EmailSettings,
  EmailTemplateName,
  RenderedEmail,
} from '../../email';
import { describeThrown } from '../describe-thrown';
import type { NotificationChannel } from '../notification-events';
import type {
  ChannelDeliveryResult,
  NotificationChannelSender,
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';

// =============================================================================
// EmailNotificationChannel (issue #125, epic #109)
// =============================================================================
//
// The one implemented channel. It joins the three halves #121–#123 built and
// left unconnected: an event key from the registry, a template from
// `../../email/templates`, and a transport from `../../email/providers`.
//
// IT IS A CHANNEL, NOT "THE" CHANNEL. `NotificationsService` reaches it only
// through `NotificationChannelSender`, so #127's browser channel is a sibling
// class and a line in the module factory rather than a branch anywhere in the
// dispatcher.
//
// -----------------------------------------------------------------------------
// WHY THIS DUPLICATES SOME OF `EmailTestSendService`'s GATING
// -----------------------------------------------------------------------------
//
// Both check `enabled`, `provider` and `fromAddress` before sending. That is
// deliberate rather than an extraction waiting to happen, because the two want
// OPPOSITE things from a failure. #124's test send is a DIAGNOSTIC: its whole
// output is a sentence for an admin staring at the settings form, it writes an
// `email_settings:test` audit row, and it returns a `TestEmailResult`. This is
// a DELIVERY path: its output is a `notification_deliveries` row, it has no
// admin looking at it, and it must never write an audit event for a message
// nobody asked to send.
//
// What IS shared is the part where duplication would be a bug rather than
// noise: `formatFromHeader` — header escaping, where a second implementation
// means either mail from nobody or an injected header. #124 exported it for
// exactly this call site.
// =============================================================================

/**
 * Notification event key -> the email template that renders it.
 *
 * -----------------------------------------------------------------------------
 * FILLED BY #128. THESE THREE LINES ARE HALF OF "WIRING AN EVENT".
 * -----------------------------------------------------------------------------
 *
 * #125 shipped this empty because inventing a template before anybody had
 * written the copy would ship a message nobody had reviewed. #128 adds the
 * three templates and the three lines here that point at them.
 *
 * EVERY EVENT DECLARING THE `email` CHANNEL MUST APPEAR HERE. A missing entry
 * is not a silent skip: `deliver` below records a FAILED delivery saying no
 * template is registered, so "declared but unsendable" shows up in
 * `notification_deliveries` rather than being invisible.
 *
 * A MAP AND NOT A NAMING CONVENTION. Event keys are dotted (`user.welcome`);
 * template names are kebab-case and match their file (`user-welcome` ->
 * `user-welcome.email.ts`). Deriving one from the other would couple two
 * independently-owned naming schemes and turn a rename into a silent
 * "template not found" at send time — the map is three lines and it is
 * greppable from either side.
 *
 * `Partial<Record<...>>` so a lookup is typed `EmailTemplateName | undefined`
 * and the missing case has to be handled rather than trusted. The VALUES are
 * `EmailTemplateName`, so a typo on the right-hand side is a compile error;
 * only the event keys on the left are unchecked strings, and an unknown one is
 * dead weight rather than a runtime fault (the dispatcher never looks it up).
 */
export const EVENT_EMAIL_TEMPLATES: Partial<Record<string, EmailTemplateName>> =
  {
    'user.welcome': 'user-welcome',
    'allowlist.invitation': 'allowlist-invitation',
    'security.role_changed': 'role-changed',
    // ONE TEMPLATE, TWO KEYS (#322, epic #319). `admin.broadcast` and
    // `admin.broadcast_critical` differ in whether a recipient may MUTE them —
    // `mandatory` on the second — not in how the message reads, and the copy
    // they render was typed by an administrator either way. A second template
    // would be a copy of the first that drifts from it, so the `critical` flag
    // in the payload adds the one footer line that differs. This map is
    // `Partial<Record<string, ...>>`, so two keys pointing at one name is
    // exactly as legal as it is correct.
    'admin.broadcast': 'broadcast',
    'admin.broadcast_critical': 'broadcast',
    // The four operational events (#288, epic #254). One template each: unlike
    // the broadcast pair above, these four say genuinely different things, and
    // the only shape they share is the detail table their layouts happen to
    // use.
    'jobs.job_failed': 'job-failed',
    'nodes.node_offline': 'node-offline',
    'db_backup.backup_failed': 'backup-failed',
    'db_backup.restore_completed': 'restore-completed',
  };

@Injectable()
export class EmailNotificationChannel implements NotificationChannelSender {
  readonly channel: NotificationChannel = 'email';

  private readonly logger = new Logger(EmailNotificationChannel.name);

  /**
   * Transport kind -> transport.
   *
   * A `Record<EmailProviderKind, EmailProvider>` rather than a `switch`, for
   * the reason spelled out on the identical map in `EmailTestSendService`:
   * adding a kind to `EMAIL_PROVIDER_KINDS` makes this fail to compile until
   * the transport is wired, where a `switch` would fall through and deliver
   * nothing with no error to explain it.
   *
   * Resolved per send from the SETTINGS, not chosen at construction: an admin
   * can switch provider without a restart, so a construction-time choice would
   * be stale the moment they did.
   */
  private readonly providers: Record<EmailProviderKind, EmailProvider>;

  constructor(
    private readonly emailSettings: EmailSettingsService,
    ses: SesEmailProvider,
    smtp: SmtpEmailProvider,
  ) {
    this.providers = { ses, smtp };
  }

  /**
   * The address this channel would send to.
   *
   * `null` when the recipient has no address — the dispatcher then writes no
   * delivery row and makes no attempt, rather than putting a placeholder in
   * the `recipient` column that is supposed to answer "where did it go?".
   *
   * `users.email` is NOT NULL, so for a `notify(..., userId, ...)` dispatch
   * this is always present. It is nullable on the type for the no-account
   * recipient (#128) and because a channel must be able to say "not reachable
   * this way" — which is what #127's browser channel will return for a user
   * who never granted permission.
   */
  resolveTo(recipient: NotificationRecipient): string | null {
    return recipient.email;
  }

  /**
   * Render the event's template and hand it to the configured transport.
   *
   * NEVER THROWS. Every branch below returns a `ChannelDeliveryResult`, and
   * `EmailProvider.send` carries the same guarantee structurally (see
   * `BaseEmailProvider`). The dispatcher wraps this call anyway — belt and
   * braces for channels added later — but nothing here relies on that.
   */
  async deliver(
    context: NotificationDispatchContext,
    to: string,
  ): Promise<ChannelDeliveryResult> {
    const eventKey = context.event.key;

    // Checked FIRST, before any I/O: a missing template is a code-level
    // omission (an event declared in the registry with nothing to render it),
    // and there is no reason to pay for a settings query to discover it. It is
    // recorded as a failed delivery rather than skipped silently, because
    // "this event is declared but can never be sent" is a bug that should be
    // visible in the same place an operator already looks for undelivered
    // notifications.
    const templateName = EVENT_EMAIL_TEMPLATES[eventKey];
    if (templateName === undefined) {
      return {
        success: false,
        error: `No email template is registered for event '${eventKey}'.`,
      };
    }

    // `EmailSettingsService.get` is the SEND path and THROWS on a stored-but-
    // invalid row — deliberately, so a corrupt configuration is not reported
    // as the benign "email is not configured". On this path that throw has to
    // become a result: #125's containment rule does not have an exception for
    // a bad settings row. The message it carries is field paths only, by
    // construction there, so it is safe to persist in the delivery record.
    let settings: EmailSettings;
    try {
      settings = await this.emailSettings.get();
    } catch (err) {
      return {
        success: false,
        error: `Email settings could not be read: ${describeThrown(err)}`,
      };
    }

    // THE MASTER SWITCH IS HONOURED, as it is by the test-send path. An admin
    // who turned email off for a maintenance window must not find that
    // notifications kept flowing. The delivery row records WHY nothing was
    // sent, which is the difference between this and dropping the event.
    if (!settings.enabled) {
      return { success: false, error: 'Email sending is disabled.' };
    }

    if (!settings.provider) {
      return { success: false, error: 'No email provider is configured.' };
    }

    // Checked here rather than left to the transport because the transports
    // deliberately do not default a from-address: a substituted sender turns
    // "never configured" into a send that SES accepts and the recipient's
    // server bounces hours later, which is far harder to trace than a refusal.
    if (!settings.fromAddress) {
      return { success: false, error: 'No sender address is configured.' };
    }

    const rendered = this.render(templateName, context.data);
    if (!rendered.ok) {
      return { success: false, error: rendered.error };
    }

    const message: EmailMessage = {
      to,
      from: formatFromHeader(settings.fromAddress, settings.fromName),
      subject: rendered.email.subject,
      html: rendered.email.html,
      text: rendered.email.text,
      ...(rendered.email.headers ? { headers: rendered.email.headers } : {}),
    };

    // No try/catch: `send` never throws, and that is implemented once in
    // `BaseEmailProvider` rather than promised. Adding one here would suggest
    // the guarantee is in doubt and would produce a worse message than the one
    // the base class already builds (redacted and length-capped).
    const result = await this.providers[settings.provider].send(message);

    if (!result.success) {
      return {
        success: false,
        // VERBATIM. Already through `SecretRedactor` and the length cap, and
        // it is the only thing that makes the failed row worth having.
        error: result.error ?? 'The transport reported a failure with no message.',
      };
    }

    // Event key, channel and provider only. No subject, no body, no recipient
    // address — the bodies on this path carry invitation links and role
    // changes, and application logs are shipped, indexed and retained far more
    // widely than `notification_deliveries` is. The address IS recorded, in
    // that table's `recipient` column, which is the controlled place for it.
    this.logger.log(
      `Sent '${eventKey}' by email via ${settings.provider}`,
    );

    return {
      success: true,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    };
  }

  /**
   * Render a template against an untyped payload.
   *
   * -----------------------------------------------------------------------------
   * WHY THIS CATCHES, WHEN `renderEmailTemplate` DOCUMENTS THAT IT DOES NOT
   * -----------------------------------------------------------------------------
   *
   * #123's rule — templates are pure, total, synchronous, so wrapping a render
   * only hides a genuine bug — holds at a call site where the payload's TYPE
   * is known, which is where `renderEmailTemplate` is meant to be used and
   * where a mismatch is a compile error.
   *
   * This call site is the one place in the system where it is not. `notify`
   * takes `data: unknown` on purpose, so the payload's shape is checked by
   * nothing, and a template reading `data.actor.email` on a caller's typo
   * throws a `TypeError` at runtime. Letting that propagate would violate the
   * containment rule the whole issue is built on — a bad payload for a welcome
   * email would take down the login that triggered it.
   *
   * So it is caught, and it is recorded as a FAILED delivery with the thrown
   * message. The bug is not hidden; it is written down, in the table an
   * operator queries for exactly this, instead of being converted into a 500
   * for an unrelated user action.
   *
   * `findEmailTemplate` (not `renderEmailTemplate`) because the name is not
   * statically known here — it came out of a runtime map keyed by event.
   */
  private render(
    templateName: EmailTemplateName,
    data: unknown,
  ): { ok: true; email: RenderedEmail } | { ok: false; error: string } {
    const template = findEmailTemplate(templateName);

    if (!template) {
      // Only reachable if `EVENT_EMAIL_TEMPLATES` names a template that has
      // since been removed from the template registry. The type system stops
      // that in a single build; a rolling deploy of two builds is where it
      // could briefly be true.
      return {
        ok: false,
        error: `Email template '${templateName}' is not registered.`,
      };
    }

    try {
      // The cast is the boundary. `EmailTemplate<never>` is the widest
      // callable shape `findEmailTemplate` can offer for a name it did not
      // know statically, so there is no type to check `data` against here —
      // which is precisely why the call is inside a `try`.
      return { ok: true, email: template(data as never) };
    } catch (err) {
      return {
        ok: false,
        // The message only. Never the payload: `data` is the caller's object
        // and may hold anything, including material that must not reach a
        // persisted column.
        error: `Rendering template '${templateName}' failed: ${describeThrown(err)}`,
      };
    }
  }
}
