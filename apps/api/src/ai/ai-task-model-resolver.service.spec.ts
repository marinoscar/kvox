import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';

import { NOTE_CONFLICT_REASONS } from '../notes/dto/note.dto';
import { NoteGenerationRequestService } from '../notes/generation/note-generation-request.service';
import type { SystemAiValue } from './ai-settings.schema';
import {
  AI_CONFLICT_REASONS,
  AI_MODEL_NOT_PERMITTED,
  AiTaskModelResolver,
} from './ai-task-model-resolver.service';
import type { AiConfigModel, AiConfigResponse } from './dto/ai-config.dto';
import type { AiProvider } from './providers/ai-provider.interface';

// =============================================================================
// AiTaskModelResolver (issue #360)
// =============================================================================
//
// `resolve` — the 409/400 order the issue specifies, over mocked collaborators.
// `resolveForGeneration` — reproduces `NoteGenerationRequestService
// .resolveModel`'s outcomes exactly: one table drives both, so the extraction
// is proven to have changed no note-generation response.
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

function config(overrides: Partial<AiConfigResponse> = {}): AiConfigResponse {
  return {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [model('gpt-5.4'), model('gpt-5.4-mini'), model('no-schema', { structuredOutput: false })],
    defaultModel: 'gpt-5.4-mini',
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    keyConfigured: true,
    graphEnabled: true,
    taskModels: {} as AiConfigResponse['taskModels'],
    ...overrides,
  };
}

const countTokens = jest.fn((text: string, _model: string) => text.length * 10);
const provider = {
  id: 'openai',
  label: 'OpenAI',
  countTokens,
} as unknown as AiProvider<never>;

function setup(opts: {
  policy?: SystemAiValue;
  config?: AiConfigResponse;
  registered?: boolean;
} = {}) {
  const aiConfig = { getConfig: jest.fn().mockResolvedValue(opts.config ?? config()) };
  const settings = { get: jest.fn().mockResolvedValue(opts.policy ?? policy()) };
  const registry = {
    get: jest.fn().mockReturnValue(opts.registered === false ? undefined : provider),
  };
  const resolver = new AiTaskModelResolver(
    aiConfig as never,
    settings as never,
    registry as never,
  );
  return { resolver, aiConfig, settings, registry };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
}

function body(error: HttpException): { message: string; details?: Record<string, unknown> } {
  const response = error.getResponse();
  return (typeof response === 'string' ? { message: response } : response) as never;
}

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

  it('shares ai_not_configured / ai_key_missing with NOTE_CONFLICT_REASONS, which the notes path relies on', () => {
    expect(AI_CONFLICT_REASONS.AI_NOT_CONFIGURED).toBe(NOTE_CONFLICT_REASONS.AI_NOT_CONFIGURED);
    expect(AI_CONFLICT_REASONS.AI_KEY_MISSING).toBe(NOTE_CONFLICT_REASONS.AI_KEY_MISSING);
  });
});

// -----------------------------------------------------------------------------
// resolveForGeneration ≡ NoteGenerationRequestService.resolveModel
// -----------------------------------------------------------------------------

const NOTE_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a note cannot be generated. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A note is generated on your own provider account, so it needs your key. Add one in your settings and try again.',
};

const PREVIEW_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a template cannot be previewed. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A preview is a real generation on your own provider account, so it needs your key. Add one in your settings and try again.',
};

type Outcome =
  | { ok: { model: string } }
  | { status: number; message: string; details?: Record<string, unknown> };

/** The shared table: the same inputs, and the outcome both paths must give. */
const GENERATION_CASES: Array<{
  name: string;
  config: AiConfigResponse;
  registered?: boolean;
  requested: string | null;
  intent: 'note' | 'preview';
  expected: Outcome;
}> = [
  {
    name: 'not available (note)',
    config: config({ available: false, models: [] }),
    requested: null,
    intent: 'note',
    expected: { status: 409, message: NOTE_MESSAGES.notConfigured, details: { reason: 'ai_not_configured' } },
  },
  {
    name: 'not available (preview)',
    config: config({ available: false, models: [] }),
    requested: null,
    intent: 'preview',
    expected: { status: 409, message: PREVIEW_MESSAGES.notConfigured, details: { reason: 'ai_not_configured' } },
  },
  {
    name: 'not configured outranks a missing key',
    config: config({ available: false, keyConfigured: false }),
    requested: null,
    intent: 'note',
    expected: { status: 409, message: NOTE_MESSAGES.notConfigured, details: { reason: 'ai_not_configured' } },
  },
  {
    name: 'no key (note)',
    config: config({ keyConfigured: false }),
    requested: null,
    intent: 'note',
    expected: { status: 409, message: NOTE_MESSAGES.keyMissing, details: { reason: 'ai_key_missing' } },
  },
  {
    name: 'no key (preview)',
    config: config({ keyConfigured: false }),
    requested: null,
    intent: 'preview',
    expected: { status: 409, message: PREVIEW_MESSAGES.keyMissing, details: { reason: 'ai_key_missing' } },
  },
  {
    name: 'a missing key outranks an unpermitted model',
    config: config({ keyConfigured: false }),
    requested: 'gpt-x',
    intent: 'note',
    expected: { status: 409, message: NOTE_MESSAGES.keyMissing, details: { reason: 'ai_key_missing' } },
  },
  {
    name: 'requested not permitted → plain 400 naming the list',
    config: config(),
    requested: 'gpt-x',
    intent: 'note',
    expected: {
      status: 400,
      message: 'The model "gpt-x" is not one this deployment permits. Choose one of: gpt-5.4, gpt-5.4-mini, no-schema.',
    },
  },
  {
    name: 'no requested and no default → 400 naming "none"',
    config: config({ defaultModel: null }),
    requested: null,
    intent: 'note',
    expected: {
      status: 400,
      message: 'The model "none" is not one this deployment permits. Choose one of: gpt-5.4, gpt-5.4-mini, no-schema.',
    },
  },
  {
    name: 'unregistered provider → 409 ai_not_configured',
    config: config(),
    registered: false,
    requested: null,
    intent: 'note',
    expected: {
      status: 409,
      message: 'This version of the application does not have the "openai" provider.',
      details: { reason: 'ai_not_configured' },
    },
  },
  {
    name: 'no request → the default model',
    config: config(),
    requested: null,
    intent: 'note',
    expected: { ok: { model: 'gpt-5.4-mini' } },
  },
  {
    name: 'a permitted request → that model, capabilities not checked',
    config: config(),
    requested: 'no-schema',
    intent: 'preview',
    expected: { ok: { model: 'no-schema' } },
  },
  {
    name: 'graph switched off does not affect notes',
    config: config(),
    requested: null,
    intent: 'note',
    expected: { ok: { model: 'gpt-5.4-mini' } },
  },
];

async function outcomeOf(promise: Promise<{ model: string }>): Promise<Outcome> {
  try {
    const r = await promise;
    return { ok: { model: r.model } };
  } catch (error) {
    const e = error as HttpException;
    const b = body(e);
    return {
      status: e.getStatus(),
      message: b.message,
      ...(b.details ? { details: b.details } : {}),
    };
  }
}

describe.each(GENERATION_CASES)('resolveForGeneration ≡ resolveModel: $name', (c) => {
  const aiPolicy = policy({ graphEnabled: false });

  it('AiTaskModelResolver.resolveForGeneration', async () => {
    const { resolver } = setup({ config: c.config, registered: c.registered, policy: aiPolicy });
    const messages = c.intent === 'preview' ? PREVIEW_MESSAGES : NOTE_MESSAGES;

    const outcome = await outcomeOf(resolver.resolveForGeneration('u1', c.requested, messages));

    expect(outcome).toEqual(c.expected);
  });

  it('NoteGenerationRequestService.resolveModel', async () => {
    const { resolver } = setup({ config: c.config, registered: c.registered, policy: aiPolicy });
    const notes = new NoteGenerationRequestService(
      {} as never, // PrismaService
      resolver,
      {} as never, // TranscriptAccessService
      {} as never, // NoteAccessService
    );

    const outcome = await outcomeOf(notes.resolveModel('u1', c.requested, c.intent));

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

  it('resolveModel returns exactly { provider, model, policy }', async () => {
    const p = policy();
    const { resolver } = setup({ policy: p });
    const notes = new NoteGenerationRequestService(
      {} as never,
      resolver,
      {} as never,
      {} as never,
    );

    expect(await notes.resolveModel('u1', null)).toEqual({
      provider,
      model: 'gpt-5.4-mini',
      policy: p,
    });
  });
});
