import { z } from 'zod';

import { AiProviderRegistry } from './ai-provider.registry';
import type {
  AiDelta,
  AiProvider,
  AiProviderContext,
} from './providers/ai-provider.interface';

// =============================================================================
// AiProviderRegistry (issue #47, epic #45)
// =============================================================================
//
// The registry's job is small and its failure modes are all at boot, which is
// what these tests are about: an incoherent provider must be refused WHERE THE
// FIX IS OBVIOUS rather than becoming a `TypeError` or a permanently
// unavailable feature much later and somewhere else.
// =============================================================================

function stubProvider(overrides: Partial<AiProvider<unknown>> = {}): AiProvider<unknown> {
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: {
      models: [
        {
          id: 'stub-1',
          label: 'Stub 1',
          contextWindowTokens: 8000,
          maxOutputTokens: 2000,
        },
      ],
      streaming: true,
      // The stub implements no `listModels`, so it must not claim to (#78) —
      // the registry refuses that combination at boot.
      modelDiscovery: false,
    },
    settingsSchema: z.object({}),
    fieldDescriptors: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true },
    ],
    testConnection: async () => ({ ok: true, latencyMs: 1, detail: 'fine' }),
    countTokens: (text: string) => text.length,
    // eslint-disable-next-line require-yield
    generate: async function* (
      _ctx: AiProviderContext<unknown>,
    ): AsyncIterable<AiDelta> {
      return;
    },
    ...overrides,
  } as AiProvider<unknown>;
}

describe('AiProviderRegistry', () => {
  let registry: AiProviderRegistry;

  beforeEach(() => {
    registry = new AiProviderRegistry();
  });

  it('registers and resolves a provider by id', () => {
    const provider = stubProvider();
    registry.register(provider);

    expect(registry.get('stub')).toBe(provider);
    expect(registry.ids()).toEqual(['stub']);
    expect(registry.all()).toEqual([provider]);
  });

  it('returns undefined rather than throwing for an unknown id', () => {
    // The caller always has a better error than this class can produce — the
    // credential endpoint 400s naming the valid ids, the config probe reports
    // `available: false`. A throw here would flatten both into a 500.
    expect(registry.get('nope')).toBeUndefined();
  });

  it('refuses a provider with no id', () => {
    expect(() => registry.register(stubProvider({ id: '' }))).toThrow(/non-empty/i);
  });

  it('refuses a provider declaring no models', () => {
    // A provider with an empty catalogue advertises a feature that is
    // permanently unavailable: `allowedModels` is intersected with this list,
    // so every model in the policy vanishes and nothing explains why.
    expect(() =>
      registry.register(
        stubProvider({
          capabilities: { models: [], streaming: true, modelDiscovery: false },
        }),
      ),
    ).toThrow(/no models/i);
  });

  it('refuses a provider that advertises modelDiscovery but implements no listModels (#78)', () => {
    // Mirrors `TranscriptionProviderRegistry`'s identical check for
    // `capabilities.cancel`: an advertised capability with no method is a
    // TypeError in the path least likely to have been exercised — here, an
    // administrator pressing "load models from the provider" on a settings
    // page opened once a quarter.
    expect(() =>
      registry.register(
        stubProvider({
          capabilities: {
            models: [
              {
                id: 'stub-1',
                label: 'Stub 1',
                contextWindowTokens: 8000,
                maxOutputTokens: 2000,
              },
            ],
            streaming: true,
            modelDiscovery: true,
          },
          // No `listModels` — the default stub does not implement one.
        }),
      ),
    ).toThrow(/declares capabilities.modelDiscovery but implements no listModels/);
  });

  it('accepts a provider that advertises modelDiscovery AND implements listModels', () => {
    expect(() =>
      registry.register(
        stubProvider({
          capabilities: {
            models: [
              {
                id: 'stub-1',
                label: 'Stub 1',
                contextWindowTokens: 8000,
                maxOutputTokens: 2000,
              },
            ],
            streaming: true,
            modelDiscovery: true,
          },
          listModels: async () => [],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a provider that declares modelDiscovery: false with no listModels', () => {
    // The default `stubProvider()` shape — registers fine, matching every test
    // above it in this file.
    expect(() => registry.register(stubProvider())).not.toThrow();
  });

  it('lets a later registration shadow an earlier one, with a warning', () => {
    const first = stubProvider();
    const second = stubProvider({ label: 'Forked Stub' });

    const warn = jest
      .spyOn((registry as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    registry.register(first);
    registry.register(second);

    // A fork deliberately shadowing a framework provider is supported;
    // refusing it would mean the only way to replace one is to patch this
    // repository.
    expect(registry.get('stub')).toBe(second);
    expect(warn).toHaveBeenCalled();
  });

  describe('describeAll', () => {
    it('publishes id, label, capabilities and field descriptors', () => {
      registry.register(stubProvider());

      expect(registry.describeAll()).toEqual([
        {
          id: 'stub',
          label: 'Stub',
          capabilities: {
            models: [
              {
                id: 'stub-1',
                label: 'Stub 1',
                contextWindowTokens: 8000,
                maxOutputTokens: 2000,
              },
            ],
            streaming: true,
            modelDiscovery: false,
          },
          fieldDescriptors: [
            {
              key: 'baseUrl',
              label: 'Base URL',
              type: 'text',
              required: true,
              options: undefined,
              defaultValue: undefined,
            },
          ],
        },
      ]);
    });

    it('omits settingsSchema and every method — the description is serialisable', () => {
      registry.register(stubProvider());

      const [described] = registry.describeAll();

      // Handing out the live objects would put a zod schema and several
      // functions on a path that ends in `JSON.stringify`.
      expect('settingsSchema' in described).toBe(false);
      expect('generate' in described).toBe(false);
      expect(() => JSON.stringify(described)).not.toThrow();
    });

    it('copies every array, so a caller cannot mutate the catalogue for everyone', () => {
      const provider = stubProvider();
      registry.register(provider);

      const described = registry.describeAll()[0];
      described.capabilities.models.push({
        id: 'injected',
        label: 'Injected',
        contextWindowTokens: 1,
        maxOutputTokens: 1,
      });
      described.fieldDescriptors.length = 0;

      expect(provider.capabilities.models).toHaveLength(1);
      expect(registry.describeAll()[0].fieldDescriptors).toHaveLength(1);
    });

    it('copies an array-valued defaultValue too', () => {
      registry.register(
        stubProvider({
          fieldDescriptors: [
            {
              key: 'allowedModels',
              label: 'Permitted models',
              type: 'string-list',
              required: false,
              defaultValue: ['a', 'b'],
            },
          ],
        }),
      );

      const described = registry.describeAll()[0];
      (described.fieldDescriptors[0].defaultValue as string[]).push('c');

      expect(registry.describeAll()[0].fieldDescriptors[0].defaultValue).toEqual([
        'a',
        'b',
      ]);
    });
  });
});
