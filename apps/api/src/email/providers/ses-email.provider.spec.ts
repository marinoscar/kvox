import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

// =============================================================================
// SesEmailProvider — tests (issue #122, epic #109)
// =============================================================================
//
// `@aws-sdk/client-sesv2` is mocked entirely, at the module level, BEFORE it
// is ever imported — including transitively, via ses-email.provider.ts.
// Nothing in this file opens a real HTTPS connection or makes a signed AWS
// request. `sesConstructorMock` records what each `new SESv2Client(...)` call
// was built with — the only way to observe the region/credential chain the
// provider resolves internally, since that resolution is private.
//
// The provider is instantiated directly (`new SesEmailProvider(...)`) rather
// than through a Nest TestingModule: its constructor takes only two plain
// dependencies, and nearly every test below needs a different combination of
// config/settings values, so a hand-built pair of fakes per test is far
// clearer than rebuilding a DI container for each one.
// =============================================================================

const sesSendMock = jest.fn();
const sesDestroyMock = jest.fn();
const sesConstructorMock = jest.fn();

jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation((config: unknown) => {
    sesConstructorMock(config);
    return { send: sesSendMock, destroy: sesDestroyMock };
  }),
  SendEmailCommand: jest.fn().mockImplementation((input: unknown) => ({
    __command: 'SendEmailCommand',
    input,
  })),
}));

import { SesEmailProvider } from './ses-email.provider';
import { CredentialsService } from '../../credentials/credentials.service';
import type { EmailSettingsService } from '../email-settings.service';
import type { EmailSettings } from '../email-settings.schema';
import type { EmailMessage } from '../email.types';

const baseMessage: EmailMessage = {
  to: 'recipient@example.com',
  from: 'sender@example.com',
  subject: 'Test subject',
  html: '<p>hello</p>',
  text: 'hello',
};

const baseEmailSettings: EmailSettings = {
  provider: 'ses',
  enabled: true,
};

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function makeEmailSettings(value: EmailSettings): EmailSettingsService {
  return {
    get: jest.fn().mockResolvedValue(value),
  } as unknown as EmailSettingsService;
}

describe('SesEmailProvider', () => {
  let warnSpy: jest.SpyInstance;
  let credentialsGetSecretSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    // SES uses only environment credentials (see the header comment in
    // ses-email.provider.ts). Spying on the real CredentialsService proves
    // that structurally: SesEmailProvider does not even hold a reference to
    // it, so this spy can only fire if a regression wires one in.
    credentialsGetSecretSpy = jest.spyOn(CredentialsService.prototype, 'getSecret');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // Credentials come from the environment, never from CredentialsService
  // ==========================================================================

  describe('credentials come from the environment, not CredentialsService', () => {
    it('never calls CredentialsService for a successful send', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-2' }),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-1' });

      await provider.send(baseMessage);

      expect(credentialsGetSecretSpy).not.toHaveBeenCalled();
    });

    it('never calls CredentialsService even on a configuration failure', async () => {
      const provider = new SesEmailProvider(makeConfig({}), makeEmailSettings(baseEmailSettings));

      await provider.send(baseMessage);

      expect(credentialsGetSecretSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Missing/incomplete configuration is a result, never a throw
  // ==========================================================================

  describe('missing/incomplete configuration is a result, not a throw', () => {
    it('reports a failure, not an exception, when no AWS credentials are configured', async () => {
      const provider = new SesEmailProvider(makeConfig({}), makeEmailSettings(baseEmailSettings));

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error:
          'SES: AWS credentials are not set. SES uses AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment.',
      });
      expect(sesConstructorMock).not.toHaveBeenCalled();
    });

    it('reports a failure when the secret access key is missing even if the access key id is present', async () => {
      const provider = new SesEmailProvider(
        makeConfig({ 'email.awsAccessKeyId': 'AKIAEXAMPLE' }),
        makeEmailSettings(baseEmailSettings),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AWS credentials are not set');
    });

    it('reports an explicit region error rather than silently defaulting to us-east-1', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
          // no email.sesRegionFallback configured either
        }),
        makeEmailSettings(baseEmailSettings), // no sesRegion
      );

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error:
          'SES: No SES region is configured. Set the SES region in email settings, or S3_REGION in the environment.',
      });
      expect(sesConstructorMock).not.toHaveBeenCalled();
      // The whole point of this test: an unconfigured region must never
      // silently resolve to a default region.
      expect(result.error).not.toContain('us-east-1');
    });
  });

  // ==========================================================================
  // Region resolution
  // ==========================================================================

  describe('region resolution', () => {
    it('prefers email.sesRegion from settings over the S3_REGION environment fallback', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
          'email.sesRegionFallback': 'us-west-2',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'eu-west-1' }),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-2' });

      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' }),
      );
    });

    it('falls back to S3_REGION when no email.sesRegion setting is configured', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
          'email.sesRegionFallback': 'ap-southeast-2',
        }),
        makeEmailSettings(baseEmailSettings), // no sesRegion
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-3' });

      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'ap-southeast-2' }),
      );
    });
  });

  // ==========================================================================
  // Sending
  // ==========================================================================

  describe('sending', () => {
    it('returns { success: true } with the SES message id on acceptance', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-real-message-id' });

      const result = await provider.send(baseMessage);

      expect(result).toEqual({ success: true, messageId: 'ses-real-message-id' });
    });

    it('builds the SendEmailCommand input from the message, including extra headers', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-4' });

      await provider.send({
        ...baseMessage,
        headers: { 'X-Correlation-Id': 'abc-123' },
      });

      const commandArg = sesSendMock.mock.calls[0][0] as { input: unknown };
      expect(commandArg.input).toMatchObject({
        FromEmailAddress: baseMessage.from,
        Destination: { ToAddresses: [baseMessage.to] },
        Content: {
          Simple: {
            Subject: { Data: baseMessage.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: baseMessage.html, Charset: 'UTF-8' },
              Text: { Data: baseMessage.text, Charset: 'UTF-8' },
            },
            Headers: [{ Name: 'X-Correlation-Id', Value: 'abc-123' }],
          },
        },
      });
    });

    it('omits the Headers field when the message carries none', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-5' });

      await provider.send(baseMessage);

      const commandArg = sesSendMock.mock.calls[0][0] as {
        input: { Content: { Simple: Record<string, unknown> } };
      };
      expect(commandArg.input.Content.Simple.Headers).toBeUndefined();
    });

    it('reports a failure when SES accepts the request but returns no message id', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockResolvedValueOnce({});

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error: 'SES: SES accepted the request but returned no message id.',
      });
    });

    it('returns a failure result, never a rejection, when the SDK call rejects with an Error', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(provider.send(baseMessage)).resolves.toEqual({
        success: false,
        error: 'SES: Network timeout',
      });
    });

    it('returns a failure result when the SDK rejects with a non-Error value', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('SES: Non-Error value of type object thrown.');
    });
  });

  // ==========================================================================
  // Client caching
  // ==========================================================================

  describe('client caching', () => {
    it('reuses the cached client across sends with the same region and access key', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-a' });

      await provider.send(baseMessage);
      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds and destroys the old client when the region changes', async () => {
      const emailSettings = makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' });
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': 'super-secret-access-key-value',
        }),
        emailSettings,
      );
      sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-b' });

      await provider.send(baseMessage);
      (emailSettings.get as jest.Mock).mockResolvedValueOnce({
        ...baseEmailSettings,
        sesRegion: 'eu-central-1',
      });
      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledTimes(2);
      expect(sesDestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Secret redaction
  // ==========================================================================

  describe('secret redaction in returned/logged errors', () => {
    it('redacts the AWS secret access key from an SDK error message', async () => {
      const secret = 'super-secret-access-key-value-1234';
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': secret,
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockRejectedValueOnce(
        new Error(
          `SignatureDoesNotMatch: could not validate signature computed with secret ${secret}`,
        ),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain('[redacted]');
    });

    it('never logs the AWS secret access key', async () => {
      const secret = 'super-secret-access-key-value-5678';
      const provider = new SesEmailProvider(
        makeConfig({
          'email.awsAccessKeyId': 'AKIAEXAMPLE',
          'email.awsSecretAccessKey': secret,
        }),
        makeEmailSettings({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      sesSendMock.mockRejectedValueOnce(new Error(`auth error, key=${secret}`));

      await provider.send(baseMessage);

      const loggedLines = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const line of loggedLines) {
        expect(line).not.toContain(secret);
      }
    });
  });
});
