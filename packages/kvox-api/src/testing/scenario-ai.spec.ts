import { z } from 'zod';

import type { KvoxChatMessage } from '../ports/index.js';
import { createScenarioKvoxAi, nextAskMove, scenarioStructuredAnswer, type KvoxScenarioMeeting } from './scenario-ai.js';

// =============================================================================
// The scenario model of `@marinoscar/kvox-api/testing` (#586): its pure
// functions and the port that wires them. Its reading of the real extraction
// prompt is pinned in graph-extraction/extraction/scenario-ai.spec.ts.
// =============================================================================

const BOSS_Q = "What meetings have we had with Jenny's boss?";
const ACTION_Q = 'What are the action items from Joe?';

/** A conversation: the question, then each [tool, args, result] the turn ran. */
function turn(question: string, steps: Array<[string, Record<string, unknown>, unknown]>): KvoxChatMessage[] {
  const messages: KvoxChatMessage[] = [
    { role: 'system', content: 'You answer.' },
    { role: 'user', content: question },
  ];
  steps.forEach(([name, args, result], i) => {
    messages.push({ role: 'assistant', content: null, toolCalls: [{ id: `c${i}`, name, arguments: args }] });
    messages.push({ role: 'tool', toolCallId: `c${i}`, content: JSON.stringify(result) });
  });
  return messages;
}

const jennySearch: [string, Record<string, unknown>, unknown] = [
  'search',
  { query: 'Jenny' },
  { entities: [{ ref: 'ent1', type: 'Person', label: 'Jenny Kim' }] },
];

describe('nextAskMove: "meetings with <name>\'s boss"', () => {
  it('searches, walks REPORTS_TO, then reads the boss\'s meetings', () => {
    expect(nextAskMove(turn(BOSS_Q, []), 'auto')).toEqual({ tool: 'search', args: { query: 'Jenny' } });
    expect(nextAskMove(turn(BOSS_Q, [jennySearch]), 'auto')).toEqual({
      tool: 'neighbors',
      args: { entity: 'ent1', relationTypes: ['REPORTS_TO'] },
    });
    const hood: [string, Record<string, unknown>, unknown] = [
      'neighbors',
      { entity: 'ent1', relationTypes: ['REPORTS_TO'] },
      {
        nodes: [
          { ref: 'ent1', label: 'Jenny Kim' },
          { ref: 'ent2', label: 'Mark Chen' },
        ],
        edges: [{ ref: 'rel1', type: 'REPORTS_TO', from: 'ent1', to: 'ent2' }],
      },
    ];
    expect(nextAskMove(turn(BOSS_Q, [jennySearch, hood]), 'auto')).toEqual({
      tool: 'timeline',
      args: { entity: 'ent2', kinds: ['meeting'] },
    });
    const timeline: [string, Record<string, unknown>, unknown] = [
      'timeline',
      { entity: 'ent2', kinds: ['meeting'] },
      { items: [{ ref: 'itm1', text: 'Weekly sync', at: '2026-10-01T10:00:00Z', evidence: [{ ref: 'ev1' }] }] },
    ];
    // The relation is cited by its handle: its first evidence may be a meeting quote or a manual "Set by hand".
    expect(nextAskMove(turn(BOSS_Q, [jennySearch, hood, timeline]), 'auto')).toEqual({
      answer: 'Jenny Kim[^ent1] reports to Mark Chen[^rel1].\nMeetings with Mark Chen:\n- Weekly sync (2026-10-01) [^ev1]',
    });
  });

  it('says so when nobody is reported to', () => {
    const hood: [string, Record<string, unknown>, unknown] = ['neighbors', {}, { nodes: [], edges: [] }];
    expect(nextAskMove(turn(BOSS_Q, [jennySearch, hood]), 'auto')).toEqual({
      answer: 'I could not find who Jenny Kim[^ent1] reports to.',
    });
  });

  it('answers instead of calling a tool when the answer is forced', () => {
    expect(nextAskMove(turn(BOSS_Q, []), 'none')).toEqual({ answer: 'I could not finish looking that up.' });
  });
});

describe('nextAskMove: "action items from <name>"', () => {
  it('searches, lists open owned commitments, and cites each one\'s evidence', () => {
    const search: [string, Record<string, unknown>, unknown] = [
      'search',
      { query: 'Joe' },
      { entities: [{ ref: 'ent3', type: 'Person', label: 'Joe Park' }] },
    ];
    expect(nextAskMove(turn(ACTION_Q, [search]), 'auto')).toEqual({
      tool: 'list_commitments',
      args: { entity: 'ent3', direction: 'owned_by', status: 'open' },
    });
    const listed: [string, Record<string, unknown>, unknown] = [
      'list_commitments',
      {},
      { items: [{ ref: 'itm2', statement: 'Send the budget draft.', evidence: ['ev4'] }] },
    ];
    expect(nextAskMove(turn(ACTION_Q, [search, listed]), 'auto')).toEqual({
      answer: 'Open action items from Joe Park[^ent3]:\n- Send the budget draft. [^ev4]',
    });
  });

  it('has no plan for any other question', () => {
    expect(nextAskMove(turn('Tell me a joke', []), 'auto')).toEqual({
      answer: 'I could not find anything in your graph that answers that.',
    });
  });
});

describe('scenarioStructuredAnswer', () => {
  it('adjudicates by label, adds no item verdicts, digests one statement per fact, and answers nothing else', () => {
    const pairs = '## Pair p1 (Person)\nMention: Joe  Park\nCandidate 0f00: joe park\n## Pair p2 (Person)\nMention: Joe\nCandidate 0f01: Jane';
    expect(scenarioStructuredAnswer('kg_adjudication', pairs, [])).toEqual({
      verdicts: [
        { pairId: 'p1', verdict: 'same', rationale: 'The names are identical.' },
        { pairId: 'p2', verdict: 'different', rationale: 'The names differ.' },
      ],
    });
    expect(scenarioStructuredAnswer('kg_item_adjudication', '', [])).toEqual({ verdicts: [] });
    expect(scenarioStructuredAnswer('entity_digest', 'Entity\nFacts:\nF1: [2026-10-17, relation] Reports to Mark\nF2: Works for Acme', [])).toEqual({
      statements: [
        { text: 'Reports to Mark', factRefs: ['F1'] },
        { text: 'Works for Acme', factRefs: ['F2'] },
      ],
    });
    expect(scenarioStructuredAnswer('note_generation', '', [])).toBeUndefined();
  });
});

describe('createScenarioKvoxAi', () => {
  const meetings: KvoxScenarioMeeting[] = [];

  it('routes a scenario schema, validated, and records the call', async () => {
    const ai = createScenarioKvoxAi({ noteText: 'A note.', meetings });
    const target = await ai.resolveTask({ userId: 'u' } as never, 'graph.adjudicate' as never);
    const out = await ai.generateStructured({ userId: 'u' } as never, {
      target,
      system: '',
      user: '',
      schema: z.object({ verdicts: z.array(z.unknown()) }),
      schemaName: 'kg_item_adjudication',
    } as never);
    expect(out.value).toEqual({ verdicts: [] });
    expect(ai.calls.some((c) => c.method === 'generateStructured')).toBe(true);
  });

  it('drives chat from the conversation: one tool call per step', async () => {
    const ai = createScenarioKvoxAi({ noteText: 'A note.', meetings });
    const events = [];
    for await (const event of ai.chat({ userId: 'u' } as never, { messages: turn(BOSS_Q, []), tools: [], toolChoice: 'auto' } as never)) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: 'tool_call', id: 'call_1', name: 'search', arguments: { query: 'Jenny' } });
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'step_end', 'done']);
  });
});
