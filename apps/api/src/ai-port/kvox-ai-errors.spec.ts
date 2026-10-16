import { HttpException } from '@nestjs/common';

import { AiError, type AiErrorCode } from '@marinoscar/platform-api/ai';

import {
  AiAuthError,
  AiInputError,
  AiRefusedError,
  AiStructuredOutputError,
  RateLimitError,
  isTerminalAiError,
} from './ai-errors';
import {
  KvoxAiBadRequest,
  KvoxAiConflict,
  graphDisabledConflict,
  keyMissingConflict,
  lacksCapabilityConflict,
  mapAiError,
  notConfiguredConflict,
  notPermittedBadRequest,
} from './kvox-ai-errors';

// =============================================================================
// mapAiError (issue #473): every row of the mapping table, on a route and in a job
// =============================================================================

function platformError(code: AiErrorCode, retryAfterMs?: number): AiError {
  return new AiError(code, `message for ${code}`, retryAfterMs !== undefined ? { retryAfterMs } : {});
}

function body(error: unknown): { message: string; details?: Record<string, unknown> } {
  return (error as HttpException).getResponse() as {
    message: string;
    details?: Record<string, unknown>;
  };
}

describe('mapAiError on a route', () => {
  const route = { feature: 'graph_extract', inJob: false } as const;

  it.each([['AI_DISABLED'], ['AI_PROVIDER_DISABLED']] as const)(
    '%s -> 409 ai_not_configured',
    (code) => {
      const mapped = mapAiError(platformError(code), route);

      expect(mapped).toBeInstanceOf(KvoxAiConflict);
      expect((mapped as HttpException).getStatus()).toBe(409);
      expect(body(mapped).details).toEqual({ reason: 'ai_not_configured' });
      expect(body(mapped).message).toBe(`message for ${code}`);
    },
  );

  it('AI_KEY_REQUIRED -> 409 ai_key_missing', () => {
    const mapped = mapAiError(platformError('AI_KEY_REQUIRED'), route);

    expect((mapped as HttpException).getStatus()).toBe(409);
    expect(body(mapped).details).toEqual({ reason: 'ai_key_missing' });
  });

  it('AI_KEY_INVALID -> 409 ai_key_missing', () => {
    const mapped = mapAiError(platformError('AI_KEY_INVALID'), route);

    expect((mapped as HttpException).getStatus()).toBe(409);
    expect(body(mapped).details).toEqual({ reason: 'ai_key_missing' });
  });

  it('AI_KEY_INVALID keeps ai_key_invalid for search', () => {
    const mapped = mapAiError(platformError('AI_KEY_INVALID'), {
      feature: 'search_embed',
      inJob: false,
    });

    expect((mapped as HttpException).getStatus()).toBe(409);
    expect(body(mapped).details).toEqual({ reason: 'ai_key_invalid' });
  });

  it.each([['AI_MODEL_NOT_ENABLED'], ['AI_MODEL_NOT_REACHABLE']] as const)(
    '%s -> 400 model_not_permitted',
    (code) => {
      const mapped = mapAiError(platformError(code), route);

      expect(mapped).toBeInstanceOf(KvoxAiBadRequest);
      expect((mapped as HttpException).getStatus()).toBe(400);
      expect(body(mapped).details).toEqual({ reason: 'model_not_permitted' });
    },
  );

  it('AI_CAPABILITY_UNSUPPORTED -> 409 model_lacks_capability', () => {
    const mapped = mapAiError(platformError('AI_CAPABILITY_UNSUPPORTED'), route);

    expect((mapped as HttpException).getStatus()).toBe(409);
    expect(body(mapped).details).toEqual({ reason: 'model_lacks_capability' });
  });

  it('AI_RATE_LIMITED -> 429, keeping retryAfterMs in the body', () => {
    const mapped = mapAiError(platformError('AI_RATE_LIMITED', 4_000), route);

    expect((mapped as HttpException).getStatus()).toBe(429);
    expect(body(mapped).details).toMatchObject({ reason: 'AI_RATE_LIMITED', retryAfterMs: 4_000 });
  });

  it('AI_CONTENT_FILTERED -> 422', () => {
    expect((mapAiError(platformError('AI_CONTENT_FILTERED'), route) as HttpException).getStatus()).toBe(
      422,
    );
  });

  it.each([['AI_INVALID_REQUEST'], ['AI_TOOL_DISABLED']] as const)('%s -> 400', (code) => {
    const mapped = mapAiError(platformError(code), route);

    expect((mapped as HttpException).getStatus()).toBe(400);
    // The platform's own code stays on the body, so nothing is lost by the re-statusing.
    expect(body(mapped)).toMatchObject({ code });
  });

  it('AI_STRUCTURED_OUTPUT_INVALID -> 502', () => {
    expect(
      (mapAiError(platformError('AI_STRUCTURED_OUTPUT_INVALID'), route) as HttpException).getStatus(),
    ).toBe(502);
  });

  it.each([['AI_PROVIDER_UNAVAILABLE'], ['AI_STORAGE_UNAVAILABLE'], ['AI_REALTIME_DISABLED']] as const)(
    '%s -> 503',
    (code) => {
      expect((mapAiError(platformError(code), route) as HttpException).getStatus()).toBe(503);
    },
  );

  it('returns an error that is not an AiError unchanged', () => {
    const other = new Error('boom');
    const http = new HttpException('x', 418);

    expect(mapAiError(other, route)).toBe(other);
    expect(mapAiError(http, route)).toBe(http);
  });

  it('wraps a thrown non-Error', () => {
    expect(mapAiError('oops', route)).toEqual(new Error('oops'));
  });
});

describe('mapAiError in a job', () => {
  const job = { feature: 'graph_extract', inJob: true } as const;

  it.each([
    ['AI_DISABLED'],
    ['AI_PROVIDER_DISABLED'],
    ['AI_MODEL_NOT_ENABLED'],
    ['AI_MODEL_NOT_REACHABLE'],
    ['AI_CAPABILITY_UNSUPPORTED'],
    ['AI_INVALID_REQUEST'],
    ['AI_TOOL_DISABLED'],
  ] as const)('%s -> AiInputError (terminal)', (code) => {
    const mapped = mapAiError(platformError(code), job);

    expect(mapped).toBeInstanceOf(AiInputError);
    expect(isTerminalAiError(mapped)).toBe(true);
  });

  it.each([['AI_KEY_REQUIRED'], ['AI_KEY_INVALID']] as const)('%s -> AiAuthError (terminal)', (code) => {
    const mapped = mapAiError(platformError(code), job);

    expect(mapped).toBeInstanceOf(AiAuthError);
    expect(isTerminalAiError(mapped)).toBe(true);
  });

  it('AI_RATE_LIMITED -> RateLimitError carrying retryAfterMs', () => {
    const mapped = mapAiError(platformError('AI_RATE_LIMITED', 7_500), job);

    expect(mapped).toBeInstanceOf(RateLimitError);
    expect((mapped as RateLimitError).retryAfterMs).toBe(7_500);
    expect(isTerminalAiError(mapped)).toBe(false);
  });

  it('AI_CONTENT_FILTERED -> AiRefusedError', () => {
    const mapped = mapAiError(platformError('AI_CONTENT_FILTERED'), job);

    expect(mapped).toBeInstanceOf(AiRefusedError);
    expect(isTerminalAiError(mapped)).toBe(true);
  });

  it("AI_STRUCTURED_OUTPUT_INVALID -> AiStructuredOutputError('invalid_json')", () => {
    const mapped = mapAiError(platformError('AI_STRUCTURED_OUTPUT_INVALID'), job);

    expect(mapped).toBeInstanceOf(AiStructuredOutputError);
    expect((mapped as AiStructuredOutputError).reason).toBe('invalid_json');
  });

  it.each([['AI_PROVIDER_UNAVAILABLE'], ['AI_STORAGE_UNAVAILABLE'], ['AI_REALTIME_DISABLED']] as const)(
    '%s -> a plain Error, which the queue retries',
    (code) => {
      const mapped = mapAiError(platformError(code), job);

      expect(mapped).toBeInstanceOf(Error);
      expect(mapped).not.toBeInstanceOf(HttpException);
      expect(isTerminalAiError(mapped)).toBe(false);
    },
  );

  it('returns an error that is not an AiError unchanged', () => {
    const other = new TypeError('boom');

    expect(mapAiError(other, job)).toBe(other);
  });
});

describe('the wire bodies (copied from AiTaskModelResolver)', () => {
  it('graph_disabled', () => {
    expect(body(graphDisabledConflict())).toEqual({
      message:
        'Connected knowledge is switched off for this deployment. An administrator can enable it in AI settings.',
      details: { reason: 'graph_disabled' },
    });
  });

  it('ai_not_configured names the work', () => {
    expect(body(notConfiguredConflict({ label: 'Graph extraction' }))).toEqual({
      message:
        'AI features are not configured for this deployment, so graph extraction cannot run. An administrator can enable them in AI settings.',
      details: { reason: 'ai_not_configured' },
    });
  });

  it('ai_key_missing names the work', () => {
    expect(body(keyMissingConflict({ label: 'Ask (graph agent)' }))).toEqual({
      message:
        'You have not saved an AI API key. Ask (graph agent) runs on your own provider account, so it needs your key. Add one in your settings and try again.',
      details: { reason: 'ai_key_missing' },
    });
  });

  it('model_lacks_capability carries task, model and missing', () => {
    const conflict = lacksCapabilityConflict({
      subject: { label: 'Ask (graph agent)' },
      task: 'graph.agent',
      model: 'no-tools',
      missing: ['toolCalling'],
    });

    expect(conflict.getStatus()).toBe(409);
    expect(body(conflict)).toEqual({
      message:
        'The model "no-tools" cannot be used for ask (graph agent): it lacks toolCalling. Choose a model that supports it, or ask an administrator to change the task model.',
      details: {
        reason: 'model_lacks_capability',
        task: 'graph.agent',
        model: 'no-tools',
        missing: ['toolCalling'],
      },
    });
  });

  it('model_not_permitted lists the permitted models', () => {
    const bad = notPermittedBadRequest({
      model: 'gpt-x',
      permitted: ['gpt-5.4', 'gpt-5.4-mini'],
      task: 'graph.extract',
    });

    expect(bad.getStatus()).toBe(400);
    expect(body(bad)).toEqual({
      message: 'The model "gpt-x" is not one this deployment permits. Choose one of: gpt-5.4, gpt-5.4-mini.',
      details: { reason: 'model_not_permitted', task: 'graph.extract', model: 'gpt-x' },
    });
  });

  it('model_not_permitted without a task carries only the reason', () => {
    expect(body(notPermittedBadRequest({ model: null, permitted: ['a'] })).details).toEqual({
      reason: 'model_not_permitted',
    });
  });
});
