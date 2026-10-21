import {
  AI_KEYLESS_API_KEY,
  AiError,
  type AiCallContext,
  type AiInputItem,
  type AiResponse,
  type AiResponseRequest,
  type AiStreamEvent,
} from '@marinoscar/platform-ai-providers';
import { z } from 'zod';

import { copilotSessionConfig, createCopilotAdapter, type CopilotProviderAdapter, type CreateCopilotAdapterOptions } from './copilot-adapter.js';
import { createCopilotMockTransport, type CopilotMockTransport } from './copilot-mock-transport.js';

// =============================================================================
// The tool bridge: Ask on GitHub Copilot through native tool calling (#654)
// =============================================================================
//
// The adapter declares the request's function tools as CUSTOM tools of the session.
// Their handlers resolve only when the caller's loop supplies the tool's output, so a
// step that calls tools ends with `tool_calls`, the session stays open (held), and the
// next request (the loop's whole history plus the `function_call_output` items) is
// continued from the same session. Everything here runs over the mock transport, which
// plays the runtime: it invokes the handlers and WAITS for them, then calls the model
// again with the results.
// =============================================================================

const ctx: AiCallContext = { apiKey: AI_KEYLESS_API_KEY, requestId: 'req-bridge' };
const MODEL = 'gpt-5-mini';

const lookup = { type: 'function' as const, name: 'lookup', description: 'Looks things up.', parameters: z.object({ query: z.string() }) };
const count = { type: 'function' as const, name: 'count', description: 'Counts things.', parameters: z.object({ of: z.string() }) };
const tools = [lookup, count];

const user = (text: string): AiInputItem => ({ type: 'message', role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): AiInputItem => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
const developer = (text: string): AiInputItem => ({ type: 'message', role: 'developer', content: [{ type: 'text', text }] });
const call = (callId: string, name: string, args: unknown): AiInputItem => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});
const output = (callId: string, text: string): AiInputItem => ({ type: 'function_call_output', callId, output: text });

interface Harness {
  mock: CopilotMockTransport;
  adapter: CopilotProviderAdapter;
  logs: Array<{ level: string; entry: Record<string, unknown> }>;
}

function setup(bridge: CreateCopilotAdapterOptions['bridge'] = {}, mock = createCopilotMockTransport()): Harness {
  const logs: Harness['logs'] = [];
  const adapter = createCopilotAdapter({
    optIn: true,
    transport: mock,
    bridge: { batchGraceMs: 200, ...bridge },
    logger: {
      info: (entry) => logs.push({ level: 'info', entry }),
      warn: (entry) => logs.push({ level: 'warn', entry }),
    },
  });
  return { mock, adapter, logs };
}

/** One Ask step: the request, streamed to the end. */
async function step(
  adapter: CopilotProviderAdapter,
  input: AiInputItem[],
  extra: Partial<AiResponseRequest> = {},
  callContext: AiCallContext = ctx,
): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of adapter.responses.stream(
    { model: MODEL, instructions: 'You answer questions.', input, tools, toolChoice: 'auto', ...extra } as AiResponseRequest,
    callContext,
  )) {
    events.push(event);
  }
  return events;
}

/** One Ask step through `create`, which throws the failure a stream would end with an `error` event. */
const createStep = (
  adapter: CopilotProviderAdapter,
  input: AiInputItem[],
  extra: Partial<AiResponseRequest> = {},
): Promise<AiResponse> =>
  adapter.responses.create(
    { model: MODEL, instructions: 'You answer questions.', input, tools, toolChoice: 'auto', ...extra } as AiResponseRequest,
    ctx,
  );

const completedOf = (events: AiStreamEvent[]): AiResponse => {
  const done = events.find((event): event is Extract<AiStreamEvent, { type: 'response.completed' }> => event.type === 'response.completed');
  if (done === undefined) throw new Error('the stream did not complete');
  return done.response;
};

const textOf = (events: AiStreamEvent[]): string =>
  events.flatMap((event) => (event.type === 'output_text.delta' ? [event.delta] : [])).join('');

const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function failureOf(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (error) {
    expect(AiError.isAiError(error)).toBe(true);
    return error as AiError;
  }
  throw new Error('expected a failure');
}

/** Every session is disconnected and deleted, and nothing is held. */
function expectNoLeak({ mock, adapter }: Harness): void {
  expect(adapter.bridge.heldSessions()).toBe(0);
  for (const session of mock.sessions()) {
    expect({ id: session.sessionId, disconnected: session.disconnected, deleted: session.deleted }).toEqual({
      id: session.sessionId,
      disconnected: true,
      deleted: true,
    });
  }
}

// -----------------------------------------------------------------------------

describe('the session of a request that carries tools', () => {
  it('declares exactly the request tools as custom tools, with an allowlist of their own names', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'No tools needed.' });
    await step(h.adapter, [user('Hi')]);

    const [{ config }] = h.mock.sessions();
    expect(config.availableTools).toEqual(['custom:lookup', 'custom:count']);
    expect(config.tools?.map((tool) => tool.name)).toEqual(['lookup', 'count']);
    expect(config.tools?.every((tool) => tool.skipPermission && tool.defer === 'never')).toBe(true);
    // Every tool is sent with overridesBuiltInTool, so a name that clashes with a runtime built-in cannot fail session creation.
    expect(config.tools?.map((tool) => tool.overridesBuiltInTool)).toEqual([true, true]);
    expect(config.tools?.[0].description).toBe('Looks things up.');
    expect(config.tools?.[0].parameters).toMatchObject({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });
    expect(config.tools?.[0].parameters).not.toHaveProperty('$schema');
    expect(config.systemMessage).toEqual({ mode: 'replace', content: 'You answer questions.' });
  });

  it('creates the session when a tool name clashes with a runtime built-in (the flag is what allows it)', async () => {
    const h = setup({}, createCopilotMockTransport({ builtInTools: ['lookup', 'search'] }));
    h.mock.queue({ kind: 'answer', text: 'No clash.' });

    const response = await createStep(h.adapter, [user('Hi')]);

    expect(response.outputText).toBe('No clash.');
    expect(h.mock.sessions()[0].config.tools?.every((tool) => tool.overridesBuiltInTool === true)).toBe(true);
    expectNoLeak(h);
  });

  it('would fail to create the session without the flag (the mock plays the runtime)', async () => {
    const mock = createCopilotMockTransport({ builtInTools: ['lookup'] });
    const tool = { name: 'lookup', description: 'd', parameters: {}, skipPermission: true, defer: 'never', handler: async () => '' } as const;
    const config = (extra: object) =>
      copilotSessionConfig({ model: MODEL, instructions: '', workingDirectory: '/x', tools: [{ ...tool, ...extra } as never] });

    await expect(mock.createSession(config({}))).rejects.toThrow(/clashes with a built-in/);
    await expect(mock.createSession(config({ overridesBuiltInTool: true }))).resolves.toBeDefined();
  });

  it('approves the permission request of its own custom tool and rejects every other', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'ok' });
    await step(h.adapter, [user('Hi')]);

    const { onPermissionRequest } = h.mock.sessions()[0].config;
    expect(onPermissionRequest({ kind: 'custom-tool', toolName: 'lookup' })).toEqual({ kind: 'approve-once' });
    expect(onPermissionRequest({ kind: 'custom-tool', toolName: 'bash' })).toEqual({ kind: 'reject' });
    expect(onPermissionRequest({ kind: 'shell' })).toEqual({ kind: 'reject' });
    expect(onPermissionRequest({ kind: 'mcp', toolName: 'lookup' })).toEqual({ kind: 'reject' });
    expect(onPermissionRequest()).toEqual({ kind: 'reject' });
  });

  it('sends a lone user message as it is, with no transcript framing', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'ok' });
    await step(h.adapter, [user('Who is Acme?')]);
    expect(h.mock.sessions()[0].prompts[0].prompt).toBe('Who is Acme?');
  });

  it('refuses a hosted tool and structured output together with tools, before a session', async () => {
    const h = setup();
    const hosted = await failureOf(() => step(h.adapter, [user('Hi')], { tools: [lookup, { type: 'web_search' }] }));
    expect(hosted.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    const structured = await failureOf(() =>
      step(h.adapter, [user('Hi')], { structuredOutput: { name: 'x', schema: z.object({ a: z.string() }) } }),
    );
    expect(structured.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(h.mock.sessions()).toHaveLength(0);
  });

  it('still refuses history items on a request without tools', async () => {
    const h = setup();
    const error = await failureOf(() => h.adapter.responses.create({ model: MODEL, input: [user('Hi'), assistant('Hello')] }, ctx));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(h.mock.sessions()).toHaveLength(0);
  });
});

describe('one tool call, its output, then the answer', () => {
  it('ends the first step with the call, holds the session, and finishes the answer on the same session', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'acme' }, toolCallId: 'call-1' }], usage: { inputTokens: 30, outputTokens: 5 } });
    h.mock.queue({ kind: 'answer', text: 'Acme is a client.', usage: { inputTokens: 50, outputTokens: 7 } });

    // Step 1: the model calls the tool.
    const first = await step(h.adapter, [user('Who is Acme?')]);

    expect(first.map((event) => event.type)).toEqual(['response.created', 'output_item.done', 'response.completed']);
    expect(first[1]).toEqual({
      type: 'output_item.done',
      item: { type: 'function_call', callId: 'call-1', name: 'lookup', arguments: '{"query":"acme"}' },
    });
    const response1 = completedOf(first);
    expect(response1).toMatchObject({
      provider: 'copilot',
      finishReason: 'tool_calls',
      outputText: '',
      output: [{ type: 'function_call', callId: 'call-1' }],
      usage: { inputTokens: 30, outputTokens: 5 },
    });
    // The session is held, open, with nothing deleted.
    expect(h.adapter.bridge.heldSessions()).toBe(1);
    expect(h.mock.sessions()).toHaveLength(1);
    expect(h.mock.sessions()[0]).toMatchObject({ aborted: false, disconnected: false, deleted: false });

    // Step 2: the loop's history plus the tool output.
    const second = await step(h.adapter, [
      user('Who is Acme?'),
      call('call-1', 'lookup', { query: 'acme' }),
      output('call-1', '{"hits":["Acme Corp"]}'),
    ]);

    expect(textOf(second)).toBe('Acme is a client.');
    expect(completedOf(second)).toMatchObject({
      finishReason: 'stop',
      outputText: 'Acme is a client.',
      output: [{ type: 'message', text: 'Acme is a client.' }],
      usage: { inputTokens: 50, outputTokens: 7 },
    });
    // The very same session served both steps; its handler got the loop's output; it is gone.
    const sessions = h.mock.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].prompts).toHaveLength(1);
    expect(sessions[0].toolRuns).toEqual([
      { toolCallId: 'call-1', name: 'lookup', arguments: { query: 'acme' }, output: '{"hits":["Acme Corp"]}' },
    ]);
    expect(sessions[0].continuations).toBe(1);
    expectNoLeak(h);
  });

  it('keeps the text before the call as the step message, with deltas that add up to it', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', text: 'Let me look that up. ', calls: [{ name: 'lookup', arguments: { query: 'x' }, toolCallId: 'c1' }] });
    const events = await step(h.adapter, [user('Q')]);

    expect(textOf(events)).toBe('Let me look that up. ');
    const response = completedOf(events);
    expect(response.outputText).toBe('Let me look that up. ');
    expect(response.output.map((item) => item.type)).toEqual(['message', 'function_call']);
    expect(response.finishReason).toBe('tool_calls');
    await h.adapter.bridge.closeAll();
    expectNoLeak(h);
  });

  it('ends the step on the usage even when the runtime reports no tool events', async () => {
    const h = setup({ batchGraceMs: 5_000 });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'c1' }], omitToolEvents: true });
    const started = Date.now();
    const events = await step(h.adapter, [user('Q')]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(completedOf(events).finishReason).toBe('tool_calls');
    await h.adapter.bridge.closeAll();
  });

  it('ends the step after the grace when neither usage nor a tool event follows the message', async () => {
    const h = setup({ batchGraceMs: 60 });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'c1' }], omitToolEvents: true, omitUsage: true });
    const events = await step(h.adapter, [user('Q')]);
    expect(completedOf(events)).toMatchObject({ finishReason: 'tool_calls', output: [{ type: 'function_call', callId: 'c1' }] });
    await h.adapter.bridge.closeAll();
  });

  it('a late handler invocation still receives the output (the loop was faster than the runtime)', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'c1' }] });
    h.mock.queue({ kind: 'answer', text: 'Done.' });
    await step(h.adapter, [user('Q')]);
    // Answered immediately: the mock's handler call has not happened yet.
    const second = await step(h.adapter, [user('Q'), call('c1', 'lookup', {}), output('c1', 'result')]);
    expect(textOf(second)).toBe('Done.');
    expect(h.mock.sessions()[0].toolRuns[0]).toMatchObject({ output: 'result' });
    expectNoLeak(h);
  });

  it('matches a handler whose invocation id differs from the id the assistant message listed', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'listed-1', invokedAs: 'invoked-1' }] });
    h.mock.queue({ kind: 'answer', text: 'Matched.' });
    await step(h.adapter, [user('Q')]);
    await settle(30);
    const second = await step(h.adapter, [user('Q'), call('listed-1', 'lookup', { query: 'a' }), output('listed-1', 'out')]);
    expect(textOf(second)).toBe('Matched.');
    expect(h.mock.sessions()[0].toolRuns[0]).toMatchObject({ toolCallId: 'listed-1', invokedAs: 'invoked-1', output: 'out' });
    expectNoLeak(h);
  });
});

describe('parallel tool calls', () => {
  const parallel = [
    { name: 'lookup', arguments: { query: 'acme' }, toolCallId: 'p1' },
    { name: 'count', arguments: { of: 'deals' }, toolCallId: 'p2' },
  ];

  it.each([['parallel' as const], ['sequential' as const]])(
    'waits for the whole batch (%s handlers), then answers once every output is in',
    async (order) => {
      const h = setup();
      h.mock.queue({ kind: 'toolCalls', calls: parallel, order });
      h.mock.queue({ kind: 'answer', text: 'Both are in.' });

      const first = await step(h.adapter, [user('Q')]);
      const calls = completedOf(first).output.filter((item) => item.type === 'function_call');
      expect(calls).toEqual([
        { type: 'function_call', callId: 'p1', name: 'lookup', arguments: '{"query":"acme"}' },
        { type: 'function_call', callId: 'p2', name: 'count', arguments: '{"of":"deals"}' },
      ]);
      expect(first.filter((event) => event.type === 'output_item.done')).toHaveLength(2);
      expect(completedOf(first).finishReason).toBe('tool_calls');
      expect(h.adapter.bridge.heldSessions()).toBe(1);

      const second = await step(h.adapter, [
        user('Q'),
        call('p1', 'lookup', { query: 'acme' }),
        call('p2', 'count', { of: 'deals' }),
        output('p1', 'one'),
        output('p2', 'two'),
      ]);

      expect(textOf(second)).toBe('Both are in.');
      expect(h.mock.sessions()).toHaveLength(1);
      expect(h.mock.sessions()[0].toolRuns.map((run) => run.output)).toEqual(['one', 'two']);
      expectNoLeak(h);
    },
  );

  it('does not continue the session when only some of the calls are answered: it is released and the step starts over from the transcript', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: parallel });
    h.mock.queue({ kind: 'answer', text: 'From the transcript.' });

    await step(h.adapter, [user('Q')]);
    const second = await step(h.adapter, [user('Q'), call('p1', 'lookup', { query: 'acme' }), call('p2', 'count', { of: 'deals' }), output('p1', 'one')]);

    expect(textOf(second)).toBe('From the transcript.');
    const sessions = h.mock.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ aborted: true, deleted: true });
    expect(sessions[1].prompts[0].prompt).toContain('Conversation so far:');
    expectNoLeak(h);
  });
});

describe('several tool steps in one turn', () => {
  it('keeps one session across tool, tool, answer, and deletes it only at the end', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'acme' }, toolCallId: 's1' }], usage: { inputTokens: 10, outputTokens: 1 } });
    h.mock.queue({ kind: 'toolCalls', text: 'Now the count. ', calls: [{ name: 'count', arguments: { of: 'deals' }, toolCallId: 's2' }], usage: { inputTokens: 20, outputTokens: 2 } });
    h.mock.queue({ kind: 'answer', text: 'Acme has 3 deals.', usage: { inputTokens: 30, outputTokens: 4 } });

    const one = await step(h.adapter, [user('How many deals?')]);
    expect(completedOf(one)).toMatchObject({ finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1 } });

    const afterOne: AiInputItem[] = [user('How many deals?'), call('s1', 'lookup', { query: 'acme' }), output('s1', 'acme-id')];
    const two = await step(h.adapter, afterOne);
    expect(textOf(two)).toBe('Now the count. ');
    expect(completedOf(two)).toMatchObject({
      finishReason: 'tool_calls',
      output: [{ type: 'message' }, { type: 'function_call', callId: 's2', name: 'count' }],
      usage: { inputTokens: 20, outputTokens: 2 },
    });
    // Still the first session, held again; nothing was deleted in between.
    expect(h.adapter.bridge.heldSessions()).toBe(1);
    expect(h.mock.sessions()).toHaveLength(1);
    expect(h.mock.sessions()[0]).toMatchObject({ deleted: false, disconnected: false });

    const three = await step(h.adapter, [
      ...afterOne,
      assistant('Now the count. '),
      call('s2', 'count', { of: 'deals' }),
      output('s2', '3'),
    ]);
    expect(textOf(three)).toBe('Acme has 3 deals.');
    expect(completedOf(three)).toMatchObject({ finishReason: 'stop', usage: { inputTokens: 30, outputTokens: 4 } });

    expect(h.mock.sessions()).toHaveLength(1);
    expect(h.mock.sessions()[0].toolRuns.map((run) => [run.toolCallId, run.output])).toEqual([
      ['s1', 'acme-id'],
      ['s2', '3'],
    ]);
    expect(h.mock.sessions()[0].continuations).toBe(2);
    expectNoLeak(h);
  });
});

describe('the lost-session fallback: a step never fails for lack of state', () => {
  const history: AiInputItem[] = [
    user('Who is Acme?'),
    assistant('Let me check. '),
    call('call-9', 'lookup', { query: 'acme' }),
    output('call-9', '{"hits":["Acme Corp"]}'),
  ];

  it('starts a fresh session with the transcript rendered as text and the same tools (a restarted process)', async () => {
    const mock = createCopilotMockTransport();
    mock.queue({ kind: 'answer', text: 'Acme Corp is a client.' });
    // An adapter that has never seen call-9: nothing is held.
    const { adapter } = setup({}, mock);

    const events = await step(adapter, history);

    expect(textOf(events)).toBe('Acme Corp is a client.');
    const [session] = mock.sessions();
    expect(session.config.tools?.map((tool) => tool.name)).toEqual(['lookup', 'count']);
    expect(session.config.availableTools).toEqual(['custom:lookup', 'custom:count']);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].prompt).toBe(
      [
        'Conversation so far:',
        '[user]\nWho is Acme?',
        '[assistant]\nLet me check. ',
        '[assistant called the tool lookup (call call-9)]\n{"query":"acme"}',
        '[result of the tool lookup (call call-9)]\n{"hits":["Acme Corp"]}',
        'Continue as the assistant: answer, or call a tool if you need more information.',
      ].join('\n\n'),
    );
    expect(session.deleted).toBe(true);
  });

  it('the fallback step may itself call tools, and the next step continues THAT session', async () => {
    const mock = createCopilotMockTransport();
    mock.queue({ kind: 'toolCalls', calls: [{ name: 'count', arguments: { of: 'deals' }, toolCallId: 'n1' }] });
    mock.queue({ kind: 'answer', text: 'Three.' });
    const { adapter } = setup({}, mock);

    const first = await step(adapter, history);
    expect(completedOf(first).finishReason).toBe('tool_calls');
    const second = await step(adapter, [...history, call('n1', 'count', { of: 'deals' }), output('n1', '3')]);

    expect(textOf(second)).toBe('Three.');
    expect(mock.sessions()).toHaveLength(1);
    expect(mock.sessions()[0].deleted).toBe(true);
  });

  it.each([
    ['an id nobody holds', (id: string) => output(`${id}-other`, 'x')],
  ])('falls back on %s', async (_what, mismatch) => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'held-1' }] });
    h.mock.queue({ kind: 'answer', text: 'Recovered.' });

    await step(h.adapter, [user('Q')]);
    const events = await step(h.adapter, [user('Q'), call('held-1-other', 'lookup', { query: 'a' }), mismatch('held-1')]);

    expect(textOf(events)).toBe('Recovered.');
    expect(h.mock.sessions()).toHaveLength(2);
    // The unrelated held session is not touched by a request that does not name it; the idle timer or closeAll ends it.
    expect(h.adapter.bridge.heldSessions()).toBe(1);
    await h.adapter.bridge.closeAll();
    expectNoLeak(h);
  });

  it('releases a held session whose request was edited (another system prompt) and starts over', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'e1' }] });
    h.mock.queue({ kind: 'answer', text: 'Fresh.' });

    await step(h.adapter, [user('Q')]);
    const events = await step(h.adapter, [user('Q'), call('e1', 'lookup', { query: 'a' }), output('e1', 'x')], { instructions: 'Different rules.' });

    expect(textOf(events)).toBe('Fresh.');
    const sessions = h.mock.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ aborted: true, deleted: true });
    expect(sessions[1].config.systemMessage.content).toBe('Different rules.');
    expectNoLeak(h);
  });

  it('releases a held session when the request ends with something other than its outputs (a new user message)', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'u1' }] });
    h.mock.queue({ kind: 'answer', text: 'Moved on.' });

    await step(h.adapter, [user('Q')]);
    const events = await step(h.adapter, [user('Q'), call('u1', 'lookup', { query: 'a' }), output('u1', 'x'), user('Never mind, who is Bob?')]);

    expect(textOf(events)).toBe('Moved on.');
    expect(h.mock.sessions()[0]).toMatchObject({ aborted: true, deleted: true });
    expect(h.mock.sessions()[1].prompts[0].prompt).toContain('[user]\nNever mind, who is Bob?');
    expectNoLeak(h);
  });

  it('a held session that went idle by itself is dropped, and the step falls back', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'd1' }] });
    h.mock.queue({ kind: 'answer', text: 'Fallback.' });

    await step(h.adapter, [user('Q')]);
    h.mock.emit(h.mock.sessions()[0].sessionId, { type: 'session.idle', data: {} });
    await settle(30);
    expect(h.adapter.bridge.heldSessions()).toBe(0);
    expect(h.mock.sessions()[0].deleted).toBe(true);

    const events = await step(h.adapter, [user('Q'), call('d1', 'lookup', { query: 'a' }), output('d1', 'x')]);
    expect(textOf(events)).toBe('Fallback.');
    expect(h.mock.sessions()).toHaveLength(2);
    expectNoLeak(h);
  });

  it('with toolChoice none (the forced answer) declares no tool, renders the transcript, and releases the held session', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 'f1' }] });
    h.mock.queue({ kind: 'answer', text: 'Final answer.' });

    await step(h.adapter, [user('Q')]);
    const events = await step(
      h.adapter,
      [user('Q'), call('f1', 'lookup', { query: 'a' }), output('f1', 'x'), developer('Answer now.')],
      { toolChoice: 'none' },
    );

    expect(textOf(events)).toBe('Final answer.');
    const sessions = h.mock.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ aborted: true, deleted: true });
    expect(sessions[1].config.availableTools).toEqual([]);
    expect(sessions[1].config.tools).toBeUndefined();
    expect(sessions[1].config.systemMessage.content).toBe('You answer questions.\n\nAnswer now.');
    expect(sessions[1].prompts[0].prompt).toContain('[result of the tool lookup (call f1)]\nx');
    expect(sessions[1].prompts[0].prompt.endsWith('Continue as the assistant and answer.')).toBe(true);
    expectNoLeak(h);
  });

  it('drops opaque reasoning items from the transcript', async () => {
    const mock = createCopilotMockTransport();
    mock.queue({ kind: 'answer', text: 'ok' });
    const { adapter } = setup({}, mock);
    await step(adapter, [user('Q'), { type: 'reasoning', summary: ['secret thoughts'] }, call('r1', 'lookup', {}), output('r1', 'x')]);
    expect(mock.sessions()[0].prompts[0].prompt).not.toContain('secret thoughts');
  });
});

describe('a tool that is not one of the request\'s own still aborts the call', () => {
  it.each([
    ['a built-in tool the model calls', { kind: 'toolCalls' as const, calls: [{ name: 'bash', arguments: { command: 'ls' } }] }],
    ['a tool the request did not declare', { kind: 'toolCalls' as const, calls: [{ name: 'lookup', toolCallId: 'ok-1' }, { name: 'delete_everything' }] }],
  ])('%s', async (_what, reply) => {
    const h = setup();
    h.mock.queue(reply);

    const error = await failureOf(() => createStep(h.adapter, [user('Q')]));

    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(h.mock.sessions()).toHaveLength(1);
    expect(h.mock.sessions()[0]).toMatchObject({ aborted: true });
    expectNoLeak(h);
  });

  it('names the offending tool in the error details, not its arguments', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'bash', arguments: { command: 'cat ~/.ssh/id_rsa' } }] });
    const error = await failureOf(() => createStep(h.adapter, [user('Q')]));
    expect(JSON.stringify(error.toJSON())).toContain('bash');
    expect(JSON.stringify(error.toJSON())).not.toContain('id_rsa');
  });

  it('fails the stream with exactly one error event once it started', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'bash' }] });
    const events: AiStreamEvent[] = [];
    for await (const event of h.adapter.responses.stream({ model: MODEL, input: 'Q', tools }, ctx)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['response.created', 'error']);
    expect(events[1]).toMatchObject({ code: 'AI_CAPABILITY_UNSUPPORTED' });
  });

  it('warns about a live tool list that holds more than the request\'s own tools, and goes on', async () => {
    const h = setup({}, createCopilotMockTransport({ liveTools: ['bash', 'internal_x'] }));
    h.mock.queue({ kind: 'answer', text: 'Went on.' });

    await expect(createStep(h.adapter, [user('Q')])).resolves.toMatchObject({ outputText: 'Went on.' });

    expect(h.mock.sessions()[0].prompts).toHaveLength(1);
    const warns = h.logs.filter((log) => log.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].entry).toMatchObject({ provider: 'copilot', tools: ['bash', 'internal_x'] });
    // Names only: the entry carries nothing but the message, the provider and the names.
    expect(Object.keys(warns[0].entry).sort()).toEqual(['msg', 'provider', 'tools']);
    expectNoLeak(h);
  });

  it('a listed extra tool does not hide a CALL of one: the call still aborts, with the tool in details.tools', async () => {
    const h = setup({}, createCopilotMockTransport({ liveTools: ['bash'] }));
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'bash' }] });
    const error = await failureOf(() => createStep(h.adapter, [user('Q')]));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(error.toJSON().details).toMatchObject({ tools: ['bash'] });
    expect(h.logs.filter((log) => log.level === 'warn')).toHaveLength(1);
    expectNoLeak(h);
  });

  it('accepts a live tool list that is exactly the request\'s own tools', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'fine' });
    await expect(createStep(h.adapter, [user('Q')])).resolves.toBeDefined();
  });

  it.each([
    ['external_tool.requested', { toolName: 'view', toolCallId: 'x', requestId: 'r' }],
    ['tool.execution_start', { toolName: 'edit', toolCallId: 'x' }],
    ['permission.requested', { permissionRequest: { kind: 'shell', toolCallId: 'x' }, requestId: 'r' }],
    ['permission.requested', { permissionRequest: { kind: 'custom-tool', toolName: 'bash' }, requestId: 'r' }],
    ['permission.requested', { permissionRequest: { kind: 'mcp', toolName: 'lookup' }, requestId: 'r' }],
  ])('a %s event for a foreign tool aborts, even while the request has tools', async (type, data) => {
    const h = setup();
    h.mock.queue({ kind: 'events', events: [{ type, data }] });
    const error = await failureOf(() => createStep(h.adapter, [user('Q')]));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expectNoLeak(h);
  });

  it('an assistant message that lists an MCP tool of the same name aborts', async () => {
    const h = setup();
    h.mock.queue({
      kind: 'events',
      events: [{ type: 'assistant.message', data: { content: '', toolRequests: [{ toolCallId: 'm1', name: 'lookup', arguments: {}, mcpServerName: 'x' }] } }],
    });
    const error = await failureOf(() => createStep(h.adapter, [user('Q')]));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expectNoLeak(h);
  });

  it('a request without tools still has no tool at all: any tool event aborts', async () => {
    const h = setup();
    h.mock.queue({ kind: 'events', events: [{ type: 'tool.execution_start', data: { toolName: 'lookup' } }] });
    const error = await failureOf(() => h.adapter.responses.create({ model: MODEL, input: 'Q' }, ctx));
    expect(error.code).toBe('AI_CAPABILITY_UNSUPPORTED');
    expect(h.mock.sessions()[0].config.availableTools).toEqual([]);
    expectNoLeak(h);
  });
});

describe('cleanup: a held session never outlives its turn', () => {
  it('deletes a held session when the loop does not come back within the idle timeout', async () => {
    const h = setup({ idleTimeoutMs: 40 });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 't1' }] });
    await step(h.adapter, [user('Q')]);
    expect(h.adapter.bridge.heldSessions()).toBe(1);
    expect(h.mock.sessions()[0].deleted).toBe(false);

    await settle(150);

    expect(h.adapter.bridge.heldSessions()).toBe(0);
    expect(h.mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
    expect(h.logs.some((log) => log.entry.msg === 'copilot held session expired')).toBe(true);
    expectNoLeak(h);
  });

  it('after the timeout the loop\'s next step falls back instead of failing', async () => {
    const h = setup({ idleTimeoutMs: 30 });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'a' }, toolCallId: 't2' }] });
    h.mock.queue({ kind: 'answer', text: 'Late but fine.' });
    await step(h.adapter, [user('Q')]);
    await settle(120);

    const events = await step(h.adapter, [user('Q'), call('t2', 'lookup', { query: 'a' }), output('t2', 'x')]);

    expect(textOf(events)).toBe('Late but fine.');
    expect(h.mock.sessions()).toHaveLength(2);
    expectNoLeak(h);
  });

  it('a claimed session no longer expires', async () => {
    const h = setup({ idleTimeoutMs: 60 });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 't3' }] });
    h.mock.queue({ kind: 'answer', text: 'Answered.' });
    await step(h.adapter, [user('Q')]);
    const second = await step(h.adapter, [user('Q'), call('t3', 'lookup', {}), output('t3', 'x')]);
    await settle(120);
    expect(textOf(second)).toBe('Answered.');
    expect(h.logs.some((log) => log.entry.msg === 'copilot held session expired')).toBe(false);
    expect(h.mock.sessions()).toHaveLength(1);
    expectNoLeak(h);
  });

  it('aborting the signal in the middle of a continuation deletes the session', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'a1' }] });
    h.mock.queue({ kind: 'hang' });
    await step(h.adapter, [user('Q')]);

    const controller = new AbortController();
    const pending = step(h.adapter, [user('Q'), call('a1', 'lookup', {}), output('a1', 'x')], {}, { ...ctx, signal: controller.signal });
    await settle(30);
    controller.abort(new DOMException('stop', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.mock.sessions()[0]).toMatchObject({ aborted: true, disconnected: true, deleted: true });
    expectNoLeak(h);
  });

  it('aborting the signal in the middle of the first step deletes the session', async () => {
    const h = setup();
    h.mock.queue({ kind: 'hang' });
    const controller = new AbortController();
    const pending = step(h.adapter, [user('Q')], {}, { ...ctx, signal: controller.signal });
    await settle(30);
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expectNoLeak(h);
  });

  it('an already aborted signal creates no session and leaves a held one to its timer', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'b1' }] });
    await step(h.adapter, [user('Q')]);
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(step(h.adapter, [user('Q'), call('b1', 'lookup', {}), output('b1', 'x')], {}, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.mock.sessions()).toHaveLength(1);
    await h.adapter.bridge.closeAll();
    expectNoLeak(h);
  });

  it('deletes the session when the continuation fails', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'x1' }] });
    h.mock.queue({ kind: 'sessionError', errorType: 'rate_limit', statusCode: 429, message: 'Too many requests' });
    await step(h.adapter, [user('Q')]);

    const events: AiStreamEvent[] = [];
    for await (const event of h.adapter.responses.stream(
      { model: MODEL, input: [user('Q'), call('x1', 'lookup', {}), output('x1', 'x')], tools },
      ctx,
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'AI_RATE_LIMITED' });
    expectNoLeak(h);
  });

  it('a consumer that stops reading a step does not leak: the session is deleted', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'A long enough answer to stream in chunks.' });
    for await (const event of h.adapter.responses.stream({ model: MODEL, input: [user('Q')], tools }, ctx)) {
      if (event.type === 'output_text.delta') break;
    }
    await settle(30);
    expectNoLeak(h);
  });

  it('a step that finishes with a plain answer holds nothing', async () => {
    const h = setup();
    h.mock.queue({ kind: 'answer', text: 'Straight answer.' });
    await step(h.adapter, [user('Q')]);
    expectNoLeak(h);
  });

  it('closeAll deletes every held session', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'ca1' }] });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'ca2' }] });
    await step(h.adapter, [user('Q1')]);
    await step(h.adapter, [user('Q2')]);
    expect(h.adapter.bridge.heldSessions()).toBe(2);
    await h.adapter.bridge.closeAll();
    expectNoLeak(h);
  });

  it('bounds the registry: a newer held session pushes the oldest one out', async () => {
    const h = setup({ maxHeldSessions: 2 });
    for (const id of ['o1', 'o2', 'o3']) {
      h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: id }] });
      await step(h.adapter, [user(`Q ${id}`)]);
    }
    expect(h.adapter.bridge.heldSessions()).toBe(2);
    const sessions = h.mock.sessions();
    expect(sessions.map((session) => session.deleted)).toEqual([true, false, false]);
    await h.adapter.bridge.closeAll();
    expectNoLeak(h);
  });

  it('two turns at once never take each other\'s tool outputs', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'k1' }] });
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'k2' }] });
    h.mock.queue({ kind: 'answer', text: 'for the second' });
    h.mock.queue({ kind: 'answer', text: 'for the first' });
    await step(h.adapter, [user('A')]);
    await step(h.adapter, [user('B')]);

    const second = await step(h.adapter, [user('B'), call('k2', 'lookup', {}), output('k2', 'two')]);
    const first = await step(h.adapter, [user('A'), call('k1', 'lookup', {}), output('k1', 'one')]);

    expect(textOf(second)).toBe('for the second');
    expect(textOf(first)).toBe('for the first');
    expect(h.mock.sessions().map((session) => session.toolRuns[0].output)).toEqual(['one', 'two']);
    expectNoLeak(h);
  });
});

describe('what the bridge reports', () => {
  it('logs metadata only: no prompt, argument, output or answer', async () => {
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', arguments: { query: 'SECRET-ARGUMENT' }, toolCallId: 'l1' }] });
    h.mock.queue({ kind: 'answer', text: 'SECRET-ANSWER' });
    await step(h.adapter, [user('SECRET-QUESTION')]);
    await step(h.adapter, [user('SECRET-QUESTION'), call('l1', 'lookup', { query: 'SECRET-ARGUMENT' }), output('l1', 'SECRET-OUTPUT')]);

    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toMatch(/SECRET/);
    const infos = h.logs.filter((log) => log.entry.msg === 'copilot call').map((log) => log.entry);
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ provider: 'copilot', model: MODEL, finishReason: 'tool_calls', heldForTools: true });
    expect(infos[1]).toMatchObject({ finishReason: 'stop', resumed: true });
    expect(Object.keys(infos[0]).sort()).toEqual(
      ['durationMs', 'finishReason', 'heldForTools', 'inputTokens', 'model', 'msg', 'outputTokens', 'provider'].sort(),
    );
  });

  it('redacts a planted token from a continuation failure and from the tripwire detail', async () => {
    const token = 'gho_PLANTEDcopilotTOKEN0000000000';
    const h = setup();
    h.mock.queue({ kind: 'toolCalls', calls: [{ name: 'lookup', toolCallId: 'z1' }] });
    h.mock.queue({ kind: 'sessionError', errorType: 'query', statusCode: 500, message: `boom ${token}` });
    await step(h.adapter, [user('Q')]);
    const events: AiStreamEvent[] = [];
    for await (const event of h.adapter.responses.stream({ model: MODEL, input: [user('Q'), call('z1', 'lookup', {}), output('z1', 'x')], tools }, ctx)) {
      events.push(event);
    }
    expect(JSON.stringify(events)).not.toContain('PLANTEDcopilotTOKEN');
    expect(JSON.stringify(h.logs)).not.toContain('PLANTEDcopilotTOKEN');

    h.mock.queue({ kind: 'toolCalls', calls: [{ name: `${token}-tool` }] });
    const error = await failureOf(() => createStep(h.adapter, [user('Q2')]));
    expect(JSON.stringify(error.toJSON()) + error.message).not.toContain('PLANTEDcopilotTOKEN');
  });
});

describe('the live model listing decides which models run Ask', () => {
  const entry = (id: string, supports?: { toolCalls?: boolean; tool_calls?: boolean }) => ({
    id,
    name: id,
    capabilities: { ...(supports !== undefined ? { supports } : {}), limits: { max_prompt_tokens: 1000 } },
    policy: { state: 'enabled' },
  });

  it('defaults every model to tool calling', () => {
    const { adapter } = setup();
    expect(adapter.kvox.toolCalling).toBe(true);
    expect(adapter.kvox.catalog.lookup('copilot', MODEL)).toMatchObject({ toolCalling: true });
    expect(adapter.classifyModel(MODEL)?.capabilities).toContain('tools');
  });

  it('honours an explicit "no tool calling" for that model only, in the catalog and the classification', async () => {
    const h = setup({}, createCopilotMockTransport({ models: [entry('plain-model', { toolCalls: false }), entry('snake-model', { tool_calls: false }), entry('good-model', { toolCalls: true }), entry('silent-model')] }));
    await h.adapter.listModels(ctx);

    for (const id of ['plain-model', 'snake-model']) {
      expect(h.adapter.kvox.catalog.lookup('copilot', id)).toMatchObject({ toolCalling: false });
      expect(h.adapter.classifyModel(id)?.capabilities).not.toContain('tools');
    }
    for (const id of ['good-model', 'silent-model', MODEL]) {
      expect(h.adapter.kvox.catalog.lookup('copilot', id)).toMatchObject({ toolCalling: true });
      expect(h.adapter.classifyModel(id)?.capabilities).toContain('tools');
    }
  });
});
