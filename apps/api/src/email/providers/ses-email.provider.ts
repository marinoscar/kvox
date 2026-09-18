import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import MailComposer = require('nodemailer/lib/mail-composer');

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
//
// -----------------------------------------------------------------------------
// TWO CONTENT PATHS, AND WHY THE OLD ONE IS UNTOUCHED
// -----------------------------------------------------------------------------
//
// SESv2's `SendEmailCommand` takes either SIMPLE content (subject/html/text as
// separate fields, which the SDK assembles) or RAW content (a complete MIME
// document we assemble). Simple content CANNOT CARRY A MIME PART AT ALL, so an
// embedded `cid:` image -- the masthead logo, see ../templates/layout.ts -- is
// only expressible as raw.
//
// ⚠ THE SWITCH IS PER MESSAGE, AND ONLY MESSAGES WITH ATTACHMENTS TAKE THE NEW
// PATH. Every existing message has no attachments and goes out through exactly
// the `Content.Simple` request it always did -- same fields, same `Headers`
// array, same everything. That is a deliberate blast-radius decision, not an
// optimisation: moving EVERY email in this application onto hand-assembled
// MIME in order to add a logo would put the deliverability of role changes,
// invitations and operational alerts at risk for a decoration, and the class of
// bug it would introduce (a charset, a transfer encoding, a header folded a
// byte too late) is invisible in tests and visible only in somebody's inbox.
// Keep the two paths separate. If you are "simplifying" this file by making
// everything raw, that is the change this paragraph exists to argue against.
//
// The MIME itself is built by nodemailer's `MailComposer` -- the same library
// the SMTP provider already depends on -- rather than by concatenating
// boundaries here. Multipart assembly has a long tail of correctness details
// (quoted-printable for the text part, base64 line length, `multipart/related`
// nesting so the `cid:` resolves, header folding, CRLF discipline) and a
// second hand-rolled implementation of it would be wrong in ways nobody
// notices until a specific client renders the message as an attachment dump.
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
        // Envelope fields are supplied on BOTH paths. With raw content SES
        // uses them for the envelope sender and recipient, and the MIME
        // document `composeRawMessage` builds carries matching `From`/`To`
        // headers, so the two agree by construction.
        Content: await this.buildContent(msg),
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
   * Pick the content shape for one message. See the header's two-path note.
   *
   * A message with no attachments -- which is every message this application
   * sends except an invitation -- produces the identical `Content.Simple`
   * request this provider has always produced.
   */
  private async buildContent(
    msg: EmailMessage,
  ): Promise<NonNullable<ConstructorParameters<typeof SendEmailCommand>[0]['Content']>> {
    if (msg.attachments && msg.attachments.length > 0) {
      return { Raw: { Data: await this.composeRawMessage(msg) } };
    }

    return {
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
    };
  }

  /**
   * Assemble one complete MIME document for a message that carries parts.
   *
   * `MailComposer` produces `multipart/alternative` (text + HTML) with the
   * HTML half wrapped in a `multipart/related` alongside each inline part --
   * the nesting a client needs in order to resolve `src="cid:..."` against a
   * part rather than fetching something. Headers go INTO the document here,
   * not into the command: SESv2's `Headers` field belongs to simple content
   * and has no counterpart on the raw path.
   *
   * ⚠ THE ONE try/catch IN THIS FILE, AND IT IS NOT ABOUT THE NEVER-THROW
   * CONTRACT. That contract still lives entirely in `BaseEmailProvider.send`,
   * which would catch anything raised here perfectly well. This catch exists
   * because of what the error would CONTAIN: `EmailSendResult.error` is shown
   * to an administrator verbatim by #124 and stored in a delivery row by #125,
   * and a composer raising `new Error(\`Invalid content: \${body}\`)` -- which
   * we do not author and cannot constrain -- would put the rendered message,
   * including an invitation link, onto both of those surfaces. So the cause is
   * replaced by a fixed sentence plus the error's CLASS NAME, which is a
   * diagnostic and cannot be content.
   *
   * Rethrowing (rather than returning a failure result) keeps this on the path
   * that logs a warning in the base class, which is where an operator looks
   * when a specific message stops going out.
   */
  private async composeRawMessage(msg: EmailMessage): Promise<Buffer> {
    try {
      const composer = new MailComposer({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.headers ? { headers: msg.headers } : {}),
        attachments: (msg.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
          cid: attachment.cid,
        })),
        // Belt and braces: `EmailAttachment.content` is a `Buffer` and there
        // is no `path` field for a caller to set, so nodemailer has nothing to
        // open -- but these two options mean that stays true even if the
        // attachment type is widened later by somebody who has not read
        // `email.types.ts`'s note on why it is narrow.
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      return await composer.compile().build();
    } catch (err) {
      throw new Error(
        'Could not assemble the MIME message for an email with embedded ' +
          `content (${err instanceof Error ? err.constructor.name : typeof err}).`,
      );
    }
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
