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

describe('AiConfigService — no provider chosen (provider: null)', () => {
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
          },
        ],
        streaming: true,
        modelDiscovery: false,
      },
    } as unknown as AiProvider<never>;
  }

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
