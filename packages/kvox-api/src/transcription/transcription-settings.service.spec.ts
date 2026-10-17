import { BadRequestException } from '@nestjs/common';

import { TRANSCRIPTION_SETTINGS_DEFAULTS } from './transcription-settings.schema.js';
import { TranscriptionProviderRegistry } from './transcription-provider.registry.js';
import { TranscriptionSettingsService } from './transcription-settings.service.js';
import { TRANSCRIPTION_CREDENTIAL_PURPOSE } from './transcription-credential.constants.js';
import type { TranscriptionProvider } from './providers/transcription-provider.interface.js';

// =============================================================================
// TranscriptionSettingsService (issue #23, epic #19)
// =============================================================================
//
// THE THING THIS SUITE EXISTS TO PROVE, above everything else: the API key has
// exactly one destination and no way back out. Every read path is asserted not
// to call `getSecret`; every write path is asserted to pass the submitted value
// to `setSecret` UNTOUCHED; every audit row is walked for the key's bytes.
//
// The rest is the blank-preserves contract, which is the one that destroys a
// working configuration when it is wrong — and does so on the FIRST unrelated
// edit somebody makes, because the form always renders the key box empty.
// =============================================================================

// Deliberately shaped so no scanner and no reader can mistake it for a real
// credential. The first spelling here was `aai-live-key-<hex>`, which imitates
// the vendor's live-key format closely enough that GitGuardian opened an
// incident on it — a false positive that costs a human the time to confirm it
// is fake. A fixture only has to be a distinctive string; looking plausible
// buys this suite nothing and costs somebody a triage.
const API_KEY = 'fake-test-api-key-do-not-use';

const DEFAULTS = TRANSCRIPTION_SETTINGS_DEFAULTS;

/** A provider stub — the registry only needs its identity and its schema. */
function stubProvider(
  id = 'assemblyai',
  overrides: Partial<TranscriptionProvider<unknown>> = {},
): TranscriptionProvider<unknown> {
  return {
    id,
    label: 'AssemblyAI',
    capabilities: {
      diarization: true,
      wordTimestamps: true,
      languageDetection: true,
      speakersExpectedHint: true,
      acceptsUrl: true,
      acceptsUpload: true,
      maxInputBytes: 5 * 1024 ** 3,
      maxDurationMs: 36_000_000,
      acceptedMimeTypes: ['audio/mpeg'],
      remoteDelete: true,
      cancel: false,
      keyterms: null,
    },
    settingsSchema: {
      safeParse: (value: unknown) => ({ success: true as const, data: value }),
    } as unknown as TranscriptionProvider<unknown>['settingsSchema'],
    fieldDescriptors: [],
    testConnection: jest.fn(async () => ({
      ok: true,
      latencyMs: 12,
      detail: 'Authenticated against the US endpoint in 12 ms.',
    })),
    submit: jest.fn(),
    getStatus: jest.fn(),
    fetchResult: jest.fn(),
    deleteRemote: jest.fn(),
    ...overrides,
  } as TranscriptionProvider<unknown>;
}

interface Harness {
  service: TranscriptionSettingsService;
  provider: TranscriptionProvider<unknown>;
  secrets: {
    registerPurpose: jest.Mock;
    set: jest.Mock;
    get: jest.Mock;
    status: jest.Mock;
    delete: jest.Mock;
  };
  settings: {
    registerNamespace: jest.Mock;
    readSystem: jest.Mock;
    patchSystem: jest.Mock;
  };
  audit: { record: jest.Mock };
}

function buildHarness(
  policy = DEFAULTS,
  provider = stubProvider(),
): Harness {
  const registry = new TranscriptionProviderRegistry();
  registry.register(provider);

  const secrets = {
    registerPurpose: jest.fn(),
    set: jest.fn(async () => undefined),
    get: jest.fn(async () => API_KEY),
    status: jest.fn(async () => ({ configured: false, hint: null, updatedAt: null })),
    delete: jest.fn(async () => undefined),
  };

  const settings = {
    registerNamespace: jest.fn(),
    readSystem: jest.fn(async () => ({
      value: policy,
      version: 4,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: { id: 'u1', email: 'admin@example.com' },
    })),
    patchSystem: jest.fn(async () => ({ value: policy, version: 5 })),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const service = new TranscriptionSettingsService(
    settings as never,
    registry,
    secrets as never,
    audit as never,
  );

  return { service, provider, secrets, settings, audit };
}

/** Every string in an object graph, for the leak assertions. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(allStrings);
}

describe('TranscriptionSettingsService', () => {
  describe('describeForAdmin', () => {
    it('returns the policy, the masked key statuses and the provider catalogue', async () => {
      const { service, secrets } = buildHarness();
      secrets.status.mockResolvedValue({
        configured: true,
        hint: '••••2b7c',
        updatedAt: '2026-01-02T00:00:00.000Z',
        updatedByUserId: 'u1',
      });

      const view = await service.describeForAdmin();

      expect(view.settings).toEqual(DEFAULTS);
      expect(view.keyStatuses).toEqual([
        {
          providerId: 'assemblyai',
          configured: true,
          hint: '••••2b7c',
          updatedAt: '2026-01-02T00:00:00.000Z',
          updatedByUserId: 'u1',
        },
      ]);
      expect(view.providers[0].id).toBe('assemblyai');
      expect(view.version).toBe(4);
    });

    it('reports an unconfigured provider rather than omitting it', async () => {
      // An admin form needs a row for every provider so it can offer "paste a
      // key here"; omitting the unconfigured ones would make the one thing the
      // page exists for invisible.
      const { service } = buildHarness();

      const view = await service.describeForAdmin();

      expect(view.keyStatuses).toEqual([
        {
          providerId: 'assemblyai',
          configured: false,
          hint: null,
          updatedAt: null,
          updatedByUserId: null,
        },
      ]);
    });

    it('NEVER reads the plaintext key', async () => {
      // `describe`, not `getSecret`. The read path must not even be able to
      // hold the value — see `CredentialsService`'s invariant 1.
      const { service, secrets } = buildHarness();

      await service.describeForAdmin();

      expect(secrets.status).toHaveBeenCalled();
      expect(secrets.get).not.toHaveBeenCalled();
    });

    it('returns nothing containing the key, even when one is stored', async () => {
      const { service, secrets } = buildHarness();
      secrets.status.mockResolvedValue({
        configured: true,
        hint: '••••2b7c',
        updatedAt: '2026-01-02T00:00:00.000Z',
        updatedByUserId: 'u1',
      });

      const view = await service.describeForAdmin();

      expect(JSON.stringify(view)).not.toContain(API_KEY);
    });
  });

  describe('update — the settings half', () => {
    it('patches through the settings port rather than writing the row itself', async () => {
      // The merge, the validation, the unknown-key preservation and the version
      // counter all belong to that row. A second writer is how two of those
      // stop agreeing.
      const { service, settings } = buildHarness();

      await service.update({ settings: { enabled: true } }, 'u1', 4);

      expect(settings.patchSystem).toHaveBeenCalledWith(
        'transcription',
        { enabled: true },
        { actorUserId: 'u1', ifMatchVersion: 4 },
      );
    });

    it('passes an If-Match version through untouched, including 0', async () => {
      const { service, settings } = buildHarness();

      await service.update({ settings: { enabled: true } }, 'u1', 0);

      // `0` asserts "I believe nothing is stored yet"; a truthiness check here
      // would silently turn a first save into the one unguarded write.
      expect(settings.patchSystem).toHaveBeenCalledWith(
        'transcription',
        expect.anything(),
        { actorUserId: 'u1', ifMatchVersion: 0 },
      );
    });
  });

  describe('update — the key half', () => {
    it('stores a submitted key byte-for-byte, at the provider-scoped address', async () => {
      const { service, secrets } = buildHarness();

      await service.update(
        { settings: { provider: 'assemblyai' }, apiKey: `  ${API_KEY}  ` },
        'u1',
      );

      // NO `.trim()`. A credential whose surrounding whitespace is significant
      // is a real credential, and silently altering one produces an
      // authentication failure with no visible cause.
      expect(secrets.set).toHaveBeenCalledWith(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        'assemblyai',
        `  ${API_KEY}  `,
        'u1',
        { label: 'AssemblyAI API key' },
      );
    });

    it.each([[undefined], [null], ['']])(
      'skips setSecret entirely for a blank key (%p)',
      async (apiKey) => {
        // BLANK PRESERVES, and the call is skipped rather than made with a
        // blank value: `CredentialsService` 400s a blank first write, so
        // calling it would break an ordinary save on a deployment that has
        // never stored a key — a save that may have nothing to do with the key.
        const { service, secrets } = buildHarness();

        await service.update(
          { settings: { enabled: false }, apiKey: apiKey as string | null | undefined },
          'u1',
        );

        expect(secrets.set).not.toHaveBeenCalled();
      },
    );

    it('never erases a key through the update path', async () => {
      const { service, secrets } = buildHarness();

      await service.update({ settings: { enabled: false }, apiKey: '' }, 'u1');

      // Erasing is `removeCredential`, from a distinct control, deliberately.
      expect(secrets.delete).not.toHaveBeenCalled();
    });

    it('addresses the ALREADY-ACTIVE provider when the body does not name one', async () => {
      // "Paste a key and save" has to work on a deployment that chose its
      // provider on an earlier visit.
      const { service, secrets } = buildHarness({
        ...DEFAULTS,
        provider: 'assemblyai',
      });

      await service.update({ settings: { enabled: true }, apiKey: API_KEY }, 'u1');

      expect(secrets.set).toHaveBeenCalledWith(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        'assemblyai',
        API_KEY,
        'u1',
        expect.anything(),
      );
    });

    it('refuses a key with no provider anywhere, rather than inventing an address', async () => {
      const { service, secrets } = buildHarness();

      await expect(
        service.update({ settings: {}, apiKey: API_KEY }, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(secrets.set).not.toHaveBeenCalled();
    });

    it('refuses a key for an unknown provider', async () => {
      const { service, secrets } = buildHarness();

      await expect(
        service.update(
          { settings: { provider: 'nonesuch' as never }, apiKey: API_KEY },
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(secrets.set).not.toHaveBeenCalled();
    });

    it('writes the key BEFORE the settings, so a refused key leaves nothing persisted', async () => {
      const order: string[] = [];
      const { service, secrets, settings } = buildHarness();
      secrets.set.mockImplementation(async () => {
        order.push('secret');
      });
      settings.patchSystem.mockImplementation(async () => {
        order.push('settings');
        return {};
      });

      await service.update(
        { settings: { provider: 'assemblyai' }, apiKey: API_KEY },
        'u1',
      );

      // The other ordering persists `provider: 'assemblyai'` with no key behind
      // it and THEN 400s: the admin sees a failure, the configuration changed
      // anyway, and the next job fails for a reason the error never mentioned.
      expect(order).toEqual(['secret', 'settings']);
    });
  });

  describe('update — the audit trail', () => {
    it('records THAT the key changed, never what it changed to', async () => {
      const { service, audit } = buildHarness();

      await service.update(
        { settings: { provider: 'assemblyai' }, apiKey: API_KEY },
        'u1',
      );

      const row = audit.record.mock.calls[0][0];
      expect(row.action).toBe('transcription_settings:update');
      expect(row.meta.apiKeyChanged).toBe(true);
      expect(allStrings(row.meta)).not.toContain(API_KEY);
      expect(JSON.stringify(row)).not.toContain(API_KEY);
    });

    it('records apiKeyChanged: false for a save that did not touch the key', async () => {
      const { service, audit } = buildHarness();

      await service.update({ settings: { enabled: true } }, 'u1');

      expect(audit.record.mock.calls[0][0].meta.apiKeyChanged).toBe(
        false,
      );
    });
  });

  describe('removeCredential', () => {
    it('deletes the provider-scoped credential and audits it', async () => {
      const { service, secrets, audit } = buildHarness();

      await service.removeCredential('assemblyai', 'u1');

      expect(secrets.delete).toHaveBeenCalledWith(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        'assemblyai',
        'u1',
      );
      expect(audit.record.mock.calls[0][0].action).toBe(
        'transcription_settings:credential_delete',
      );
    });

    it('does NOT disable transcription as a side effect', async () => {
      // Removing the active provider's key mid-rotation must not take the
      // deployment off the air — the admin is about to paste the new one.
      const { service, settings } = buildHarness({
        ...DEFAULTS,
        enabled: true,
        provider: 'assemblyai',
      });

      await service.removeCredential('assemblyai', 'u1');

      expect(settings.patchSystem).not.toHaveBeenCalled();
    });

    it('refuses an unknown provider', async () => {
      const { service, secrets } = buildHarness();

      await expect(service.removeCredential('nonesuch', 'u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(secrets.delete).not.toHaveBeenCalled();
    });
  });

  describe('testConnection', () => {
    it('probes with the SUPPLIED key, without saving it', async () => {
      // THE WORKFLOW THIS ENDPOINT EXISTS FOR: prove a key before committing
      // it, so a wrong key is a two-minute problem rather than a failed job an
      // hour later.
      const { service, provider, secrets } = buildHarness();

      await service.testConnection(
        { provider: 'assemblyai', apiKey: 'unsaved-key-123' },
        'u1',
      );

      expect(secrets.get).not.toHaveBeenCalled();
      expect(secrets.set).not.toHaveBeenCalled();
      expect(provider.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'unsaved-key-123' }),
      );
    });

    it('falls back to the stored key when none is supplied', async () => {
      const { service, provider, secrets } = buildHarness();

      await service.testConnection({ provider: 'assemblyai' }, 'u1');

      expect(secrets.get).toHaveBeenCalledWith(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        'assemblyai',
      );
      expect(provider.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: API_KEY }),
      );
    });

    it('applies a region override for this probe only', async () => {
      const { service, provider } = buildHarness();

      await service.testConnection(
        { provider: 'assemblyai', region: 'eu', apiKey: 'k' },
        'u1',
      );

      expect(provider.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ region: 'eu' }) }),
      );
    });

    it('400s when there is no key anywhere — which is not a failed probe', async () => {
      const { service, secrets, provider } = buildHarness();
      secrets.get.mockResolvedValue(null);

      await expect(
        service.testConnection({ provider: 'assemblyai' }, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(provider.testConnection).not.toHaveBeenCalled();
    });

    it('400s for an unknown provider', async () => {
      const { service } = buildHarness();

      await expect(
        service.testConnection({ provider: 'nonesuch' }, 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves a FAILED probe rather than throwing — a refusal is a diagnosis', async () => {
      const provider = stubProvider('assemblyai', {
        testConnection: jest.fn(async () => ({
          ok: false,
          latencyMs: 40,
          detail: 'The US endpoint rejected this API key (HTTP 401).',
        })),
      });
      const { service } = buildHarness(DEFAULTS, provider);

      await expect(
        service.testConnection({ provider: 'assemblyai', apiKey: 'bad' }, 'u1'),
      ).resolves.toMatchObject({ ok: false });
    });

    it('audits the outcome, never the key', async () => {
      const { service, audit } = buildHarness();

      await service.testConnection(
        { provider: 'assemblyai', apiKey: API_KEY },
        'u1',
      );

      const row = audit.record.mock.calls[0][0];
      expect(row.action).toBe('transcription_settings:test');
      expect(row.meta.ok).toBe(true);
      // The FACT that an inline key was used — "an admin proved a new key"
      // versus "an admin re-checked the stored one" — and nothing more.
      expect(row.meta.usedSuppliedKey).toBe(true);
      expect(allStrings(row.meta)).not.toContain(API_KEY);
      expect(JSON.stringify(row)).not.toContain(API_KEY);
    });

    it('audits a probe of the stored key as such', async () => {
      const { service, audit } = buildHarness();

      await service.testConnection({ provider: 'assemblyai' }, 'u1');

      expect(audit.record.mock.calls[0][0].meta.usedSuppliedKey).toBe(
        false,
      );
    });
  });
});
