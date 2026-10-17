import { ConflictException } from '@nestjs/common';

import { createFakeKvoxAi } from '../testing/index.js';
import { GraphAiRunResolver } from './graph-ai-run.service.js';

const USER = '11111111-1111-4111-8111-111111111111';

function build(over: { policy?: Record<string, unknown> } = {}) {
  const ai = createFakeKvoxAi();
  const settings = {
    readSystem: jest.fn(async () => ({
      value: {
        graphEnabled: true,
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        reasoningEffort: 'low',
        ...over.policy,
      },
      version: 1,
    })),
  };
  const resolver = new GraphAiRunResolver(ai, settings as never);
  return { resolver, ai, settings };
}

async function rejection(promise: Promise<unknown>): Promise<ConflictException> {
  try {
    await promise;
  } catch (error) {
    return error as ConflictException;
  }
  throw new Error('expected a rejection');
}

const bodyOf = (e: ConflictException) => e.getResponse() as { message: string; details: Record<string, unknown> };

describe('GraphAiRunResolver.resolve (#475, over the ports by #496)', () => {
  it('resolves the task with the requested model and shapes the run', async () => {
    const { resolver, ai } = build();
    ai.script.target = { provider: 'openai', contextWindowTokens: 200_000, maxOutputTokens: 32_000, reasoningEffort: 'medium' };

    const run = await resolver.resolve(USER, 'graph.extract', 'gpt-4o');

    expect(ai.calls.find((c) => c.method === 'resolveTask')).toEqual(
      expect.objectContaining({
        ctx: { userId: USER, orgId: null, feature: 'graph.extract' },
        req: { task: 'graph.extract', model: 'gpt-4o', requireKey: true },
      }),
    );
    expect(run).toEqual(
      expect.objectContaining({
        providerId: 'openai',
        model: 'gpt-4o',
        reasoningEffort: 'medium',
        modelLimits: { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
        policy: { maxInputTokens: 100_000, maxOutputTokens: 8_000, reasoningEffort: 'low' },
        keyConfigured: true,
        source: 'requested',
      }),
    );
    expect(run.target.model).toBe('gpt-4o');
    expect(run.countTokens('abcdefgh')).toBe(2);
  });

  it.each(['graph.extract', 'graph.adjudicate', 'graph.digest'] as const)('%s is resolved as its own task and feature', async (task) => {
    const { resolver, ai } = build();
    await resolver.resolve(USER, task);
    const call = ai.calls.find((c) => c.method === 'resolveTask');
    expect(call?.ctx?.feature).toBe(task);
    expect((call?.req as { task: string }).task).toBe(task);
  });

  it('falls back to the conservative floor when the model has no numbers', async () => {
    const { resolver, ai } = build();
    ai.script.target = { contextWindowTokens: 0, maxOutputTokens: 0 };
    const run = await resolver.resolve(USER, 'graph.extract');
    expect(run.modelLimits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 16_384 });
  });

  it('refuses graph_disabled before the port is asked', async () => {
    const { resolver, ai } = build({ policy: { graphEnabled: false } });
    const error = await rejection(resolver.resolve(USER, 'graph.extract'));
    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error).details.reason).toBe('graph_disabled');
    expect(ai.calls).toHaveLength(0);
  });

  it.each([
    ['not_configured', 'ai_not_configured'],
    ['key_missing', 'ai_key_missing'],
  ] as const)('refuses a %s port failure with the 409 and details.reason the product has always answered', async (errorClass, reason) => {
    const { resolver, ai } = build();
    ai.script.failWith = errorClass;
    const error = await rejection(resolver.resolve(USER, 'graph.extract'));
    expect(error.getStatus()).toBe(409);
    expect(bodyOf(error).details.reason).toBe(reason);
  });

  it('refuses a model that lacks a required capability, naming the task, the model and what is missing', async () => {
    const { resolver, ai } = build();
    ai.script.failWith = 'capability';
    const error = await rejection(resolver.resolve(USER, 'graph.adjudicate', 'gpt-a'));
    expect(bodyOf(error).details).toEqual(
      expect.objectContaining({ reason: 'model_lacks_capability', task: 'graph.adjudicate', model: 'gpt-a', missing: ['structuredOutput'] }),
    );
  });

  describe('requireKey: false (an estimate)', () => {
    it('asks the port not to require the key and reports keyConfigured: false when there is none', async () => {
      const { resolver, ai } = build();
      ai.script.capabilities = { available: false, reason: 'ai_key_missing' };
      const run = await resolver.resolve(USER, 'graph.extract', 'gpt-4o', { requireKey: false });
      expect(run.keyConfigured).toBe(false);
      expect(run.model).toBe('gpt-4o');
      expect((ai.calls.find((c) => c.method === 'resolveTask')?.req as { requireKey: boolean }).requireKey).toBe(false);
    });

    it('still refuses every other problem', async () => {
      const { resolver, ai } = build();
      ai.script.failWith = 'not_configured';
      const error = await rejection(resolver.resolve(USER, 'graph.extract', null, { requireKey: false }));
      expect(bodyOf(error).details.reason).toBe('ai_not_configured');
    });
  });
});

describe('GraphAiRunResolver.graphEnabled (#475)', () => {
  it('reads ai.graphEnabled from the extended namespace', async () => {
    expect(await build().resolver.graphEnabled()).toBe(true);
    expect(await build({ policy: { graphEnabled: false } }).resolver.graphEnabled()).toBe(false);
  });
});
