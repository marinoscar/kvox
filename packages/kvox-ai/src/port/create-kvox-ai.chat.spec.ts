import { AI_PROVIDER_STATE, AiError, type AiErrorCode, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';

import { AiAuthError, AiRefusedError, RateLimitError } from './ai-errors';
import { clearToolCache, type KvoxChatEvent, type KvoxChatRequest, type KvoxToolDefinition } from '@marinoscar/kvox-ai';
import { PlatformKvoxAi } from './platform-kvox-ai';

// =============================================================================
// PlatformKvoxAi.chat (issue #476): one Ask-loop model call over `stream()`
// =============================================================================

const USER = 'user-1';
const ORG = 'org-1';
const JOB = 'job-1';

const SEARCH: KvoxToolDefinition = {
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
  const client = { stream: jest.fn() };
  const forUser = jest.fn().mockReturnValue(client);
  const loadState = jest.fn();
  const requestTimeoutMs = jest.fn().mockResolvedValue(opts.timeoutMs ?? 600_000);
  const service = new PlatformKvoxAi(
    { forUser } as never,
    { loadState } as never,
    {} as never,
    { requestTimeoutMs } as never,
  );
  return { service, client, forUser, loadState, requestTimeoutMs };
}

const request = (extra: Partial<KvoxChatRequest> = {}): KvoxChatRequest => ({
  userId: USER,
  orgId: ORG,
  jobId: JOB,
  feature: 'graph_agent',
  model: 'gpt-5.4-mini',
  messages: [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'QUESTION' },
  ],
  tools: [SEARCH],
  toolChoice: 'auto',
  maxOutputTokens: 2000,
  reasoningEffort: 'low',
  ...extra,
});

/** The first argument of the n-th `stream()` call. */
const sent = (client: { stream: jest.Mock }, n = 0) => client.stream.mock.calls[n][0] as Record<string, any>;

describe('PlatformKvoxAi.chat', () => {
  beforeEach(() => clearToolCache());

  describe('the request', () => {
    it('is one platform stream call for the graph agent, under the job and organization', async () => {
      const { service, client, forUser } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(service.chat(request()));

      expect(forUser).toHaveBeenCalledTimes(1);
      expect(forUser).toHaveBeenCalledWith(USER, { orgId: ORG, jobId: JOB, feature: 'graph_agent' });
      expect(client.stream).toHaveBeenCalledTimes(1);
    });

    it('sends the whole history as items, the system messages as instructions, and never previousResponseId', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(
        service.chat(
          request({
            messages: [
              { role: 'system', content: 'SYSTEM' },
              { role: 'user', content: 'QUESTION' },
              { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' }] },
              { role: 'tool', toolCallId: 'c1', content: '{"hits":1}' },
              { role: 'system', content: 'Answer now.' },
            ],
            toolChoice: 'none',
          }),
        ),
      );

      const body = sent(client);
      expect(body.instructions).toBe('SYSTEM');
      expect(body.model).toBe('gpt-5.4-mini');
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

    it('converts the tools to strict function tools and maps a named tool choice', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(service.chat(request({ toolChoice: { name: 'search' } })));

      const body = sent(client);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toMatchObject({ type: 'function', name: 'search', description: 'Search the graph', strict: true });
      expect(body.tools[0].parameters.safeParse({ query: 'x' }).success).toBe(true);
      expect(body.toolChoice).toEqual({ type: 'function', name: 'search' });
    });

    it('sends no tool choice when there are no tools', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(service.chat(request({ tools: undefined, toolChoice: 'auto' })));

      expect(sent(client).tools).toBeUndefined();
      expect(sent(client).toolChoice).toBeUndefined();
    });

    it('sends the effort of the request (xhigh is clamped to high, none omits it)', async () => {
      const { service, client } = build();
      client.stream.mockImplementation(() => events(completed()));

      await collect(service.chat(request({ reasoningEffort: 'xhigh' })));
      await collect(service.chat(request({ reasoningEffort: 'none' })));
      await collect(service.chat(request({ reasoningEffort: 'medium' })));

      expect(sent(client, 0).reasoning).toEqual({ effort: 'high' });
      expect(sent(client, 1).reasoning).toBeUndefined();
      expect(sent(client, 2).reasoning).toEqual({ effort: 'medium' });
    });

    it('omits the model when none is requested, so the resolver decides', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed()));

      await collect(service.chat(request({ model: null, reasoningEffort: 'none' })));

      expect('model' in sent(client)).toBe(false);
    });
  });

  describe('the events', () => {
    it('streams text, then a tool call, then done with the usage', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(
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

      const out = await collect(service.chat(request()));

      expect(out).toEqual<KvoxChatEvent[]>([
        { kind: 'delta', text: 'Let me ' },
        { kind: 'delta', text: 'check.' },
        { kind: 'tool_call', id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' },
        { kind: 'done', finishReason: 'tool_calls', model: 'gpt-5.4-mini', usage: { inputTokens: 12, outputTokens: 7 } },
      ]);
    });

    it('never emits a call twice when the final response repeats it, and does not lose one it alone carries', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(
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

      const out = await collect(service.chat(request()));

      expect(out.filter((e) => e.kind === 'tool_call').map((e) => (e as { id: string }).id)).toEqual(['c1', 'c2']);
      expect(out[out.length - 1]).toMatchObject({ kind: 'done' });
    });

    it('maps length and content_filter finishes', async () => {
      const { service, client } = build();
      client.stream.mockImplementation(() => events(completed({ finishReason: 'length' })));
      await expect(collect(service.chat(request()))).resolves.toEqual([
        expect.objectContaining({ kind: 'done', finishReason: 'length' }),
      ]);

      client.stream.mockImplementation(() => events(completed({ finishReason: 'content_filter' })));
      await expect(collect(service.chat(request()))).resolves.toEqual([
        expect.objectContaining({ kind: 'done', finishReason: 'content_filter' }),
      ]);
    });

    it('reports missing usage as null', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(completed({ usage: {} as never })));

      await expect(collect(service.chat(request()))).resolves.toEqual([
        { kind: 'done', finishReason: 'stop', model: 'gpt-5.4-mini', usage: { inputTokens: null, outputTokens: null } },
      ]);
    });

    it('fails a response that ended with an error finish, and a stream that never completed', async () => {
      const { service, client } = build();
      client.stream.mockReturnValueOnce(events(completed({ finishReason: 'error' as never })));
      await expect(collect(service.chat(request()))).rejects.toThrow(/ended the response with an error/);

      client.stream.mockReturnValueOnce(events({ type: 'output_text.delta', delta: 'cut off' }));
      await expect(collect(service.chat(request()))).rejects.toThrow(/closed the stream without finishing/);
    });
  });

  describe('reasoning replay', () => {
    it('puts the reasoning a step emitted back in front of its call on the next request, as the same object', async () => {
      const { service, client } = build();
      const state = { provider: 'anthropic', data: { signature: 'opaque' } };
      const thought = { type: 'reasoning' as const, summary: ['thinking'], [AI_PROVIDER_STATE]: state };
      client.stream.mockReturnValueOnce(
        events(
          { type: 'output_item.done', item: thought },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"query":"a"}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );
      const first = await collect(service.chat(request()));
      // Reasoning is opaque provider state: it is never surfaced as an event.
      expect(JSON.stringify(first)).not.toContain('thinking');

      client.stream.mockReturnValueOnce(events(completed()));
      await collect(
        service.chat(
          request({
            messages: [
              { role: 'system', content: 'SYSTEM' },
              { role: 'user', content: 'QUESTION' },
              { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' }] },
              { role: 'tool', toolCallId: 'c1', content: '{}' },
            ],
          }),
        ),
      );

      const items = sent(client, 1).input as Array<Record<string, unknown>>;
      expect(items.map((i) => i.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
      expect(items[1]).toBe(thought);
      expect((items[1] as typeof thought)[AI_PROVIDER_STATE]).toBe(state);
    });

    it('does not replay one user\'s reasoning into another user\'s request', async () => {
      const { service, client } = build();
      client.stream.mockReturnValueOnce(
        events(
          { type: 'output_item.done', item: { type: 'reasoning', summary: ['secret'] } },
          { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
          completed({ finishReason: 'tool_calls' }),
        ),
      );
      await collect(service.chat(request()));

      client.stream.mockReturnValueOnce(events(completed()));
      await collect(
        service.chat(
          request({
            userId: 'user-2',
            messages: [
              { role: 'user', content: 'Q' },
              { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', argumentsJson: '{}' }] },
              { role: 'tool', toolCallId: 'c1', content: '{}' },
            ],
          }),
        ),
      );

      expect((sent(client, 1).input as Array<{ type: string }>).map((i) => i.type)).toEqual([
        'message',
        'function_call',
        'function_call_output',
      ]);
    });
  });

  describe('failures', () => {
    const platform = (code: AiErrorCode, message = `platform ${code}`) => new AiError(code, message);

    it('maps an error event to the job error classes', async () => {
      const { service, client } = build();

      client.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_RATE_LIMITED', message: 'slow down' }));
      await expect(collect(service.chat(request()))).rejects.toBeInstanceOf(RateLimitError);

      client.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_KEY_INVALID', message: 'bad key' }));
      await expect(collect(service.chat(request()))).rejects.toBeInstanceOf(AiAuthError);

      client.stream.mockReturnValueOnce(events({ type: 'error', code: 'AI_CONTENT_FILTERED', message: 'no' }));
      await expect(collect(service.chat(request()))).rejects.toBeInstanceOf(AiRefusedError);
    });

    it('maps a gate error raised on the first iteration (the stream is lazy)', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events(platform('AI_RATE_LIMITED')));

      await expect(collect(service.chat(request()))).rejects.toBeInstanceOf(RateLimitError);
    });

    it('keeps the text it already yielded when a 429 follows, so the handler can tell the two cases apart', async () => {
      const { service, client } = build();
      client.stream.mockReturnValue(events({ type: 'output_text.delta', delta: 'partial' }, platform('AI_RATE_LIMITED')));

      const seen: KvoxChatEvent[] = [];
      await expect(
        (async () => {
          for await (const event of service.chat(request())) seen.push(event);
        })(),
      ).rejects.toBeInstanceOf(RateLimitError);
      expect(seen).toEqual([{ kind: 'delta', text: 'partial' }]);
    });
  });

  describe('the guard', () => {
    it('passes a signal that aborts at the request timeout, and surfaces a TimeoutError', async () => {
      const { service, client } = build({ timeoutMs: 600_000 });
      client.stream.mockImplementation((_req: unknown, options: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new AiError('AI_PROVIDER_UNAVAILABLE', 'aborted')));
          });
          yield { type: 'response.created', id: 'never' } as AiStreamEvent;
        })(),
      );

      await expect(collect(service.chat(request({ timeoutMs: 20 })))).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(client.stream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('uses the smaller of the request timeout and the deployment backstop', async () => {
      const { service, client } = build({ timeoutMs: 20 });
      client.stream.mockImplementation((_req: unknown, options: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new AiError('AI_PROVIDER_UNAVAILABLE', 'aborted')));
          });
          yield { type: 'response.created', id: 'never' } as AiStreamEvent;
        })(),
      );

      await expect(collect(service.chat(request({ timeoutMs: 600_000 })))).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('surfaces the caller\'s own abort reason, not a timeout', async () => {
      const { service, client } = build();
      const controller = new AbortController();
      client.stream.mockImplementation((_req: unknown, options: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new AiError('AI_PROVIDER_UNAVAILABLE', 'aborted')));
          });
          yield { type: 'response.created', id: 'never' } as AiStreamEvent;
        })(),
      );

      const pending = collect(service.chat(request({ signal: controller.signal })));
      setTimeout(() => controller.abort(new Error('caller gave up')), 10);

      await expect(pending).rejects.toThrow('caller gave up');
    });
  });

  describe('the effort when the request names none', () => {
    it('is decided by the port from the policy, as for every other call', async () => {
      const { service, client, loadState } = build();
      loadState.mockResolvedValue({
        provider: 'openai',
        models: [],
        policy: { reasoningEffort: 'medium', taskModels: {}, defaultModel: null },
      });
      client.stream.mockReturnValue(events(completed()));

      await collect(service.chat(request({ reasoningEffort: undefined })));

      expect(sent(client).reasoning).toEqual({ effort: 'medium' });
    });
  });
});
