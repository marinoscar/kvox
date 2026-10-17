import { HttpException } from '@nestjs/common';

import {
  graphDisabledConflict,
  keyMissingConflict,
  lacksCapabilityConflict,
  notConfiguredConflict,
  notPermittedBadRequest,
} from './kvox-ai-errors';

// =============================================================================
// This product's AI 409 / 400 bodies (issue #473)
// =============================================================================
//
// The `mapAiError` rows that lived here left with the mapper (#579): what a platform
// `AiError` becomes is now `toKvoxAiError` of `@marinoscar/kvox-ai`, pinned row by row
// against the old route and job answers in `packages/kvox-ai/test/fixtures/error-parity.v1.json`.
// =============================================================================

function body(error: unknown): { message: string; details?: Record<string, unknown> } {
  return (error as HttpException).getResponse() as {
    message: string;
    details?: Record<string, unknown>;
  };
}

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
