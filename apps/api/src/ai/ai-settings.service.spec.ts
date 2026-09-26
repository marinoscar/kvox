import { BadRequestException, HttpException } from '@nestjs/common';

import type { AiProviderRegistry } from './ai-provider.registry';
import type { SystemAiPatchValue, SystemAiValue } from './ai-settings.schema';
import { AiSettingsService } from './ai-settings.service';
import { AI_TASK_DEFINITIONS } from './ai-task-models';
import type { AiProvider } from './providers/ai-provider.interface';

// =============================================================================
// AiSettingsService — task models (issue #360)
// =============================================================================
//
// Save-time validation of `taskModels` in `update`, and the three admin-view
// additions (`tasks`, `modelCapabilities`, `taskModelStatus`). Collaborators are
// stubs: `SystemSettingsService` owns the merge and is covered by its own spec
// and by `test/settings/system-settings.integration.spec.ts`.
// =============================================================================

function stubProvider(): AiProvider<never> {
  return {
    id: 'openai',
    label: 'OpenAI',
    capabilities: {
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          contextWindowTokens: 400_000,
          maxOutputTokens: 128_000,
          structuredOutput: true,
          toolCalling: true,
        },
        {
          id: 'gpt-5.4-mini',
          label: 'GPT-5.4 mini',
          contextWindowTokens: 400_000,
          maxOutputTokens: 128_000,
          structuredOutput: true,
          toolCalling: true,
        },
        {
          id: 'no-tools',
          label: 'No tools',
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_000,
          structuredOutput: true,
          toolCalling: false,
        },
      ],
      streaming: true,
      modelDiscovery: false,
      defaultModelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
      defaultModelFeatures: { structuredOutput: false, toolCalling: false },
    },
  } as unknown as AiProvider<never>;
}

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }, { id: 'no-tools' }],
        defaultModel: 'gpt-5.4-mini',
      },
    },
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    requestTimeoutMs: 60_000,
    reasoningEffort: 'none',
    maxDocumentBytes: 1_000_000,
    taskModels: {},
    graphEnabled: false,
    ...overrides,
  };
}

function setup(stored: SystemAiValue) {
  let current = stored;
  const systemSettings = {
    getAiPolicy: jest.fn(async () => current),
    patchSettings: jest.fn(async (dto: { ai: SystemAiPatchValue }) => {
      // A deliberately shallow stand-in for the real merge — enough for the
      // view to be re-read over what was saved.
      current = {
        ...current,
        ...dto.ai,
        providers: dto.ai.providers?.openai
          ? {
              openai: { ...current.providers.openai, ...dto.ai.providers.openai },
            }
          : current.providers,
      } as SystemAiValue;
    }),
  };
  const prisma = {
    systemSettings: {
      findUnique: jest.fn().mockResolvedValue({
        version: 3,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        updatedByUser: null,
      }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const provider = stubProvider();
  const registry = {
    get: jest.fn((id: string) => (id === 'openai' ? provider : undefined)),
    describeAll: jest.fn().mockReturnValue([]),
  } as unknown as AiProviderRegistry;

  const service = new AiSettingsService(
    prisma as never,
    systemSettings as never,
    registry,
  );
  return { service, systemSettings, prisma };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
}

function body(error: HttpException) {
  return error.getResponse() as {
    message: string;
    details?: Record<string, unknown>;
  };
}

describe('AiSettingsService.update — task-model validation (#360)', () => {
  it('saves a permitted, capable task model', async () => {
    const { service, systemSettings } = setup(policy());

    const view = await service.update(
      { taskModels: { 'graph.agent': { model: 'gpt-5.4', reasoningEffort: 'high' } } },
      'admin-1',
    );

    expect(systemSettings.patchSettings).toHaveBeenCalled();
    expect(view.settings.taskModels).toEqual({
      'graph.agent': { model: 'gpt-5.4', reasoningEffort: 'high' },
    });
  });

  it('a task model outside allowedModels → 400 model_not_permitted naming the task label', async () => {
    const { service, systemSettings } = setup(policy());

    const error = await rejection(
      service.update({ taskModels: { 'graph.extract': { model: 'gpt-x' } } }, 'admin-1'),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(body(error).message).toBe(
      'The task model for "Graph extraction" (gpt-x) is not in the permitted models list.',
    );
    expect(body(error).details).toEqual({
      reason: 'model_not_permitted',
      task: 'graph.extract',
      model: 'gpt-x',
    });
    expect(systemSettings.patchSettings).not.toHaveBeenCalled();
  });

  it('a model lacking toolCalling for graph.agent → 400 model_lacks_capability', async () => {
    const { service, systemSettings } = setup(policy());

    const error = await rejection(
      service.update({ taskModels: { 'graph.agent': { model: 'no-tools' } } }, 'admin-1'),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect(body(error).details).toEqual({
      reason: 'model_lacks_capability',
      task: 'graph.agent',
      model: 'no-tools',
      missing: ['toolCalling'],
    });
    expect(body(error).message).toMatch(/Ask \(graph agent\)/);
    expect(systemSettings.patchSettings).not.toHaveBeenCalled();
  });

  it('the same model is accepted for a structured task', async () => {
    const { service } = setup(policy());
    await expect(
      service.update({ taskModels: { 'graph.extract': { model: 'no-tools' } } }, 'admin-1'),
    ).resolves.toBeDefined();
  });

  it('checks against the allowedModels the SAME patch writes', async () => {
    const base = policy();
    const { service } = setup({
      ...base,
      providers: {
        openai: { ...base.providers.openai, allowedModels: [{ id: 'gpt-5.4' }] },
      },
    });

    // Not stored as permitted, but newly permitted in this request → accepted.
    await expect(
      service.update(
        {
          providers: {
            openai: { allowedModels: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] },
          },
          taskModels: { 'graph.extract': { model: 'gpt-5.4-mini' } },
        },
        'admin-1',
      ),
    ).resolves.toBeDefined();

    // Removed in this request → refused.
    const error = await rejection(
      setup(policy()).service.update(
        {
          providers: { openai: { allowedModels: [{ id: 'gpt-5.4' }] } },
          taskModels: { 'graph.extract': { model: 'gpt-5.4-mini' } },
        },
        'admin-1',
      ),
    );
    expect(body(error).details).toEqual(
      expect.objectContaining({ reason: 'model_not_permitted' }),
    );
  });

  it('an unplaceable permitted model has no capabilities → lacks_capability', async () => {
    const stored = policy();
    stored.providers.openai.allowedModels.push({ id: 'mystery-model' });
    const { service } = setup(stored);

    const error = await rejection(
      service.update({ taskModels: { 'graph.digest': { model: 'mystery-model' } } }, 'admin-1'),
    );
    expect(body(error).details).toEqual({
      reason: 'model_lacks_capability',
      task: 'graph.digest',
      model: 'mystery-model',
      missing: ['structuredOutput'],
    });
  });

  it('removing a model a stored task uses is accepted; the status falls back to the default', async () => {
    const { service } = setup(
      policy({ taskModels: { 'graph.extract': { model: 'gpt-5.4' } } }),
    );

    const view = await service.update(
      { providers: { openai: { allowedModels: [{ id: 'gpt-5.4-mini' }, { id: 'no-tools' }] } } },
      'admin-1',
    );

    const extract = view.taskModelStatus.find((s) => s.task === 'graph.extract');
    expect(extract).toEqual({
      task: 'graph.extract',
      configuredModel: 'gpt-5.4',
      effectiveModel: 'gpt-5.4-mini',
      source: 'default',
      missing: [],
      problem: null,
    });
  });

  it('a patch without taskModels skips the check entirely', async () => {
    const { service, systemSettings } = setup(
      // A stored task model that is no longer permitted must not block an
      // unrelated save.
      policy({ taskModels: { 'graph.extract': { model: 'retired' } } }),
    );

    await service.update({ graphEnabled: true }, 'admin-1');

    expect(systemSettings.patchSettings).toHaveBeenCalled();
  });
});

describe('AiSettingsService.describeForAdmin — task-model additions (#360)', () => {
  it('publishes the task definitions verbatim', async () => {
    const { service } = setup(policy());
    const view = await service.describeForAdmin();
    expect(view.tasks).toEqual(AI_TASK_DEFINITIONS);
  });

  it('reports the capability flags of each resolvable permitted model', async () => {
    const stored = policy();
    stored.providers.openai.allowedModels.push({ id: 'mystery-model' });
    const { service } = setup(stored);

    const view = await service.describeForAdmin();

    expect(view.modelCapabilities).toEqual([
      { id: 'gpt-5.4', structuredOutput: true, toolCalling: true, source: 'catalogue' },
      { id: 'gpt-5.4-mini', structuredOutput: true, toolCalling: true, source: 'catalogue' },
      { id: 'no-tools', structuredOutput: true, toolCalling: false, source: 'catalogue' },
      { id: 'mystery-model', structuredOutput: false, toolCalling: false, source: 'default' },
    ]);
  });

  it('computes taskModelStatus WITHOUT the graphEnabled gate', async () => {
    const { service } = setup(
      policy({
        graphEnabled: false,
        taskModels: { 'graph.adjudicate': { model: 'gpt-5.4' } },
      }),
    );

    const view = await service.describeForAdmin();

    expect(view.taskModelStatus.map((s) => s.task)).toEqual([
      'graph.extract',
      'graph.adjudicate',
      'graph.digest',
      'graph.agent',
    ]);
    expect(view.taskModelStatus.every((s) => s.problem === null)).toBe(true);
    expect(view.taskModelStatus[1]).toEqual({
      task: 'graph.adjudicate',
      configuredModel: 'gpt-5.4',
      effectiveModel: 'gpt-5.4',
      source: 'task',
      missing: [],
      problem: null,
    });
  });

  it('reports lacks_capability when the default cannot serve a task', async () => {
    const base = policy();
    const { service } = setup({
      ...base,
      providers: { openai: { ...base.providers.openai, defaultModel: 'no-tools' } },
    });

    const view = await service.describeForAdmin();
    const agent = view.taskModelStatus.find((s) => s.task === 'graph.agent');

    expect(agent).toEqual({
      task: 'graph.agent',
      configuredModel: null,
      effectiveModel: 'no-tools',
      source: 'default',
      missing: ['toolCalling'],
      problem: 'lacks_capability',
    });
  });

  it('reports no_model when nothing is permitted', async () => {
    const base = policy();
    const { service } = setup({
      ...base,
      providers: { openai: { ...base.providers.openai, allowedModels: [] } },
    });

    const view = await service.describeForAdmin();

    expect(view.modelCapabilities).toEqual([]);
    expect(view.taskModelStatus.every((s) => s.problem === 'no_model' && s.source === 'none')).toBe(
      true,
    );
  });
});
