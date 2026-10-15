import type { HttpException } from '@nestjs/common';

import type { SystemAiValue } from '../../src/ai/ai-settings.schema';
import { AiTaskModelResolver } from '../../src/ai/ai-task-model-resolver.service';
import type { AiConfigModel, AiConfigResponse } from '../../src/ai/dto/ai-config.dto';
import type { AiProvider } from '../../src/ai/providers/ai-provider.interface';

// =============================================================================
// Shared fixtures for the two specs that pin `AiTaskModelResolver`'s note
// generation path (issue #360, split by #459)
// =============================================================================
//
// `resolveForGeneration` reproduces `NoteGenerationRequestService.resolveModel`'s
// outcomes exactly, and one table (`GENERATION_CASES`) drives both so the
// extraction is proven to have changed no note-generation response. The two
// halves of that proof live in different folders because `src/ai/` is base code
// and may not import a domain folder (test/architecture/base-domain-boundary):
//
//   - `src/ai/ai-task-model-resolver.service.spec.ts`          the resolver half
//   - `src/notes/generation/note-generation-request.task-model.spec.ts`
//                                                             the notes half
//
// They share this file, which imports nothing from `src/notes/`.
// =============================================================================

export function model(
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

export function policy(overrides: Partial<SystemAiValue> = {}): SystemAiValue {
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

export function config(overrides: Partial<AiConfigResponse> = {}): AiConfigResponse {
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

export const countTokens = jest.fn((text: string, _model: string) => text.length * 10);
export const provider = {
  id: 'openai',
  label: 'OpenAI',
  countTokens,
} as unknown as AiProvider<never>;

export function setup(opts: {
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

export async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
}

export function body(error: HttpException): { message: string; details?: Record<string, unknown> } {
  const response = error.getResponse();
  return (typeof response === 'string' ? { message: response } : response) as never;
}

export const NOTE_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a note cannot be generated. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A note is generated on your own provider account, so it needs your key. Add one in your settings and try again.',
};

export const PREVIEW_MESSAGES = {
  notConfigured:
    'AI features are not configured for this deployment, so a template cannot be previewed. An administrator can enable them in system settings.',
  keyMissing:
    'You have not saved an AI API key. A preview is a real generation on your own provider account, so it needs your key. Add one in your settings and try again.',
};

export type Outcome =
  | { ok: { model: string } }
  | { status: number; message: string; details?: Record<string, unknown> };

/** The shared table: the same inputs, and the outcome both paths must give. */
export const GENERATION_CASES: Array<{
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

export async function outcomeOf(promise: Promise<{ model: string }>): Promise<Outcome> {
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

