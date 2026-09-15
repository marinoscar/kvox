import { z } from 'zod';

import { AiProviderRegistry } from './ai-provider.registry';
import type {
  AiDelta,
  AiEmbeddingCapability,
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

  // ---------------------------------------------------------------------------
  // Embeddings (#183, epic #165)
  // ---------------------------------------------------------------------------
  //
  // The same "both or neither" rule `modelDiscovery`/`listModels` follows, plus
  // the one check that is genuinely load-bearing: a declared width that is not
  // the one the vector column holds cannot be stored AT ALL, and without a boot
  // check the first evidence of it is a Postgres type error inside a queue job.

  const EMBEDDING: AiEmbeddingCapability = {
    model: 'stub-embed-1',
    dimensions: 1536,
    maxInputTokens: 8191,
    maxBatchSize: 64,
  };

  const embed = async () => ({ vectors: [], promptTokens: null, model: 'stub-embed-1' });

  it('refuses a provider that declares `embedding` but implements no embed() (#183)', () => {
    expect(() =>
      registry.register(stubProvider({ embedding: EMBEDDING })),
    ).toThrow(/declares an `embedding` capability but implements no embed\(\)/);
  });

  it('refuses a provider that implements embed() but declares no `embedding` (#183)', () => {
    // The mirror case, and not a pedantic one: a method nothing advertises is
    // one no caller can discover, so the capability would be dead code that
    // looks alive.
    expect(() => registry.register(stubProvider({ embed }))).toThrow(
      /declares an embed\(\) method but no `embedding` capability/,
    );
  });

  it('refuses an embedding width the vector column cannot hold, NAMING the provider and the width (#183)', () => {
    // ⚠ THE LOAD-BEARING CHECK. `vector(1536)` is a contract, not a default:
    // 768 numbers cannot be stored badly, they cannot be stored. The message
    // has to carry both facts because the alternative failure — a type error
    // inside `search.index` at 3am — carries neither.
    const thrown = (() => {
      try {
        registry.register(
          stubProvider({
            id: 'narrow-vendor',
            embedding: { ...EMBEDDING, dimensions: 768 },
            embed,
          }),
        );
        return null;
      } catch (err) {
        return err as Error;
      }
    })();

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('narrow-vendor');
    expect(thrown?.message).toContain('768');
    expect(thrown?.message).toContain('1536');
  });

  it('refuses a maxBatchSize of zero (#183)', () => {
    // A zero batch size makes an indexer either loop forever taking no inputs
    // per pass or refuse every input — both silent, both look like "search
    // never finishes".
    expect(() =>
      registry.register(
        stubProvider({ embedding: { ...EMBEDDING, maxBatchSize: 0 }, embed }),
      ),
    ).toThrow(/at least 1/);
  });

  it('refuses a maxInputTokens of zero (#183)', () => {
    expect(() =>
      registry.register(
        stubProvider({ embedding: { ...EMBEDDING, maxInputTokens: 0 }, embed }),
      ),
    ).toThrow(/at least 1/);
  });

  it('accepts a coherent embedding declaration (#183)', () => {
    expect(() =>
      registry.register(stubProvider({ embedding: EMBEDDING, embed })),
    ).not.toThrow();
  });

  it('accepts a provider that declares neither half — embeddings are optional (#183)', () => {
    // The default `stubProvider()` shape. A vendor with no embeddings endpoint
    // is a perfectly registrable chat provider; forcing it to write a throwing
    // stub is exactly what the interface argues against.
    expect(() => registry.register(stubProvider())).not.toThrow();
    expect(registry.get('stub')?.embedding).toBeUndefined();
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
