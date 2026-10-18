import { z } from 'zod';

import { AiError } from '@marinoscar/platform-ai-providers';
import { KvoxAiError, type KvoxAiContext, type KvoxAiTarget } from '@marinoscar/kvox-api/ports';

import {
  buildPromptedStructuredInstructions,
  createKvoxAi,
  createKvoxAiReadiness,
  promptedJsonSchemaOf,
  type KvoxAiModelState,
  type KvoxModelCatalog,
} from '../src/index.js';
import { createScriptedRuntime } from '../src/testing/index.js';

// =============================================================================
// The prompted structured-output path and per-model tool calling (#581)
// =============================================================================
//
// ADAPTER-INDEPENDENT: `createKvoxAi` over a scripted runtime, so what is proved here
// is kvox-ai's own rule for a model whose `structuredOutputMode` is `prompted` (the
// schema goes in the system prompt, the answer is parsed and validated twice, ONE repair
// call is made) and for a model whose `toolCalling` flag is false, whatever adapter sits
// under the runtime. The native request is pinned byte for byte.
// =============================================================================

type Row = KvoxAiModelState['models'][number];

const verdict = z.object({ verdict: z.enum(['yes', 'no']) });
const ctx: KvoxAiContext = { userId: 'u1', orgId: null, feature: 'notes.generate' };

function row(id: string, extra: Partial<Row> = {}): Row {
  return { id, label: id, structuredOutput: true, toolCalling: true, contextWindow: 100_000, maxOutputTokens: 8_000, ...extra };
}

function stateOf(models: Row[], extra: { provider?: string; defaultModel?: string; taskModels?: KvoxAiModelState['policy']['taskModels'] } = {}): KvoxAiModelState {
  const provider = extra.provider ?? 'copilot';
  return {
    provider,
    models,
    policy: {
      enabled: true,
      provider,
      defaultModel: extra.defaultModel ?? models[0].id,
      graphEnabled: true,
      taskModels: extra.taskModels ?? {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function build(state: KvoxAiModelState, options: { catalog?: KvoxModelCatalog } = {}) {
  const runtime = createScriptedRuntime();
  const ai = createKvoxAi({ runtime, taskModels: { load: async () => state }, ...(options.catalog ? { catalog: options.catalog } : {}) });
  return { ai, runtime };
}

const targetOf = (model: string, provider = 'copilot'): KvoxAiTarget => ({
  provider,
  model,
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  source: 'default',
});

const structured = (ai: ReturnType<typeof build>['ai'], model: string, extra: Record<string, unknown> = {}, provider = 'copilot') =>
  ai.generateStructured(ctx, {
    target: targetOf(model, provider),
    system: 'SYSTEM',
    user: 'USER',
    schema: verdict,
    schemaName: 'verdict_schema',
    ...extra,
  } as never);

const answer = (outputText: string, extra: Record<string, unknown> = {}) => ({
  response: { outputText, usage: { inputTokens: 10, outputTokens: 5 }, ...extra },
});

const requests = (runtime: ReturnType<typeof createScriptedRuntime>) =>
  runtime.calls.filter((c) => c.kind === 'create').map((c) => c.request as Record<string, unknown>);

async function failureOf(run: () => Promise<unknown>): Promise<KvoxAiError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(KvoxAiError);
    return error as KvoxAiError;
  }
  throw new Error('expected a failure');
}

// -----------------------------------------------------------------------------

describe('the native request is unchanged', () => {
  it('sends the strict schema, the system prompt and the user text, and nothing else', async () => {
    const { ai, runtime } = build(stateOf([row('gpt-5-mini')]));
    runtime.queueCreate({ response: { parsed: { verdict: 'yes' }, usage: { inputTokens: 1, outputTokens: 1 } } });

    await structured(ai, 'gpt-5-mini');

    const [request] = requests(runtime);
    expect(Object.keys(request).sort()).toEqual(['input', 'instructions', 'structuredOutput']);
    expect(request.instructions).toBe('SYSTEM');
    expect(request.input).toBe('USER');
    expect(request.structuredOutput).toMatchObject({ name: 'verdict_schema', strict: true });
  });

  it('is identical for a row that says native explicitly, and carries the ceiling and effort as before', async () => {
    const asNative = build(stateOf([row('m', { structuredOutputMode: 'native' })]));
    const implicit = build(stateOf([row('m')]));
    for (const { runtime } of [asNative, implicit]) runtime.queueCreate({ response: { parsed: { verdict: 'no' }, usage: { inputTokens: 1, outputTokens: 1 } } });

    await structured(asNative.ai, 'm', { maxOutputTokens: 300 });
    await structured(implicit.ai, 'm', { maxOutputTokens: 300 });

    expect(requests(asNative.runtime)).toEqual(requests(implicit.runtime));
    expect(requests(asNative.runtime)[0]).toMatchObject({ maxOutputTokens: 300 });
  });

  it('makes one call, however the model answers (no repair on the native path)', async () => {
    const { ai, runtime } = build(stateOf([row('m')]));
    runtime.queueCreate({ response: { parsed: { verdict: 'maybe' }, usage: { inputTokens: 1, outputTokens: 1 } } });
    const error = await failureOf(() => structured(ai, 'm'));
    expect(error.errorClass).toBe('invalid_output');
    expect(requests(runtime)).toHaveLength(1);
  });
});

describe('the prompted request', () => {
  const prompted = () => build(stateOf([row('claude-x', { structuredOutputMode: 'prompted' })]));

  it('has no structuredOutput, the schema block after the system prompt and the user text as input', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict":"yes"}'));

    await structured(ai, 'claude-x');

    const [request] = requests(runtime);
    expect('structuredOutput' in request).toBe(false);
    expect(request.input).toBe('USER');
    expect(request.instructions).toBe(
      buildPromptedStructuredInstructions({ system: 'SYSTEM', schemaName: 'verdict_schema', jsonSchema: promptedJsonSchemaOf(verdict) }),
    );
    const text = request.instructions as string;
    expect(text.startsWith('SYSTEM\n\n')).toBe(true);
    expect(text).toContain('"verdict_schema"');
    expect(text).toContain(JSON.stringify(promptedJsonSchemaOf(verdict), null, 2));
  });

  it('embeds the caller JSON Schema when it gave one', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict":"yes"}'));
    const jsonSchema = {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['yes', 'no'] } },
      required: ['verdict'],
      additionalProperties: false,
    };

    await structured(ai, 'claude-x', { jsonSchema });

    expect(requests(runtime)[0].instructions).toContain(JSON.stringify(jsonSchema, null, 2));
  });

  it('carries the same output ceiling and reasoning effort as the native request', async () => {
    const state = stateOf([row('claude-x', { structuredOutputMode: 'prompted' })]);
    state.policy.reasoningEffort = 'high';
    const { ai, runtime } = build(state);
    runtime.queueCreate(answer('{"verdict":"yes"}'));

    await structured(ai, 'claude-x', { maxOutputTokens: 321 });

    expect(requests(runtime)[0]).toMatchObject({ maxOutputTokens: 321, reasoning: { effort: 'high' } });
  });

  it('accepts a fenced answer in one call and returns the value with the usage', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('```json\n{"verdict":"no"}\n```'));

    const result = await structured(ai, 'claude-x');

    expect(result).toEqual({ value: { verdict: 'no' }, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(requests(runtime)).toHaveLength(1);
  });

  it('validates twice: a JSON Schema the answer breaks, and the caller schema it breaks', async () => {
    const jsonSchema = { type: 'object', properties: { verdict: { enum: ['yes', 'no'] } }, required: ['verdict'], additionalProperties: false };
    const picky = z.object({ verdict: z.enum(['yes', 'no']) }).refine((v) => v.verdict === 'yes', 'must be yes');

    // 1: passes the JSON Schema, fails the caller schema.
    const a = prompted();
    a.runtime.queueCreate(answer('{"verdict":"no"}'));
    a.runtime.queueCreate(answer('{"verdict":"yes"}'));
    await expect(structured(a.ai, 'claude-x', { schema: picky, jsonSchema })).resolves.toMatchObject({ value: { verdict: 'yes' } });
    expect(requests(a.runtime)).toHaveLength(2);
    expect(requests(a.runtime)[1].input).toContain('must be yes');

    // 2: breaks the JSON Schema (an extra property).
    const b = prompted();
    b.runtime.queueCreate(answer('{"verdict":"yes","extra":1}'));
    b.runtime.queueCreate(answer('{"verdict":"yes"}'));
    await expect(structured(b.ai, 'claude-x', { jsonSchema })).resolves.toMatchObject({ value: { verdict: 'yes' } });
    expect(requests(b.runtime)).toHaveLength(2);
  });
});

describe('the one repair', () => {
  const prompted = () => build(stateOf([row('claude-x', { structuredOutputMode: 'prompted' })]));

  it('is one more call with the same instructions and ONE string input, usage summed', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('Sure! {"verdict": 3}', { usage: { inputTokens: 10, outputTokens: 4 } }));
    runtime.queueCreate(answer('{"verdict":"yes"}', { usage: { inputTokens: 25, outputTokens: 6 } }));

    const result = await structured(ai, 'claude-x', { maxOutputTokens: 500 });

    expect(result).toEqual({ value: { verdict: 'yes' }, usage: { inputTokens: 35, outputTokens: 10 } });
    const [first, second] = requests(runtime);
    expect(requests(runtime)).toHaveLength(2);
    expect(second.instructions).toBe(first.instructions);
    expect(typeof second.input).toBe('string');
    expect('structuredOutput' in second).toBe(false);
    expect(second).toMatchObject({ maxOutputTokens: 500 });
    expect(second.input as string).toMatch(/^USER\n\n---\n\n/);
    expect(second.input as string).toContain('Sure! {"verdict": 3}');
  });

  it('lists the validation problems by path when the first answer was JSON but wrong', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict":"maybe"}'));
    runtime.queueCreate(answer('{"verdict":"no"}'));

    await structured(ai, 'claude-x');

    expect(requests(runtime)[1].input as string).toMatch(/- \$\.verdict: /);
  });

  it('repairs a non-JSON first answer under a ceiling (the repair, not a truncation verdict)', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict": "ye'));
    runtime.queueCreate(answer('{"verdict":"yes"}'));
    await expect(structured(ai, 'claude-x', { maxOutputTokens: 100 })).resolves.toMatchObject({ value: { verdict: 'yes' } });
  });

  it('never makes a third call: a repair that still mismatches is invalid_output carrying the usage', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict":"maybe"}', { usage: { inputTokens: 10, outputTokens: 2 } }));
    runtime.queueCreate(answer('{"verdict":"perhaps"}', { usage: { inputTokens: 20, outputTokens: 3 } }));

    const error = await failureOf(() => structured(ai, 'claude-x'));

    expect(error.errorClass).toBe('invalid_output');
    expect(requests(runtime)).toHaveLength(2);
    expect(error.usage).toEqual({ inputTokens: 30, outputTokens: 5 });
    // Model output never rides in an error message.
    expect(error.message).not.toMatch(/maybe|perhaps/);
  });

  it('is invalid_output when the repair is not JSON and there is no ceiling', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('not json'));
    runtime.queueCreate(answer('still not json'));
    expect((await failureOf(() => structured(ai, 'claude-x'))).errorClass).toBe('invalid_output');
    expect(requests(runtime)).toHaveLength(2);
  });

  it('is truncated when the repair is not JSON and a ceiling was set', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict": "ye'));
    runtime.queueCreate(answer('{"verdict": "y'));
    const error = await failureOf(() => structured(ai, 'claude-x', { maxOutputTokens: 100 }));
    expect(error.errorClass).toBe('truncated');
    expect(requests(runtime)).toHaveLength(2);
  });

  it('is invalid_output, not truncated, when the repair is JSON that mismatches under a ceiling', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('not json'));
    runtime.queueCreate(answer('{"verdict":"maybe"}'));
    expect((await failureOf(() => structured(ai, 'claude-x', { maxOutputTokens: 100 }))).errorClass).toBe('invalid_output');
  });
});

describe('finish reasons on the prompted path', () => {
  const prompted = () => build(stateOf([row('claude-x', { structuredOutputMode: 'prompted' })]));

  it('treats a length finish as truncated at once, with no repair', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('{"verdict": "ye', { finishReason: 'length' }));
    const error = await failureOf(() => structured(ai, 'claude-x', { maxOutputTokens: 100 }));
    expect(error.errorClass).toBe('truncated');
    expect(error.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(requests(runtime)).toHaveLength(1);
  });

  it('treats a length finish on the repair as truncated too, with the summed usage', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('nope'));
    runtime.queueCreate(answer('{"verdict": "y', { finishReason: 'length' }));
    const error = await failureOf(() => structured(ai, 'claude-x'));
    expect(error.errorClass).toBe('truncated');
    expect(error.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(requests(runtime)).toHaveLength(2);
  });

  it('treats a content_filter finish as a refusal, with no repair', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('I cannot', { finishReason: 'content_filter' }));
    const error = await failureOf(() => structured(ai, 'claude-x'));
    expect(error.errorClass).toBe('refusal');
    expect(requests(runtime)).toHaveLength(1);
  });

  it('treats a content_filter finish on the repair as a refusal', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('nope'));
    runtime.queueCreate(answer('', { finishReason: 'content_filter' }));
    expect((await failureOf(() => structured(ai, 'claude-x'))).errorClass).toBe('refusal');
  });

  it('classifies a provider failure of the first call like any other (no repair)', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate({ fail: new AiError('AI_RATE_LIMITED', 'slow', { retryAfterMs: 1000 }) });
    const error = await failureOf(() => structured(ai, 'claude-x'));
    expect(error.errorClass).toBe('rate_limit');
    expect(requests(runtime)).toHaveLength(1);
  });

  it('classifies a provider failure of the repair call', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(answer('nope'));
    runtime.queueCreate({ fail: new AiError('AI_PROVIDER_UNAVAILABLE', 'down') });
    expect((await failureOf(() => structured(ai, 'claude-x'))).errorClass).toBe('other');
  });
});

describe('where the structured-output mode comes from: row, then catalog, then native', () => {
  const catalogOf = (mode: 'native' | 'prompted' | undefined, provider = 'copilot'): KvoxModelCatalog => ({
    lookup: (p, model) =>
      p === provider
        ? { id: model, contextWindow: null, maxOutputTokens: null, structuredOutput: true, toolCalling: true, ...(mode ? { structuredOutputMode: mode } : {}) }
        : null,
  });
  const usesPrompt = (runtime: ReturnType<typeof createScriptedRuntime>) => !('structuredOutput' in requests(runtime)[0]);

  async function run(state: KvoxAiModelState, model: string, catalog?: KvoxModelCatalog, provider = 'copilot') {
    const { ai, runtime } = build(state, catalog ? { catalog } : {});
    runtime.queueCreate({ response: { parsed: { verdict: 'yes' }, outputText: '{"verdict":"yes"}', usage: { inputTokens: 1, outputTokens: 1 } } });
    await structured(ai, model, {}, provider);
    return usesPrompt(runtime) ? 'prompted' : 'native';
  }

  it('is native with no row mode and no catalog', async () => {
    expect(await run(stateOf([row('m')]), 'm')).toBe('native');
  });

  it('is native for a model with no row at all and no catalog', async () => {
    expect(await run(stateOf([row('other')]), 'unlisted')).toBe('native');
  });

  it('takes the catalog when the row has no mode', async () => {
    expect(await run(stateOf([row('m')]), 'm', catalogOf('prompted'))).toBe('prompted');
    expect(await run(stateOf([row('m')]), 'm', catalogOf('native'))).toBe('native');
    expect(await run(stateOf([row('other')]), 'unlisted', catalogOf('prompted'))).toBe('prompted');
  });

  it('lets the row win over the catalog, in both directions', async () => {
    expect(await run(stateOf([row('m', { structuredOutputMode: 'prompted' })]), 'm', catalogOf('native'))).toBe('prompted');
    expect(await run(stateOf([row('m', { structuredOutputMode: 'native' })]), 'm', catalogOf('prompted'))).toBe('native');
  });

  it('falls back to native when the catalog has no mode for the model', async () => {
    expect(await run(stateOf([row('m')]), 'm', catalogOf(undefined))).toBe('native');
  });

  it('ignores the state rows when the target provider is not the state provider', async () => {
    // The row says prompted, but the call goes to another provider: only that provider's catalog speaks.
    const state = stateOf([row('m', { structuredOutputMode: 'prompted' })], { provider: 'openai' });
    expect(await run(state, 'm', catalogOf('native', 'copilot'), 'copilot')).toBe('native');
    expect(await run(state, 'm', catalogOf('prompted', 'copilot'), 'copilot')).toBe('prompted');
    expect(await run(state, 'm', undefined, 'copilot')).toBe('native');
  });

  it('survives a failing state read by using native', async () => {
    const runtime = createScriptedRuntime();
    runtime.queueCreate({ response: { parsed: { verdict: 'yes' }, usage: { inputTokens: 1, outputTokens: 1 } } });
    let reads = 0;
    const ai = createKvoxAi({
      runtime,
      taskModels: {
        load: async () => {
          reads += 1;
          // The reasoning-effort read comes first and succeeds; the per-call mode read fails.
          if (reads > 1) throw new Error('settings unavailable');
          return stateOf([row('m', { structuredOutputMode: 'prompted' })]);
        },
      },
    });
    await structured(ai, 'm');
    expect('structuredOutput' in requests(runtime)[0]).toBe(true);
  });
});

describe('tool calling is per model', () => {
  const caps = (state: KvoxAiModelState, options: { catalog?: KvoxModelCatalog; hasKey?: boolean } = {}) => {
    const { ai, runtime } = build(state, options.catalog ? { catalog: options.catalog } : {});
    if (options.hasKey === false) runtime.setKey(false);
    return ai.capabilities(ctx);
  };

  it('is true for a model whose flag is true and false for one whose flag is false', async () => {
    await expect(caps(stateOf([row('can', { toolCalling: true })]))).resolves.toMatchObject({ available: true, toolCalling: true, structuredOutput: true });
    await expect(caps(stateOf([row('cannot', { toolCalling: false })]))).resolves.toMatchObject({ available: true, toolCalling: false, structuredOutput: true });
  });

  it('reads the catalog when the row says nothing, and the row over the catalog', async () => {
    const catalog: KvoxModelCatalog = {
      lookup: (_p, model) => ({ id: model, contextWindow: null, maxOutputTokens: null, structuredOutput: true, toolCalling: false }),
    };
    const unflagged = { ...row('m') } as Partial<Row>;
    delete unflagged.toolCalling;
    await expect(caps(stateOf([unflagged as Row]), { catalog })).resolves.toMatchObject({ toolCalling: false });
    await expect(caps(stateOf([row('m', { toolCalling: true })]), { catalog })).resolves.toMatchObject({ toolCalling: true });
  });

  it('defaults to true when neither the row nor a catalog says', async () => {
    const unflagged = { ...row('m') } as Partial<Row>;
    delete unflagged.toolCalling;
    await expect(caps(stateOf([unflagged as Row]))).resolves.toMatchObject({ toolCalling: true });
  });

  it('is false whenever the feature is not ready, whatever the flag', async () => {
    await expect(caps(stateOf([row('can', { toolCalling: true })]), { hasKey: false })).resolves.toMatchObject({
      available: false,
      toolCalling: false,
      reason: 'ai_key_missing',
    });
  });

  it('makes the Ask feature (graph.agent) not ready on a model without tool calling', async () => {
    const state = stateOf([row('plain', { toolCalling: false }), row('agentic', { toolCalling: true })], {
      taskModels: { 'graph.agent': { model: 'plain' } },
    });
    const { runtime } = build(state);
    const reader = createKvoxAiReadiness({ runtime, taskModels: { load: async () => state } });

    await expect(reader.readiness('u1', 'graph_agent')).resolves.toMatchObject({ ok: false, reason: 'model_lacks_capability' });

    const { ai } = build(state);
    const refusal = await failureOf(() => ai.resolveTask({ ...ctx, feature: 'graph.agent' }, 'graph.agent'));
    expect(refusal.errorClass).toBe('capability');
  });

  it('keeps Ask ready on a model with tool calling', async () => {
    const state = stateOf([row('agentic', { toolCalling: true })], { taskModels: { 'graph.agent': { model: 'agentic' } } });
    const { ai } = build(state);
    await expect(ai.resolveTask({ ...ctx, feature: 'graph.agent' }, 'graph.agent')).resolves.toMatchObject({ model: 'agentic' });
  });

  it('keeps the tool-less model usable for features that need no tools', async () => {
    const state = stateOf([row('plain', { toolCalling: false })], { taskModels: { 'graph.agent': { model: 'plain' } } });
    const { ai } = build(state);
    await expect(ai.resolveTask(ctx, 'notes.generate')).resolves.toMatchObject({ model: 'plain' });
  });
});
