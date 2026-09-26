import { BadRequestException, ConflictException, Logger } from '@nestjs/common';

import { AiModelDiscoveryService } from './ai-model-discovery.service';
import type { AiProviderRegistry } from './ai-provider.registry';
import type { AiSettingsService } from './ai-settings.service';
import type { SystemAiValue } from './ai-settings.schema';
import type { UserAiCredentialsService } from './user-ai-credentials.service';
import type { AiProvider } from './providers/ai-provider.interface';
import type { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// AiModelDiscoveryService (issue #78, epic #45)
// =============================================================================
//
// The four outcomes `GET /api/ai-settings/models` can produce, isolated at the
// unit level so each is deterministic and none depends on mutating the shared,
// singleton `AiProviderRegistry` a full-`AppModule` integration spec would
// otherwise have to register a second provider into. `test/ai/ai-settings
// .integration.spec.ts` covers the same four outcomes again over the wire
// (status codes, the response envelope, the real cipher) — this file is where
// the SERVICE's own branching and its "never leak the key" discipline are
// pinned directly.
// =============================================================================

const RAW_KEY = 'sk-proj-UNIT-TEST-DO-NOT-LOG-9x8y7z';

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: true,
    provider: 'openai',
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

function discoveringProvider(
  overrides: Partial<AiProvider<never>> = {},
): AiProvider<never> {
  return {
    id: 'openai',
    label: 'OpenAI',
    capabilities: {
      models: [
        { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      ],
      streaming: true,
      modelDiscovery: true,
    },
    settingsSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    fieldDescriptors: [],
    testConnection: jest.fn(),
    countTokens: () => 0,
    generate: (async function* () {})(),
    listModels: jest.fn().mockResolvedValue([
      { id: 'gpt-4o', label: 'GPT-4o', known: true, contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
    ]),
    ...overrides,
  } as unknown as AiProvider<never>;
}

function harness(opts: {
  policyValue?: SystemAiValue;
  provider?: AiProvider<never> | undefined;
  secret?: string | null;
}) {
  const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService;
  const settings = {
    get: jest.fn().mockResolvedValue(opts.policyValue ?? policy()),
  } as unknown as AiSettingsService;
  const registry = {
    get: jest.fn().mockReturnValue(opts.provider),
    ids: jest.fn().mockReturnValue(opts.provider ? [opts.provider.id] : []),
  } as unknown as AiProviderRegistry;
  const credentials = {
    getSecret: jest.fn().mockResolvedValue(opts.secret ?? null),
  } as unknown as UserAiCredentialsService;

  const service = new AiModelDiscoveryService(prisma, settings, registry, credentials);

  return { service, prisma, settings, registry, credentials };
}

describe('AiModelDiscoveryService.discoverModels', () => {
  it('success: returns ok:true with the models the provider listed', async () => {
    const provider = discoveringProvider();
    const { service, credentials } = harness({ provider, secret: RAW_KEY });

    const result = await service.discoverModels('user-1');

    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      expect.objectContaining({ id: 'gpt-4o', known: true }),
    ]);
    // The CALLER'S credential — resolved for THIS provider, THIS user.
    expect(credentials.getSecret).toHaveBeenCalledWith('user-1', 'openai');
  });

  it('vendor refusal: ok:false with an empty model list, from a thrown provider error — never rethrown', async () => {
    const provider = discoveringProvider({
      listModels: jest.fn().mockRejectedValue(new Error('The provider rejected this API key.')),
    });
    const { service } = harness({ provider, secret: RAW_KEY });

    const result = await service.discoverModels('user-1');

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.detail).toContain('rejected this API key');
  });

  it('409s with details.reason: ai_key_missing when the caller has no key of their own', async () => {
    const provider = discoveringProvider();
    const { service } = harness({ provider, secret: null });

    let thrown: ConflictException | undefined;
    try {
      await service.discoverModels('user-1');
    } catch (err) {
      thrown = err as ConflictException;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown?.getStatus()).toBe(409);
    expect(
      (thrown?.getResponse() as { details: { reason: string } }).details,
    ).toEqual({ reason: 'ai_key_missing' });
  });

  it('400s when no provider is active and none was requested', async () => {
    const { service } = harness({
      policyValue: policy({ provider: null }),
      provider: undefined,
    });

    await expect(service.discoverModels('user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s for a provider this build does not implement', async () => {
    const { service } = harness({ provider: undefined });

    await expect(
      service.discoverModels('user-1', 'azure-openai'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s for a provider registered but declaring no discovery support', async () => {
    const provider = discoveringProvider({
      capabilities: {
        models: [{ id: 'x', label: 'x', contextWindowTokens: 1, maxOutputTokens: 1, structuredOutput: false }],
        streaming: true,
        modelDiscovery: false,
      },
      listModels: undefined,
    });
    const { service } = harness({ provider, secret: RAW_KEY });

    let thrown: BadRequestException | undefined;
    try {
      await service.discoverModels('user-1');
    } catch (err) {
      thrown = err as BadRequestException;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown?.getResponse() as { message: string }).message).toContain(
      'cannot list its models',
    );
  });

  it('lets an explicitly requested provider win over the active one', async () => {
    // Inspecting a catalogue BEFORE switching to it — the same workflow
    // `baseUrl` overrides on `POST /api/ai-settings/test` serve.
    const requested = discoveringProvider({ id: 'requested-stub' });
    const { service, registry } = harness({
      policyValue: policy({ provider: 'openai' }),
      provider: requested,
      secret: RAW_KEY,
    });

    await service.discoverModels('user-1', 'requested-stub');

    expect(registry.get).toHaveBeenCalledWith('requested-stub');
  });

  it('NEVER puts the key in the error body, the returned detail, or a log call', async () => {
    // A REALISTIC refusal message — the shape `AiAuthError` and the rest of
    // `../ai-errors.ts` actually produce, which by construction never
    // interpolates the credential. (A vendor echoing a submitted key back
    // inside a raw, unclassified error BODY is a separate, already-documented
    // and already-accepted edge case — see `OpenAiProvider.testConnection`'s
    // own "never puts the key in the reported detail, whatever happened" spec,
    // which asserts the opposite for exactly that scenario. This test is about
    // this SERVICE's own surfaces never introducing the key on their own, not
    // about re-deciding that documented, pre-existing tradeoff.)
    const provider = discoveringProvider({
      listModels: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'The AI provider refused this API key (HTTP 401). Check the key on your AI key settings page.',
          ),
        ),
    });
    const { service, prisma } = harness({ provider, secret: RAW_KEY });

    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const debugSpy = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const result = await service.discoverModels('user-1');

    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(RAW_KEY);

    const auditCall = (prisma.auditEvent.create as jest.Mock).mock.calls[0][0];
    // STRUCTURAL, not just a substring search: the meta object must not even
    // carry a field able to hold the credential — the same discipline
    // `ai-settings.schema.ts`'s compile-time proof applies to the settings
    // blob, checked here at the call-site instead.
    expect(Object.keys(auditCall.data.meta)).not.toContain('apiKey');
    expect(JSON.stringify(auditCall.data.meta)).not.toContain(RAW_KEY);

    for (const spy of [logSpy, debugSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(RAW_KEY);
      }
      spy.mockRestore();
    }
  });

  it('audits the outcome with a count, never the model ids or the key', async () => {
    const provider = discoveringProvider();
    const { service, prisma } = harness({ provider, secret: RAW_KEY });

    await service.discoverModels('user-1');

    const auditCall = (prisma.auditEvent.create as jest.Mock).mock.calls[0][0];
    expect(auditCall.data.action).toBe('ai_settings:discover_models');
    expect(auditCall.data.targetType).toBe('system_settings');
    expect(auditCall.data.targetId).toBe('ai');
    expect(auditCall.data.meta).toMatchObject({ provider: 'openai', ok: true, modelCount: 1 });
    expect(JSON.stringify(auditCall.data.meta)).not.toContain(RAW_KEY);
  });
});
