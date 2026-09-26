import { AI_TASK_KEYS, type SystemAiValue } from './ai-settings.schema';
import {
  AI_TASK_DEFINITIONS,
  chooseTaskModel,
  missingCapabilities,
  taskDefinition,
} from './ai-task-models';
import type { AiConfigModel } from './dto/ai-config.dto';

// =============================================================================
// chooseTaskModel (issue #360) — every branch, as a table
// =============================================================================

function model(
  id: string,
  flags: { structuredOutput?: boolean; toolCalling?: boolean } = {},
): AiConfigModel {
  return {
    id,
    label: id,
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    structuredOutput: flags.structuredOutput ?? true,
    toolCalling: flags.toolCalling ?? true,
    source: 'catalogue',
    derivedFrom: null,
  };
}

const BOTH = model('gpt-5.4');
const MINI = model('gpt-5.4-mini');
const NO_TOOLS = model('no-tools', { toolCalling: false });
const NO_SCHEMA = model('no-schema', { structuredOutput: false });

function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
  return {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [],
        defaultModel: 'gpt-5.4-mini',
      },
    },
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    requestTimeoutMs: 60_000,
    reasoningEffort: 'low',
    maxDocumentBytes: 1_000_000,
    taskModels: {},
    graphEnabled: true,
    ...overrides,
  };
}

function withDefault(defaultModel: string, overrides: Partial<SystemAiValue> = {}) {
  const base = policy(overrides);
  return {
    ...base,
    providers: {
      openai: { ...base.providers.openai, defaultModel },
    },
  };
}

describe('AI_TASK_DEFINITIONS', () => {
  it('defines every task key exactly once, in key order', () => {
    expect(AI_TASK_DEFINITIONS.map((d) => d.key)).toEqual([...AI_TASK_KEYS]);
  });

  it('requires structuredOutput for the three structured tasks and toolCalling for the agent', () => {
    expect(taskDefinition('graph.extract').requires).toEqual(['structuredOutput']);
    expect(taskDefinition('graph.adjudicate').requires).toEqual(['structuredOutput']);
    expect(taskDefinition('graph.digest').requires).toEqual(['structuredOutput']);
    expect(taskDefinition('graph.agent').requires).toEqual(['toolCalling']);
  });

  it('has no graph.brief task', () => {
    expect(AI_TASK_DEFINITIONS.some((d) => (d.key as string) === 'graph.brief')).toBe(false);
  });
});

describe('missingCapabilities', () => {
  it('lists only the required flags the model lacks', () => {
    expect(missingCapabilities(NO_TOOLS, ['structuredOutput', 'toolCalling'])).toEqual([
      'toolCalling',
    ]);
    expect(missingCapabilities(BOTH, ['structuredOutput', 'toolCalling'])).toEqual([]);
  });
});

describe('chooseTaskModel', () => {
  const models = [BOTH, MINI, NO_TOOLS, NO_SCHEMA];

  it.each([
    {
      name: 'task unset → defaultModel with the deployment effort',
      input: { policy: policy(), task: 'graph.extract' as const },
      expected: { model: 'gpt-5.4-mini', source: 'default', reasoningEffort: 'low', problem: null, missing: [] },
    },
    {
      name: 'task model set → that model with its own effort',
      input: {
        policy: policy({ taskModels: { 'graph.extract': { model: 'gpt-5.4', reasoningEffort: 'high' } } }),
        task: 'graph.extract' as const,
      },
      expected: { model: 'gpt-5.4', source: 'task', reasoningEffort: 'high', problem: null, missing: [] },
    },
    {
      name: 'task model set without an effort → the deployment effort',
      input: {
        policy: policy({ taskModels: { 'graph.extract': { model: 'gpt-5.4' } } }),
        task: 'graph.extract' as const,
      },
      expected: { model: 'gpt-5.4', source: 'task', reasoningEffort: 'low', problem: null },
    },
    {
      name: 'task model no longer permitted → falls back to the default (stale)',
      input: {
        policy: policy({ taskModels: { 'graph.extract': { model: 'retired', reasoningEffort: 'high' } } }),
        task: 'graph.extract' as const,
      },
      expected: { model: 'gpt-5.4-mini', source: 'default', reasoningEffort: 'low', problem: null, staleTaskModel: true },
    },
    {
      name: 'default not permitted either → no_model',
      input: { policy: withDefault('retired'), task: 'graph.extract' as const },
      expected: { model: null, source: 'none', problem: 'no_model', missing: [], staleTaskModel: false },
    },
    {
      name: 'requested and permitted → the requested model',
      input: { policy: policy(), task: 'graph.extract' as const, requested: 'gpt-5.4' },
      expected: { model: 'gpt-5.4', source: 'requested', reasoningEffort: 'low', problem: null },
    },
    {
      name: 'requested equals the task model → the task effort applies',
      input: {
        policy: policy({ taskModels: { 'graph.agent': { model: 'gpt-5.4', reasoningEffort: 'medium' } } }),
        task: 'graph.agent' as const,
        requested: 'gpt-5.4',
      },
      expected: { model: 'gpt-5.4', source: 'requested', reasoningEffort: 'medium', problem: null },
    },
    {
      name: 'requested differs from the task model → the deployment effort',
      input: {
        policy: policy({ taskModels: { 'graph.agent': { model: 'gpt-5.4', reasoningEffort: 'medium' } } }),
        task: 'graph.agent' as const,
        requested: 'gpt-5.4-mini',
      },
      expected: { model: 'gpt-5.4-mini', source: 'requested', reasoningEffort: 'low', problem: null },
    },
    {
      name: 'requested but not permitted → not_permitted',
      input: { policy: policy(), task: 'graph.extract' as const, requested: 'gpt-x' },
      expected: { model: 'gpt-x', source: 'requested', problem: 'not_permitted', missing: [] },
    },
    {
      name: 'agent on a model without toolCalling → lacks_capability',
      input: { policy: withDefault('no-tools'), task: 'graph.agent' as const },
      expected: { model: 'no-tools', source: 'default', problem: 'lacks_capability', missing: ['toolCalling'] },
    },
    {
      name: 'the same model is fine for a structured task',
      input: { policy: withDefault('no-tools'), task: 'graph.extract' as const },
      expected: { model: 'no-tools', problem: null, missing: [] },
    },
    ...(['graph.extract', 'graph.adjudicate', 'graph.digest'] as const).map((task) => ({
      name: `${task} on a model without structuredOutput → lacks_capability`,
      input: { policy: withDefault('no-schema'), task },
      expected: { model: 'no-schema', problem: 'lacks_capability', missing: ['structuredOutput'] },
    })),
    {
      name: 'graph disabled → graph_disabled, but the model is still computed',
      input: { policy: policy({ graphEnabled: false }), task: 'graph.extract' as const },
      expected: { model: 'gpt-5.4-mini', source: 'default', problem: 'graph_disabled' },
    },
    {
      name: 'graph disabled outranks lacks_capability, and missing is still reported',
      input: { policy: withDefault('no-tools', { graphEnabled: false }), task: 'graph.agent' as const },
      expected: { model: 'no-tools', problem: 'graph_disabled', missing: ['toolCalling'] },
    },
    {
      name: 'graph disabled outranks not_permitted',
      input: { policy: policy({ graphEnabled: false }), task: 'graph.extract' as const, requested: 'gpt-x' },
      expected: { model: 'gpt-x', problem: 'graph_disabled' },
    },
  ])('$name', ({ input, expected }) => {
    const choice = chooseTaskModel({ ...input, models });

    expect(choice).toEqual(expect.objectContaining({ task: input.task, ...expected }));
  });

  it('no provider chosen → no_model', () => {
    const choice = chooseTaskModel({
      policy: policy({ provider: null }),
      models,
      task: 'graph.extract',
    });
    expect(choice).toEqual(
      expect.objectContaining({ model: null, source: 'none', problem: 'no_model' }),
    );
  });

  it('an empty model list → no_model even with a task model configured', () => {
    const choice = chooseTaskModel({
      policy: policy({ taskModels: { 'graph.extract': { model: 'gpt-5.4' } } }),
      models: [],
      task: 'graph.extract',
    });
    expect(choice.problem).toBe('no_model');
    expect(choice.staleTaskModel).toBe(true);
  });
});
