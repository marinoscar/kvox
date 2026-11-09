import type { KvoxChatMessage, KvoxToolDefinition } from '../types/index.js';
import {
  buildPromptedToolInstructions,
  buildPromptedToolRepairInput,
  countToolCalls,
  parsePromptedToolAnswer,
  promptedToolCallId,
  toPromptedToolInput,
} from './prompted-tools.js';

const SEARCH: KvoxToolDefinition = {
  name: 'search',
  description: 'Search the notes',
  parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
};
const TIMELINE: KvoxToolDefinition = {
  name: 'timeline',
  description: 'List events of an entity',
  parameters: { type: 'object', additionalProperties: false, properties: { entity: { type: 'string' } }, required: ['entity'] },
};
const TOOLS = [SEARCH, TIMELINE];

const textOf = (item: unknown): string => ((item as { content: Array<{ text: string }> }).content[0]).text;
const roleOf = (item: unknown): string => (item as { role: string }).role;

describe('buildPromptedToolInstructions', () => {
  it('appends one generic block listing every tool after the loop system prompt', () => {
    const text = buildPromptedToolInstructions({ system: 'You are an assistant.', tools: TOOLS, toolChoice: 'auto' });
    expect(text.startsWith('You are an assistant.\n\n')).toBe(true);
    expect(text).toContain('- search: Search the notes');
    expect(text).toContain('- timeline: List events of an entity');
    expect(text).toContain('"type":"tool_calls"');
    expect(text).toContain('"type":"answer"');
  });

  it('offers only the answer when the choice is none, only the call when it is required, one tool when named', () => {
    const none = buildPromptedToolInstructions({ system: '', tools: TOOLS, toolChoice: 'none' });
    expect(none).not.toContain('- search:');
    expect(none).not.toContain('"type":"tool_calls"');
    expect(none).toContain('"type":"answer"');

    const required = buildPromptedToolInstructions({ system: '', tools: TOOLS, toolChoice: 'required' });
    expect(required).toContain('"type":"tool_calls"');
    expect(required).not.toContain('"type":"answer"');

    const named = buildPromptedToolInstructions({ system: '', tools: TOOLS, toolChoice: { name: 'timeline' } });
    expect(named).toContain('- timeline:');
    expect(named).not.toContain('- search:');
  });
});

describe('toPromptedToolInput', () => {
  const messages: KvoxChatMessage[] = [
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'user', content: 'Q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'search', argumentsJson: '{"query":"x"}' }, { id: 'b', name: 'timeline', argumentsJson: '{"entity":"E"}' }] },
    { role: 'tool', toolCallId: 'a', content: 'result A' },
    { role: 'tool', toolCallId: 'b', content: 'result B' },
    { role: 'system', content: 'Answer now.' },
  ];

  it('returns the leading system messages apart and replays the rest as plain messages', () => {
    const { system, input } = toPromptedToolInput(messages);
    expect(system).toBe('S1\n\nS2');
    expect(input.map(roleOf)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(input.every((item) => (item as { type: string }).type === 'message')).toBe(true);
  });

  it('shows an assistant tool step as the JSON it would have said and merges one step results into one message', () => {
    const { input } = toPromptedToolInput(messages);
    expect(JSON.parse(textOf(input[1]))).toEqual({
      type: 'tool_calls',
      calls: [
        { name: 'search', arguments: { query: 'x' } },
        { name: 'timeline', arguments: { entity: 'E' } },
      ],
    });
    expect(textOf(input[2])).toContain('Result of the tool call a (search):\nresult A');
    expect(textOf(input[2])).toContain('Result of the tool call b (timeline):\nresult B');
    expect(textOf(input[3])).toBe('Answer now.');
  });

  it('shows assistant text as an answer value', () => {
    const { input } = toPromptedToolInput([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'Done.' }]);
    expect(JSON.parse(textOf(input[1]))).toEqual({ type: 'answer', text: 'Done.' });
  });
});

describe('countToolCalls and promptedToolCallId', () => {
  it('numbers calls across the transcript', () => {
    expect(
      countToolCalls([
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'search', argumentsJson: '{}' }, { id: 'y', name: 'search', argumentsJson: '{}' }] },
      ]),
    ).toBe(2);
    expect(promptedToolCallId(3)).toBe('prompted_call_3');
  });
});

describe('parsePromptedToolAnswer', () => {
  it('reads an answer, a fenced answer and parallel tool calls', () => {
    expect(parsePromptedToolAnswer('{"type":"answer","text":"Hi"}', TOOLS, 'auto')).toEqual({ ok: true, step: { kind: 'answer', text: 'Hi' } });
    expect(parsePromptedToolAnswer('```json\n{"type":"answer","text":"Hi"}\n```', TOOLS, 'auto')).toMatchObject({ ok: true });
    const calls = parsePromptedToolAnswer(
      '{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":"a"}},{"name":"timeline","arguments":"{\\"entity\\":\\"E\\"}"}]}',
      TOOLS,
      'auto',
    );
    expect(calls).toEqual({
      ok: true,
      step: {
        kind: 'calls',
        calls: [
          { name: 'search', arguments: { query: 'a' } },
          { name: 'timeline', arguments: { entity: 'E' } },
        ],
      },
    });
  });

  it('reports text that is not JSON', () => {
    const parsed = parsePromptedToolAnswer('I will search.', TOOLS, 'auto');
    expect(parsed).toMatchObject({ ok: false, notJson: true });
  });

  it('reports an unknown type, an unknown tool, bad arguments and an empty call list', () => {
    expect(parsePromptedToolAnswer('{"type":"nope"}', TOOLS, 'auto')).toMatchObject({ ok: false, notJson: false });
    const unknownTool = parsePromptedToolAnswer('{"type":"tool_calls","calls":[{"name":"delete","arguments":{}}]}', TOOLS, 'auto');
    expect(unknownTool).toMatchObject({ ok: false, issues: [{ path: ['calls', 0, 'name'] }] });
    const badArgs = parsePromptedToolAnswer('{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":7}}]}', TOOLS, 'auto');
    expect(badArgs).toMatchObject({ ok: false });
    expect((badArgs as { issues: Array<{ path: unknown[] }> }).issues[0].path.slice(0, 3)).toEqual(['calls', 0, 'arguments']);
    expect(parsePromptedToolAnswer('{"type":"tool_calls","calls":[]}', TOOLS, 'auto')).toMatchObject({ ok: false });
  });

  it('enforces the tool choice', () => {
    const call = '{"type":"tool_calls","calls":[{"name":"search","arguments":{"query":"a"}}]}';
    expect(parsePromptedToolAnswer(call, TOOLS, 'none')).toMatchObject({ ok: false });
    expect(parsePromptedToolAnswer('{"type":"answer","text":"x"}', TOOLS, 'required')).toMatchObject({ ok: false });
    expect(parsePromptedToolAnswer(call, TOOLS, { name: 'timeline' })).toMatchObject({ ok: false });
    expect(parsePromptedToolAnswer(call, TOOLS, { name: 'search' })).toMatchObject({ ok: true });
  });
});

describe('buildPromptedToolRepairInput', () => {
  it('keeps the input, replays the bad reply and lists the problems', () => {
    const { input } = toPromptedToolInput([{ role: 'user', content: 'Q' }]);
    const repair = buildPromptedToolRepairInput(input, 'oops', [{ path: ['calls', 0, 'name'], code: 'invalid_value', message: 'expected one of: search' }]);
    expect(repair.map(roleOf)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(repair[1])).toBe('oops');
    expect(textOf(repair[2])).toContain('$.calls[0].name: expected one of: search');
  });
});
