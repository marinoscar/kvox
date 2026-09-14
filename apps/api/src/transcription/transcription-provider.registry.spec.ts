import { TranscriptionProviderRegistry } from './transcription-provider.registry';
import type { TranscriptionProvider } from './providers/transcription-provider.interface';

function provider(
  id: string,
  overrides: Partial<TranscriptionProvider<unknown>> = {},
): TranscriptionProvider<unknown> {
  return {
    id,
    label: id.toUpperCase(),
    capabilities: {
      diarization: true,
      wordTimestamps: true,
      languageDetection: false,
      speakersExpectedHint: false,
      acceptsUrl: true,
      acceptsUpload: false,
      maxInputBytes: 100,
      maxDurationMs: 200,
      acceptedMimeTypes: ['audio/mpeg'],
      remoteDelete: true,
      cancel: false,
      ...(overrides.capabilities ?? {}),
    },
    settingsSchema: {} as TranscriptionProvider<unknown>['settingsSchema'],
    fieldDescriptors: [
      {
        key: 'region',
        label: 'Region',
        type: 'select',
        options: [{ value: 'us', label: 'US' }],
        required: true,
      },
    ],
    testConnection: jest.fn(),
    submit: jest.fn(),
    getStatus: jest.fn(),
    fetchResult: jest.fn(),
    deleteRemote: jest.fn(),
    ...overrides,
  } as TranscriptionProvider<unknown>;
}

describe('TranscriptionProviderRegistry', () => {
  it('registers and resolves by id, preserving registration order', () => {
    const registry = new TranscriptionProviderRegistry();
    registry.register(provider('alpha'));
    registry.register(provider('beta'));

    expect(registry.ids()).toEqual(['alpha', 'beta']);
    expect(registry.get('alpha')?.id).toBe('alpha');
  });

  it('returns undefined for an unknown id rather than throwing', () => {
    // The caller always has a better error than this class can produce: the
    // settings endpoint names the valid ids as a 400, a job handler fails the
    // job. A throw here would flatten both into a 500.
    expect(new TranscriptionProviderRegistry().get('nope')).toBeUndefined();
  });

  it('lets a later registration of the same id win, with a warning', () => {
    // A fork deliberately shadowing a framework provider is a supported thing
    // to do; refusing it would make patching this repository the only way.
    const registry = new TranscriptionProviderRegistry();
    const first = provider('alpha');
    const second = provider('alpha', { label: 'Replacement' });

    registry.register(first);
    registry.register(second);

    expect(registry.ids()).toEqual(['alpha']);
    expect(registry.get('alpha')?.label).toBe('Replacement');
  });

  it('refuses a provider with no id', () => {
    const registry = new TranscriptionProviderRegistry();

    expect(() => registry.register(provider(''))).toThrow(/non-empty `id`/);
  });

  it('refuses a provider that advertises cancel but implements none', () => {
    // Otherwise the failure is a TypeError inside a cancellation path — rarely
    // exercised code, running at the moment somebody is trying to stop a job
    // that is costing money.
    const registry = new TranscriptionProviderRegistry();
    const broken = provider('alpha', {
      capabilities: { ...provider('alpha').capabilities, cancel: true },
    });

    expect(() => registry.register(broken)).toThrow(/declares capabilities.cancel/);
  });

  it('accepts a provider that advertises cancel AND implements it', () => {
    const registry = new TranscriptionProviderRegistry();
    const ok = provider('alpha', {
      capabilities: { ...provider('alpha').capabilities, cancel: true },
      cancel: jest.fn(),
    });

    expect(() => registry.register(ok)).not.toThrow();
  });

  describe('describeAll', () => {
    it('publishes id, label, capabilities and field descriptors', () => {
      const registry = new TranscriptionProviderRegistry();
      registry.register(provider('alpha'));

      const [described] = registry.describeAll();

      expect(described.id).toBe('alpha');
      expect(described.capabilities.maxInputBytes).toBe(100);
      expect(described.fieldDescriptors[0].key).toBe('region');
    });

    it('publishes nothing unserialisable — it is a response body', () => {
      const registry = new TranscriptionProviderRegistry();
      registry.register(provider('alpha'));

      const described = registry.describeAll();

      // `settingsSchema` is a zod object and the methods are functions; handing
      // out the live provider would put both on a path ending in
      // `JSON.stringify`.
      expect(described[0]).not.toHaveProperty('settingsSchema');
      expect(described[0]).not.toHaveProperty('submit');
      expect(() => JSON.stringify(described)).not.toThrow();
    });

    it('copies the arrays, so a caller cannot mutate them for everyone', () => {
      const registry = new TranscriptionProviderRegistry();
      const live = provider('alpha');
      registry.register(live);

      const described = registry.describeAll();
      described[0].capabilities.acceptedMimeTypes.push('audio/forged');
      described[0].fieldDescriptors[0].label = 'Tampered';
      described[0].fieldDescriptors[0].options?.push({ value: 'x', label: 'x' });

      expect(live.capabilities.acceptedMimeTypes).toEqual(['audio/mpeg']);
      expect(live.fieldDescriptors[0].label).toBe('Region');
      expect(live.fieldDescriptors[0].options).toHaveLength(1);
    });
  });
});
