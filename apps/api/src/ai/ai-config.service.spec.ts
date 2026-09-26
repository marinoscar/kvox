import { AiConfigService } from './ai-config.service';
import type { AiProviderRegistry } from './ai-provider.registry';
import type { AiSettingsService } from './ai-settings.service';
import type { SystemAiValue } from './ai-settings.schema';
import type { UserAiCredentialsService } from './user-ai-credentials.service';
import type { AiProvider } from './providers/ai-provider.interface';

// =============================================================================
// AiConfigService — the active-provider axis (issue #78, epic #45)
// =============================================================================
//
// `AiConfigService.getConfig` NEVER THROWS for an unconfigured deployment: a
// client asking "may I offer this?" and getting a 500 has learned nothing it
// can act on. This file drives that guarantee directly, at the unit level,
// for the two states `docs/specs/notes.md` and the file's own header call out
// as ordinary rather than exceptional:
//
//   1. `provider: null` — nobody has chosen a vendor yet (a fresh install).
//   2. a `provider` NAMED by the policy but NOT REGISTERED in this build — a
//      deployment rolled back across the addition of a provider. This is
//      deliberately exercised with a stub registry that has nothing
//      registered, which the wire-level integration suite cannot produce on
//      its own: the real `OpenAiProvider` always self-registers, and the
//      `provider` field's own zod enum only ever accepts ids this build knows
//      the name of.
// =============================================================================

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: true,
    provider: null,
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [{ id: 'gpt-4o' }],
        defaultModel: 'gpt-4o',
      },
    },
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    requestTimeoutMs: 60_000,
    reasoningEffort: 'none',
    maxDocumentBytes: 1_000_000,
    ...overrides,
  };
}

function settingsStub(value: SystemAiValue): AiSettingsService {
  return { get: jest.fn().mockResolvedValue(value) } as unknown as AiSettingsService;
}

function registryStub(provider: AiProvider<never> | undefined): AiProviderRegistry {
  return { get: jest.fn().mockReturnValue(provider) } as unknown as AiProviderRegistry;
}

function credentialsStub(hasKey: boolean): UserAiCredentialsService {
  return {
    hasKey: jest.fn().mockResolvedValue(hasKey),
  } as unknown as UserAiCredentialsService;
}

// Hoisted so the #83 regression cases below can share it with the
// pre-existing "registered provider, for contrast" describe rather than
// each maintaining their own copy of the same registry entry.
function stubOpenAi(): AiProvider<never> {
  return {
    id: 'openai',
    label: 'OpenAI',
    capabilities: {
      models: [
        {
          id: 'gpt-4o',
          label: 'GPT-4o',
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
          structuredOutput: true,
          toolCalling: true,
        },
      ],
      streaming: true,
      modelDiscovery: false,
      // #358: a floor that claims nothing, so an unplaceable id reports false.
      defaultModelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      defaultModelFeatures: { structuredOutput: false, toolCalling: false },
    },
  } as unknown as AiProvider<never>;
}

describe('AiConfigService — no provider chosen (provider: null)', () => {
  // This remains one of the two genuinely nameless cases (#83's case a):
  // nobody has picked a vendor, so there is nothing for `provider` to name.
  // Contrast with the "switch is off but a provider IS chosen" describe
  // below, which is the case that must NOT collapse into this one.
  it('reports available: false without throwing, on a fresh deployment', async () => {
    const registry = registryStub(undefined);
    const credentials = credentialsStub(false);
    const service = new AiConfigService(
      settingsStub(policy({ provider: null })),
      registry,
      credentials,
    );

    await expect(service.getConfig('user-1')).resolves.toMatchObject({
      available: false,
      provider: null,
      providerLabel: null,
      models: [],
      defaultModel: null,
    });
  });

  it('never asks the registry for a provider it has no id for', async () => {
    const registry = registryStub(undefined);
    const service = new AiConfigService(
      settingsStub(policy({ provider: null })),
      registry,
      credentialsStub(false),
    );

    await service.getConfig('user-1');

    expect(registry.get).not.toHaveBeenCalled();
  });

  it('reports keyConfigured: false without consulting the credential store', async () => {
    const credentials = credentialsStub(true);
    const service = new AiConfigService(
      settingsStub(policy({ provider: null })),
      registryStub(undefined),
      credentials,
    );

    const result = await service.getConfig('user-1');

    // There is no provider to have a key FOR, so `hasKey` is never even asked —
    // the same "resolved regardless of `available`" contract, applied to the
    // one case where there is nothing to resolve against.
    expect(result.keyConfigured).toBe(false);
    expect(credentials.hasKey).not.toHaveBeenCalled();
  });
});

describe('AiConfigService — a chosen provider this build does not implement', () => {
  // This remains the other genuinely nameless case (#83's case b): the
  // registry has nothing registered under this id, so `provider` resolves
  // to `undefined` regardless of `enabled`, and stays null. Contrast with
  // the "switch is off but a provider IS chosen" describe below: THERE the
  // registry has a real entry, and `provider` must come through non-null —
  // that distinction is exactly what issue #83 was about.
  it('reports available: false without throwing — a rollback across the provider\'s addition', async () => {
    // The policy's `provider` enum accepted "openai" at write time, but the
    // registry (a stub standing in for "this process never registered it")
    // has nothing under that id. `AiConfigService` must treat this exactly
    // like `provider: null`, not throw and not crash the request.
    const registry = registryStub(undefined);
    const service = new AiConfigService(
      settingsStub(policy({ provider: 'openai', enabled: true })),
      registry,
      credentialsStub(false),
    );

    await expect(service.getConfig('user-1')).resolves.toMatchObject({
      available: false,
      provider: null,
      providerLabel: null,
      models: [],
      defaultModel: null,
    });
    expect(registry.get).toHaveBeenCalledWith('openai');
  });

  it('still reports keyConfigured: false, since there is no registered provider to hold a key for', async () => {
    const credentials = credentialsStub(true);
    const service = new AiConfigService(
      settingsStub(policy({ provider: 'openai', enabled: true })),
      registryStub(undefined),
      credentials,
    );

    const result = await service.getConfig('user-1');

    expect(result.keyConfigured).toBe(false);
    expect(credentials.hasKey).not.toHaveBeenCalled();
  });
});

describe('AiConfigService — a registered provider, for contrast', () => {
  it('reports available: true and resolves the key for the ACTUAL registered provider', async () => {
    const provider = stubOpenAi();
    const credentials = credentialsStub(true);
    const service = new AiConfigService(
      settingsStub(policy({ provider: 'openai', enabled: true })),
      registryStub(provider),
      credentials,
    );

    const result = await service.getConfig('user-1');

    expect(result.available).toBe(true);
    expect(result.provider).toBe('openai');
    expect(result.keyConfigured).toBe(true);
    expect(credentials.hasKey).toHaveBeenCalledWith('user-1', 'openai');
  });
});

// =============================================================================
// Issue #83 regression coverage: `provider` is independent of `available`
// =============================================================================
//
// The gap this closes: nothing above ever exercised `enabled: false` with a
// REGISTERED provider — the exact state `DEFAULT_SYSTEM_SETTINGS.ai` ships on
// every fresh deployment (`enabled: false`, `provider: 'openai'`). The fixed
// code resolves `provider`/`providerLabel`/`keyConfigured` once, above the
// `available` branch, and carries all three through both returns; these
// specs pin that so a future edit cannot quietly re-blank them.
describe('AiConfigService — switch is off but a provider IS chosen (issue #83 regression)', () => {
  it('still names the provider on a fresh deployment\'s exact default state (enabled: false, provider: "openai")', async () => {
    // This is `DEFAULT_SYSTEM_SETTINGS.ai` verbatim: a provider is named, the
    // registry has it, and a model is permitted — the switch alone is off.
    // Before the fix, this exact state returned `provider: null`, which is
    // what deadlocked setup: the key form on `/settings/ai` derives its
    // enablement from `config.provider`, so nobody could save a key to even
    // start turning AI on. A null here again would be that regression.
    const provider = stubOpenAi();
    const service = new AiConfigService(
      settingsStub(policy({ provider: 'openai', enabled: false })),
      registryStub(provider),
      credentialsStub(false),
    );

    const result = await service.getConfig('user-1');

    expect(result.available).toBe(false);
    expect(result.provider).toBe('openai');
    expect(result.providerLabel).toBe('OpenAI');
    expect(result.models).toEqual([]);
    expect(result.defaultModel).toBeNull();
  });

  it('still reports keyConfigured: true for a user with a stored key, even though the switch is off', async () => {
    // `keyConfigured` already had this independence before #83; this pins
    // that the fix for `provider` did not accidentally couple the two, since
    // a user must be able to see their own key is saved before an
    // administrator finishes turning the feature on.
    const provider = stubOpenAi();
    const credentials = credentialsStub(true);
    const service = new AiConfigService(
      settingsStub(policy({ provider: 'openai', enabled: false })),
      registryStub(provider),
      credentials,
    );

    const result = await service.getConfig('user-1');

    expect(result.available).toBe(false);
    expect(result.keyConfigured).toBe(true);
    expect(credentials.hasKey).toHaveBeenCalledWith('user-1', 'openai');
  });
});

describe('AiConfigService — switch is on, provider registered, but nothing is permitted (fact 3 fails)', () => {
  it('still names the provider when available: false comes from the second return path, not the early one', async () => {
    // `enabled`, `providerId` and `provider` are all truthy here, so this
    // takes the SECOND return (the `usable.length > 0` branch), unlike the
    // two describes above which take the early return. Both paths resolve
    // `provider` the same way — this pins that they agree rather than one
    // being fixed and the other still blanking it.
    const provider = stubOpenAi();
    const service = new AiConfigService(
      settingsStub(
        policy({
          provider: 'openai',
          enabled: true,
          providers: {
            openai: {
              baseUrl: 'https://api.openai.com/v1',
              allowedModels: [],
              // Still a valid model id — it just cannot survive an EMPTY
              // `allowedModels`, which is the point: `usable` ends up empty
              // regardless of what this names.
              defaultModel: 'gpt-4o',
            },
          },
        }),
      ),
      registryStub(provider),
      credentialsStub(false),
    );

    const result = await service.getConfig('user-1');

    expect(result.available).toBe(false);
    expect(result.provider).toBe('openai');
    expect(result.providerLabel).toBe('OpenAI');
    expect(result.models).toEqual([]);
    expect(result.defaultModel).toBeNull();
  });
});

describe('AiConfigService — the structuredOutput flag (#358)', () => {
  it('publishes each model\'s structuredOutput from its resolution rank', async () => {
    const service = new AiConfigService(
      settingsStub(
        policy({
          provider: 'openai',
          enabled: true,
          providers: {
            openai: {
              baseUrl: 'https://api.openai.com/v1',
              allowedModels: [
                // Catalogue hit: the catalogue's flag.
                { id: 'gpt-4o' },
                // Unplaceable id: the provider floor's flag — and typed numbers
                // never promote it, because there is no admin override of a
                // flag in v1.
                {
                  id: 'some-gateway-model',
                  contextWindowTokens: 64_000,
                  maxOutputTokens: 4_000,
                },
              ],
              defaultModel: 'gpt-4o',
            },
          },
        }),
      ),
      registryStub(stubOpenAi()),
      credentialsStub(true),
    );

    const result = await service.getConfig('user-1');

    expect(result.models.map((m) => [m.id, m.structuredOutput])).toEqual([
      ['gpt-4o', true],
      ['some-gateway-model', false],
    ]);
  });
});
