import { Test } from '@nestjs/testing';

import { CredentialsService } from '../credentials/credentials.service';
import { ProviderAuthError } from '../transcription/errors';
import { TranscriptionProviderRegistry } from '../transcription/transcription-provider.registry';
import { TranscriptionSettingsService } from '../transcription/transcription-settings.service';
import { createFakeProvider, type FakeProvider } from './handlers/__fixtures__/fake-provider';
import { TranscriptionRuntimeService } from './transcription-runtime.service';

// =============================================================================
// TranscriptionRuntimeService — every "not configured" is a DOMAIN failure
// =============================================================================
//
// The point of this file: each of the four ways a deployment can be unable to
// transcribe throws `ProviderAuthError`, NOT a plain `Error`. A plain error
// would be classified retryable, so the queue would read the same settings row
// three times to reach the same conclusion before failing the transcript
// anyway — two extra job rows saying nothing new, and the owner told two
// attempts later than they could have been.
// =============================================================================

describe('TranscriptionRuntimeService', () => {
  let service: TranscriptionRuntimeService;
  let provider: FakeProvider;
  let settings: { get: jest.Mock };
  let registry: { get: jest.Mock; describeAll: jest.Mock };
  let credentials: { getSecret: jest.Mock; describe: jest.Mock };

  const policy = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    provider: 'fake',
    providers: { fake: {} },
    audioDelivery: 'presigned_url',
    ...overrides,
  });

  beforeEach(async () => {
    provider = createFakeProvider();

    settings = { get: jest.fn().mockResolvedValue(policy()) };
    registry = {
      get: jest.fn().mockReturnValue(provider),
      describeAll: jest.fn().mockReturnValue([{ id: 'fake' }]),
    };
    credentials = {
      getSecret: jest.fn().mockResolvedValue('secret-key'),
      describe: jest.fn().mockResolvedValue({ name: 'fake' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptionRuntimeService,
        { provide: TranscriptionSettingsService, useValue: settings },
        { provide: TranscriptionProviderRegistry, useValue: registry },
        { provide: CredentialsService, useValue: credentials },
      ],
    }).compile();

    service = module.get(TranscriptionRuntimeService);
  });

  describe('resolve', () => {
    it('returns the provider, a context and the policy', async () => {
      const resolved = await service.resolve();

      expect(resolved.provider).toBe(provider);
      expect(resolved.ctx.apiKey).toBe('secret-key');
      expect(resolved.policy.enabled).toBe(true);
    });

    it('makes an accidental serialisation of the context inert', async () => {
      // A context reaching `JSON.stringify` through a log serialiser or an
      // error's `cause` is the most common leak. This is a backstop, not
      // permission: the rule is still "never log this".
      const resolved = await service.resolve();

      expect(JSON.stringify(resolved.ctx)).not.toContain('secret-key');
      expect(JSON.parse(JSON.stringify(resolved.ctx)).apiKey).toBe('[redacted]');
    });

    it.each([
      ['transcription is off', () => settings.get.mockResolvedValue(policy({ enabled: false }))],
      ['no provider is chosen', () => settings.get.mockResolvedValue(policy({ provider: null }))],
      ['the provider is not in this build', () => registry.get.mockReturnValue(undefined)],
      ['no key is stored', () => credentials.getSecret.mockResolvedValue(null)],
    ] as Array<[string, () => void]>)(
      'throws ProviderAuthError — not a plain Error — when %s',
      async (_label, arrange) => {
        arrange();

        await expect(service.resolve()).rejects.toBeInstanceOf(ProviderAuthError);
      },
    );

    it('names what IS registered when the configured provider is missing', async () => {
      // The difference between a one-minute diagnosis and an afternoon.
      registry.get.mockReturnValue(undefined);

      await expect(service.resolve()).rejects.toThrow(/Registered providers: fake/);
    });

    it('validates the stored provider settings with the provider\'s own schema', async () => {
      // A row written by an older build with a different schema is exactly the
      // case a parse here catches before the vendor call rather than after.
      const strict = createFakeProvider();
      (strict as unknown as { settingsSchema: unknown }).settingsSchema = {
        safeParse: () => ({ success: false, error: { issues: [{ path: ['region'] }] } }),
      };
      registry.get.mockReturnValue(strict);

      await expect(service.resolve()).rejects.toThrow(/not\s+valid: region/);
    });
  });

  describe('activeProvider', () => {
    it('returns null rather than throwing for an unconfigured deployment', async () => {
      // "Nothing is set up" is a 409 on the create path and a normal wait on
      // the pipeline path — neither is an exception.
      settings.get.mockResolvedValue(policy({ enabled: false }));

      await expect(service.activeProvider()).resolves.toBeNull();
    });

    it('reads no credential at all', async () => {
      await service.activeProvider();

      expect(credentials.getSecret).not.toHaveBeenCalled();
      expect(credentials.describe).not.toHaveBeenCalled();
    });
  });

  describe('isAvailable', () => {
    it('checks the key with `describe`, never `getSecret`', async () => {
      // A path that decrypts a credential to answer a capability question is
      // one careless `return` away from publishing it.
      await expect(service.isAvailable()).resolves.toBe(true);

      expect(credentials.describe).toHaveBeenCalled();
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });

    it('is false when a provider is chosen but has no key', async () => {
      credentials.describe.mockResolvedValue(null);

      await expect(service.isAvailable()).resolves.toBe(false);
    });
  });
});
