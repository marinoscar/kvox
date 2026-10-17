import { HttpException, Logger } from '@nestjs/common';

import type { AiTargetContext, DefaultAiTargetResolver } from '@marinoscar/platform-api/ai';

import {
  AI_TASK_KEYS,
  KVOX_AI_FEATURES,
  KVOX_EMBEDDING,
  KVOX_FEATURE_TASK,
  chooseTaskModel,
  type AiTaskKey,
  type KvoxAiFeatureId,
  type TaskModelPolicy,
} from '@marinoscar/kvox-ai';
import {
  KVOX_AI_RESOLVER_CACHE_MS,
  KVOX_EMBEDDING_MODEL,
  KvoxAiTargetResolver,
} from './kvox-ai-target-resolver';
import { PlatformTaskModelSource } from './platform-task-model-source';

// =============================================================================
// KvoxAiTargetResolver (issue #473)
// =============================================================================

interface Row {
  modelId: string;
  displayName?: string | null;
  capabilities: unknown;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

function row(modelId: string, capabilities: string[]): Row {
  return { modelId, capabilities: { capabilities }, contextWindow: 128_000, maxOutputTokens: 16_384 };
}

// `gpt-5.4` can do everything; `no-tools` cannot call tools; `no-schema` cannot do structured output.
const ROWS: Row[] = [
  row('gpt-5.4', ['responses', 'structured_output', 'tools', 'streaming']),
  row('gpt-5.4-mini', ['responses', 'structured_output', 'tools', 'streaming']),
  row('no-tools', ['responses', 'structured_output', 'streaming']),
  row('no-schema', ['responses', 'tools', 'streaming']),
];

interface Ai {
  enabled: boolean;
  providers: Record<string, { enabled: boolean }>;
  defaultModel: string | null;
  graphEnabled: boolean;
  taskModels: Record<string, { model: string; reasoningEffort?: 'low' | 'medium' | 'high' }>;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

function ai(overrides: Partial<Ai> = {}): Ai {
  return {
    enabled: true,
    providers: { openai: { enabled: true } },
    defaultModel: 'gpt-5.4-mini',
    graphEnabled: true,
    taskModels: {},
    reasoningEffort: 'low',
    maxInputTokens: null,
    maxOutputTokens: null,
    ...overrides,
  };
}

function setup(initial: Ai = ai(), rows: Row[] = ROWS) {
  let current = initial;
  const prisma = { aiModel: { findMany: jest.fn(async () => rows) } };
  const settings = { getNamespace: jest.fn(async () => current) };
  const fallback = { resolve: jest.fn(async () => ({ provider: 'openai', model: 'platform-pick' })) };
  // The reads and their cache live in the task-model source (#579); the resolver delegates to it.
  const source = new PlatformTaskModelSource(prisma as never, settings as never);
  const resolver = new KvoxAiTargetResolver(source, fallback as unknown as DefaultAiTargetResolver);
  return {
    resolver,
    prisma,
    settings,
    fallback,
    set(next: Ai) {
      current = next;
      resolver.invalidateCache();
    },
  };
}

function context(feature: string | undefined, model?: string): AiTargetContext {
  return { userId: 'user-1', feature, requested: model ? { model } : {} };
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
  return error.getResponse() as { message: string; details?: Record<string, unknown> };
}

const POLICY_OF = (value: Ai): TaskModelPolicy => ({
  provider: 'openai',
  defaultModel: value.defaultModel,
  graphEnabled: value.graphEnabled,
  taskModels: value.taskModels,
  reasoningEffort: value.reasoningEffort,
});

const CANDIDATES = ROWS.map((r) => ({
  id: r.modelId,
  structuredOutput: (r.capabilities as { capabilities: string[] }).capabilities.includes('structured_output'),
  toolCalling: (r.capabilities as { capabilities: string[] }).capabilities.includes('tools'),
}));

const TASK_FEATURES = (Object.entries(KVOX_FEATURE_TASK) as Array<[KvoxAiFeatureId, AiTaskKey | null]>).filter(
  (entry): entry is [KvoxAiFeatureId, AiTaskKey] => entry[1] !== null,
);

describe('the feature map', () => {
  it('maps every kvox feature, and the four task features cover the four tasks', () => {
    expect(Object.keys(KVOX_FEATURE_TASK).sort()).toEqual([...KVOX_AI_FEATURES].sort());
    expect(TASK_FEATURES.map(([, task]) => task).sort()).toEqual([...AI_TASK_KEYS].sort());
  });
});

describe('KvoxAiTargetResolver: a task feature returns what chooseTaskModel chooses', () => {
  // One row per source: requested, task, default. (`none` is the next describe: it throws.)
  const cases: Array<{
    source: string;
    value: Ai;
    requested?: string;
  }> = [
    { source: 'requested', value: ai({ taskModels: {} }), requested: 'gpt-5.4' },
    { source: 'task', value: ai({ taskModels: { 'graph.extract': { model: 'gpt-5.4' }, 'graph.adjudicate': { model: 'gpt-5.4' }, 'graph.digest': { model: 'gpt-5.4' }, 'graph.agent': { model: 'gpt-5.4' } } }) },
    { source: 'default', value: ai({ taskModels: {} }) },
  ];

  it.each(
    TASK_FEATURES.flatMap(([feature, task]) => cases.map((c) => [feature, task, c.source, c] as const)),
  )('%s (%s) from %s', async (feature, task, source, c) => {
    const { resolver } = setup(c.value);

    const target = await resolver.resolve(context(feature, c.requested));
    const expected = chooseTaskModel({
      policy: POLICY_OF(c.value),
      models: CANDIDATES,
      task,
      requested: c.requested ?? null,
    });

    expect(expected.source).toBe(source);
    expect(expected.problem).toBeNull();
    expect(target).toEqual({ provider: 'openai', model: expected.model });
  });

  it('explain() answers exactly what resolve() would, without throwing', async () => {
    const value = ai({ taskModels: { 'graph.agent': { model: 'no-tools' } } });
    const { resolver } = setup(value);

    const choice = await resolver.explain('user-1', 'graph.agent');

    expect(choice).toEqual(
      chooseTaskModel({ policy: POLICY_OF(value), models: CANDIDATES, task: 'graph.agent' }),
    );
    expect(choice.problem).toBe('lacks_capability');
  });
});

describe('KvoxAiTargetResolver: a task feature that cannot run throws, never returns null', () => {
  it('graph disabled -> 409 graph_disabled for graph_extract', async () => {
    const { resolver } = setup(ai({ graphEnabled: false }));

    const error = await rejection(resolver.resolve(context('graph_extract')));

    expect(error.getStatus()).toBe(409);
    expect(body(error).details).toEqual({ reason: 'graph_disabled' });
  });

  it('graph disabled outranks AI not being configured', async () => {
    const { resolver } = setup(ai({ graphEnabled: false, enabled: false }));

    const error = await rejection(resolver.resolve(context('graph_agent')));

    expect(body(error).details).toEqual({ reason: 'graph_disabled' });
  });

  it('AI disabled -> 409 ai_not_configured', async () => {
    const { resolver, prisma } = setup(ai({ enabled: false }));

    const error = await rejection(resolver.resolve(context('graph_extract')));

    expect(error.getStatus()).toBe(409);
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
    expect(prisma.aiModel.findMany).not.toHaveBeenCalled();
  });

  it('the provider slot off -> 409 ai_not_configured', async () => {
    const { resolver } = setup(ai({ providers: { openai: { enabled: false } } }));

    const error = await rejection(resolver.resolve(context('graph_digest')));

    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('no model enabled -> 409 ai_not_configured, even for a requested model', async () => {
    const { resolver } = setup(ai(), []);

    const error = await rejection(resolver.resolve(context('graph_extract', 'gpt-5.4')));

    expect(error.getStatus()).toBe(409);
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('the default is not enabled -> 409 ai_not_configured', async () => {
    const { resolver } = setup(ai({ defaultModel: 'retired' }));

    const error = await rejection(resolver.resolve(context('graph_adjudicate')));

    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('a requested model that is not enabled -> 400 model_not_permitted with the task', async () => {
    const { resolver } = setup(ai());

    const error = await rejection(resolver.resolve(context('graph_extract', 'gpt-x')));

    expect(error.getStatus()).toBe(400);
    expect(body(error).details).toEqual({
      reason: 'model_not_permitted',
      task: 'graph.extract',
      model: 'gpt-x',
    });
    expect(body(error).message).toContain('Choose one of: gpt-5.4, gpt-5.4-mini, no-tools, no-schema.');
  });

  it('the agent on a model without tools -> 409 model_lacks_capability', async () => {
    const { resolver } = setup(ai({ defaultModel: 'no-tools' }));

    const error = await rejection(resolver.resolve(context('graph_agent')));

    expect(error.getStatus()).toBe(409);
    expect(body(error).details).toEqual({
      reason: 'model_lacks_capability',
      task: 'graph.agent',
      model: 'no-tools',
      missing: ['toolCalling'],
    });
  });

  it('extraction on a model without structured output -> 409 model_lacks_capability', async () => {
    const { resolver } = setup(ai({ taskModels: { 'graph.extract': { model: 'no-schema' } } }));

    const error = await rejection(resolver.resolve(context('graph_extract')));

    expect(body(error).details).toMatchObject({
      reason: 'model_lacks_capability',
      missing: ['structuredOutput'],
    });
  });
});

describe('KvoxAiTargetResolver: a feature with no task', () => {
  it.each(['note_generate', 'note_retitle', 'transcript_name_check'] as const)(
    '%s takes an enabled requested model',
    async (feature) => {
      const { resolver } = setup();

      expect(await resolver.resolve(context(feature, 'no-tools'))).toEqual({
        provider: 'openai',
        model: 'no-tools',
      });
    },
  );

  it('falls back to the default model', async () => {
    const { resolver } = setup(ai({ defaultModel: 'gpt-5.4' }));

    expect(await resolver.resolve(context('note_generate'))).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  it('is not gated by graphEnabled', async () => {
    const { resolver } = setup(ai({ graphEnabled: false }));

    expect(await resolver.resolve(context('note_generate'))).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
  });

  it('a requested model that is not enabled -> 400 model_not_permitted', async () => {
    const { resolver } = setup();

    const error = await rejection(resolver.resolve(context('note_generate', 'gpt-x')));

    expect(error.getStatus()).toBe(400);
    expect(body(error).details).toEqual({ reason: 'model_not_permitted' });
  });

  it('no default model -> 409 ai_not_configured', async () => {
    const { resolver } = setup(ai({ defaultModel: null }));

    const error = await rejection(resolver.resolve(context('note_retitle')));

    expect(error.getStatus()).toBe(409);
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('nothing enabled -> 409 ai_not_configured', async () => {
    const { resolver } = setup(ai({ enabled: false }));

    const error = await rejection(resolver.resolve(context('transcript_name_check')));

    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });
});

describe('KvoxAiTargetResolver: embeddings and unknown features', () => {
  it.each(['graph_embed', 'search_embed'] as const)(
    '%s returns the catalog embedding model',
    async (feature) => {
      const { resolver, prisma } = setup();

      expect(await resolver.resolve(context(feature))).toEqual({
        provider: 'openai',
        model: KVOX_EMBEDDING_MODEL,
      });
      expect(KVOX_EMBEDDING_MODEL).toBe('text-embedding-3-small');
      expect(prisma.aiModel.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it('delegates an unregistered feature to the platform order', async () => {
    const { resolver, fallback, settings } = setup();
    const ctx = context('playground_chat');

    expect(await resolver.resolve(ctx)).toEqual({ provider: 'openai', model: 'platform-pick' });
    expect(fallback.resolve).toHaveBeenCalledWith(ctx);
    expect(settings.getNamespace).not.toHaveBeenCalled();
  });

  it('delegates a call that named no feature', async () => {
    const { resolver, fallback } = setup();

    await resolver.resolve(context(undefined));

    expect(fallback.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('KvoxAiTargetResolver: caching and the stale warning', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the policy and the models once inside the cache window', async () => {
    const { resolver, prisma, settings } = setup();

    await resolver.resolve(context('graph_extract'));
    await resolver.resolve(context('graph_digest'));

    expect(settings.getNamespace).toHaveBeenCalledTimes(1);
    expect(prisma.aiModel.findMany).toHaveBeenCalledTimes(1);
  });

  it('reads again after the window, or after a write invalidates it', async () => {
    const { resolver, settings, set } = setup();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    await resolver.resolve(context('graph_extract'));
    now.mockReturnValue(1_000 + KVOX_AI_RESOLVER_CACHE_MS + 1);
    await resolver.resolve(context('graph_extract'));
    expect(settings.getNamespace).toHaveBeenCalledTimes(2);

    set(ai({ defaultModel: 'gpt-5.4' }));
    expect(await resolver.resolve(context('note_generate'))).toMatchObject({ model: 'gpt-5.4' });
    expect(settings.getNamespace).toHaveBeenCalledTimes(3);
  });

  it('warns once per process about a task model that is no longer enabled', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolver } = setup(ai({ taskModels: { 'graph.extract': { model: 'retired' } } }));

    // The default still answers: a stale task model is a fallback, not a failure.
    expect(await resolver.resolve(context('graph_extract'))).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    await resolver.resolve(context('graph_extract'));
    await resolver.resolve(context('graph_extract'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ task: 'graph.extract', configuredModel: 'retired' });
  });

  it('never warns when no task model is stale', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { resolver } = setup();

    await resolver.resolve(context('graph_extract'));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('capability mapping from the ai_models row', () => {
  it('reads structured_output and tools from the capabilities JSON, tolerating a malformed one', async () => {
    const { resolver } = setup(ai(), [
      { modelId: 'odd', capabilities: null },
      { modelId: 'odd2', capabilities: { capabilities: 'not-an-array' } },
      row('full', ['structured_output', 'tools']),
    ]);

    const state = await resolver.loadState();

    expect(state.models.map((m) => [m.id, m.structuredOutput, m.toolCalling])).toEqual([
      ['odd', false, false],
      ['odd2', false, false],
      ['full', true, true],
    ]);
  });
});

describe('the embeddings model', () => {
  it('is the package catalog\'s, so the platform target and the bound port agree (moved from platform-kvox-ai.spec.ts)', () => {
    expect(KVOX_EMBEDDING_MODEL).toBe(KVOX_EMBEDDING.model);
  });
});
