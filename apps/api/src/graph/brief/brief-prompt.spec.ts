import { assertStrictJsonSchema } from '../../ai/structured/strict-json-schema';
import { buildDigestFactList, itemAllowedInPrompt, type DigestItemFact } from './brief-facts';
import { buildDigestPrompt, DIGEST_RESPONSE_SCHEMA, DIGEST_SYSTEM_PROMPT } from './brief-prompt';

const E = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fact(over: Partial<DigestItemFact>): DigestItemFact {
  return {
    kind: 'decision',
    title: null,
    statement: 'Acme chose the blue plan',
    status: 'active',
    occurredAt: new Date('2026-03-04T10:00:00Z'),
    dueAt: null,
    sensitivity: null,
    evidenceIds: [E(1)],
    ...over,
  };
}

describe('itemAllowedInPrompt', () => {
  it('never allows a sensitive fact, allows personal only with the opt-in', () => {
    expect(itemAllowedInPrompt({ kind: 'person_fact', sensitivity: 'sensitive' }, true)).toBe(false);
    expect(itemAllowedInPrompt({ kind: 'person_fact', sensitivity: 'personal' }, false)).toBe(false);
    expect(itemAllowedInPrompt({ kind: 'person_fact', sensitivity: 'personal' }, true)).toBe(true);
    expect(itemAllowedInPrompt({ kind: 'person_fact', sensitivity: 'business' }, false)).toBe(true);
    expect(itemAllowedInPrompt({ kind: 'decision', sensitivity: null }, false)).toBe(true);
  });
});

describe('the digest prompt', () => {
  const list = buildDigestFactList({
    previous: [{ text: 'Acme is evaluating vendors', evidenceIds: [E(10), E(11)] }],
    relations: [
      {
        typeLabel: 'Has role',
        fromLabel: 'Sarah',
        toLabel: 'Acme',
        title: 'Staff Engineer',
        validFrom: new Date('2026-02-01T00:00:00Z'),
        validTo: null,
        evidenceIds: [E(20)],
      },
    ],
    items: [
      fact({}),
      fact({ kind: 'person_fact', statement: 'SENSITIVE-DIAGNOSIS', sensitivity: 'sensitive', evidenceIds: [E(30)] }),
      fact({ kind: 'person_fact', statement: 'PERSONAL-HOBBY', sensitivity: 'personal', evidenceIds: [E(31)] }),
      fact({ kind: 'commitment', statement: 'Send the contract', status: 'open', dueAt: new Date('2026-04-01T00:00:00Z'), evidenceIds: [E(40)] }),
    ],
    includePersonalFacts: false,
  });
  const prompt = buildDigestPrompt({ entity: { label: 'Acme', type: 'Organization' }, facts: list.facts, previousHandles: list.previousHandles });

  it('numbers facts with F<n> handles and keeps every evidence id server-side', () => {
    expect(list.facts.map((f) => f.handle)).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(list.previousHandles).toEqual(['F1']);
    expect(list.evidenceByHandle.get('F1')).toEqual([E(10), E(11)]);
    expect(list.evidenceByHandle.get('F4')).toEqual([E(40)]);
    expect(prompt.userContent).toMatch(/^F1: Acme is evaluating vendors$/m);
    expect(prompt.userContent).toMatch(/^F3: \[2026-03-04, decision\] Acme chose the blue plan$/m);
    expect(prompt.userContent).toContain('F4: [2026-03-04, commitment] Send the contract (status: open, due 2026-04-01)');
    expect(prompt.userContent).toContain('Sarah — Has role — Acme (Staff Engineer), since 2026-02-01');
  });

  it('contains no uuid anywhere', () => {
    expect(prompt.systemPrompt).not.toMatch(UUID);
    expect(prompt.userContent).not.toMatch(UUID);
  });

  it('excludes sensitive facts always and personal facts without the opt-in', () => {
    expect(prompt.userContent).not.toContain('SENSITIVE-DIAGNOSIS');
    expect(prompt.userContent).not.toContain('PERSONAL-HOBBY');
    const withOptIn = buildDigestFactList({
      previous: [],
      relations: [],
      items: [
        fact({ kind: 'person_fact', statement: 'SENSITIVE-DIAGNOSIS', sensitivity: 'sensitive' }),
        fact({ kind: 'person_fact', statement: 'PERSONAL-HOBBY', sensitivity: 'personal' }),
      ],
      includePersonalFacts: true,
    });
    expect(withOptIn.facts.map((f) => f.text)).toEqual(['PERSONAL-HOBBY']);
  });

  it('uses the fixed system instruction and a strict-subset schema', () => {
    expect(prompt.systemPrompt).toBe(DIGEST_SYSTEM_PROMPT);
    expect(DIGEST_SYSTEM_PROMPT).toContain('Use ONLY the numbered facts');
    expect(() => assertStrictJsonSchema(DIGEST_RESPONSE_SCHEMA)).not.toThrow();
  });

  it('caps the list at 200 facts', () => {
    const many = buildDigestFactList({
      previous: [],
      relations: [],
      items: Array.from({ length: 250 }, (_, i) => fact({ statement: `s${i}`, evidenceIds: [E(i + 1)] })),
      includePersonalFacts: false,
    });
    expect(many.facts).toHaveLength(200);
  });
});
