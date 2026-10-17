import { AI_PROVIDER_STATE, AiError, type AiErrorCode, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';
import type { KvoxAiContext, KvoxAiTarget, KvoxChatEvent, KvoxChatMessage, KvoxToolDef } from '@marinoscar/kvox-api/ports';

import { clearToolCache } from '../chat/index.js';
import type { KvoxAiModelState } from '../runtime/index.js';
import { createKvoxAi } from './create-kvox-ai.js';

// =============================================================================
// createKvoxAi.chat (issue #579, from PlatformKvoxAi.chat #476): one Ask step over `stream()`
// =============================================================================
//
// Moved from `apps/api/src/ai-port/platform-kvox-ai.chat.spec.ts`. Every case is
// kept, translated at the port boundary: the platform client is the runtime, the
// events are the port's (`delta`, `tool_call` with parsed arguments, `step_end`,
// `done`), and a failure is the `KvoxAiError` class the port adapter answered
// (`rate_limit`, `auth`, `refusal`, `timeout`). The two guard cases that set a
// per-request `timeoutMs` (a facade-only field the port never had) now drive the
// same backstop through `requestTimeoutMs`.
// =============================================================================

const USER = 'user-1';
const ORG = 'org-1';
const JOB = 'job-1';

const SEARCH: KvoxToolDef = {
  name: 'search',
  description: 'Search the graph',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

const RESPONSE: AiResponse = {
  id: 'resp-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  output: [],
  outputText: '',
  usage: { inputTokens: 12, outputTokens: 7 },
  finishReason: 'stop',
};

const TARGET: KvoxAiTarget = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'low',
  contextWindowTokens: 128_000,
  maxOutputTokens: 2000,
  source: 'task',
};

function completed(overrides: Partial<AiResponse> = {}): AiStreamEvent {
  return { type: 'response.completed', response: { ...RESPONSE, ...overrides } };
}

async function* events(...list: Array<AiStreamEvent | Error>): AsyncGenerator<AiStreamEvent> {
  for (const event of list) {
    if (event instanceof Error) throw event;
    yield event;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function build(opts: { timeoutMs?: number } = {}) {
  const runtime = { stream: jest.fn(), create: jest.fn(), readiness: jest.fn() };
  const load = jest.fn();
  const requestTimeoutMs = jest.fn().mockResolvedValue(opts.timeoutMs ?? 600_000);
  const port = createKvoxAi({ runtime, taskModels: { load }, requestTimeoutMs });
  return { port, runtime, load, requestTimeoutMs };
}

const CTX: KvoxAiContext = { userId: USER, orgId: ORG, jobId: JOB, feature: 'ask.respond' };

interface ChatRequest {
  target: KvoxAiTarget;
  messages: KvoxChatMessage[];
  tools: KvoxToolDef[];
  toolChoice: 'auto' | 'none';
}

const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  target: TARGET,
  messages: [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'QUESTION' },
  ],
  tools: [SEARCH],
  toolChoice: 'auto',
  ...extra,
});

/** The request (second argument) of the n-th `stream()` call. */
const sent = (runtime: { stream: jest.Mock }, n = 0) => runtime.stream.mock.calls[n][1] as Record<string, any>;

describe('createKvoxAi.chat', () => {
  beforeEach(() => clearToolCache());

  describe('the request', () => {
    it('is one runtime stream call for the graph agent, under the job and organization', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(port.chat(CTX, request()));

      expect(runtime.stream).toHaveBeenCalledTimes(1);
      expect(runtime.stream.mock.calls[0][0]).toMatchObject({
        userId: USER,
        orgId: ORG,
        jobId: JOB,
        feature: 'graph_agent',
        model: 'gpt-5.4-mini',
      });
    });

    it('sends the whole history as items, the system messages as instructions, and never previousResponseId', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(
        port.chat(
          CTX,
          request({
            messages: [
              { role: 'system', content: 'SYSTEM' },
              { role: 'user', content: 'QUESTION' },
              { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'search', arguments: { query: 'a' } }] },
              { role: 'tool', toolCallId: 'c1', content: '{"hits":1}' },
              { role: 'system', content: 'Answer now.' },
            ],
            toolChoice: 'none',
          }),
        ),
      );

      const body = sent(runtime);
      expect(body.instructions).toBe('SYSTEM');
      expect(runtime.stream.mock.calls[0][0].model).toBe('gpt-5.4-mini');
      expect(body.input).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'QUESTION' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
        { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"query":"a"}' },
        { type: 'function_call_output', callId: 'c1', output: '{"hits":1}' },
        { type: 'message', role: 'developer', content: [{ type: 'text', text: 'Answer now.' }] },
      ]);
      expect(body.previousResponseId).toBeUndefined();
      expect(body.toolChoice).toBe('none');
      expect(body.maxOutputTokens).toBe(2000);
    });

    it('converts the tools to strict function tools and passes the tool choice', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(port.chat(CTX, request({ toolChoice: 'auto' })));

      const body = sent(runtime);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toMatchObject({ type: 'function', name: 'search', description: 'Search the graph', strict: true });
      expect(body.tools[0].parameters.safeParse({ query: 'x' }).success).toBe(true);
      expect(body.toolChoice).toBe('auto');
    });

    it('sends no tool choice when there are no tools', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(port.chat(CTX, request({ tools: [], toolChoice: 'auto' })));

      expect(sent(runtime).tools).toBeUndefined();
      expect(sent(runtime).toolChoice).toBeUndefined();
    });

    it('sends the effort of the target (xhigh is clamped to high, none omits it)', async () => {
      const { port, runtime } = build();
      runtime.stream.mockImplementation(() => events(completed()));

      await collect(port.chat(CTX, request({ target: { ...TARGET, reasoningEffort: 'xhigh' } })));
      await collect(port.chat(CTX, request({ target: { ...TARGET, reasoningEffort: 'none' } })));
      await collect(port.chat(CTX, request({ target: { ...TARGET, reasoningEffort: 'medium' } })));

      expect(sent(runtime, 0).reasoning).toEqual({ effort: 'high' });
      expect(sent(runtime, 1).reasoning).toBeUndefined();
      expect(sent(runtime, 2).reasoning).toEqual({ effort: 'medium' });
    });

    it('omits the model when the target names none, so the host resolver decides', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed()));

      await collect(port.chat(CTX, request({ target: { ...TARGET, model: '', reasoningEffort: 'none' } })));

      expect('model' in runtime.stream.mock.calls[0][0]).toBe(false);
      expect('model' in sent(runtime)).toBe(false);
    });
  });

  describe('the events', () => {
    it('streams text, then a tool call, then step_end and done with the usage', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(
        events(
          { type: 'response.created', id: 'r' },
          { type: 'output_text.delta', delta: 'Let me ' },
          { type: 'output_text.delta', delta: 'check.' },
          { type: 'function_call.arguments.delta', callId: 'c1', delta: '{"query":' },
          { type: 'function_call.arguments.delta', callId: 'c1', delta: '"a"}' },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"query":"a"}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );

      const out = await collect(port.chat(CTX, request()));

      expect(out).toEqual<KvoxChatEvent[]>([
        { type: 'delta', text: 'Let me ' },
        { type: 'delta', text: 'check.' },
        { type: 'tool_call', id: 'c1', name: 'search', arguments: { query: 'a' } },
        { type: 'step_end' },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7 } },
      ]);
    });

    it('never emits a call twice when the final response repeats it, and does not lose one it alone carries', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(
        events(
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
          completed({
            finishReason: 'tool_calls',
            output: [
              { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' },
              { type: 'function_call', callId: 'c2', name: 'search', arguments: '{"query":"b"}' },
            ] as never,
          }),
        ),
      );

      const out = await collect(port.chat(CTX, request()));

      expect(out.filter((e) => e.type === 'tool_call').map((e) => (e as { id: string }).id)).toEqual(['c1', 'c2']);
      expect(out[out.length - 1]).toMatchObject({ type: 'done' });
    });

    it('drops text that follows a tool call in the same step, and hands unparseable arguments over as text', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(
        events(
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{"q":"acme"}' } },
          { type: 'output_text.delta', delta: 'ignored' },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c2', name: 'lookup', arguments: 'not json' } },
          completed({ finishReason: 'tool_calls', usage: { inputTokens: 3, outputTokens: 4 } }),
        ),
      );

      const out = await collect(port.chat(CTX, request()));

      expect(out).toEqual([
        { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'acme' } },
        { type: 'tool_call', id: 'c2', name: 'lookup', arguments: 'not json' },
        { type: 'step_end' },
        { type: 'done', usage: { inputTokens: 3, outputTokens: 4 }, finishReason: 'stop' },
      ]);
    });

    it('maps length and content_filter finishes', async () => {
      const { port, runtime } = build();
      runtime.stream.mockImplementation(() => events(completed({ finishReason: 'length' })));
      await expect(collect(port.chat(CTX, request()))).resolves.toEqual([
        { type: 'step_end' },
        expect.objectContaining({ type: 'done', finishReason: 'length' }),
      ]);

      runtime.stream.mockImplementation(() => events(completed({ finishReason: 'content_filter' })));
      await expect(collect(port.chat(CTX, request()))).resolves.toEqual([
        { type: 'step_end' },
        expect.objectContaining({ type: 'done', finishReason: 'content_filter' }),
      ]);
    });

    it('reports missing usage as null', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(completed({ usage: {} as never })));

      await expect(collect(port.chat(CTX, request()))).resolves.toEqual([
        { type: 'step_end' },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: null, outputTokens: null } },
      ]);
    });

    it('fails a response that ended with an error finish, and a stream that never completed', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValueOnce(events(completed({ finishReason: 'error' as never })));
      await expect(collect(port.chat(CTX, request()))).rejects.toThrow(/ended the response with an error/);

      runtime.stream.mockReturnValueOnce(events({ type: 'output_text.delta', delta: 'cut off' }));
      await expect(collect(port.chat(CTX, request()))).rejects.toThrow(/closed the stream without finishing/);
    });
  });

  describe('reasoning replay', () => {
    it('puts the reasoning a step emitted back in front of its call on the next request, as the same object', async () => {
      const { port, runtime } = build();
      const state = { provider: 'anthropic', data: { signature: 'opaque' } };
      const thought = { type: 'reasoning' as const, summary: ['thinking'], [AI_PROVIDER_STATE]: state };
      runtime.stream.mockReturnValueOnce(
        events(
          { type: 'output_item.done', item: thought },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"query":"a"}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );
      const first = await collect(port.chat(CTX, request()));
      // Reasoning is opaque provider state: it is never surfaced as an event.
      expect(JSON.stringify(first)).not.toContain('thinking');

      runtime.stream.mockReturnValueOnce(events(completed()));
      await collect(
        port.chat(
          CTX,
          request({
            messages: [
              { role: 'system', content: 'SYSTEM' },
              { role: 'user', content: 'QUESTION' },
              { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', arguments: { query: 'a' } }] },
              { role: 'tool', toolCallId: 'c1', content: '{}' },
            ],
          }),
        ),
      );

      const items = sent(runtime, 1).input as Array<Record<string, unknown>>;
      expect(items.map((i) => i.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
      expect(items[1]).toBe(thought);
      expect((items[1] as typeof thought)[AI_PROVIDER_STATE]).toBe(state);
    });

    it('does not replay one user\'s reasoning into another user\'s request', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValueOnce(
        events(
          { type: 'output_item.done', item: { type: 'reasoning', summary: ['secret'] } },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );
      await collect(port.chat(CTX, request()));

      runtime.stream.mockReturnValueOnce(events(completed()));
      await collect(
        port.chat(
          { ...CTX, userId: 'user-2' },
          request({
            messages: [
              { role: 'user', content: 'Q' },
              { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', arguments: {} }] },
              { role: 'tool', toolCallId: 'c1', content: '{}' },
            ],
          }),
        ),
      );

      expect((sent(runtime, 1).input as Array<{ type: string }>).map((i) => i.type)).toEqual([
        'message',
        'function_call',
        'function_call_output',
      ]);
    });

    it('keeps one replay cache per instance', async () => {
      const first = build();
      const second = build();
      first.runtime.stream.mockReturnValueOnce(
        events(
          { type: 'output_item.done', item: { type: 'reasoning', summary: ['mine'] } },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );
      await collect(first.port.chat(CTX, request()));

      second.runtime.stream.mockReturnValueOnce(events(completed()));
      await collect(
        second.port.chat(
          CTX,
          request({
            messages: [
              { role: 'user', content: 'Q' },
              { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', arguments: {} }] },
              { role: 'tool', toolCallId: 'c1', content: '{}' },
            ],
          }),
        ),
      );

      expect((sent(second.runtime, 0).input as Array<{ type: string }>).map((i) => i.type)).not.toContain('reasoning');
    });
  });

  describe('failures', () => {
    const platform = (code: AiErrorCode, message = `platform ${code}`) => new AiError(code, message);

    it('maps an error event to the job classes', async () => {
      const { port, runtime } = build();

      runtime.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_RATE_LIMITED', message: 'slow down' }));
      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'rate_limit' });

      runtime.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_KEY_INVALID', message: 'bad key' }));
      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'auth' });

      runtime.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_CONTENT_FILTERED', message: 'no' }));
      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'refusal' });
    });

    it('maps a gate error raised on the first iteration (the stream is lazy)', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events(platform('AI_RATE_LIMITED')));

      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'rate_limit' });
    });

    it('keeps the text it already yielded when a 429 follows, so the handler can tell the two cases apart', async () => {
      const { port, runtime } = build();
      runtime.stream.mockReturnValue(events({ type: 'output_text.delta', delta: 'partial' }, platform('AI_RATE_LIMITED')));

      const seen: KvoxChatEvent[] = [];
      await expect(
        (async () => {
          for await (const event of port.chat(CTX, request())) seen.push(event);
        })(),
      ).rejects.toMatchObject({ errorClass: 'rate_limit' });
      expect(seen).toEqual([{ type: 'delta', text: 'partial' }]);
    });
  });

  describe('the guard', () => {
    const hangUntilAborted = (call: { signal: AbortSignal }) =>
      (async function* () {
        await new Promise<void>((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(new AiError('AI_PROVIDER_UNAVAILABLE', 'aborted')));
        });
        yield { type: 'response.created', id: 'never' } as AiStreamEvent;
      })();

    it('passes a signal that aborts at the request timeout, and surfaces a timeout', async () => {
      const { port, runtime } = build({ timeoutMs: 20 });
      runtime.stream.mockImplementation(hangUntilAborted);

      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'timeout', message: expect.stringMatching(/20 ms/) });
      expect(runtime.stream.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    });

    it('reads the deployment backstop per call (a reader, not a constant)', async () => {
      const { port, runtime, requestTimeoutMs } = build({ timeoutMs: 600_000 });
      requestTimeoutMs.mockResolvedValueOnce(20);
      runtime.stream.mockImplementation(hangUntilAborted);

      await expect(collect(port.chat(CTX, request()))).rejects.toMatchObject({ errorClass: 'timeout' });
    });

    it('surfaces the caller\'s own abort reason, not a timeout', async () => {
      const { port, runtime } = build();
      const controller = new AbortController();
      runtime.stream.mockImplementation(hangUntilAborted);

      const pending = collect(port.chat({ ...CTX, signal: controller.signal }, request()));
      setTimeout(() => controller.abort(new Error('caller gave up')), 10);

      await expect(pending).rejects.toMatchObject({ errorClass: 'other', message: 'caller gave up' });
    });
  });

  describe('the effort when the target names none', () => {
    it('is decided by the port from the policy, as for every other call', async () => {
      const { port, runtime, load } = build();
      load.mockResolvedValue({
        provider: 'openai',
        models: [],
        policy: { reasoningEffort: 'medium', taskModels: {}, defaultModel: null },
      } as unknown as KvoxAiModelState);
      runtime.stream.mockReturnValue(events(completed()));

      const { reasoningEffort: _omitted, ...withoutEffort } = TARGET;
      await collect(port.chat(CTX, request({ target: withoutEffort })));

      expect(sent(runtime).reasoning).toEqual({ effort: 'medium' });
    });
  });
});
