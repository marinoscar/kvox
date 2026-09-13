import { Logger } from '@nestjs/common';

// =============================================================================
// SmtpEmailProvider — tests (issue #122, epic #109)
// =============================================================================
//
// `nodemailer` is mocked entirely, at the module level, BEFORE it is ever
// imported — including transitively, via smtp-email.provider.ts. No test
// here opens a real TCP connection, TLS handshake, or SMTP session.
// `nodemailerCreateTransportMock` records the options each
// `nodemailer.createTransport(...)` call was built with, which is the only
// way to observe host/port/TLS/auth resolution — that logic is private.
//
// The provider is instantiated directly (`new SmtpEmailProvider(...)`)
// rather than through a Nest TestingModule, for the same reason as the SES
// provider spec: its constructor takes two plain dependencies, and most
// tests need a different settings/credential combination, so a hand-built
// pair of fakes per test is clearer than rebuilding a DI container each time.
// =============================================================================

const smtpSendMailMock = jest.fn();
const smtpCloseMock = jest.fn();
const nodemailerCreateTransportMock = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn((options: unknown) => {
    nodemailerCreateTransportMock(options);
    return { sendMail: smtpSendMailMock, close: smtpCloseMock };
  }),
}));

import {
  SmtpEmailProvider,
  SMTP_CREDENTIAL_NAME,
  SMTP_CREDENTIAL_PURPOSE,
} from './smtp-email.provider';
import type { CredentialsService } from '../../credentials/credentials.service';
import type { EmailSettingsService } from '../email-settings.service';
import { DEFAULT_SMTP_PORT, IMPLICIT_TLS_SMTP_PORT } from '../email-settings.schema';
import type { EmailSettings } from '../email-settings.schema';
import type { EmailMessage } from '../email.types';

const baseMessage: EmailMessage = {
  to: 'recipient@example.com',
  from: 'sender@example.com',
  subject: 'Test subject',
  html: '<p>hello</p>',
  text: 'hello',
};

const baseSmtpSettings: EmailSettings = {
  provider: 'smtp',
  enabled: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUseTls: true,
  smtpUsername: 'mailer@example.com',
};

function makeEmailSettings(value: EmailSettings): EmailSettingsService {
  return {
    get: jest.fn().mockResolvedValue(value),
  } as unknown as EmailSettingsService;
}

function makeCredentials(password: string | null): CredentialsService {
  return {
    getSecret: jest.fn().mockResolvedValue(password),
  } as unknown as CredentialsService;
}

describe('SmtpEmailProvider', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // The never-throw contract
  // ==========================================================================

  describe('the never-throw contract', () => {
    it('resolves { success: true } with the transporter message id on success', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials('the-real-password'),
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'smtp-real-id' });

      await expect(provider.send(baseMessage)).resolves.toEqual({
        success: true,
        messageId: 'smtp-real-id',
      });
    });

    it('returns success with an undefined messageId when nodemailer does not synthesise one', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockResolvedValueOnce({});

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeUndefined();
    });

    it('reports a failure, not a throw, when no SMTP host is configured', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings({ provider: 'smtp', enabled: true }),
        makeCredentials(null),
      );

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error: 'SMTP: No SMTP host is configured. Set the SMTP server host in email settings.',
      });
    });

    it('reports a failure when a username is configured but no password is stored', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials(null),
      );

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error:
          'SMTP: An SMTP username is configured but no password is stored. Save the SMTP password in email settings.',
      });
    });

    it('returns a failure result, never a rejection, when the transport rejects with an Error', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockRejectedValueOnce(new Error('Connection timeout'));

      await expect(provider.send(baseMessage)).resolves.toEqual({
        success: false,
        error: 'SMTP: Connection timeout',
      });
    });

    it('returns a failure result when the transport rejects with a non-Error value', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials('pw'),
      );
      // eslint-disable-next-line prefer-promise-reject-errors
      smtpSendMailMock.mockRejectedValueOnce('a plain string rejection');

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error: 'SMTP: a plain string rejection',
      });
    });
  });

  // ==========================================================================
  // The password comes from CredentialsService, never from settings
  // ==========================================================================

  describe('the password comes from CredentialsService, never from settings', () => {
    it('reads the password through CredentialsService.getSecret with the smtp purpose and default name', async () => {
      const credentials = makeCredentials('the-real-password');
      const provider = new SmtpEmailProvider(makeEmailSettings(baseSmtpSettings), credentials);
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      expect(credentials.getSecret).toHaveBeenCalledWith(
        SMTP_CREDENTIAL_PURPOSE,
        SMTP_CREDENTIAL_NAME,
      );
      expect(SMTP_CREDENTIAL_PURPOSE).toBe('smtp');
    });

    it('never uses a password field on the settings object even if one is present at runtime', async () => {
      const settingsWithStraySecret = {
        ...baseSmtpSettings,
        // Simulates a bug elsewhere putting a password on the settings blob.
        // The schema forbids this field by construction (see
        // EMAIL_SETTINGS_CARRIES_NO_SECRET in email-settings.schema.ts), but
        // the provider must not use it even if it somehow appeared here at
        // runtime — it must always go through CredentialsService instead.
        smtpPassword: 'settings-leaked-password',
      } as EmailSettings & { smtpPassword: string };
      const credentials = makeCredentials('the-real-password-from-store');
      const provider = new SmtpEmailProvider(
        makeEmailSettings(settingsWithStraySecret),
        credentials,
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as {
        auth: { pass: string };
      };
      expect(opts.auth.pass).toBe('the-real-password-from-store');
      expect(opts.auth.pass).not.toBe('settings-leaked-password');
    });

    it('does not fetch a credential and sends unauthenticated when no username is configured', async () => {
      const { smtpUsername: _unused, ...withoutUsername } = baseSmtpSettings;
      const credentials = makeCredentials('should-not-be-used');
      const provider = new SmtpEmailProvider(makeEmailSettings(withoutUsername), credentials);
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      expect(credentials.getSecret).not.toHaveBeenCalled();
      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as { auth?: unknown };
      expect(opts.auth).toBeUndefined();
    });
  });

  // ==========================================================================
  // Host/port/TLS/username come from settings
  // ==========================================================================

  describe('host/port/TLS/username come from settings', () => {
    it('passes host, port, and username straight through', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings({
          ...baseSmtpSettings,
          smtpHost: 'mail.example.org',
          smtpPort: 2525,
          smtpUsername: 'user@example.org',
        }),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as {
        host: string;
        port: number;
        auth: { user: string; pass: string };
      };
      expect(opts.host).toBe('mail.example.org');
      expect(opts.port).toBe(2525);
      expect(opts.auth).toEqual({ user: 'user@example.org', pass: 'pw' });
    });

    it('defaults to DEFAULT_SMTP_PORT when smtpPort is not set', async () => {
      const { smtpPort: _unused, ...withoutPort } = baseSmtpSettings;
      const provider = new SmtpEmailProvider(makeEmailSettings(withoutPort), makeCredentials('pw'));
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as { port: number };
      expect(opts.port).toBe(DEFAULT_SMTP_PORT);
    });

    it('uses implicit TLS (secure) on port 465 and does not require STARTTLS', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings({ ...baseSmtpSettings, smtpPort: IMPLICIT_TLS_SMTP_PORT }),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as {
        secure: boolean;
        requireTLS: boolean;
      };
      expect(opts.secure).toBe(true);
      expect(opts.requireTLS).toBe(false);
    });

    it('requires STARTTLS on the default submission port when TLS is on', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings({ ...baseSmtpSettings, smtpPort: DEFAULT_SMTP_PORT, smtpUseTls: true }),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as {
        secure: boolean;
        requireTLS: boolean;
      };
      expect(opts.secure).toBe(false);
      expect(opts.requireTLS).toBe(true);
    });

    it('does not require STARTTLS when smtpUseTls is explicitly false', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings({ ...baseSmtpSettings, smtpPort: DEFAULT_SMTP_PORT, smtpUseTls: false }),
        makeCredentials('pw'),
      );
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as { requireTLS: boolean };
      expect(opts.requireTLS).toBe(false);
    });

    it('treats a missing smtpUseTls as TLS required (safe default)', async () => {
      const { smtpUseTls: _unused, ...withoutTls } = baseSmtpSettings;
      const provider = new SmtpEmailProvider(makeEmailSettings(withoutTls), makeCredentials('pw'));
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send(baseMessage);

      const opts = nodemailerCreateTransportMock.mock.calls[0][0] as { requireTLS: boolean };
      expect(opts.requireTLS).toBe(true);
    });

    it('passes extra message headers through to sendMail', async () => {
      const provider = new SmtpEmailProvider(makeEmailSettings(baseSmtpSettings), makeCredentials('pw'));
      smtpSendMailMock.mockResolvedValueOnce({ messageId: 'm' });

      await provider.send({ ...baseMessage, headers: { 'X-Test': '1' } });

      expect(smtpSendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'X-Test': '1' } }),
      );
    });
  });

  // ==========================================================================
  // Transporter caching keyed on a fingerprint
  // ==========================================================================

  describe('transporter caching keyed on a fingerprint', () => {
    it('reuses the cached transporter across sends when nothing changes', async () => {
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials('same-password'),
      );
      smtpSendMailMock.mockResolvedValue({ messageId: 'm' });

      await provider.send(baseMessage);
      await provider.send(baseMessage);

      expect(nodemailerCreateTransportMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the transporter, closing the old one, when the password rotates', async () => {
      const credentialsGetSecret = jest
        .fn()
        .mockResolvedValueOnce('old-password')
        .mockResolvedValueOnce('new-rotated-password');
      const credentials = { getSecret: credentialsGetSecret } as unknown as CredentialsService;
      const provider = new SmtpEmailProvider(makeEmailSettings(baseSmtpSettings), credentials);
      smtpSendMailMock.mockResolvedValue({ messageId: 'm' });

      await provider.send(baseMessage);
      await provider.send(baseMessage);

      // A stale cached transporter after a password rotation would be a
      // silent authentication failure the next time an admin tests the
      // connection — see the class-level comment on `cached` for why the
      // fingerprint has to include the password.
      expect(nodemailerCreateTransportMock).toHaveBeenCalledTimes(2);
      expect(smtpCloseMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the transporter when the host changes', async () => {
      const emailSettings = makeEmailSettings(baseSmtpSettings);
      const provider = new SmtpEmailProvider(emailSettings, makeCredentials('pw'));
      smtpSendMailMock.mockResolvedValue({ messageId: 'm' });

      await provider.send(baseMessage);
      (emailSettings.get as jest.Mock).mockResolvedValueOnce({
        ...baseSmtpSettings,
        smtpHost: 'a-different-host.example.com',
      });
      await provider.send(baseMessage);

      expect(nodemailerCreateTransportMock).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Secret redaction
  // ==========================================================================

  describe('secret redaction in returned/logged errors', () => {
    it('redacts the SMTP password from a transport error message', async () => {
      const password = 'hunter2-actual-smtp-password';
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials(password),
      );
      smtpSendMailMock.mockRejectedValueOnce(
        new Error(`535 Authentication failed for password ${password}`),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(password);
      expect(result.error).toContain('[redacted]');
    });

    it('withholds the entire error when the password is shorter than the redactable floor', async () => {
      const password = 'ab1'; // 3 chars, below MIN_REDACTABLE_SECRET_LENGTH
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials(password),
      );
      smtpSendMailMock.mockRejectedValueOnce(new Error(`535 auth failed, tried ${password}`));

      const result = await provider.send(baseMessage);

      expect(result.error).toBe(
        'SMTP: [error withheld: it contained the configured credential]',
      );
    });

    it('never logs the password, the message body, or the subject', async () => {
      const password = 'do-not-leak-this-password';
      const provider = new SmtpEmailProvider(
        makeEmailSettings(baseSmtpSettings),
        makeCredentials(password),
      );
      const secretMessage: EmailMessage = {
        ...baseMessage,
        subject: 'Your password reset link',
        html: '<p>token=xyz789</p>',
        text: 'token=xyz789',
      };
      smtpSendMailMock.mockRejectedValueOnce(new Error(`535 auth failed for ${password}`));

      await provider.send(secretMessage);

      const loggedLines = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(loggedLines.length).toBeGreaterThan(0);
      for (const line of loggedLines) {
        expect(line).not.toContain(password);
        expect(line).not.toContain('xyz789');
        expect(line).not.toContain(secretMessage.subject);
      }
    });
  });
});
