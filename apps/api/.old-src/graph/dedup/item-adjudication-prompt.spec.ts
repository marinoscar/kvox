import { assertStrictJsonSchema } from '../../ai/structured/strict-json-schema';
import {
  ITEM_ADJUDICATION_HEADINGS,
  buildItemAdjudicationOutputSchema,
  buildItemAdjudicationSystemPrompt,
  buildItemAdjudicationUserContent,
  readItemVerdicts,
  type ItemAdjudicationPair,
} from './item-adjudication-prompt';

function pair(n: number): ItemAdjudicationPair {
  return {
    pairId: `p${n}`,
    kind: 'claim',
    subjectType: 'Project',
    proposed: {
      title: 'Pilot moved',
      statement: 'The pilot moved to Q2.',
      occurredAt: '2026-04-02',
      dueAt: null,
      ownerLabel: null,
      quotes: ['we moved the pilot to Q2', 'second', 'a third quote that is dropped'],
    },
    existing: { title: 'Pilot timing', statement: 'The pilot is in Q1.', occurredAt: '2026-01-10', dueAt: null, status: 'active', ownerLabel: 'Sarah' },
  };
}

describe('item adjudication prompt', () => {
  it('states the three verdicts and the decision rule', () => {
    const system = buildItemAdjudicationSystemPrompt([pair(1)]);
    expect(system).toContain('newly stated claim');
    expect(system).toContain('about the same Project');
    expect(system).toMatch(/`same`/);
    expect(system).toMatch(/`supersedes`/);
    expect(system).toContain('Decisions are never `same` when the choice differs.');
  });

  it('lays out both sides with at most two quotes', () => {
    const user = buildItemAdjudicationUserContent([pair(1)]);
    expect(user).toContain(`${ITEM_ADJUDICATION_HEADINGS.pair} p1 (claim)`);
    expect(user).toContain('Statement: The pilot moved to Q2.');
    expect(user).toContain('Statement: The pilot is in Q1.');
    expect(user).toContain('status active; owner Sarah');
    expect(user).toContain('"second"');
    expect(user).not.toContain('a third quote');
  });

  it('the output schema is strict-mode valid', () => {
    expect(() => assertStrictJsonSchema(buildItemAdjudicationOutputSchema())).not.toThrow();
  });

  it('reads verdicts leniently', () => {
    const out = readItemVerdicts(
      {
        verdicts: [
          { pairId: 'p1', verdict: 'same', changes: { status: 'done', dueAt: '2026-05-01' }, rationale: 'r'.repeat(900) },
          { pairId: 'p2', verdict: 'supersedes', changes: { status: 'nonsense', dueAt: 'soon' }, rationale: 'moved' },
          { pairId: 'p1', verdict: 'new', changes: null, rationale: 'duplicate answer ignored' },
          { pairId: 'p9', verdict: 'new', changes: null, rationale: 'unknown pair' },
          { pairId: 'p3', verdict: 'maybe', rationale: 'invalid' },
        ],
      },
      new Set(['p1', 'p2', 'p3']),
    );
    expect(out.get('p1')).toEqual({ verdict: 'same', changes: { status: 'done', dueAt: '2026-05-01' }, rationale: 'r'.repeat(500) });
    expect(out.get('p2')).toEqual({ verdict: 'supersedes', changes: { status: null, dueAt: null }, rationale: 'moved' });
    expect(out.has('p3')).toBe(false);
    expect(out.size).toBe(2);
    expect(readItemVerdicts(null, new Set(['p1'])).size).toBe(0);
  });
});
