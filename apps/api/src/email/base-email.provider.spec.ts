import { Logger } from '@nestjs/common';

import { BaseEmailProvider, SecretRedactor } from './base-email.provider';
import type { EmailMessage, EmailSendResult } from './email.types';

// =============================================================================
// BaseEmailProvider — tests (issue #122, epic #109)
// =============================================================================
//
// This is the file the entire never-throw guarantee lives in (see the header
// comment in base-email.provider.ts), so it gets the deepest coverage: every
// way `deliver` can misbehave — a thrown Error, a thrown non-Error, a
// resolved failure, a resolved malformed value — must come back through
// `send` as `{ success: false, error }`, never as a rejection.
//
// `SesEmailProvider` and `SmtpEmailProvider` are imported ONLY for the
// structural proof below (`send` is inherited, not overridden). Both real
// transports are mocked at the module level before either provider is
// imported, so importing them here does nothing but define classes — no
// client is built, no socket opens, unless a test explicitly calls `.send()`
// on one (which none in this file do).
// =============================================================================

jest.mock('@aws-sdk/client-sesv2');
jest.mock('nodemailer');

import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

const baseMessage: EmailMessage = {
  to: 'recipient@example.com',
  from: 'sender@example.com',
  subject: 'Test subject',
  html: '<p>hello</p>',
  text: 'hello',
};

/**
 * Minimal concrete subclass so `BaseEmailProvider.send` — the only thing this
 * file tests — can be exercised without a real transport. `deliverImpl` is
 * swapped per test to simulate a resolved success, a resolved failure, a
 * thrown Error, a thrown non-Error, or a malformed/undefined return.
 */
class TestEmailProvider extends BaseEmailProvider {
  protected readonly logger = new Logger('TestEmailProvider');
  protected readonly transportName = 'TEST';

  deliverImpl: (
    msg: EmailMessage,
    redact: SecretRedactor,
  ) => Promise<EmailSendResult> = async () => ({ success: true });

  protected deliver(
    msg: EmailMessage,
    redact: SecretRedactor,
  ): Promise<EmailSendResult> {
    return this.deliverImpl(msg, redact);
  }
}

describe('BaseEmailProvider', () => {
  let provider: TestEmailProvider;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    provider = new TestEmailProvider();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // The never-throw contract
  // ==========================================================================

  describe('the never-throw contract', () => {
    it('is structural: SesEmailProvider does not define its own `send`, only `deliver`', () => {
      // `send` must be inherited from BaseEmailProvider unchanged. If this
      // ever fails, a subclass has redefined `send` and the never-throw
      // guarantee is no longer enforced in one place.
      expect(
        Object.prototype.hasOwnProperty.call(SesEmailProvider.prototype, 'send'),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(SesEmailProvider.prototype, 'deliver'),
      ).toBe(true);
    });

    it('is structural: SmtpEmailProvider does not define its own `send`, only `deliver`', () => {
      expect(
        Object.prototype.hasOwnProperty.call(SmtpEmailProvider.prototype, 'send'),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(SmtpEmailProvider.prototype, 'deliver'),
      ).toBe(true);
    });

    it('resolves { success: true } with the message id on a successful deliver', async () => {
      provider.deliverImpl = async () => ({ success: true, messageId: 'msg-1' });

      await expect(provider.send(baseMessage)).resolves.toEqual({
        success: true,
        messageId: 'msg-1',
      });
    });

    it('returns a failure result rather than throwing when deliver rejects with an Error', async () => {
      provider.deliverImpl = async () => {
        throw new Error('boom');
      };

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TEST: boom');
    });

    it('returns a failure result rather than throwing when deliver throws a plain string', async () => {
      provider.deliverImpl = async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'a plain string was thrown';
      };

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TEST: a plain string was thrown');
    });

    it('returns a failure result rather than throwing when deliver throws a plain object', async () => {
      provider.deliverImpl = async () => {
        // A thrown SDK request context is exactly the case the class-level
        // JSDoc calls out: never JSON.stringify an unknown thrown value into
        // the error, because it could be carrying credentials.
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw { code: 'ECONNRESET', requestContext: { accessKeyId: 'AKIA-SHOULD-NOT-LEAK' } };
      };

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TEST: Non-Error value of type object thrown.');
      expect(result.error).not.toContain('AKIA-SHOULD-NOT-LEAK');
    });

    it('treats an undefined resolution from deliver as a failure, not a downstream TypeError', async () => {
      provider.deliverImpl = async () => undefined as unknown as EmailSendResult;

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error: 'TEST transport returned no result.',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'TEST provider returned no result object; treating as a failure',
      );
    });

    it('treats a non-object resolution from deliver (a bare string) as a failure', async () => {
      provider.deliverImpl = async () =>
        'not a result object' as unknown as EmailSendResult;

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('TEST transport returned no result.');
    });

    it('runs a resolved (non-throwing) failure through the same formatter as a thrown error', async () => {
      provider.deliverImpl = async () => ({ success: false, error: 'bad config' });

      const result = await provider.send(baseMessage);

      expect(result).toEqual({ success: false, error: 'TEST: bad config' });
    });

    it('falls back to "Unknown error." when a resolved failure carries no error text', async () => {
      provider.deliverImpl = async () => ({ success: false });

      const result = await provider.send(baseMessage);

      expect(result.error).toBe('TEST: Unknown error.');
    });
  });

  // ==========================================================================
  // SecretRedactor
  // ==========================================================================

  describe('SecretRedactor', () => {
    it('replaces a registered secret of ordinary length, keeping the rest of the message', () => {
      const redact = new SecretRedactor();
      redact.protect('super-secret-password');

      expect(redact.apply('auth failed for super-secret-password on host')).toBe(
        'auth failed for [redacted] on host',
      );
    });

    it('drops the WHOLE message when the registered secret is shorter than the redactable floor', () => {
      const redact = new SecretRedactor();
      redact.protect('abc'); // 3 chars — below MIN_REDACTABLE_SECRET_LENGTH (4)

      expect(redact.apply('the password was abc, rejected')).toBe(
        '[error withheld: it contained the configured credential]',
      );
    });

    it('does not treat a 4-character secret as too short to redact by substring', () => {
      const redact = new SecretRedactor();
      redact.protect('abcd'); // exactly the floor

      expect(redact.apply('tried abcd and failed')).toBe('tried [redacted] and failed');
    });

    it('leaves text untouched when the secret does not appear in it', () => {
      const redact = new SecretRedactor();
      redact.protect('unrelated-secret-value');

      expect(redact.apply('a totally different error')).toBe('a totally different error');
    });

    it('ignores null, undefined and empty-string secrets', () => {
      const redact = new SecretRedactor();
      redact.protect(null);
      redact.protect(undefined);
      redact.protect('');

      expect(redact.apply('nothing to redact here')).toBe('nothing to redact here');
    });

    it('redacts every registered secret, not just the first', () => {
      const redact = new SecretRedactor();
      redact.protect('first-secret-value');
      redact.protect('second-secret-value');

      expect(
        redact.apply('first-secret-value and second-secret-value both leaked'),
      ).toBe('[redacted] and [redacted] both leaked');
    });
  });

  // ==========================================================================
  // Error text truncation
  // ==========================================================================

  describe('error text truncation', () => {
    // MAX_ERROR_LENGTH is documented in base-email.provider.ts (JSDoc above
    // the constant) as 2000 and is not exported, so it is pinned here by
    // producing messages either side of the boundary.
    const MAX_ERROR_LENGTH = 2000;

    it('truncates error text past the documented limit and appends the marker', async () => {
      provider.deliverImpl = async () => {
        throw new Error('A'.repeat(MAX_ERROR_LENGTH + 500));
      };

      const result = await provider.send(baseMessage);

      expect(result.error).toBe(`TEST: ${'A'.repeat(MAX_ERROR_LENGTH)}… (truncated)`);
    });

    it('does not truncate error text exactly at the limit', async () => {
      provider.deliverImpl = async () => {
        throw new Error('B'.repeat(MAX_ERROR_LENGTH));
      };

      const result = await provider.send(baseMessage);

      expect(result.error).toBe(`TEST: ${'B'.repeat(MAX_ERROR_LENGTH)}`);
      expect(result.error).not.toContain('truncated');
    });
  });

  // ==========================================================================
  // Logging never carries message content
  // ==========================================================================

  describe('logging never carries secrets or message content', () => {
    it('the warn line logged on a thrown error contains no password, body, or subject', async () => {
      provider.deliverImpl = async (_msg, redact) => {
        redact.protect('hunter2-secret-password');
        throw new Error('auth failed for hunter2-secret-password');
      };
      const secretMessage: EmailMessage = {
        ...baseMessage,
        subject: 'Password reset for Jane Doe',
        html: '<p>token=abc123</p>',
        text: 'token=abc123',
      };

      await provider.send(secretMessage);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = String(warnSpy.mock.calls[0][0]);
      expect(logged).not.toContain('hunter2-secret-password');
      expect(logged).not.toContain(secretMessage.subject);
      expect(logged).not.toContain('token=abc123');
      // The redacted error text IS expected in the log line — only the raw
      // secret and the message content are forbidden.
      expect(logged).toContain('[redacted]');
    });
  });
});
