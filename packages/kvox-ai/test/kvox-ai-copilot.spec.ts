import { AI_KEYLESS_API_KEY } from '@marinoscar/platform-ai-providers';
import { z } from 'zod';

import { createCopilotAdapter, createCopilotMockTransport } from '../src/copilot/index.js';
import { createDirectRuntime } from '../src/direct/index.js';
import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiModelState } from '../src/runtime/index.js';
import { KvoxAiError, type KvoxAiContext } from '@marinoscar/kvox-api/ports';
import { wrapRecordingAdapter } from '../src/testing/index.js';

// =============================================================================
// createKvoxAi over the Copilot adapter: the prompted structured path (#581)
// =============================================================================
//
// Smoke proof of the whole Desktop path: `createKvoxAi` over `createDirectRuntime`
// over the GitHub Copilot adapter over its mock transport. A `prompted` model gets
// the schema in its system prompt and ONE repair; a `native` one gets
// `responseSchema`; tool calling is off.
// =============================================================================

function state(model: string, row: Partial<KvoxAiModelState['models'][number]> = {}): KvoxAiModelState {
  return {
    provider: 'copilot',
    models: [{ id: model, label: model, structuredOutput: true, toolCalling: false, contextWindow: null, maxOutputTokens: null, ...row }],
    policy: {
      enabled: true,
      provider: 'copilot',
      defaultModel: model,
      graphEnabled: true,
      taskModels: { 'graph.agent': { model } },
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function build(model: string, stateOverride?: KvoxAiModelState) {
  const transport = createCopilotMockTransport();
  const copilot = createCopilotAdapter({ optIn: true, transport });
  const recording = wrapRecordingAdapter(copilot);
  const ai = createKvoxAi({
    runtime: createDirectRuntime({ adapters: { copilot: recording }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
    taskModels: { load: async () => stateOverride ?? state(model) },
    catalog: copilot.kvox.catalog,
  });
  return { ai, transport, recording };
}

const ctx: KvoxAiContext = { userId: 'u1', orgId: null, feature: 'notes.generate' };
const schema = z.object({ title: z.string() });

describe('createKvoxAi over the Copilot adapter', () => {
  it('runs a prompted model with the schema in the prompt and one repair', async () => {
    const { ai, transport, recording } = build('claude-sonnet-4.5');
    transport.queue({ kind: 'answer', text: 'Sure! Here it is: {"title": 3}', usage: { inputTokens: 10, outputTokens: 4 } });
    transport.queue({ kind: 'answer', text: '```json\n{"title":"Fixed"}\n```', usage: { inputTokens: 20, outputTokens: 5 } });

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const result = await ai.generateStructured(ctx, { target, system: 'Extract.', user: 'The text.', schema, schemaName: 'title' });

    expect(result).toEqual({ value: { title: 'Fixed' }, usage: { inputTokens: 30, outputTokens: 9 } });
    const sessions = transport.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].config.systemMessage.content).toMatch(/^Extract\.\n\nAnswer with a single JSON value only/);
    expect(sessions[0].prompts[0]).toMatchObject({ prompt: 'The text.' });
    expect(sessions[0].prompts[0].responseSchema).toBeUndefined();
    expect(sessions[1].prompts[0].prompt).toMatch(/^The text\.\n\n---\n\n/);
    expect(recording.requests().every((r) => !('structuredOutput' in (r.request as object)))).toBe(true);
  });

  it('sends responseSchema for a native model, and offers no tool calling', async () => {
    const { ai, transport } = build('gpt-5-mini');
    transport.queue({ kind: 'answer', text: '{"title":"Native"}' });

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const result = await ai.generateStructured(ctx, { target, system: 'Extract.', user: 'The text.', schema, schemaName: 'title' });

    expect(result.value).toEqual({ title: 'Native' });
    expect(transport.sessions()[0].prompts[0].responseSchema).toMatchObject({ type: 'object' });
    expect(transport.sessions()[0].config.systemMessage.content).toBe('Extract.');
    await expect(ai.capabilities(ctx)).resolves.toMatchObject({ available: true, toolCalling: false, structuredOutput: true });
  });
});

// -----------------------------------------------------------------------------
// The rest of the Desktop path: the catalog, the error classes, Ask, cleanup
// -----------------------------------------------------------------------------

const jobCtx: KvoxAiContext = { ...ctx, orgId: 'org-1', jobId: 'job-1' };

async function failureOf(run: () => Promise<unknown>): Promise<KvoxAiError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(KvoxAiError);
    return error as KvoxAiError;
  }
  throw new Error('expected a failure');
}

describe('createKvoxAi over the Copilot adapter: the model catalog decides', () => {
  /** A row that says nothing about the mode or tools: the adapter catalog must speak. */
  const bare = (model: string) => {
    const base = state(model);
    const { structuredOutputMode: _m, toolCalling: _t, ...rest } = base.models[0];
    return { ...base, models: [rest as unknown as KvoxAiModelState['models'][number]] };
  };

  it.each([
    ['claude-sonnet-4.5', true],
    ['claude-haiku-4.5', true],
    ['gemini-2.5-pro', true],
    ['gpt-5-mini', false],
    ['gpt-4.1', false],
    ['o3', false],
  ])('%s is prompted: %s (from the adapter catalog alone)', async (model, prompted) => {
    const { ai, transport } = build(model, bare(model));
    transport.queue({ kind: 'answer', text: '{"title":"T"}' });

    const target = await ai.resolveTask(ctx, 'notes.generate');
    const result = await ai.generateStructured(ctx, { target, system: 'S', user: 'U', schema, schemaName: 'title' });

    expect(result.value).toEqual({ title: 'T' });
    const sent = transport.sessions()[0].prompts[0].responseSchema;
    expect(sent === undefined).toBe(prompted);
    expect(transport.sessions()[0].config.systemMessage.content.includes('single JSON value only')).toBe(prompted);
  });

  it('reports no tool calling for any Copilot model whose row says nothing', async () => {
    const { ai } = build('gpt-5-mini', bare('gpt-5-mini'));
    await expect(ai.capabilities(ctx)).resolves.toMatchObject({ available: true, toolCalling: false });
  });

  it('does not offer Ask on a Copilot model, with the capability class and no session spent', async () => {
    const { ai, transport } = build('gpt-5-mini', bare('gpt-5-mini'));
    const error = await failureOf(() => ai.resolveTask({ ...ctx, feature: 'graph.agent' }, 'graph.agent'));
    expect(error.errorClass).toBe('capability');
    expect(transport.sessions()).toHaveLength(0);
  });

  it('refuses a chat that offers tools, before a session exists (the loop stays on OpenAI)', async () => {
    const { ai, transport } = build('gpt-5-mini');
    const target = await ai.resolveTask(ctx, 'notes.generate');
    const error = await failureOf(async () => {
      for await (const _event of ai.chat(ctx, {
        target,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{ name: 'lookup', description: 'Looks up.', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'auto',
      })) void _event;
    });
    expect(error.errorClass).toBe('capability');
    expect(transport.sessions()).toHaveLength(0);
  });
});

describe('createKvoxAi over the Copilot adapter: failures become port error classes', () => {
  const text = async (model = 'gpt-5-mini', context = ctx) => {
    const built = build(model);
    return { ...built, target: await built.ai.resolveTask(context, 'notes.generate') };
  };

  async function textFailure(arm: (t: ReturnType<typeof build>['transport']) => void, context = ctx): Promise<KvoxAiError> {
    const { ai, transport, target } = await text('gpt-5-mini', context);
    arm(transport);
    return failureOf(async () => {
      for await (const _event of ai.generateText(context, { target, system: 's', user: 'u' })) void _event;
    });
  }

  it('maps a rate limit to rate_limit with no retry hint (SDK 1.0.22 reports none)', async () => {
    const error = await textFailure((t) => t.queue({ kind: 'sessionError', errorType: 'rate_limit', statusCode: 429, message: 'slow down' }), jobCtx);
    expect(error.errorClass).toBe('rate_limit');
    expect(error.retryAfterMs).toBeUndefined();
  });

  it('maps a rejected login to key_missing on a route and auth in a job', async () => {
    const arm = (t: ReturnType<typeof build>['transport']) => t.queue({ kind: 'sessionError', errorType: 'authentication', statusCode: 401, message: 'no' });
    expect((await textFailure(arm)).errorClass).toBe('key_missing');
    expect((await textFailure(arm, jobCtx)).errorClass).toBe('auth');
  });

  it('maps a signed-out runtime to key_missing on a route and auth in a job', async () => {
    const arm = (t: ReturnType<typeof build>['transport']) => t.setSignedIn(false);
    expect((await textFailure(arm)).errorClass).toBe('key_missing');
    expect((await textFailure(arm, jobCtx)).errorClass).toBe('auth');
  });

  it('maps a content filter to refusal, as an error and as a finish reason', async () => {
    expect((await textFailure((t) => t.queue({ kind: 'sessionError', errorType: 'content_filter', message: 'declined' }))).errorClass).toBe('refusal');
    expect((await textFailure((t) => t.queue({ kind: 'answer', text: 'I cannot', finishReason: 'content_filter' }))).errorClass).toBe('refusal');
  });

  it('maps any other runtime failure to other, and a call failure the same way', async () => {
    expect((await textFailure((t) => t.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'boom' }))).errorClass).toBe('other');
    expect((await textFailure((t) => t.queue({ kind: 'callFailure', statusCode: 502, message: 'bad gateway', thenRetrySucceeds: true }))).errorClass).toBe('other');
  });

  it('maps a hung session to timeout through the port request timeout, deleting the session', async () => {
    const transport = createCopilotMockTransport();
    const copilot = createCopilotAdapter({ optIn: true, transport });
    const ai = createKvoxAi({
      runtime: createDirectRuntime({ adapters: { copilot }, keys: async () => ({ apiKey: AI_KEYLESS_API_KEY }) }),
      taskModels: { load: async () => state('gpt-5-mini') },
      requestTimeoutMs: 80,
    });
    transport.queue({ kind: 'hang' });
    const target = await ai.resolveTask(ctx, 'notes.generate');

    const error = await failureOf(async () => {
      for await (const _event of ai.generateText(ctx, { target, system: 's', user: 'u' })) void _event;
    });

    expect(error.errorClass).toBe('timeout');
    expect(transport.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('maps a native structured answer by what is wrong with it', async () => {
    const run = async (reply: Parameters<ReturnType<typeof build>['transport']['queue']>[0], maxOutputTokens?: number) => {
      const { ai, transport } = build('gpt-5-mini');
      transport.queue(reply);
      const target = await ai.resolveTask(ctx, 'notes.generate');
      return failureOf(() =>
        ai.generateStructured(ctx, { target, system: 's', user: 'u', schema, schemaName: 'title', ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }),
      );
    };
    expect((await run({ kind: 'answer', text: '{"title": 3}' })).errorClass).toBe('invalid_output');
    expect((await run({ kind: 'answer', text: 'prose' })).errorClass).toBe('invalid_output');
    expect((await run({ kind: 'answer', text: '{"title": "cut of', finishReason: 'length' })).errorClass).toBe('truncated');
    expect((await run({ kind: 'answer', text: 'prose' }, 200)).errorClass).toBe('truncated');
    expect((await run({ kind: 'answer', text: '', finishReason: 'content_filter' })).errorClass).toBe('refusal');
  });

  it('deletes the session of every call, success or failure', async () => {
    const { ai, transport } = build('gpt-5-mini');
    const target = await ai.resolveTask(ctx, 'notes.generate');
    transport.queue({ kind: 'answer', text: '{"title":"ok"}' });
    transport.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'x' });
    await ai.generateStructured(ctx, { target, system: 's', user: 'u', schema, schemaName: 'title' });
    await failureOf(() => ai.generateStructured(ctx, { target, system: 's', user: 'u', schema, schemaName: 'title' }));
    expect(transport.sessions().map((s) => s.deleted)).toEqual([true, true]);
  });

  it('offers no embeddings port: an embeddings call on the Copilot provider is refused', async () => {
    const { ai } = build('gpt-5-mini');
    // The embeddings model is OpenAI's; with only the Copilot adapter registered the runtime has none to call.
    const error = await failureOf(() => ai.embed(ctx, { inputs: ['x'] }));
    expect(['not_configured', 'capability']).toContain(error.errorClass);
  });
});
