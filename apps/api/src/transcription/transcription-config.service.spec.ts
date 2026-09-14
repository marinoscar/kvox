import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { TranscriptionConfigService } from './transcription-config.service';
import { TranscriptionProviderRegistry } from './transcription-provider.registry';
import type { TranscriptionProvider } from './providers/transcription-provider.interface';

// =============================================================================
// TranscriptionConfigService (issue #23, epic #19)
// =============================================================================
//
// `available` is a conjunction of FOUR facts, and each one has its own test
// below, because reporting anything less than all four as available moves the
// failure from a disabled button to a failed job minutes later — the difference
// between "transcription is not set up" and "transcription is broken".
// =============================================================================

const DEFAULTS = DEFAULT_SYSTEM_SETTINGS.transcription;

function provider(id = 'assemblyai'): TranscriptionProvider<unknown> {
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
      maxInputBytes: 5_368_709_120,
      maxDurationMs: 36_000_000,
      acceptedMimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'video/quicktime'],
      remoteDelete: true,
      cancel: false,
    },
    settingsSchema: {} as TranscriptionProvider<unknown>['settingsSchema'],
    fieldDescriptors: [],
    testConnection: jest.fn(),
    submit: jest.fn(),
    getStatus: jest.fn(),
    fetchResult: jest.fn(),
    deleteRemote: jest.fn(),
  } as TranscriptionProvider<unknown>;
}

function build(
  policy: typeof DEFAULTS,
  { registered = true, keyStored = true } = {},
) {
  const registry = new TranscriptionProviderRegistry();
  if (registered) registry.register(provider());

  const credentials = {
    describe: jest.fn(async () => (keyStored ? { hint: '••••1234' } : null)),
    getSecret: jest.fn(),
  };

  const settings = { get: jest.fn(async () => policy) };

  return {
    service: new TranscriptionConfigService(
      settings as never,
      registry,
      credentials as never,
    ),
    credentials,
  };
}

const CONFIGURED = {
  ...DEFAULTS,
  enabled: true,
  provider: 'assemblyai' as const,
};

describe('TranscriptionConfigService', () => {
  it('reports available with the provider limits when all four facts hold', () => {
    return build(CONFIGURED)
      .service.getConfig()
      .then((config) => {
        expect(config).toEqual({
          available: true,
          providerLabel: 'AssemblyAI',
          maxUploadBytes: 5_368_709_120,
          maxDurationMs: 36_000_000,
          acceptedExtensions: ['.mp3', '.wav', '.mov'],
          acceptedMimeTypes: [
            'audio/mpeg',
            'audio/mp3',
            'audio/wav',
            'video/quicktime',
          ],
        });
      });
  });

  it('de-duplicates extensions shared by several MIME types', async () => {
    // `audio/mpeg` and `audio/mp3` both give `.mp3`; a repeated entry in an
    // `accept` attribute is noise a user can see in the file dialog.
    const config = await build(CONFIGURED).service.getConfig();

    expect(config.acceptedExtensions).toEqual([
      ...new Set(config.acceptedExtensions),
    ]);
  });

  it('is unavailable when the master switch is off (fact 1)', async () => {
    const config = await build({ ...CONFIGURED, enabled: false }).service.getConfig();

    expect(config.available).toBe(false);
    expect(config.providerLabel).toBeNull();
    expect(config.maxUploadBytes).toBe(0);
  });

  it('is unavailable when no provider has been chosen (fact 2)', async () => {
    const config = await build({ ...CONFIGURED, provider: null }).service.getConfig();

    expect(config.available).toBe(false);
    expect(config.acceptedMimeTypes).toEqual([]);
  });

  it('is unavailable when the stored provider is not registered in this build (fact 3)', async () => {
    // What a rollback across the addition of a provider looks like. Reporting
    // it as available would let a user upload a file for a vendor nothing in
    // this process can submit to.
    const config = await build(CONFIGURED, { registered: false }).service.getConfig();

    expect(config.available).toBe(false);
    expect(config.providerLabel).toBeNull();
  });

  it('is unavailable when no API key is stored (fact 4), but STILL reports the limits', async () => {
    // The most common half-finished state: choosing a provider and pasting its
    // key are two fields and people save between them. Keeping the limits means
    // a disabled control can still say what it would allow, and an
    // administrator reading the same payload sees "half-finished" rather than
    // "absent".
    const config = await build(CONFIGURED, { keyStored: false }).service.getConfig();

    expect(config.available).toBe(false);
    expect(config.providerLabel).toBe('AssemblyAI');
    expect(config.maxUploadBytes).toBeGreaterThan(0);
  });

  it('checks the key with describe, NEVER getSecret', async () => {
    // This runs on a request any signed-in user can make; a path that decrypts
    // a credential to answer a capability question is one careless `return`
    // away from publishing it.
    const { service, credentials } = build(CONFIGURED);

    await service.getConfig();

    expect(credentials.describe).toHaveBeenCalled();
    expect(credentials.getSecret).not.toHaveBeenCalled();
  });

  it('publishes no configuration detail — region, model or delivery mode', async () => {
    const config = await build(CONFIGURED).service.getConfig();

    // A capability probe hands out the CAPABILITY, not the configuration
    // behind it. Anything here would be readable by every signed-in account.
    expect(config).not.toHaveProperty('region');
    expect(config).not.toHaveProperty('speechModel');
    expect(config).not.toHaveProperty('audioDelivery');
    expect(config).not.toHaveProperty('deleteRemoteAfterIngest');
    expect(JSON.stringify(config)).not.toContain('universal');
  });
});
