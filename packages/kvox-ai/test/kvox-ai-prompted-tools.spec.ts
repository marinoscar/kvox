import { AiError } from '@marinoscar/platform-ai-providers';
import { KvoxAiError, type KvoxAiContext, type KvoxAiTarget, type KvoxChatMessage, type KvoxToolDef } from '@marinoscar/kvox-api/ports';

import { createKvoxAi, type KvoxAiModelState, type KvoxModelCatalog } from '../src/index.js';
import { collect, createScriptedRuntime } from '../src/testing/index.js';

// =============================================================================
// Prompted tool calling (#654): `toolCallingMode: 'prompted'`
// =============================================================================
//
// ADAPTER-INDEPENDENT: `createKvoxAi` over a scripted runtime. What is proved is
// kvox-ai's own rule for a model behind a server without tool calls: the request
// carries NO `tools`, each step is one plain `create` (plus ONE repair), and the
// result is the chat events a native step produces. The native request is pinned.
// =============================================================================

type Row = KvoxAiModelState['models'][number];

const ctx: KvoxAiContext = { userId: 'u1', orgId: null, feature: 'ask.respond' };

const SEARCH: KvoxToolDef = {
  name: 'search',
  description: 'Search the notes',
  parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
};

function row(id: string, extra: Partial<Row> = {}): Row {
  return { id, label: id, structuredOutput: true, toolCalling: true, contextWindow: 100_000, maxOutputTokens: 8_000, ...extra };
}

function stateOf(models: Row[], provider = 'compat'): KvoxAiModelState {
  return {
    provider,
    models,
    policy: {
      enabled: true,
      provider,
      defaultModel: models[0].id,
      graphEnabled: true,
      taskModels: {},
      reasoningEffort: 'none',
      maxInputTokens: null,
      maxOutputTokens: null,
    },
  };
}

function build(state: KvoxAiModelState, catalog?: KvoxModelCatalog) {
  const runtime = createScriptedRuntime();
  const ai = createKvoxAi({ runtime, taskModels: { load: async () => state }, ...(catalog ? { catalog } : {}) });
  return { ai, runtime };
}

const targetOf = (model: string, provider = 'compat'): KvoxAiTarget => ({
  provider,
  model,
  contextWindowTokens: 100_000,
  maxOutputTokens: 4_000,
  source: 'default',
});

const QUESTION: KvoxChatMessage[] = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: 'QUESTION' },
];

const step = (ai: ReturnType<typeof build>['ai'], model: string, messages: KvoxChatMessage[] = QUESTION, toolChoice: 'auto' | 'none' = 'auto') =>
  collect(ai.chat(ctx, { target: targetOf(model), messages, tools: [SEARCH], toolChoice }));

const reply = (outputText: string, extra: Record<string, unknown> = {}) => ({
  response: { outputText, usage: { inputTokens: 10, outputTokens: 5 }, ...extra },
});

const creates = (runtime: ReturnType<typeof createScriptedRuntime>) =>
  runtime.calls.filter((c) => c.kind === 'create').map((c) => c.request as Record<string, any>);

const CALL = '{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":"kappa"}}]}';
const ANSWER = '{"type":"answer","text":"Kappa signed [1]."}';

describe('a native model is unchanged', () => {
  it('streams with tools, and never uses create, with or without an explicit native mode', async () => {
    for (const extra of [{}, { toolCallingMode: 'native' as const }]) {
      const { ai, runtime } = build(stateOf([row('m', extra)]));
      await step(ai, 'm');
      expect(runtime.calls.map((c) => c.kind)).toEqual(['stream']);
      const request = runtime.calls[0].request as Record<string, any>;
      expect(request.tools).toHaveLength(1);
      expect(request.toolChoice).toBe('auto');
    }
  });

  it('is identical for an implicit and an explicit native row', async () => {
    const a = build(stateOf([row('m')]));
    const b = build(stateOf([row('m', { toolCallingMode: 'native' })]));
    await step(a.ai, 'm');
    await step(b.ai, 'm');
    expect(JSON.stringify(a.runtime.calls[0].request)).toEqual(JSON.stringify(b.runtime.calls[0].request));
  });
});

describe('a prompted model', () => {
  const prompted = () => build(stateOf([row('m', { toolCallingMode: 'prompted' })]));

  it('sends one plain create with the tools in the system prompt, and no tools', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply(ANSWER));

    await step(ai, 'm');

    expect(runtime.calls.map((c) => c.kind)).toEqual(['create']);
    const [request] = creates(runtime);
    expect(request.tools).toBeUndefined();
    expect(request.toolChoice).toBeUndefined();
    expect(request.structuredOutput).toBeUndefined();
    expect(request.maxOutputTokens).toBe(4_000);
    expect(request.instructions.startsWith('SYSTEM\n\n')).toBe(true);
    expect(request.instructions).toContain('- search: Search the notes');
    expect(request.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'text', text: 'QUESTION' }] }]);
  });

  it('maps a final answer to delta, step_end, done with the usage', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply(ANSWER));

    expect(await step(ai, 'm')).toEqual([
      { type: 'delta', text: 'Kappa signed [1].' },
      { type: 'step_end' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' },
    ]);
  });

  it('maps parallel tool calls to tool_call events with parsed arguments and distinct ids', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(
      reply('{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":"a"}},{"name":"search","arguments":{"query":"b"}}]}'),
    );

    const events = await step(ai, 'm');

    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_call', id: 'prompted_call_1', name: 'search', arguments: { query: 'a' } },
      { type: 'tool_call', id: 'prompted_call_2', name: 'search', arguments: { query: 'b' } },
    ]);
    expect(events.slice(2).map((e) => e.type)).toEqual(['step_end', 'done']);
  });

  it('runs a multi-step loop: the history is replayed as text and new calls get fresh ids', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply(CALL));
    runtime.queueCreate(reply(CALL));
    runtime.queueCreate(reply(ANSWER));

    const first = await step(ai, 'm');
    const firstCall = first.find((e) => e.type === 'tool_call') as { id: string; name: string; arguments: unknown };

    const history: KvoxChatMessage[] = [
      ...QUESTION,
      { role: 'assistant', content: '', toolCalls: [{ id: firstCall.id, name: firstCall.name, arguments: firstCall.arguments }] },
      { role: 'tool', toolCallId: firstCall.id, content: 'NOTE TEXT' },
    ];
    const second = await step(ai, 'm', history);
    expect(second[0]).toMatchObject({ type: 'tool_call', id: 'prompted_call_2' });

    const [, secondRequest] = creates(runtime);
    expect(secondRequest.input.map((item: any) => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.parse(secondRequest.input[1].content[0].text)).toEqual({
      type: 'tool_calls',
      calls: [{ name: 'search', arguments: { query: 'kappa' } }],
    });
    expect(secondRequest.input[2].content[0].text).toContain('Result of the tool call prompted_call_1 (search):\nNOTE TEXT');
    expect(JSON.stringify(secondRequest)).not.toContain('function_call');

    const last = await step(ai, 'm', history, 'none');
    expect(last.map((e) => e.type)).toEqual(['delta', 'step_end', 'done']);
    expect(creates(runtime)[2].instructions).not.toContain('- search:');
  });

  it('makes ONE repair for an invalid reply, sums the usage, and shows the problems', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply('I will search for kappa.'));
    runtime.queueCreate(reply(CALL));

    const events = await step(ai, 'm');

    expect(events.map((e) => e.type)).toEqual(['tool_call', 'step_end', 'done']);
    expect(events[2]).toMatchObject({ usage: { inputTokens: 20, outputTokens: 10 } });
    const [first, repair] = creates(runtime);
    expect(repair.instructions).toBe(first.instructions);
    expect(repair.input.map((item: any) => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(repair.input[1].content[0].text).toBe('I will search for kappa.');
    expect(repair.input[2].content[0].text).toContain('Reply again with the corrected JSON value only.');
  });

  it('repairs a call whose arguments do not fit the tool', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply('{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":7}}]}'));
    runtime.queueCreate(reply(CALL));

    expect((await step(ai, 'm'))[0]).toMatchObject({ type: 'tool_call', arguments: { query: 'kappa' } });
    expect(creates(runtime)).toHaveLength(2);
  });

  it('fails invalid_output after a second invalid reply, with no third call', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate(reply('nope'));
    runtime.queueCreate(reply('still nope'));

    const error = await step(ai, 'm').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KvoxAiError);
    expect((error as KvoxAiError).errorClass).toBe('invalid_output');
    expect(creates(runtime)).toHaveLength(2);
  });

  it('reports a cut-off or filtered reply as the finish reason, without a repair', async () => {
    for (const finishReason of ['length', 'content_filter'] as const) {
      const { ai, runtime } = prompted();
      runtime.queueCreate(reply('{"type":"answer","text":"cut', { finishReason }));
      const events = await step(ai, 'm');
      expect(events.map((e) => e.type)).toEqual(['step_end', 'done']);
      expect(events[1]).toMatchObject({ finishReason });
      expect(creates(runtime)).toHaveLength(1);
    }
  });

  it('translates a provider failure like any other chat step', async () => {
    const { ai, runtime } = prompted();
    runtime.queueCreate({ fail: new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1500 }) });
    const error = (await step(ai, 'm').then(
      () => null,
      (e: unknown) => e,
    )) as KvoxAiError;
    expect(error.errorClass).toBe('rate_limit');
  });

  it('does nothing different when the request has no tools', async () => {
    const { ai, runtime } = prompted();
    await collect(ai.chat(ctx, { target: targetOf('m'), messages: QUESTION, tools: [], toolChoice: 'auto' }));
    expect(runtime.calls.map((c) => c.kind)).toEqual(['stream']);
  });
});

describe('where the mode comes from', () => {
  it('reads a catalog entry when the row says nothing, and the row wins over the catalog', async () => {
    const catalog: KvoxModelCatalog = {
      lookup: (_provider, model) => ({
        id: model,
        contextWindow: null,
        maxOutputTokens: null,
        structuredOutput: true,
        toolCalling: true,
        toolCallingMode: 'prompted',
      }),
    };
    const fromCatalog = build(stateOf([row('m')]), catalog);
    fromCatalog.runtime.queueCreate(reply(ANSWER));
    await step(fromCatalog.ai, 'm');
    expect(fromCatalog.runtime.calls.map((c) => c.kind)).toEqual(['create']);

    const rowWins = build(stateOf([row('m', { toolCallingMode: 'native' })]), catalog);
    await step(rowWins.ai, 'm');
    expect(rowWins.runtime.calls.map((c) => c.kind)).toEqual(['stream']);
  });

  it('keeps the model capable of Ask in capabilities()', async () => {
    const { ai } = build(stateOf([row('m', { toolCallingMode: 'prompted' })]));
    expect((await ai.capabilities({ ...ctx })).toolCalling).toBe(true);
  });
});
