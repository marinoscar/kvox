import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { CredentialsService } from '../../credentials/credentials.service';
import { BaseEmailProvider, SecretRedactor } from '../base-email.provider';
import { EmailSettingsService } from '../email-settings.service';
import {
  DEFAULT_SMTP_PORT,
  IMPLICIT_TLS_SMTP_PORT,
} from '../email-settings.schema';
import {
  SMTP_CREDENTIAL_NAME,
  SMTP_CREDENTIAL_PURPOSE,
} from '../smtp-credential.constants';
import type { EmailMessage, EmailSendResult } from '../email.types';

// =============================================================================
// SmtpEmailProvider (issue #122, epic #109)
// =============================================================================
//
// The transport for everyone not on SES: a corporate relay, a Postfix box, a
// third-party submission endpoint. Host, port, TLS flag and username are
// ordinary settings (see email-settings.schema.ts).
//
// THE PASSWORD IS NOT A SETTING. It is read here, at the moment of use, from
// the encrypted credential store built in #115 (epic #108). That store already
// enforces the two properties this provider would otherwise have to reinvent:
//
//   * NO PLAINTEXT EGRESS -- `getSecret` is the only method that returns
//     plaintext, and `describe`/`list` return a type with no field capable of
//     holding a secret, so an admin screen physically cannot read it back.
//   * BLANK PRESERVES -- an admin form renders the password field empty
//     (the stored value is unreadable), so an empty submission means "keep
//     what is stored" and can never mean "erase it". #124's form gets that
//     behaviour for free by writing through `setSecret`.
//
// Reimplementing either of those here would mean a second, subtly different
// copy of a security guarantee. Use the service.
//
// The transport is built LAZILY on send, never in the constructor: a fresh
// install has no SMTP configuration, and an unconfigured mail server must not
// prevent the API from starting.
// =============================================================================

// The credential store address moved to ../smtp-credential.constants.ts when
// #124 added the WRITE side of the SMTP password to `EmailSettingsService`.
// This provider injects that service, so importing the constants back out of
// this file would make the two modules import each other — and under
// `emitDecoratorMetadata` a cycle leaves `design:paramtypes` holding
// `undefined`, which Nest reports as an unresolvable dependency at boot.
//
// Re-exported here so every existing import path (and the ../index.ts barrel)
// keeps working, and so the address still reads as belonging to the transport
// that consumes it.
export {
  SMTP_CREDENTIAL_NAME,
  SMTP_CREDENTIAL_PURPOSE,
} from '../smtp-credential.constants';

/**
 * Socket-level timeouts, in milliseconds.
 *
 * WITHOUT THESE THE NEVER-THROW CONTRACT IS TECHNICALLY HELD AND PRACTICALLY
 * BROKEN. A firewalled SMTP port does not refuse a connection, it blackholes
 * the SYN: nodemailer's default is to wait a very long time, and a caller in
 * the middle of a business action would block on it. "Never throw" exists so a
 * mail server cannot take a request down; a mail server that hangs the request
 * for two minutes takes it down just as effectively. A bounded wait turns that
 * into an ordinary `{ success: false, error: 'connection timeout' }`.
 *
 * Ten seconds each is generous for a relay that is actually alive, and short
 * enough that #124's test button answers while the admin is still looking.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 20_000;

@Injectable()
export class SmtpEmailProvider extends BaseEmailProvider {
  protected readonly logger = new Logger(SmtpEmailProvider.name);
  protected readonly transportName = 'SMTP';

  /**
   * Cached transporter and a fingerprint of the configuration that produced
   * it.
   *
   * Cached because a transporter holds a connection pool; rebuilt whenever the
   * fingerprint changes so an admin's edit -- including a password rotation --
   * takes effect on the next send rather than at the next restart. A stale
   * transporter after a password change is a confusing failure: the admin
   * fixes the credential, the test button still reports "authentication
   * failed", and nothing on screen explains why.
   *
   * THE FINGERPRINT IS A HASH, NOT THE VALUES. Keying on the password would
   * park a plaintext copy on this instance for the life of the process, where
   * a heap dump or a careless `JSON.stringify(this)` in a debug log would find
   * it. A SHA-256 detects change just as well and carries nothing back out.
   * (The transporter itself necessarily holds the password to authenticate
   * with; that is unavoidable and is not a reason to add a second copy.)
   */
  private cached: { fingerprint: string; transport: Transporter } | null = null;

  constructor(
    private readonly emailSettings: EmailSettingsService,
    private readonly credentials: CredentialsService,
  ) {
    super();
  }

  /**
   * @see BaseEmailProvider.deliver -- this may throw freely; `send`, the only
   * public entry point, converts anything thrown into a failure result. There
   * is intentionally no try/catch anywhere in this file.
   */
  protected async deliver(
    msg: EmailMessage,
    redact: SecretRedactor,
  ): Promise<EmailSendResult> {
    const transport = await this.getTransport(redact);

    const info = await transport.sendMail({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      // Always both parts -- see the same note in the SES provider.
      text: msg.text,
      ...(msg.headers ? { headers: msg.headers } : {}),
    });

    // nodemailer synthesises a Message-ID when the server does not return one,
    // so unlike SES this is effectively always present; the fallback keeps the
    // delivery record honest rather than writing `undefined`.
    return {
      success: true,
      messageId: info.messageId ?? undefined,
    };
  }

  /**
   * Resolve settings and the stored password, then build (or reuse) the
   * transporter.
   *
   * Throws a plain `Error` naming the missing piece. Those messages reach an
   * admin verbatim through #124, so they say which field to fix -- and they
   * never quote a value.
   */
  private async getTransport(redact: SecretRedactor): Promise<Transporter> {
    const settings = await this.emailSettings.get();

    if (!settings.smtpHost) {
      throw new Error(
        'No SMTP host is configured. Set the SMTP server host in email settings.',
      );
    }

    const host = settings.smtpHost;
    const port = settings.smtpPort ?? DEFAULT_SMTP_PORT;

    // Absent means TLS. A missing key in a stored blob must not be the reason
    // a mail password crosses the network in the clear -- the safe reading of
    // "unspecified" is the strict one, and an operator on a legacy plaintext
    // relay has to say so explicitly.
    const useTls = settings.smtpUseTls ?? true;

    const username = settings.smtpUsername;

    // Fetched only when there is a username to use it with. An unauthenticated
    // relay (authorised by source IP, common inside a private network) is a
    // legitimate configuration, and looking up a credential that is not
    // supposed to exist would turn that into a spurious error.
    const password = username
      ? await this.credentials.getSecret(
          SMTP_CREDENTIAL_PURPOSE,
          SMTP_CREDENTIAL_NAME,
        )
      : null;

    // Registered IMMEDIATELY on obtaining it, before the connect, the TLS
    // handshake and the AUTH exchange -- every one of which can throw while
    // this value is in scope, and at least one of which (a server that echoes
    // the offending command back in its rejection) can throw with the value
    // *inside the error text*. See SecretRedactor: this is the whole reason it
    // exists, because we do not author nodemailer's error strings.
    redact.protect(password);

    if (username && !password) {
      throw new Error(
        'An SMTP username is configured but no password is stored. Save the SMTP password in email settings.',
      );
    }

    // Implicit TLS on 465 (the connection is TLS from the first byte);
    // STARTTLS everywhere else, REQUIRED rather than opportunistic when TLS is
    // on. Opportunistic STARTTLS silently downgrades to plaintext against a
    // server that does not advertise it -- which is exactly the case where the
    // credential most needs protecting.
    const secure = port === IMPLICIT_TLS_SMTP_PORT;
    const requireTLS = useTls && !secure;

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          host,
          port,
          secure,
          requireTLS,
          username ?? null,
          password ?? null,
        ]),
      )
      .digest('hex');

    if (this.cached?.fingerprint === fingerprint) {
      return this.cached.transport;
    }

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS,
      auth: username && password ? { user: username, pass: password } : undefined,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      // Certificate verification is left at nodemailer's default (on). There
      // is deliberately no "ignore TLS errors" setting: it is the field every
      // frustrated operator ticks, it silently converts an authenticated
      // channel into an interceptable one, and the legitimate case (a private
      // CA) is solved properly with NODE_EXTRA_CA_CERTS.
    });

    // Close the transporter being replaced, or every settings edit leaks a
    // pool of open SMTP sockets for the life of the process.
    this.cached?.transport.close();
    this.cached = { fingerprint, transport };

    return transport;
  }
}
