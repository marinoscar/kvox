import { z } from 'zod';

import { AI_PROVIDER_STATE, AiError, type AiResponse, type AiStreamEvent } from '@marinoscar/platform-api/ai';

import {
  ReasoningReplayCache,
  clearToolCache,
  createChatMappingState,
  fromPlatformEvent,
  missingToolCalls,
  replayScope,
  toPlatformInput,
  toPlatformToolChoice,
  toPlatformTools,
  toolCallIdsOf,
} from './chat-mapping.js';
import type { KvoxChatMessage, KvoxToolDefinition } from '../types/index.js';

// =============================================================================
// chat-mapping (issue #476): the pure request/event mapping of KvoxAi.chat
// =============================================================================

const SEARCH: KvoxToolDefinition = {
  name: 'search',
  description: 'Search the graph',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'What to look for' },
      scope: { type: ['string', 'null'], enum: ['entities', 'all', null], description: 'Where' },
    },
    required: ['query', 'scope'],
  },
};

function response(overrides: Partial<AiResponse> = {}): AiResponse {
  return {
    id: 'resp-1',
    provider: 'openai',
    model: 'gpt-x',
    output: [],
    outputText: '',
    usage: { inputTokens: 10, outputTokens: 4 },
    finishReason: 'stop',
    ...overrides,
  };
}

/** Maps a whole script, collecting the kvox events it yields. */
function run(events: AiStreamEvent[], state = createChatMappingState()) {
  const out = [];
  for (const event of events) {
    const mapped = fromPlatformEvent(event, state);
    if (mapped !== null) out.push(mapped);
  }
  return { out, state };
}

describe('toPlatformInput', () => {
  it('joins the leading system messages into instructions and maps the rest in order', () => {
    const messages: KvoxChatMessage[] = [
      { role: 'system', content: 'You answer from the graph.' },
      { role: 'system', content: 'Today is Monday.' },
      { role: 'user', content: 'Who is Sarah?' },
    ];

    expect(toPlatformInput(messages)).toEqual({
      instructions: 'You answer from the graph.\n\nToday is Monday.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Who is Sarah?' }] }],
    });
  });

  it('has no instructions when there is no leading system message', () => {
    expect(toPlatformInput([{ role: 'user', content: 'Hi' }]).instructions).toBeUndefined();
  });

  it('turns a later system message (the forced-answer line) into a developer message in place', () => {
    const { input } = toPlatformInput([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Q' },
      { role: 'system', content: 'Answer now.' },
    ]);

    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Q' }] },
      { type: 'message', role: 'developer', content: [{ type: 'text', text: 'Answer now.' }] },
    ]);
  });

  it('replays an assistant step: its text, then each call, then each tool result', () => {
    const { input } = toPlatformInput([
      { role: 'user', content: 'Q' },
      {
        role: 'assistant',
        content: 'Let me look.',
        toolCalls: [
          { id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' },
          { id: 'c2', name: 'search', argumentsJson: '{"query":"b"}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"a":1}' },
      { role: 'tool', toolCallId: 'c2', content: '{"b":2}' },
    ]);

    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Q' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
      { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"query":"a"}' },
      { type: 'function_call', callId: 'c2', name: 'search', arguments: '{"query":"b"}' },
      { type: 'function_call_output', callId: 'c1', output: '{"a":1}' },
      { type: 'function_call_output', callId: 'c2', output: '{"b":2}' },
    ]);
  });

  it('omits the assistant message when the step had no text', () => {
    const { input } = toPlatformInput([
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search', argumentsJson: '{}' }] },
    ]);

    expect(input).toEqual([{ type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' }]);
  });

  it('puts the captured reasoning in front of the call it preceded, as the same object', () => {
    const state = { provider: 'anthropic', data: { signature: 'opaque' } };
    const thought = { type: 'reasoning' as const, summary: ['thinking'], [AI_PROVIDER_STATE]: state };
    const { input } = toPlatformInput(
      [
        {
          role: 'assistant',
          content: 'Looking.',
          toolCalls: [
            { id: 'c1', name: 'search', argumentsJson: '{}' },
            { id: 'c2', name: 'search', argumentsJson: '{}' },
          ],
        },
      ],
      new Map([['c1', [thought]]]),
    );

    expect(input.map((item) => item.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call']);
    expect(input[1]).toBe(thought);
    expect((input[1] as typeof thought)[AI_PROVIDER_STATE]).toBe(state);
  });
});

describe('toolCallIdsOf', () => {
  it('lists every replayed call id', () => {
    expect(
      toolCallIdsOf([
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'x', argumentsJson: '{}' }] },
        { role: 'assistant', content: 'T', toolCalls: [{ id: 'b', name: 'x', argumentsJson: '{}' }] },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('toPlatformTools and toPlatformToolChoice', () => {
  beforeEach(() => clearToolCache());

  it('builds strict function tools whose parameters come from the JSON Schema', () => {
    const [tool] = toPlatformTools([SEARCH]);

    expect(tool).toMatchObject({ type: 'function', name: 'search', description: 'Search the graph', strict: true });
    expect(tool.parameters.safeParse({ query: 'x', scope: null }).success).toBe(true);
    expect(tool.parameters.safeParse({ query: 'x', scope: 'bogus' }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: 'x', scope: null, extra: 1 }).success).toBe(false);
  });

  it('converts once per tool name and rebuilds when the schema changes', () => {
    const spy = jest.spyOn(z, 'fromJSONSchema');
    try {
      const first = toPlatformTools([SEARCH])[0].parameters;
      const second = toPlatformTools([SEARCH])[0].parameters;
      expect(second).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);

      const changed = toPlatformTools([
        { ...SEARCH, parameters: { ...SEARCH.parameters, properties: { query: { type: 'string' } }, required: ['query'] } },
      ])[0].parameters;
      expect(changed).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the tool whose schema cannot be converted', () => {
    expect(() =>
      toPlatformTools([{ name: 'broken', description: 'd', parameters: { type: 'object', properties: { a: { type: 'nope' } } } }]),
    ).toThrow(/tool "broken"/);
  });

  it('maps the tool choices', () => {
    expect(toPlatformToolChoice('auto')).toBe('auto');
    expect(toPlatformToolChoice('none')).toBe('none');
    expect(toPlatformToolChoice('required')).toBe('required');
    expect(toPlatformToolChoice({ name: 'search' })).toEqual({ type: 'function', name: 'search' });
  });
});

describe('fromPlatformEvent', () => {
  it('maps text deltas and ignores empty ones', () => {
    const { out } = run([
      { type: 'response.created', id: 'r' },
      { type: 'output_text.delta', delta: 'Hel' },
      { type: 'output_text.delta', delta: '' },
      { type: 'output_text.delta', delta: 'lo' },
      { type: 'reasoning_summary.delta', delta: 'hmm' },
    ]);

    expect(out).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
    ]);
  });

  it('emits a finished function_call item with its full arguments, once', () => {
    const item = { type: 'function_call' as const, callId: 'c1', name: 'search', arguments: '{"query":"a"}' };
    const { out } = run([
      { type: 'function_call.arguments.delta', callId: 'c1', delta: '{"query"' },
      { type: 'function_call.arguments.delta', callId: 'c1', delta: ':"a"}' },
      { type: 'output_item.done', item },
      { type: 'output_item.done', item },
    ]);

    expect(out).toEqual([{ kind: 'tool_call', id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' }]);
  });

  it('prefers the item arguments over the buffered deltas', () => {
    const { out } = run([
      { type: 'function_call.arguments.delta', callId: 'c1', delta: '{"stale":true}' },
      { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{"fresh":1}' } },
    ]);

    expect(out).toEqual([{ kind: 'tool_call', id: 'c1', name: 'search', argumentsJson: '{"fresh":1}' }]);
  });

  it('falls back to the buffered deltas when the item carries no arguments', () => {
    const { out, state } = run([
      { type: 'function_call.arguments.delta', callId: 'c1', delta: '{"query"' },
      { type: 'function_call.arguments.delta', callId: 'c1', delta: ':"a"}' },
      { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '' } },
    ]);

    expect(out).toEqual([{ kind: 'tool_call', id: 'c1', name: 'search', argumentsJson: '{"query":"a"}' }]);
    expect(state.argumentBuffers.size).toBe(0);
  });

  it('keeps reasoning for the next tool call only, never as an event', () => {
    const first = { type: 'reasoning' as const, summary: ['a'] };
    const second = { type: 'reasoning' as const, summary: ['b'] };
    const { out, state } = run([
      { type: 'output_item.done', item: first },
      { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
      { type: 'output_item.done', item: { type: 'function_call', callId: 'c2', name: 'search', arguments: '{}' } },
      { type: 'output_item.done', item: second },
    ]);

    expect(out.map((e) => e.kind)).toEqual(['tool_call', 'tool_call']);
    expect(state.reasoningByCall.get('c1')).toEqual([first]);
    expect(state.reasoningByCall.has('c2')).toBe(false);
    // Reasoning with no call after it (a final answer's) is not replayed.
    expect(state.pendingReasoning).toEqual([second]);
  });

  it('ignores message and hosted items (the text already streamed)', () => {
    const { out } = run([{ type: 'output_item.done', item: { type: 'message', text: 'already streamed' } }]);

    expect(out).toEqual([]);
  });

  it.each([
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
  ] as const)('maps finish reason %s', (platform, kvox) => {
    const { out, state } = run([{ type: 'response.completed', response: response({ finishReason: platform }) }]);

    expect(out).toEqual([{ kind: 'done', finishReason: kvox, model: 'gpt-x', usage: { inputTokens: 10, outputTokens: 4 } }]);
    expect(state.completed).toBe(true);
  });

  it('reports absent usage as null, never 0', () => {
    const { out } = run([{ type: 'response.completed', response: response({ usage: {} }) }]);

    expect(out).toEqual([
      { kind: 'done', finishReason: 'stop', model: 'gpt-x', usage: { inputTokens: null, outputTokens: null } },
    ]);
  });

  it('throws for a response that ended with error', () => {
    expect(() => run([{ type: 'response.completed', response: response({ finishReason: 'error' }) }])).toThrow(
      /ended the response with an error/,
    );
  });

  it('throws the platform AiError for an error event', () => {
    let thrown: unknown;
    try {
      run([{ type: 'error', code: 'AI_RATE_LIMITED', message: 'slow down' }]);
    } catch (err) {
      thrown = err;
    }

    expect(AiError.isAiError(thrown)).toBe(true);
    expect((thrown as AiError).code).toBe('AI_RATE_LIMITED');
  });
});

describe('missingToolCalls', () => {
  it('emits the calls only the final response carries, and never one twice', () => {
    const state = createChatMappingState();
    fromPlatformEvent(
      { type: 'output_item.done', item: { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' } },
      state,
    );

    const events = missingToolCalls(
      response({
        output: [
          { type: 'function_call', callId: 'c1', name: 'search', arguments: '{}' },
          { type: 'function_call', callId: 'c2', name: 'search', arguments: '{"q":1}' },
        ],
      }),
      state,
    );

    expect(events).toEqual([{ kind: 'tool_call', id: 'c2', name: 'search', argumentsJson: '{"q":1}' }]);
  });
});

describe('ReasoningReplayCache', () => {
  it('returns what was remembered for the same scope and nothing for another', () => {
    const cache = new ReasoningReplayCache();
    const items = [{ type: 'reasoning', summary: [] }];
    cache.remember('u1\u0000j1', new Map([['c1', items]]));

    expect(cache.recall('u1\u0000j1', ['c1', 'c2'])).toEqual(new Map([['c1', items]]));
    expect(cache.recall('u2\u0000j1', ['c1']).size).toBe(0);
    expect(cache.recall('u1\u0000j2', ['c1']).size).toBe(0);
  });

  it('forgets after the time to live', () => {
    let now = 0;
    const cache = new ReasoningReplayCache({ ttlMs: 1000, now: () => now });
    cache.remember('s', new Map([['c1', [{}]]]));

    now = 999;
    expect(cache.recall('s', ['c1']).size).toBe(1);
    now = 1001;
    expect(cache.recall('s', ['c1']).size).toBe(0);
  });

  it('is bounded: the oldest entries go first', () => {
    const cache = new ReasoningReplayCache({ maxEntries: 2 });
    cache.remember('s', new Map([['c1', [{}]]]));
    cache.remember('s', new Map([['c2', [{}]]]));
    cache.remember('s', new Map([['c3', [{}]]]));

    expect(cache.size).toBe(2);
    expect([...cache.recall('s', ['c1', 'c2', 'c3']).keys()]).toEqual(['c2', 'c3']);
  });

  it('scopes by user and job', () => {
    expect(replayScope({ userId: 'u', jobId: 'j' })).not.toBe(replayScope({ userId: 'u' }));
    expect(replayScope({ userId: 'u', jobId: 'j' })).not.toBe(replayScope({ userId: 'v', jobId: 'j' }));
  });
});
