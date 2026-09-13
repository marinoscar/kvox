import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { EmailSettingsService } from './email-settings.service';
import type { EmailProviderKind, EmailSettings } from './email-settings.schema';
import type { EmailMessage } from './email.types';
import type { EmailProvider } from './providers/email-provider.interface';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { renderEmailTemplate } from './templates';
import type { TestEmailResult } from './dto/test-email-result.dto';

// =============================================================================
// EmailTestSendService — the "Send test email" button (issue #124, epic #109)
// =============================================================================
//
// THIS IS A DIAGNOSTIC, AND EVERY DECISION BELOW FOLLOWS FROM THAT.
//
// Epic #109 and issue #124 say the same thing twice: diagnosing a mail
// misconfiguration is this page's entire job. A wrong SES region, an
// unverified sender identity, a bad SMTP password and a firewalled port all
// fail, and they fail DIFFERENTLY. The value of this endpoint is exactly the
// difference between those failures, so nothing here may flatten them into a
// category, a boolean, or a rewritten sentence.
//
// -----------------------------------------------------------------------------
// THE RECIPIENT IS THE CALLER. THERE IS NO RECIPIENT PARAMETER.
// -----------------------------------------------------------------------------
//
// The address comes from the authenticated session and from nowhere else. A
// free-text recipient field is tempting -- testing deliverability to a
// colleague is a real thing an admin wants -- and it turns an admin form into
// an endpoint that sends attacker-composed-looking mail, from this app's
// verified domain, to any address on the internet. Issue #124 rejects it by
// name under "Alternatives Considered".
//
// Note the shape that keeps this honest: `sendTest` takes an authenticated
// user, not an address. There is no parameter for a caller to fill from a
// request body, so "just let them pass a `to`" is a signature change and a
// visible diff rather than a one-word edit at a call site.
//
// -----------------------------------------------------------------------------
// IT RETURNS A RESULT; IT DOES NOT THROW FOR A FAILED SEND
// -----------------------------------------------------------------------------
//
// A refused send is a successful diagnosis. See the long note in
// ./dto/test-email-result.dto.ts for why the outcome travels as a 200 payload
// rather than through this app's error envelope -- in short, the envelope
// suppresses detail in production and the client funnels it into generic
// failure handling, so the one fact worth having would be the one fact lost.
//
// Configuration problems detected BEFORE a provider is reached (no transport
// chosen, sending disabled, no from address) come back through the same
// `{ success: false, error }` shape as a provider rejection, because to the
// admin they are the same question -- "why did nothing arrive?" -- and
// answering half of them in a different shape means the UI needs two code
// paths to display one sentence.
// =============================================================================

/**
 * Characters that must never reach an RFC 5322 header value.
 *
 * CR and LF terminate a header. A display name containing one would let
 * whatever follows be read as a new header — a second `Bcc:`, a forged
 * `Reply-To:` — which is header injection, and the injected text here would
 * come from the `fromName` SETTING. That is admin-controlled rather than
 * anonymous, so this is defence in depth rather than the last line, but a
 * stored setting is exactly the kind of value that later gets populated from
 * somewhere less trusted. NUL is stripped for the same reason: it truncates
 * the header in some C-based MTAs and hides everything after it.
 */
const HEADER_UNSAFE = /[\r\n\0]/g;

/** Printable US-ASCII, the range an RFC 5322 quoted-string may carry as-is. */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/**
 * Build the `From` header value from the configured address and display name.
 *
 * Exported because #125's dispatcher needs the identical string for real
 * notifications, and a second implementation would be a second chance to get
 * the escaping wrong — in a header, where "wrong" means either a mail the
 * recipient sees as coming from nobody, or an injected header.
 *
 * Three cases, in order:
 *
 *   * no name              -> the bare address
 *   * printable-ASCII name -> an RFC 5322 quoted-string, with `"` and `\`
 *                             backslash-escaped (they are the only two
 *                             characters a quoted-string cannot carry raw)
 *   * anything else        -> RFC 2047 encoded-word, base64/UTF-8
 *
 * The third case is not theoretical: a display name is admin-entered free text
 * and `fromName` accepts any 100 characters. Raw UTF-8 in a header is illegal,
 * and SES rejects it outright rather than rendering it oddly — so "Ácme" in a
 * settings field would break every send with an error that says nothing about
 * display names.
 */
export function formatFromHeader(address: string, name?: string): string {
  const cleanedName = (name ?? '').replace(HEADER_UNSAFE, '').trim();
  const cleanedAddress = address.replace(HEADER_UNSAFE, '').trim();

  if (!cleanedName) return cleanedAddress;

  if (PRINTABLE_ASCII.test(cleanedName)) {
    const escaped = cleanedName.replace(/([\\"])/g, '\\$1');
    return `"${escaped}" <${cleanedAddress}>`;
  }

  const encoded = Buffer.from(cleanedName, 'utf8').toString('base64');
  return `=?UTF-8?B?${encoded}?= <${cleanedAddress}>`;
}

/**
 * The authenticated caller, reduced to the two fields a test send needs.
 *
 * Narrower than `RequestUser` on purpose: this service has no business reading
 * roles or permissions (the guard already decided), and a narrow parameter is
 * one that a test can construct in a line.
 */
export interface TestSendActor {
  id: string;
  email: string;
}

@Injectable()
export class EmailTestSendService {
  private readonly logger = new Logger(EmailTestSendService.name);

  /**
   * Transport kind -> transport.
   *
   * A `Record<EmailProviderKind, EmailProvider>` rather than a `switch`:
   * adding a kind to `EMAIL_PROVIDER_KINDS` makes this object fail to compile
   * until the new transport is wired, where a `switch` would fall through and
   * report "nothing was sent" with no error to explain it — the exact failure
   * mode the registries elsewhere in this epic are built to prevent.
   *
   * Built in the constructor rather than resolved per send: both providers are
   * already singletons and neither touches the network until its first send,
   * so this costs nothing and keeps the mapping in one readable place.
   */
  private readonly providers: Record<EmailProviderKind, EmailProvider>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly emailSettings: EmailSettingsService,
    ses: SesEmailProvider,
    smtp: SmtpEmailProvider,
  ) {
    this.providers = { ses, smtp };
  }

  /**
   * Render the `test-email` template and send it to the caller's own address.
   *
   * NEVER THROWS for a delivery or configuration problem — every such outcome
   * is a `{ success: false, error }` result. It can still reject for a genuine
   * fault (the database being down while writing the audit row), which is a
   * 500 and correctly so.
   *
   * @param actor the authenticated caller. The recipient, and the only one.
   */
  async sendTest(actor: TestSendActor): Promise<TestEmailResult> {
    const attemptedAt = new Date();

    // Read through the settings service's SEND path (`get`), not the admin
    // view: this must fail the same way a real notification would. A stored
    // row that will not parse throws there, and the catch below turns it into
    // the admin-facing error — which is precisely the diagnosis wanted, and
    // the message carries field paths only.
    let settings: EmailSettings;
    try {
      settings = await this.emailSettings.get();
    } catch (err) {
      return this.failure(
        actor,
        null,
        attemptedAt,
        err instanceof Error ? err.message : 'Email settings could not be read.',
      );
    }

    if (!settings.provider) {
      return this.failure(
        actor,
        null,
        attemptedAt,
        'No email provider is selected. Choose SES or SMTP, save, then test again.',
      );
    }

    const providerKind = settings.provider;

    // THE MASTER SWITCH IS HONOURED. `enabled: false` means "nothing is sent"
    // (see email-settings.schema.ts), and a test button that sends anyway
    // would make the switch a lie in the one place an admin is looking at it.
    // The error says which control to flip, so this costs an admin one extra
    // save and no confusion.
    if (!settings.enabled) {
      return this.failure(
        actor,
        providerKind,
        attemptedAt,
        'Email sending is disabled. Turn on email sending, save, then test again.',
      );
    }

    // Checked here rather than left to the transport because the transports
    // deliberately do NOT default a from-address (see `EmailMessage.from`): a
    // provider that substituted one would turn "the admin never configured a
    // sender" into a send that SES accepts and the recipient's server bounces
    // hours later, which is a far harder failure to trace than a refusal.
    if (!settings.fromAddress) {
      return this.failure(
        actor,
        providerKind,
        attemptedAt,
        'No from address is configured. Set the sender address, save, then test again.',
      );
    }

    const rendered = renderEmailTemplate('test-email', {
      recipientEmail: actor.email,
      providerKind,
      sentAt: attemptedAt,
      // Who pressed the button. On a system with several admins this is the
      // difference between a test and an unexplained message in an inbox.
      triggeredBy: actor.email,
      settingsUrl: this.settingsUrl(),
    });

    const message: EmailMessage = {
      to: actor.email,
      from: formatFromHeader(settings.fromAddress, settings.fromName),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(rendered.headers ? { headers: rendered.headers } : {}),
    };

    // `send` NEVER throws — that contract is implemented once, in
    // `BaseEmailProvider`, so there is deliberately no try/catch here. Adding
    // one would suggest the guarantee is in doubt and would produce a worse
    // error message than the one the base class already builds.
    const result = await this.providers[providerKind].send(message);

    if (!result.success) {
      // VERBATIM. `result.error` has already been through `SecretRedactor` and
      // the length cap in `BaseEmailProvider.formatError`, the single exit
      // path for provider error text, so it carries no credential. Rewriting,
      // categorising or replacing it here would discard the only thing this
      // endpoint exists to produce.
      return this.failure(
        actor,
        providerKind,
        attemptedAt,
        result.error ?? 'The transport reported a failure with no message.',
      );
    }

    // Subject, body and recipient are absent from this line on purpose. The
    // body of a test message is harmless, but the log statement is the thing
    // that gets copied when #125 adds real sends whose bodies carry invitation
    // and reset tokens — so the shape is right from the start.
    this.logger.log(
      `Test email sent via ${providerKind} at the request of user ${actor.id}`,
    );

    await this.audit(actor, providerKind, true, null);

    return {
      success: true,
      sentTo: actor.email,
      providerKind,
      messageId: result.messageId ?? null,
      error: null,
      attemptedAt: attemptedAt.toISOString(),
    };
  }

  /**
   * Build (and record) a failed attempt.
   *
   * One place, so every failure — configuration, settings corruption, provider
   * rejection — reaches the admin in the same shape and reaches the audit
   * trail with the same fields. A second, hand-rolled failure literal is how
   * one of them ends up without an audit row.
   */
  private async failure(
    actor: TestSendActor,
    providerKind: EmailProviderKind | null,
    attemptedAt: Date,
    error: string,
  ): Promise<TestEmailResult> {
    // `warn`, not `error`: a misconfigured mail server is an operator problem
    // the operator is actively looking at, not a fault of this service. The
    // error text is already redacted (provider failures) or authored here
    // (configuration failures, which quote no stored value).
    this.logger.warn(
      `Test email failed for user ${actor.id} via ${providerKind ?? 'no provider'}: ${error}`,
    );

    await this.audit(actor, providerKind, false, error);

    return {
      success: false,
      sentTo: actor.email,
      providerKind,
      messageId: null,
      error,
      attemptedAt: attemptedAt.toISOString(),
    };
  }

  /**
   * Record the attempt.
   *
   * Every attempt, successful or not: "did anyone test this, and what did it
   * say?" is the first question asked when an admin reports that email stopped
   * working, and an audit trail that only records successes cannot answer it.
   *
   * The error text is stored because it is already redacted and it is the
   * whole content of the answer. The message body and the recipient are not
   * stored — the recipient is `actorUserId` by construction, and the body is
   * the same template every time.
   */
  private async audit(
    actor: TestSendActor,
    providerKind: EmailProviderKind | null,
    success: boolean,
    error: string | null,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actor.id,
        action: 'email_settings:test',
        targetType: 'system_settings',
        // No settings row is guaranteed to exist (a test on a fresh install
        // fails before one is written), and `targetId` is non-nullable, so the
        // stable settings key names the target instead of a row id.
        targetId: 'email',
        meta: {
          provider: providerKind,
          success,
          error,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Absolute URL of the admin email settings page, for the message's CTA.
   *
   * Built here rather than in the template, which is a pure function of its
   * input and has no business reading configuration or knowing the web app's
   * route table.
   */
  private settingsUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? `${appUrl.replace(/\/+$/, '')}/admin/settings/email` : undefined;
  }
}
