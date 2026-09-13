import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { BaseEmailProvider, SecretRedactor } from '../base-email.provider';
import { EmailSettingsService } from '../email-settings.service';
import type { EmailMessage, EmailSendResult } from '../email.types';

// =============================================================================
// SesEmailProvider (issue #122, epic #109)
// =============================================================================
//
// AWS SES v2, for deployments already running on AWS: cheaper than a hosted
// mail API, better deliverability than an arbitrary SMTP relay, and no
// long-lived SMTP credential to store anywhere.
//
// CREDENTIALS COME FROM THE ENVIRONMENT -- `AWS_ACCESS_KEY_ID` and
// `AWS_SECRET_ACCESS_KEY`, the same pair storage already uses. This provider
// introduces NO new secret: nothing for an admin to paste into a form, nothing
// in the settings blob, nothing in the credential store, nothing to rotate
// separately. The only email-specific knob is the region.
//
// THIS DELIBERATELY DIFFERS FROM THE REFERENCE IMPLEMENTATION. MemoriaHub's
// SES provider loads the S3 STORAGE PROVIDER's database credential row and
// decrypts it. That makes email depend on storage being configured -- a
// deployment that sends mail and keeps files on local disk cannot send mail,
// and "why is email broken?" gets answered in the storage settings page. Epic
// #109 calls that coupling out by name. Do not reintroduce it: if you find
// yourself importing PrismaService here to look up a storage credential, that
// is the bug.
//
// The client is built LAZILY, on send, never in the constructor. A missing
// credential or an unset region must not stop the module -- and therefore the
// whole API -- from starting, because email being unconfigured is a normal
// state for a fresh install. The region can also change under us when an admin
// edits the settings, so binding it at DI time would need a restart to take
// effect.
// =============================================================================

@Injectable()
export class SesEmailProvider extends BaseEmailProvider {
  protected readonly logger = new Logger(SesEmailProvider.name);
  protected readonly transportName = 'SES';

  /**
   * Cached client, keyed by the inputs that determine its construction.
   *
   * Reused because an SESv2Client owns an HTTPS agent and a connection pool;
   * building one per message means a fresh TLS handshake for every email.
   * Keyed rather than built once so an admin's region change takes effect on
   * the next send instead of at the next deploy.
   */
  private cached: { key: string; client: SESv2Client } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly emailSettings: EmailSettingsService,
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
    const client = await this.buildClient(redact);

    const result = await client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              // Both parts, always. SESv2 will happily send HTML-only; a
              // message with no text alternative scores worse with spam
              // filters and is unreadable in a text-only client. `EmailMessage`
              // makes `text` required and this passes it straight through.
              Html: { Data: msg.html, Charset: 'UTF-8' },
              Text: { Data: msg.text, Charset: 'UTF-8' },
            },
            // SESv2 accepts extra headers on Simple content. Used for
            // per-recipient headers (a List-Unsubscribe pair, a correlation
            // id) that cannot be provider-level configuration.
            ...(msg.headers
              ? {
                  Headers: Object.entries(msg.headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
      }),
    );

    if (!result.MessageId) {
      // SES returns 200 with a MessageId on acceptance. No id means we cannot
      // answer "did this actually go out?" later from a delivery record
      // (#125), so report it rather than recording a success we cannot trace.
      return {
        success: false,
        error: 'SES accepted the request but returned no message id.',
      };
    }

    return { success: true, messageId: result.MessageId };
  }

  /**
   * Resolve credentials and region, and build (or reuse) the client.
   *
   * Throws a plain `Error` for each missing piece, with a message written for
   * the admin who will read it in #124's dialog: it names the setting or the
   * environment variable to go and fix.
   */
  private async buildClient(redact: SecretRedactor): Promise<SESv2Client> {
    const accessKeyId = this.config.get<string>('email.awsAccessKeyId') || '';
    const secretAccessKey =
      this.config.get<string>('email.awsSecretAccessKey') || '';

    // Registered the instant we hold it, BEFORE anything that can throw while
    // holding it. An AWS SDK error that serialised its own request context
    // would otherwise carry this string into an admin's browser (#124) and a
    // database row (#125). See SecretRedactor.
    redact.protect(secretAccessKey);

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'AWS credentials are not set. SES uses AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment.',
      );
    }

    // Settings first, environment second: an admin editing a setting must be
    // able to override the deploy-time default without a redeploy, which is
    // the entire reason `sesRegion` is a setting at all.
    const settings = await this.emailSettings.get();
    const region =
      settings.sesRegion ||
      this.config.get<string>('email.sesRegionFallback') ||
      '';

    if (!region) {
      throw new Error(
        'No SES region is configured. Set the SES region in email settings, or S3_REGION in the environment.',
      );
    }

    // The access key id is in the cache key; the secret is NOT. The id is not
    // sensitive (it travels in every signed request), and adding the secret
    // would keep a second copy of it alive on this instance for the process
    // lifetime for no benefit: both come from the environment and change only
    // on restart, so the id alone already distinguishes every reachable state.
    const key = `${region} ${accessKeyId}`;

    if (this.cached?.key === key) {
      return this.cached.client;
    }

    const client = new SESv2Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      // Bounded retries. The SDK default (3 attempts with exponential backoff)
      // suits a queue worker and is wrong for a send that may sit in a request
      // path: a throttled SES would hold the caller open for seconds. #125
      // owns retry policy; a transport should fail fast and report.
      maxAttempts: 2,
    });

    // Replacing a cached client: drop the old one's sockets rather than
    // leaking a connection pool on every region change.
    this.cached?.client.destroy();
    this.cached = { key, client };

    return client;
  }
}
