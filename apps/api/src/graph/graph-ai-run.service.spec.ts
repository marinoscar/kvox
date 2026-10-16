import { BadRequestException, ConflictException } from '@nestjs/common';

import { FakeKvoxAi, notReadyReadiness } from '../ai-port/testing/fake-kvox-ai';
import { GraphAiRunResolver } from './graph-ai-run.service';

const USER = '11111111-1111-4111-8111-111111111111';

function build(over: { policy?: Record<string, unknown>; models?: string[]; missing?: string[] } = {}) {
  const ai = new FakeKvoxAi();
  const settings = {
    getNamespace: jest.fn(async () => ({
      graphEnabled: true,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      reasoningEffort: 'low',
      ...over.policy,
    })),
  };
  const targets = {
    loadState: jest.fn(async () => ({ models: (over.models ?? ['gpt-a', 'gpt-b']).map((id) => ({ id })) })),
    explain: jest.fn(async () => ({ model: 'gpt-a', missing: over.missing ?? ['structured output'] })),
  };
  const resolver = new GraphAiRunResolver(ai, settings as never, targets as never);
  return { resolver, ai, settings, targets };
}

async function rejection(promise: Promise<unknown>): Promise<ConflictException | BadRequestException> {
  try {
    await promise;
  } catch (error) {
    return error as ConflictException;
  }
  throw new Error('expected a rejection');
}

const bodyOf = (e: ConflictException | BadRequestException) =>
  e.getResponse() as { message: string; details: Record<string, unknown> };

describe('GraphAiRunResolver.resolve (#475)', () => {
  it('asks readiness for the task feature with the requested model and shapes the run', async () => {
    const { resolver, ai } = build();
    ai.setReadiness({ model: 'gpt-4o', contextWindowTokens: 200_000, maxOutputTokens: 32_000, reasoningEffort: 'medium' });

    const run = await resolver.resolve(USER, 'graph.extract', 'gpt-4o');

    expect(ai.lastCall('readiness')).toEqual(
      expect.objectContaining({ userId: USER, feature: 'graph_extract', request: { userId: USER, feature: 'graph_extract', requested: 'gpt-4o' } }),
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
    expect(run.countTokens('abcdefgh')).toBe(2);
  });

  it.each([
    ['graph.extract', 'graph_extract'],
    ['graph.adjudicate', 'graph_adjudicate'],
    ['graph.digest', 'graph_digest'],
  ] as const)('%s maps to the %s feature', async (task, feature) => {
    const { resolver, ai } = build();
    await resolver.resolve(USER, task);
    expect(ai.lastCall('readiness')?.feature).toBe(feature);
  });

  it('falls back to the conservative floor when the catalogue row has no numbers', async () => {
    const { resolver, ai } = build();
    ai.setReadiness({ contextWindowTokens: null, maxOutputTokens: null });
    const run = await resolver.resolve(USER, 'graph.extract');
    expect(run.modelLimits).toEqual({ contextWindowTokens: 128_000, maxOutputTokens: 16_384 });
  });

  it.each([
    ['graph_disabled', 409],
    ['ai_not_configured', 409],
    ['ai_key_missing', 409],
  ] as const)('refuses %s with the 409 and details.reason the product has always answered', async (reason, status) => {
    const { resolver, ai } = build();
    ai.setNotReady(reason);
    const error = await rejection(resolver.resolve(USER, 'graph.extract'));
    expect(error.getStatus()).toBe(status);
    expect(bodyOf(error).details.reason).toBe(reason);
  });

  it('refuses a model the deployment does not permit with a 400 that lists the permitted ones', async () => {
    const { resolver, ai } = build({ models: ['gpt-a', 'gpt-b'] });
    ai.setNotReady('model_not_permitted');
    const error = await rejection(resolver.resolve(USER, 'graph.extract', 'gpt-nope'));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(bodyOf(error).details).toEqual(expect.objectContaining({ reason: 'model_not_permitted', task: 'graph.extract', model: 'gpt-nope' }));
    expect(bodyOf(error).message).toContain('gpt-a, gpt-b');
  });

  it('refuses a model that lacks a required capability, naming what is missing', async () => {
    const { resolver, ai } = build({ missing: ['structured output'] });
    ai.setNotReady('model_lacks_capability');
    const error = await rejection(resolver.resolve(USER, 'graph.adjudicate'));
    expect(bodyOf(error).details).toEqual(
      expect.objectContaining({ reason: 'model_lacks_capability', task: 'graph.adjudicate', model: 'gpt-a', missing: ['structured output'] }),
    );
  });

  describe('requireKey: false (an estimate)', () => {
    it('proceeds without a key when a model was chosen, reporting keyConfigured: false', async () => {
      const { resolver, ai } = build();
      ai.setReadiness(notReadyReadiness('ai_key_missing'));
      const run = await resolver.resolve(USER, 'graph.extract', 'gpt-4o', { requireKey: false });
      expect(run.keyConfigured).toBe(false);
      expect(run.model).toBe('gpt-4o');
    });

    it('still refuses every other problem', async () => {
      const { resolver, ai } = build();
      ai.setNotReady('ai_not_configured');
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
