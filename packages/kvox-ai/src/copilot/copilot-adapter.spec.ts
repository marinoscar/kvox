import {
  AI_KEYLESS_API_KEY,
  AiError,
  type AiCallContext,
  type AiResponseRequest,
  type AiStreamEvent,
} from '@marinoscar/platform-ai-providers';
import { z } from 'zod';

import { copilotSessionConfig, createCopilotAdapter, COPILOT_PROVIDER_ID, type CopilotProviderAdapter } from './copilot-adapter.js';
import { COPILOT_SIGN_IN_MESSAGE } from './copilot-errors.js';
import { createCopilotMockTransport, type CopilotMockTransport, type CopilotMockTransportOptions } from './copilot-mock-transport.js';
import type { CopilotTransport } from './copilot-transport.js';

// =============================================================================
// The GitHub Copilot adapter over the mock transport (#581, Phase 2)
// =============================================================================
//
// Proves the acceptance items of the adapter, with no SDK, no network and no
// sign-in: the zero-tool session template, the tool tripwire, every SUPPRESSION
// (datetime prefix, continuation after `length`, SDK retries), the session
// cleanup on every exit, the request refusals, the sign-in rule, the model
// listing, the structured-output contract and the abort rule. The error table and
// the planted-token sweep are `copilot-errors.spec.ts` and `copilot-token-leak.spec.ts`.
// =============================================================================

const ctx: AiCallContext = { apiKey: AI_KEYLESS_API_KEY, requestId: 'req-1' };
const MODEL = 'gpt-5-mini';
const CLAUDE = 'claude-sonnet-4.5';
const schema = z.object({ title: z.string() });

interface LogEntry {
  level: 'info' | 'warn';
  entry: Record<string, unknown>;
}

/** An adapter over a fresh mock, with every logger call captured. */
function setup(options: CopilotMockTransportOptions = {}, wrap?: (mock: CopilotMockTransport) => CopilotTransport) {
  const mock = createCopilotMockTransport(options);
  const logs: LogEntry[] = [];
  const adapter: CopilotProviderAdapter = createCopilotAdapter({
    optIn: true,
    transport: wrap ? wrap(mock) : mock,
    logger: {
      info: (entry) => logs.push({ level: 'info', entry }),
      warn: (entry) => logs.push({ level: 'warn', entry }),
    },
  });
  return { mock, adapter, logs };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** Lets the mock's `setImmediate` emissions drain, so a suppressed request would have shown. */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function failureOf(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (error) {
    expect(AiError.isAiError(error)).toBe(true);
    return error as AiError;
  }
  throw new Error('expected a failure');
}

const ask = (adapter: CopilotProviderAdapter, req: Partial<AiResponseRequest> = {}) =>
  adapter.responses.create({ model: MODEL, input: 'Hi', ...req } as AiResponseRequest, ctx);

const userMessage = (text: string): AiResponseRequest['input'] => [{ type: 'message', role: 'user', content: [{ type: 'text', text }] }];

// -----------------------------------------------------------------------------

describe('createCopilotAdapter: the opt-in and the surface', () => {
  it.each([[false], [undefined], ['true' as unknown as boolean], [1 as unknown as boolean]])(
    'refuses to build unless optIn is exactly true (got %p)',
    (optIn) => {
      expect(() => createCopilotAdapter({ optIn: optIn as boolean, transport: createCopilotMockTransport() })).toThrow(/switched off/);
      expect(() => createCopilotAdapter({ optIn: optIn as boolean, transport: createCopilotMockTransport() })).not.toThrow(AiError);
    },
  );

  it('describes itself as a stateless, embeddings-less responses adapter that serves tools through the bridge', () => {
    const { adapter } = setup();
    expect(adapter).toMatchObject({
      id: COPILOT_PROVIDER_ID,
      displayName: 'GitHub Copilot',
      supportsPreviousResponseId: false,
      supportsHostedTools: false,
    });
    expect(COPILOT_PROVIDER_ID).toBe('copilot');
    expect(adapter.responses).toBeDefined();
    expect(adapter.embeddings).toBeUndefined();
    expect(adapter.fileInputStrategy).toBeUndefined();
    expect(adapter.kvox).toMatchObject({ toolCalling: true, embeddings: false });
    expect(adapter.bridge.heldSessions()).toBe(0);
  });
});

describe('the session configuration: zero built-in tools, our system prompt', () => {
  it('lists no tool and replaces the SDK system prompt with exactly our instructions', async () => {
    const { mock, adapter } = setup();
    await ask(adapter, { instructions: 'Be brief.' });

    const [{ config }] = mock.sessions();
    expect(config.availableTools).toEqual([]);
    expect(config.systemMessage).toEqual({ mode: 'replace', content: 'Be brief.' });
    expect(config.model).toBe(MODEL);
  });

  it('sends an empty replacement when there are no instructions (never an SDK default)', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    expect(mock.sessions()[0].config.systemMessage).toEqual({ mode: 'replace', content: '' });
  });

  it('joins instructions then system and developer messages with a blank line, adding no text', async () => {
    const { mock, adapter } = setup();
    await ask(adapter, {
      instructions: 'I1',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'S1' }] },
        { type: 'message', role: 'developer', content: [{ type: 'text', text: 'D1' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] },
      ],
    });

    const [session] = mock.sessions();
    expect(session.config.systemMessage.content).toBe('I1\n\nS1\n\nD1');
    expect(session.prompts[0].prompt).toBe('Hello');
  });

  it('turns every ambient SDK feature off and points the session at the transport working directory', async () => {
    const { mock, adapter } = setup({ workingDirectory: '/empty/dir' });
    await ask(adapter);

    const { config } = mock.sessions()[0];
    expect(config).toMatchObject({
      streaming: true,
      enableSkills: false,
      skipCustomInstructions: true,
      skipEmbeddingRetrieval: true,
      infiniteSessions: { enabled: false },
      enableSessionStore: false,
      enableConfigDiscovery: false,
      requestExtensions: false,
      requestCanvasRenderer: false,
      enableMcpApps: false,
      workingDirectory: '/empty/dir',
    });
    expect(config.onPermissionRequest()).toEqual({ kind: 'reject' });
  });

  it('never carries a GitHub token setting', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    const config = mock.sessions()[0].config as unknown as Record<string, unknown>;
    expect(Object.keys(config).filter((key) => /token|apikey|auth/i.test(key))).toEqual([]);
  });

  it('is the same frozen template when built directly', () => {
    const config = copilotSessionConfig({ model: MODEL, instructions: 'S', workingDirectory: '/empty' });
    expect(config.availableTools).toEqual([]);
    expect(config.systemMessage).toEqual({ mode: 'replace', content: 'S' });
    expect(config).not.toHaveProperty('reasoningEffort');
    expect(config.hooks.onUserPromptTransformed({ prompt: 'p', transformedPrompt: '<current_datetime>x</current_datetime>\n\np' })).toEqual({
      modifiedTransformedPrompt: 'p',
    });
  });

  it.each([
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)('maps reasoning effort %s to %s', async (effort, expected) => {
    const { mock, adapter } = setup();
    await ask(adapter, { reasoning: { effort } });
    expect(mock.sessions()[0].config.reasoningEffort).toBe(expected);
  });

  it('omits reasoningEffort when the request has none', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    expect(mock.sessions()[0].config).not.toHaveProperty('reasoningEffort');
  });

  it('ignores temperature, maxOutputTokens and toolChoice without tools (the SDK has no per-call setting)', async () => {
    const { mock, adapter } = setup();
    await ask(adapter, { temperature: 0.2, maxOutputTokens: 50, toolChoice: 'none' } as Partial<AiResponseRequest>);

    const [session] = mock.sessions();
    expect(JSON.stringify(session.config)).not.toMatch(/temperature|maxOutputTokens|max_tokens/);
    expect(Object.keys(session.prompts[0]).sort()).toEqual(['prompt', 'sentPrompt']);
  });

  it('uses one fresh session per call', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    await ask(adapter);
    const sessions = mock.sessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(2);
    expect(sessions.every((s) => s.prompts.length === 1)).toBe(true);
  });
});

describe('SUPPRESSION: the datetime prefix', () => {
  it('hands the model exactly the user text', async () => {
    const { mock, adapter } = setup();
    await ask(adapter, { input: 'Summarise this.' });

    const [{ prompts }] = mock.sessions();
    expect(prompts[0].prompt).toBe('Summarise this.');
    expect(prompts[0].sentPrompt).toBe('Summarise this.');
    expect(prompts[0].sentPrompt).not.toContain('current_datetime');
  });

  it('does the same for a structured prompt and a message input', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: '{"title":"T"}' });
    await ask(adapter, { input: userMessage('Extract.'), structuredOutput: { name: 't', schema, strict: true } });
    expect(mock.sessions()[0].prompts[0].sentPrompt).toBe('Extract.');
  });

  it('would reach the model prefixed without the hook (the mock proves the hook is what removes it)', async () => {
    const mock = createCopilotMockTransport();
    const config = copilotSessionConfig({ model: MODEL, instructions: '', workingDirectory: '/x' });
    const { hooks: _hooks, ...withoutHook } = config;
    const session = await mock.createSession(withoutHook as typeof config);
    await session.send({ prompt: 'raw' });
    expect(mock.sessions()[0].prompts[0].sentPrompt).toMatch(/^<current_datetime>.*<\/current_datetime>\n\nraw$/);
  });
});

describe('the built-in tool tripwire', () => {
  it('warns, once, when the session lists a tool and goes on: the prompt is sent and the call answers', async () => {
    const { mock, adapter, logs } = setup({ liveTools: ['bash'] });
    mock.queue({ kind: 'answer', text: 'Fine.' });

    await expect(ask(adapter)).resolves.toMatchObject({ finishReason: 'stop', outputText: 'Fine.' });

    expect(mock.sessions()[0].prompts).toHaveLength(1);
    expect(mock.sessions()[0]).toMatchObject({ aborted: false, disconnected: true, deleted: true });
    const warns = logs.filter((log) => log.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].entry).toEqual({
      msg: "copilot session lists tools that are not the request's own",
      provider: 'copilot',
      tools: ['bash'],
    });

    // The same name on a later session is not logged again; a new name is.
    mock.queue({ kind: 'answer', text: 'Again.' });
    await ask(adapter);
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(1);
  });

  it('goes on the same way on a stream, and logs every listed name in one entry', async () => {
    const { mock, adapter, logs } = setup({ liveTools: ['view', 'edit'] });
    mock.queue({ kind: 'answer', text: 'Streamed.' });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));

    expect(events.map((event) => event.type)).toContain('response.completed');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(logs.filter((log) => log.level === 'warn').map((log) => log.entry.tools)).toEqual([['view', 'edit']]);
    expect(mock.sessions()[0].deleted).toBe(true);
  });

  it('warns about a listed tool and still aborts when the model then CALLS one, naming it in details.tools', async () => {
    const { mock, adapter, logs } = setup({ liveTools: ['bash'] });
    mock.queue({ kind: 'events', events: [{ type: 'tool.execution_start', data: { toolName: 'bash' } }] });

    const error = await failureOf(() => ask(adapter));

    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(error.toJSON().details).toMatchObject({ tools: ['bash'] });
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(1);
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('proceeds when the runtime reports no tool list yet (null) or an empty one', async () => {
    const empty = setup();
    await expect(ask(empty.adapter)).resolves.toMatchObject({ finishReason: 'stop' });

    const unbuilt = setup({}, (mock) => ({
      ...mock,
      async createSession(config) {
        const session = await mock.createSession(config);
        return { ...session, currentToolNames: async () => null };
      },
    }));
    await expect(ask(unbuilt.adapter)).resolves.toMatchObject({ finishReason: 'stop' });
  });

  it.each(['external_tool.requested', 'permission.requested', 'tool.execution_start'])(
    'aborts and fails with AI_CAPABILITY_UNSUPPORTED on a %s event, deleting the session',
    async (type) => {
      const { mock, adapter } = setup();
      mock.queue({
        kind: 'events',
        events: [{ type: 'assistant.message_delta', data: { deltaContent: 'Let me ' } }, { type, data: { toolName: 'bash' } }],
      });

      const error = await failureOf(() => ask(adapter));

      expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
      expect(error.toJSON().details).toMatchObject({ tools: ['bash'] });
      expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
    },
  );

  it('aborts and fails on an assistant.message that carries tool requests', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [{ type: 'assistant.message', data: { content: '', toolRequests: [{ toolCallId: 't1', name: 'bash', arguments: {} }] } }],
    });

    const error = await failureOf(() => ask(adapter));

    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(error.toJSON().details).toMatchObject({ tools: ['bash'] });
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, deleted: true });
  });

  it('ends a stream that already started with exactly one error event', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'events', events: [{ type: 'tool.execution_start', data: {} }] });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));

    expect(events.map((e) => e.type)).toEqual(['response.created', 'error']);
    expect(events[1]).toMatchObject({ type: 'error', code: 'AI_CAPABILITY_UNSUPPORTED' });
  });

  it('accepts an assistant.message with an empty toolRequests array', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message', data: { content: 'fine', toolRequests: [] } },
        { type: 'assistant.usage', data: { finishReason: 'stop' } },
        { type: 'session.idle', data: {} },
      ],
    });
    await expect(ask(adapter)).resolves.toMatchObject({ outputText: 'fine' });
  });
});

describe('SUPPRESSION: no continuation after a length finish', () => {
  it('aborts at once, makes exactly one model request and reports length', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'lengthThenContinue', text: 'cut off' });

    const response = await ask(adapter);
    await settle();

    expect(response).toMatchObject({ finishReason: 'length', outputText: 'cut off' });
    expect(mock.sessions()[0]).toMatchObject({ modelRequests: 1, aborted: true, deleted: true });
  });

  it('is what the mock itself would not do: without an abort the runtime makes a second request', async () => {
    const mock = createCopilotMockTransport();
    mock.queue({ kind: 'lengthThenContinue', text: 'cut off' });
    const session = await mock.createSession(copilotSessionConfig({ model: MODEL, instructions: '', workingDirectory: '/x' }));
    await session.send({ prompt: 'p' });
    await settle(80);
    expect(mock.sessions()[0].modelRequests).toBe(2);
  });

  it('reports length through the stream as well, without the continued text', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'lengthThenContinue', text: 'cut off' });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));
    await settle();

    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'response.completed', response: { finishReason: 'length', outputText: 'cut off' } });
    expect(mock.sessions()[0].modelRequests).toBe(1);
  });
});

describe('SUPPRESSION: no SDK retry after a model call failure', () => {
  it('aborts, makes one model request and maps the failure (the retried answer is never used)', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'callFailure', statusCode: 429, message: 'slow down', thenRetrySucceeds: true });

    const error = await failureOf(() => ask(adapter));
    await settle();

    expect(error.code).toBe('AI_RATE_LIMITED');
    expect(mock.sessions()[0]).toMatchObject({ modelRequests: 1, aborted: true, deleted: true });
  });

  it('reads the failure text from model.call_failure errorMessage and its status from statusCode', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [{ type: 'model.call_failure', data: { source: 'top_level', statusCode: 503, errorMessage: 'upstream is down', failureKind: 'api' } }],
    });

    const error = await failureOf(() => ask(adapter));

    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toBe('GitHub Copilot: upstream is down');
    expect(error.toJSON().details).toMatchObject({ statusCode: 503 });
  });

  it('maps a call failure with an auth status to AI_KEY_INVALID', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'callFailure', statusCode: 401, message: 'bad credentials' });
    expect((await failureOf(() => ask(adapter))).code).toBe('AI_KEY_INVALID');
  });

  it('ends a started stream with one error event after a call failure', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'callFailure', statusCode: 429, message: 'slow down', thenRetrySucceeds: true });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));
    await settle();

    expect(events.map((e) => e.type)).toEqual(['response.created', 'error']);
    expect(events[1]).toMatchObject({ code: 'AI_RATE_LIMITED' });
    expect(mock.sessions()[0].modelRequests).toBe(1);
  });

  it('maps a session.error that follows no call failure', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'sessionError', errorType: 'authentication', statusCode: 401, message: 'nope' });
    expect((await failureOf(() => ask(adapter))).code).toBe('AI_KEY_INVALID');
  });

  it('fails when the session goes idle by an abort the adapter did not ask for', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'events', events: [{ type: 'session.idle', data: { aborted: true } }] });
    const error = await failureOf(() => ask(adapter));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toMatch(/aborted before it answered/);
  });
});

describe('the session is disconnected and deleted on every exit', () => {
  it('on success (no abort needed once the session went idle)', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    expect(mock.sessions()[0]).toMatchObject({ aborted: false, disconnected: true, deleted: true });
  });

  it('on a session error', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'boom' });
    await failureOf(() => ask(adapter));
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('on a send that throws', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'throw', error: new Error('socket closed') });
    const error = await failureOf(() => ask(adapter));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(mock.sessions()[0]).toMatchObject({ disconnected: true, deleted: true });
  });

  it('on a structured answer that fails validation', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'not json' });
    await failureOf(() => ask(adapter, { structuredOutput: { name: 't', schema, strict: true } }));
    expect(mock.sessions()[0]).toMatchObject({ disconnected: true, deleted: true });
  });

  it('when the caller aborts a hung session', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'hang' });
    const controller = new AbortController();
    const pending = adapter.responses.create({ model: MODEL, input: 'Hi' }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 10);

    await expect(pending).rejects.toThrow('caller gave up');
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('when the consumer stops reading a stream early', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'abcdefghijklmnopqrstuvwxyz', chunkSize: 4 });

    const seen: AiStreamEvent[] = [];
    for await (const event of adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx)) {
      seen.push(event);
      if (event.type === 'output_text.delta') break;
    }

    expect(seen.map((e) => e.type)).toEqual(['response.created', 'output_text.delta']);
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('disconnects before it deletes', async () => {
    const order: string[] = [];
    const { adapter } = setup({}, (mock) => ({
      ...mock,
      async createSession(config) {
        const session = await mock.createSession(config);
        return {
          ...session,
          disconnect: async () => {
            order.push('disconnect');
            await session.disconnect();
          },
        };
      },
      async deleteSession(id) {
        order.push('delete');
        await mock.deleteSession(id);
      },
    }));
    await ask(adapter);
    expect(order).toEqual(['disconnect', 'delete']);
  });

  it('swallows a failing cleanup step, logs it without content and still returns the answer', async () => {
    const { adapter, logs } = setup({}, (mock) => ({
      ...mock,
      async createSession(config) {
        const session = await mock.createSession(config);
        return {
          ...session,
          disconnect: async () => {
            throw new Error('disconnect exploded: the prompt was SECRET-PROMPT');
          },
        };
      },
      deleteSession: async () => {
        throw new Error('delete exploded');
      },
    }));

    await expect(ask(adapter, { input: 'SECRET-PROMPT' })).resolves.toMatchObject({ outputText: 'Hello from the Copilot mock.' });

    const warns = logs.filter((l) => l.level === 'warn').map((l) => l.entry);
    expect(warns).toHaveLength(2);
    for (const warn of warns) {
      expect(Object.keys(warn).sort()).toEqual(['code', 'msg', 'provider']);
      expect(warn.provider).toBe('copilot');
    }
    expect(JSON.stringify(warns)).not.toContain('SECRET-PROMPT');
  });

  it('creates no session when the request is refused or nobody is signed in', async () => {
    const refused = setup();
    await failureOf(() => ask(refused.adapter, { previousResponseId: 'r1' }));
    expect(refused.mock.sessions()).toHaveLength(0);

    const signedOut = setup({ signedIn: false });
    await failureOf(() => ask(signedOut.adapter));
    expect(signedOut.mock.sessions()).toHaveLength(0);
  });

  it('leaves nothing behind when createSession itself fails', async () => {
    const { mock, adapter } = setup();
    mock.failNextCreate(new Error('runtime refused the session'));
    const error = await failureOf(() => ask(adapter));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(mock.sessions()).toHaveLength(0);
  });
});

describe('request refusals, all before any session is created', () => {
  const textPart = { type: 'text' as const, text: 'x' };
  const cases: Array<[string, Partial<AiResponseRequest>]> = [
    ['structured output together with tools', { tools: [{ type: 'function', name: 'lookup', description: 'd', parameters: z.object({}) }], structuredOutput: { name: 't', schema } }],
    ['a hosted tool', { tools: [{ type: 'web_search' }] }],
    ['previousResponseId', { previousResponseId: 'resp_1' }],
    ['an assistant message', { input: [{ type: 'message', role: 'assistant', content: [textPart] }] }],
    ['a function_call item', { input: [{ type: 'function_call', callId: 'c1', name: 'lookup', arguments: '{}' }] }],
    ['a function_call_output item', { input: [{ type: 'function_call_output', callId: 'c1', output: 'ok' }] }],
    ['a reasoning item', { input: [{ type: 'reasoning', summary: ['thinking'] }, ...(userMessage('Hi') as never[])] }],
    [
      'two user messages',
      { input: [...(userMessage('one') as never[]), ...(userMessage('two') as never[])] },
    ],
    ['no user message', { input: [{ type: 'message', role: 'system', content: [textPart] }] }],
    ['an image part', { input: [{ type: 'message', role: 'user', content: [textPart, { type: 'image', url: 'https://example.com/a.png' }] }] }],
    ['a file part', { input: [{ type: 'message', role: 'user', content: [{ type: 'file', storageObjectId: 'obj' }] }] }],
  ];

  it.each(cases)('refuses %s with AI_CAPABILITY_UNSUPPORTED', async (_what, req) => {
    const { mock, adapter } = setup();
    const error = await failureOf(() => ask(adapter, req));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(error.message).toMatch(/one user message/);
    expect(mock.sessions()).toHaveLength(0);
  });

  it('refuses in a stream before response.created (it throws, it does not yield an error event)', async () => {
    const { mock, adapter } = setup();
    const error = await failureOf(() => collect(adapter.responses.stream({ model: MODEL, input: 'Hi', previousResponseId: 'r' }, ctx)));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(mock.sessions()).toHaveLength(0);
  });

  it('accepts an empty tools array, system-only extras and a single user message', async () => {
    const { adapter } = setup();
    await expect(ask(adapter, { tools: [] })).resolves.toMatchObject({ outputText: 'Hello from the Copilot mock.' });
  });
});

describe('the sign-in rule', () => {
  it('answers AI_KEY_REQUIRED with the sign-in sentence when nobody is signed in', async () => {
    const { mock, adapter } = setup({ signedIn: false });
    const error = await failureOf(() => ask(adapter));
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(error.message).toBe(COPILOT_SIGN_IN_MESSAGE);
    expect(mock.sessions()).toHaveLength(0);
  });

  it('throws (not an error event) from a stream when nobody is signed in', async () => {
    const { adapter } = setup({ signedIn: false });
    const error = await failureOf(() => collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx)));
    expect(error.code).toBe('AI_KEY_REQUIRED');
  });

  it('verifyKey reports ok:false with AI_KEY_REQUIRED, and ok:true once signed in', async () => {
    const { mock, adapter } = setup({ signedIn: false });
    await expect(adapter.verifyKey(ctx)).resolves.toEqual({ ok: false, code: 'AI_KEY_REQUIRED', detail: 'Sign in to GitHub Copilot.' });
    mock.setSignedIn(true);
    await expect(adapter.verifyKey(ctx)).resolves.toEqual({ ok: true });
    await expect(ask(adapter)).resolves.toBeDefined();
  });

  it('verifyKey never throws: a failing transport is AI_PROVIDER_UNAVAILABLE', async () => {
    const { adapter } = setup({}, (mock) => ({
      ...mock,
      getAuthStatus: async () => {
        throw new Error('runtime not running');
      },
    }));
    const verdict = await adapter.verifyKey(ctx);
    expect(verdict).toMatchObject({ ok: false, code: 'AI_PROVIDER_UNAVAILABLE' });
    expect((verdict as { detail: string }).detail).toMatch(/runtime not running/);
  });

  it('authStatus reports the login only while signed in', async () => {
    const { mock, adapter } = setup({ login: 'hubot' });
    await expect(adapter.authStatus()).resolves.toEqual({ signedIn: true, login: 'hubot' });
    mock.setSignedIn(false);
    await expect(adapter.authStatus()).resolves.toEqual({ signedIn: false, login: null });
  });

  it('maps a runtime that says "not authenticated" while creating a session to AI_KEY_REQUIRED', async () => {
    const { mock, adapter } = setup();
    mock.failNextCreate(new Error('Session was not created because the user is Not Authenticated'));
    const error = await failureOf(() => ask(adapter));
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(error.message).toBe(COPILOT_SIGN_IN_MESSAGE);
  });

  it('passes the adapter own AiError through a transport untouched', async () => {
    const { mock, adapter } = setup();
    const own = new AiError('AI_PROVIDER_UNAVAILABLE', 'The GitHub Copilot SDK is not installed (optional peer @github/copilot-sdk).');
    mock.failNextCreate(own);
    expect(await failureOf(() => ask(adapter))).toBe(own);
  });
});

describe('listModels and classifyModel', () => {
  it('lists the signed-in models, drops disabled ones and maps the limits', async () => {
    const { adapter } = setup({
      models: [
        { id: 'a', name: 'Model A', capabilities: { limits: { max_prompt_tokens: 100, max_context_window_tokens: 999, max_output_tokens: 10 } }, policy: { state: 'enabled' } },
        { id: 'b', name: 'Model B', capabilities: { limits: { max_context_window_tokens: 500 } } },
        { id: 'c', name: 'Model C', policy: { state: 'disabled' } },
        { id: 'd', policy: { state: 'unconfigured' } },
      ],
    });

    const models = await adapter.listModels(ctx);

    expect(models.map((m) => m.id)).toEqual(['a', 'b', 'd']);
    expect(models[0].metadata).toEqual({ displayName: 'Model A', inputTokenLimit: 100, outputTokenLimit: 10 });
    expect(models[1].metadata).toEqual({ displayName: 'Model B', inputTokenLimit: 500 });
    expect(models[2].metadata).toEqual({});
  });

  it('needs a sign-in to list', async () => {
    const { adapter } = setup({ signedIn: false });
    expect((await failureOf(() => adapter.listModels(ctx))).code).toBe('AI_KEY_REQUIRED');
  });

  it('maps a failing listing to AI_PROVIDER_UNAVAILABLE', async () => {
    const { adapter } = setup({}, (mock) => ({
      ...mock,
      listModels: async () => {
        throw new Error('listing failed');
      },
    }));
    expect((await failureOf(() => adapter.listModels(ctx))).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('classifies every model as text-in text-out with responses, streaming, structured output and tools (the bridge)', () => {
    const { adapter } = setup();
    for (const id of [MODEL, CLAUDE, 'gemini-2.5-pro', 'o3', 'something-new']) {
      const result = adapter.classifyModel(id);
      expect(result?.capabilities).toEqual(['responses', 'streaming', 'structured_output', 'tools']);
      expect(result?.inputModalities).toEqual(['text']);
      expect(result?.outputModalities).toEqual(['text']);
    }
  });

  it('prefers the live metadata numbers, then the fallback catalog, else omits them', () => {
    const { adapter } = setup();
    expect(adapter.classifyModel(MODEL, { inputTokenLimit: 1000, outputTokenLimit: 100 })).toMatchObject({ contextWindow: 1000, maxOutputTokens: 100 });
    expect(adapter.classifyModel(MODEL)).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384 });
    expect(adapter.classifyModel(MODEL, { inputTokenLimit: 1000 })).toMatchObject({ contextWindow: 1000, maxOutputTokens: 16_384 });
    const unknown = adapter.classifyModel('something-new');
    expect(unknown).not.toHaveProperty('contextWindow');
    expect(unknown).not.toHaveProperty('maxOutputTokens');
  });
});

describe('the kvox model catalog', () => {
  it('answers null for any other provider and a description for any Copilot id', () => {
    const { adapter } = setup();
    const catalog = adapter.kvox.catalog;
    expect(catalog.lookup('openai', MODEL)).toBeNull();
    expect(catalog.lookup('copilot', MODEL)).toEqual({
      id: MODEL,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      structuredOutput: true,
      toolCalling: true,
      structuredOutputMode: 'native',
    });
    expect(catalog.lookup('copilot', CLAUDE)).toMatchObject({ structuredOutputMode: 'prompted', contextWindow: 200_000 });
    expect(catalog.lookup('copilot', 'gemini-2.5-pro')).toEqual({
      id: 'gemini-2.5-pro',
      contextWindow: null,
      maxOutputTokens: null,
      structuredOutput: true,
      toolCalling: true,
      structuredOutputMode: 'prompted',
    });
    expect(catalog.lookup('copilot', 'o4-mini')).toMatchObject({ structuredOutputMode: 'native' });
  });

  it('honours a catalog passed to the adapter, for the lookup and for the structured-output refusal', async () => {
    const mock = createCopilotMockTransport();
    const adapter = createCopilotAdapter({
      optIn: true,
      transport: mock,
      catalog: [{ id: 'gpt-special', label: 'Special', contextWindow: 10, maxOutputTokens: 5, structuredOutputMode: 'prompted' }],
    });

    expect(adapter.kvox.catalog.lookup('copilot', 'gpt-special')).toMatchObject({ contextWindow: 10, structuredOutputMode: 'prompted' });
    expect(adapter.kvox.catalog.lookup('copilot', MODEL)).toMatchObject({ contextWindow: null });
    const error = await failureOf(() =>
      adapter.responses.create({ model: 'gpt-special', input: 'Hi', structuredOutput: { name: 't', schema } }, ctx),
    );
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
  });
});

describe('structured output', () => {
  const structured = { name: 'title', schema, strict: true } as const;

  it('sends the schema as responseSchema for a native model and returns the parsed value', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: '{"title":"T"}' });

    const response = await ask(adapter, { structuredOutput: structured });

    expect(response.parsed).toEqual({ title: 'T' });
    const sent = mock.sessions()[0].prompts[0].responseSchema;
    expect(sent).toMatchObject({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] });
  });

  it('sends no responseSchema when the call is not structured', async () => {
    const { mock, adapter } = setup();
    await ask(adapter);
    expect(mock.sessions()[0].prompts[0]).not.toHaveProperty('responseSchema');
  });

  it('refuses a structured call on a prompted model before a session exists', async () => {
    const { mock, adapter } = setup();
    for (const model of [CLAUDE, 'claude-haiku-4.5', 'gemini-2.5-pro']) {
      const error = await failureOf(() => ask(adapter, { model, structuredOutput: structured }));
      expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    }
    expect(mock.sessions()).toHaveLength(0);
  });

  it('still answers a plain text call on a prompted model', async () => {
    const { adapter } = setup();
    await expect(ask(adapter, { model: CLAUDE })).resolves.toMatchObject({ outputText: 'Hello from the Copilot mock.' });
  });

  it('answers AI_STRUCTURED_OUTPUT_INVALID with an invalid_json issue for text that is not JSON', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'Sure! Here you go: title is T' });

    const error = await failureOf(() => ask(adapter, { structuredOutput: structured }));

    expect(error.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    const issues = error.toJSON().details.issues as Array<{ path: unknown[]; code: string; message: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: [], code: 'invalid_json' });
    expect(typeof issues[0].message).toBe('string');
  });

  it('answers AI_STRUCTURED_OUTPUT_INVALID with the Zod issues (path, code, message only) for a schema mismatch', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: '{"title": 3}' });

    const error = await failureOf(() => ask(adapter, { structuredOutput: structured }));

    expect(error.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    const issues = error.toJSON().details.issues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: ['title'], code: 'invalid_type' });
    expect(Object.keys(issues[0]).sort()).toEqual(['code', 'message', 'path']);
  });

  it('fails a structured stream with one error event carrying the same code', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'nope' });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi', structuredOutput: structured }, ctx));

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'AI_STRUCTURED_OUTPUT_INVALID' });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it.each(['length', 'content_filter'])('hands a %s structured answer back unparsed with that finish reason (kvox-ai decides)', async (finishReason) => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: '{"title": "cut of', finishReason });

    const response = await ask(adapter, { structuredOutput: structured });

    expect(response.finishReason).toBe(finishReason);
    expect(response.parsed).toBeUndefined();
    expect(response.outputText).toBe('{"title": "cut of');
  });
});

describe('the event mapping', () => {
  it('streams created, deltas, output_item.done and completed, in order, with the ids and provider', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'abcdefghijkl', chunkSize: 5 });

    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));

    expect(events.map((e) => e.type)).toEqual([
      'response.created',
      'output_text.delta',
      'output_text.delta',
      'output_text.delta',
      'output_item.done',
      'response.completed',
    ]);
    const created = events[0] as Extract<AiStreamEvent, { type: 'response.created' }>;
    expect(created.id).toMatch(/^copilot-[0-9a-f-]{36}$/);
    const completed = events.at(-1) as Extract<AiStreamEvent, { type: 'response.completed' }>;
    expect(completed.response).toMatchObject({
      id: created.id,
      provider: 'copilot',
      model: MODEL,
      output: [{ type: 'message', text: 'abcdefghijkl' }],
      outputText: 'abcdefghijkl',
      finishReason: 'stop',
    });
    expect(events[4]).toEqual({ type: 'output_item.done', item: { type: 'message', text: 'abcdefghijkl' } });
  });

  it('create returns the same completed response', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'Hello.' });
    await expect(ask(adapter)).resolves.toMatchObject({ provider: 'copilot', outputText: 'Hello.', output: [{ type: 'message', text: 'Hello.' }] });
  });

  it('maps usage: input, output, reasoning and cacheRead as cachedInputTokens', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'answer', text: 'x', usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 5 } });
    expect((await ask(adapter)).usage).toEqual({ inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 5 });
  });

  it('keeps absent usage counts absent and reports the model the runtime says it used', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message', data: { content: 'x' } },
        { type: 'assistant.usage', data: { model: 'gpt-5-mini-2026', inputTokens: 4, outputTokens: -1 } },
        { type: 'session.idle', data: {} },
      ],
    });
    const response = await ask(adapter);
    expect(response.usage).toEqual({ inputTokens: 4 });
    expect(response.model).toBe('gpt-5-mini-2026');
  });

  it('emits a final assistant.message as one delta when nothing was streamed', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [{ type: 'assistant.message', data: { content: 'whole' } }, { type: 'session.idle', data: {} }],
    });
    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));
    expect(events.filter((e) => e.type === 'output_text.delta')).toEqual([{ type: 'output_text.delta', delta: 'whole' }]);
  });

  it('emits only the remainder when the final message is longer than the streamed text', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message_delta', data: { deltaContent: 'Hello ' } },
        { type: 'assistant.message', data: { content: 'Hello world' } },
        { type: 'session.idle', data: {} },
      ],
    });
    const events = await collect(adapter.responses.stream({ model: MODEL, input: 'Hi' }, ctx));
    expect(events.filter((e) => e.type === 'output_text.delta').map((e) => (e as { delta: string }).delta)).toEqual(['Hello ', 'world']);
    expect((events.at(-1) as { response: { outputText: string } }).response.outputText).toBe('Hello world');
  });

  it('ignores deltas, messages and usage of a nested tool call (parentToolCallId)', async () => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message_delta', data: { deltaContent: 'NESTED', parentToolCallId: 'p1' } },
        { type: 'assistant.message', data: { content: 'NESTED', parentToolCallId: 'p1' } },
        { type: 'assistant.usage', data: { inputTokens: 999, parentToolCallId: 'p1' } },
        { type: 'assistant.message_delta', data: { deltaContent: 'top' } },
        { type: 'assistant.usage', data: { inputTokens: 1, outputTokens: 1 } },
        { type: 'session.idle', data: {} },
      ],
    });
    const response = await ask(adapter);
    expect(response.outputText).toBe('top');
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it.each([
    [{ finishReason: 'stop' }, 'stop'],
    [{ finishReason: 'tool_calls' }, 'stop'],
    [{ finishReason: 'something_new' }, 'stop'],
    [{ finishReason: 'content_filter' }, 'content_filter'],
    [{ finishReason: 'stop', contentFilterTriggered: true }, 'content_filter'],
    [{ finishReason: 'length' }, 'length'],
  ])('maps usage %j to finish reason %s', async (usage, expected) => {
    const { mock, adapter } = setup();
    mock.queue({
      kind: 'events',
      events: [
        { type: 'assistant.message', data: { content: 'x' } },
        { type: 'assistant.usage', data: usage },
        { type: 'session.idle', data: {} },
      ],
    });
    expect((await ask(adapter)).finishReason).toBe(expected);
  });

  it('defaults to stop when no usage event arrives', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'events', events: [{ type: 'assistant.message', data: { content: 'x' } }, { type: 'session.idle', data: {} }] });
    expect((await ask(adapter)).finishReason).toBe('stop');
  });
});

describe('the caller signal', () => {
  it('rethrows the reason of a signal that was already aborted, creating no session', async () => {
    const { mock, adapter } = setup();
    const reason = new DOMException('too late', 'AbortError');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(adapter.responses.create({ model: MODEL, input: 'Hi' }, { ...ctx, signal: controller.signal })).rejects.toBe(reason);
    expect(mock.sessions()).toHaveLength(0);
  });

  it('rethrows the very reason object when the caller aborts mid-call', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'hang' });
    const reason = new DOMException('deadline', 'TimeoutError');
    const controller = new AbortController();
    const pending = adapter.responses.create({ model: MODEL, input: 'Hi' }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 10);

    await expect(pending).rejects.toBe(reason);
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, deleted: true });
  });

  it('throws the reason out of a stream that is aborted after it started (never an error event)', async () => {
    const { mock, adapter } = setup();
    mock.queue({ kind: 'hang' });
    const reason = new Error('stop now');
    const controller = new AbortController();
    const seen: string[] = [];
    setTimeout(() => controller.abort(reason), 10);

    await expect(
      (async () => {
        for await (const event of adapter.responses.stream({ model: MODEL, input: 'Hi' }, { ...ctx, signal: controller.signal })) seen.push(event.type);
      })(),
    ).rejects.toBe(reason);
    expect(seen).toEqual(['response.created']);
    expect(mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
  });

  it('does not wait on a transport that hangs while checking the sign-in', async () => {
    const { adapter } = setup({}, (mock) => ({ ...mock, getAuthStatus: () => new Promise(() => undefined) }));
    const controller = new AbortController();
    const pending = adapter.responses.create({ model: MODEL, input: 'Hi' }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('give up')), 10);
    await expect(pending).rejects.toThrow('give up');
  });
});

describe('the per-call log entry', () => {
  it('logs one info entry with provider, model, duration, counts and finish reason, never content', async () => {
    const { mock, adapter, logs } = setup();
    mock.queue({ kind: 'answer', text: 'THE-ANSWER-TEXT', usage: { inputTokens: 5, outputTokens: 3 } });

    await ask(adapter, { instructions: 'THE-SYSTEM-PROMPT', input: 'THE-USER-PROMPT' });

    expect(logs).toHaveLength(1);
    const [{ level, entry }] = logs;
    expect(level).toBe('info');
    expect(entry).toMatchObject({ msg: 'copilot call', provider: 'copilot', model: MODEL, inputTokens: 5, outputTokens: 3, finishReason: 'stop' });
    expect(typeof entry.durationMs).toBe('number');
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'finishReason', 'inputTokens', 'model', 'msg', 'outputTokens', 'provider']);
    expect(JSON.stringify(logs)).not.toMatch(/THE-(ANSWER-TEXT|SYSTEM-PROMPT|USER-PROMPT)/);
  });

  it('logs finishReason error with null counts on a failure, and still no content', async () => {
    const { mock, adapter, logs } = setup();
    mock.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: 'broke' });
    await failureOf(() => ask(adapter, { input: 'THE-USER-PROMPT' }));

    const infos = logs.filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0].entry).toMatchObject({ finishReason: 'error', inputTokens: null, outputTokens: null });
    expect(JSON.stringify(logs)).not.toContain('THE-USER-PROMPT');
  });

  it('logs the length finish reason', async () => {
    const { mock, adapter, logs } = setup();
    mock.queue({ kind: 'lengthThenContinue', text: 'cut' });
    await ask(adapter);
    expect(logs.find((l) => l.level === 'info')?.entry.finishReason).toBe('length');
  });

  it('works without a logger', async () => {
    const adapter = createCopilotAdapter({ optIn: true, transport: createCopilotMockTransport() });
    await expect(ask(adapter)).resolves.toBeDefined();
  });
});
