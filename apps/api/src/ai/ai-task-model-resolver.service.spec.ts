import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  config,
  countTokens,
  GENERATION_CASES,
  NOTE_MESSAGES,
  outcomeOf,
  PREVIEW_MESSAGES,
  policy,
  provider,
  rejection,
  setup,
  body,
  model,
} from '../../test/helpers/ai-task-model.fixtures';
import { AI_CONFLICT_REASONS, AI_MODEL_NOT_PERMITTED } from './ai-task-model-resolver.service';

// =============================================================================
// AiTaskModelResolver (issue #360)
// =============================================================================
//
// `resolve` — the 409/400 order the issue specifies, over mocked collaborators.
// `resolveForGeneration` — must reproduce `NoteGenerationRequestService
// .resolveModel`'s outcomes exactly: one table (`GENERATION_CASES`, in
// `test/helpers/ai-task-model.fixtures.ts`) drives both halves, so the
// extraction is proven to have changed no note-generation response. THIS file
// holds the resolver half; the `resolveModel` half, and the check that the 409
// reason strings are shared with the notes DTO, live in
// `src/notes/generation/note-generation-request.task-model.spec.ts` — `src/ai/`
// is base code and may not import a domain folder (#459,
// test/architecture/base-domain-boundary).
// =============================================================================

describe('AiTaskModelResolver.resolve', () => {
  beforeEach(() => countTokens.mockClear());

  it('graph switched off → 409 graph_disabled, before anything else is read', async () => {
    const { resolver, aiConfig } = setup({ policy: policy({ graphEnabled: false }) });

    const error = await rejection(resolver.resolve('u1', 'graph.extract'));

    expect(error).toBeInstanceOf(ConflictException);
    expect(body(error).details).toEqual({ reason: 'graph_disabled' });
    expect(body(error).message).toMatch(/Connected knowledge is switched off/);
    expect(aiConfig.getConfig).not.toHaveBeenCalled();
  });

  it('graph_disabled outranks ai_key_missing', async () => {
    const { resolver } = setup({
      policy: policy({ graphEnabled: false }),
      config: config({ keyConfigured: false }),
    });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(body(error).details).toEqual({ reason: 'graph_disabled' });
  });

  it('AI not available → 409 ai_not_configured', async () => {
    const { resolver } = setup({ config: config({ available: false, models: [] }) });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('no provider → 409 ai_not_configured', async () => {
    const { resolver } = setup({ config: config({ provider: null }) });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('no key → 409 ai_key_missing', async () => {
    const { resolver } = setup({ config: config({ keyConfigured: false }) });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(error).toBeInstanceOf(ConflictException);
    expect(body(error).details).toEqual({ reason: 'ai_key_missing' });
  });

  it('{ requireKey: false } skips only the key check and reports keyConfigured (#363)', async () => {
    const { resolver } = setup({ config: config({ keyConfigured: false }) });
    const r = await resolver.resolve('u1', 'graph.extract', null, { requireKey: false });
    expect(r.keyConfigured).toBe(false);

    const disabled = setup({ policy: policy({ graphEnabled: false }), config: config({ keyConfigured: false }) });
    const error = await rejection(disabled.resolver.resolve('u1', 'graph.extract', null, { requireKey: false }));
    expect(body(error).details).toEqual({ reason: 'graph_disabled' });
  });

  it('a default resolution reports keyConfigured: true', async () => {
    const { resolver } = setup();
    expect((await resolver.resolve('u1', 'graph.extract')).keyConfigured).toBe(true);
  });

  it('task model set → that model with its reasoningEffort', async () => {
    const { resolver } = setup({
      policy: policy({
        taskModels: { 'graph.extract': { model: 'gpt-5.4', reasoningEffort: 'high' } },
      }),
    });

    const r = await resolver.resolve('u1', 'graph.extract');

    expect(r).toEqual(
      expect.objectContaining({
        providerId: 'openai',
        provider,
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        source: 'task',
      }),
    );
    expect(r.descriptor.id).toBe('gpt-5.4');
  });

  it('task model unset → defaultModel with policy.reasoningEffort', async () => {
    const { resolver } = setup();
    const r = await resolver.resolve('u1', 'graph.extract');
    expect(r).toEqual(
      expect.objectContaining({ model: 'gpt-5.4-mini', reasoningEffort: 'low', source: 'default' }),
    );
  });

  it('a stale task model falls back to the default and logs a warning', async () => {
    const { resolver } = setup({
      policy: policy({ taskModels: { 'graph.digest': { model: 'retired' } } }),
    });
    const warn = jest
      .spyOn((resolver as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    const r = await resolver.resolve('u1', 'graph.digest');

    expect(r.model).toBe('gpt-5.4-mini');
    expect(r.source).toBe('default');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'graph.digest', configuredModel: 'retired' }),
    );
  });

  it('requested and permitted → the requested model', async () => {
    const { resolver } = setup();
    const r = await resolver.resolve('u1', 'graph.extract', 'gpt-5.4');
    expect(r.model).toBe('gpt-5.4');
    expect(r.source).toBe('requested');
  });

  it('requested but not permitted → 400 model_not_permitted listing the permitted ids', async () => {
    const { resolver } = setup();

    const error = await rejection(resolver.resolve('u1', 'graph.extract', 'gpt-x'));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(body(error).details).toEqual({
      reason: AI_MODEL_NOT_PERMITTED,
      task: 'graph.extract',
      model: 'gpt-x',
    });
    expect(body(error).message).toBe(
      'The model "gpt-x" is not one this deployment permits. Choose one of: gpt-5.4, gpt-5.4-mini, no-schema.',
    );
  });

  it('no model at all → 409 ai_not_configured', async () => {
    const { resolver } = setup({ config: config({ models: [], defaultModel: null }) });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('provider not registered → 409 ai_not_configured', async () => {
    const { resolver } = setup({ registered: false });
    const error = await rejection(resolver.resolve('u1', 'graph.extract'));
    expect(body(error).details).toEqual({ reason: 'ai_not_configured' });
  });

  it('chosen model lacks structuredOutput → 409 model_lacks_capability', async () => {
    const { resolver } = setup({
      policy: policy({ taskModels: { 'graph.extract': { model: 'no-schema' } } }),
    });

    const error = await rejection(resolver.resolve('u1', 'graph.extract'));

    expect(error).toBeInstanceOf(ConflictException);
    expect(body(error).details).toEqual({
      reason: 'model_lacks_capability',
      task: 'graph.extract',
      model: 'no-schema',
      missing: ['structuredOutput'],
    });
  });

  it('countTokens delegates to provider.countTokens(text, model)', async () => {
    const { resolver } = setup();
    const r = await resolver.resolve('u1', 'graph.extract');

    expect(r.countTokens('abc')).toBe(30);
    expect(countTokens).toHaveBeenCalledWith('abc', 'gpt-5.4-mini');
  });
});

describe('AI_CONFLICT_REASONS', () => {
  it('owns the four 409 strings', () => {
    expect(AI_CONFLICT_REASONS).toEqual({
      GRAPH_DISABLED: 'graph_disabled',
      AI_NOT_CONFIGURED: 'ai_not_configured',
      AI_KEY_MISSING: 'ai_key_missing',
      MODEL_LACKS_CAPABILITY: 'model_lacks_capability',
    });
  });
});

describe.each(GENERATION_CASES)('resolveForGeneration: $name', (c) => {
  it('gives the outcome the shared table specifies', async () => {
    const { resolver } = setup({
      config: c.config,
      registered: c.registered,
      policy: policy({ graphEnabled: false }),
    });
    const messages = c.intent === 'preview' ? PREVIEW_MESSAGES : NOTE_MESSAGES;

    const outcome = await outcomeOf(resolver.resolveForGeneration('u1', c.requested, messages));

    expect(outcome).toEqual(c.expected);
  });
});

describe('resolveForGeneration — the resolution it returns', () => {
  it('carries the policy, its reasoning effort, and the source', async () => {
    const p = policy({ reasoningEffort: 'medium' });
    const { resolver } = setup({ policy: p });

    const defaulted = await resolver.resolveForGeneration('u1', null, NOTE_MESSAGES);
    expect(defaulted).toEqual(
      expect.objectContaining({ model: 'gpt-5.4-mini', reasoningEffort: 'medium', source: 'default', policy: p }),
    );

    const requested = await resolver.resolveForGeneration('u1', 'gpt-5.4', NOTE_MESSAGES);
    expect(requested.source).toBe('requested');
    expect(requested.descriptor.id).toBe('gpt-5.4');
  });
});
