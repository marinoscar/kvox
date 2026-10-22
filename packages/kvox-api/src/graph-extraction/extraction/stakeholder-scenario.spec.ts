import { buildExtractionContext } from './extraction-context.js';
import { makeInput, schemaFor, IDS } from '../testing/extraction-fixtures.js';
import { assembleExtractionPrompt } from './prompt.js';
import { validateExtraction, type ProposedRow, type ValidationResult } from './validate.js';

// =============================================================================
// The reference scenario of the Graph Insight Canvas epic (#661, story #665):
// "Joe from Company A said he's skeptical about the Copilot rollout; Company A
// is piloting Microsoft Copilot; the licence budget isn't approved."
//
// A STUBBED model answers (no provider call); the REAL prompt, output schema
// validator and registry-derived vocabularies decide what survives. So the
// spec pins (1) exactly which proposal rows the answer becomes, (2) that a
// stance, role or stage outside the registry's choices, or an endpoint the
// ontology disallows, is dropped rather than proposed, and (3) that the prompt
// the model reads carries the boundary rule and the example.
// =============================================================================

const NOTE_BODY = [
  '# Copilot rollout call',
  '',
  "Joe from Company A said he's skeptical about the Copilot rollout.",
  'Company A is piloting Microsoft Copilot.',
  "The licence budget isn't approved.",
  'Microsoft Copilot is offered by Microsoft.',
  'The rollout concerns Microsoft Copilot and licensing cost.',
  'Nadia from Company A joined for the last ten minutes and only took notes.',
  'Ilse Brandvold is the executive sponsor and said she will not sign off the second wave.',
  'Northgate Partners is the integration partner of Microsoft.',
].join('\n');

function noteOnlyContext(body = NOTE_BODY) {
  const input = makeInput({
    transcript: null,
    segments: [],
    speakers: [],
    effectiveSchema: schemaFor(['core', 'work']),
    knownEntityCandidates: { pinned: [], speakerPersons: [], organizations: [], contextPool: [], recentlyMentioned: [] },
  });
  input.note.bodyAtVersion = body;
  input.note.contextText = null;
  return buildExtractionContext(input);
}

const cite = (quote: string) => [{ source: 'N', quote }];

const entity = (ref: string, type: string, label: string, quote: string, props: Record<string, unknown> = {}) => ({
  ref,
  type,
  label,
  aliases: [],
  props,
  evidence: cite(quote),
});

const relation = (type: string, from: string, to: string, quote: string, props: Record<string, unknown> = {}) => ({
  type,
  from,
  to,
  props,
  validFrom: null,
  validTo: null,
  precision: 'unknown',
  evidence: cite(quote),
});

const risk = (subject: string, title: string, statement: string, quote: string, props: Record<string, unknown>) => ({
  kind: 'risk',
  title,
  statement,
  subject,
  owner: null,
  counterparty: null,
  status: 'open',
  occurredAt: null,
  dueAt: null,
  validFrom: null,
  validTo: null,
  precision: 'unknown',
  sensitivity: null,
  props,
  evidence: cite(quote),
});

/** The stubbed model's answer for the reference scenario. */
function referenceAnswer() {
  return {
    meeting: { topics: [] },
    entities: [
      entity('e1', 'Person', 'Joe', 'Joe from Company A'),
      entity('e2', 'Organization', 'Company A', 'Joe from Company A'),
      entity('e3', 'Organization', 'Microsoft', 'offered by Microsoft'),
      entity('e4', 'Product', 'Microsoft Copilot', 'piloting Microsoft Copilot'),
      entity('e5', 'Project', 'Copilot rollout', 'skeptical about the Copilot rollout'),
      entity('e6', 'Topic', 'licensing cost', 'licensing cost'),
    ],
    relations: [
      relation('WORKS_FOR', 'e1', 'e2', 'Joe from Company A'),
      relation('INVOLVED_IN', 'e1', 'e5', "Joe from Company A said he's skeptical about the Copilot rollout", {
        role: 'stakeholder',
        stance: 'skeptical',
      }),
      relation('USES', 'e2', 'e4', 'Company A is piloting Microsoft Copilot', { stage: 'piloting' }),
      relation('OFFERED_BY', 'e4', 'e3', 'Microsoft Copilot is offered by Microsoft'),
      relation('CONCERNS', 'e5', 'e4', 'The rollout concerns Microsoft Copilot and licensing cost'),
      relation('CONCERNS', 'e5', 'e6', 'The rollout concerns Microsoft Copilot and licensing cost'),
    ],
    items: [
      risk('e5', 'Licence budget not approved', "The licence budget isn't approved.", "The licence budget isn't approved.", {
        riskKind: 'blocker',
      }),
    ],
  };
}

function ok(result: ValidationResult) {
  if (!result.ok) throw new Error(result.message);
  return result;
}

/** A compact, stable view of what a proposal would hold. */
function view(rows: ProposedRow[]) {
  const label = new Map<string, string>();
  for (const r of rows) if (r.kind === 'entity') label.set(r.payload.ref, r.payload.label);
  const end = (e: unknown): string => {
    const ref = e as { ref?: string; entityId?: string };
    return (ref.ref !== undefined ? label.get(ref.ref) : undefined) ?? ref.ref ?? String(ref.entityId);
  };
  return rows.map((r) => {
    if (r.kind === 'entity') return `entity ${r.payload.type} ${r.payload.label}`;
    if (r.kind === 'relation') {
      const props = Object.entries(r.payload.props ?? {})
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `relation ${end(r.payload.from)} ${r.payload.type} ${end(r.payload.to)}${props ? ` {${props}}` : ''}`;
    }
    const props = Object.entries(r.payload.props ?? {})
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(',');
    return `item ${r.payload.kind} "${r.payload.title}" about ${r.payload.subject ? end(r.payload.subject) : '-'}${props ? ` {${props}}` : ''}`;
  });
}

describe('the Joe / Company A / Copilot reference scenario (#665)', () => {
  it('proposes exactly the expected rows from the stubbed model answer', () => {
    const result = ok(validateExtraction(referenceAnswer(), noteOnlyContext()));
    expect(result.stats.dropped).toEqual({ uncited: 0, invalid: 0, unknownType: 0, dangling: 0 });
    expect(view(result.rows).filter((v) => !v.startsWith('entity Meeting'))).toEqual([
      'entity Person Joe',
      'entity Organization Company A',
      'entity Organization Microsoft',
      'entity Product Microsoft Copilot',
      'entity Project Copilot rollout',
      'entity Topic licensing cost',
      'relation Joe WORKS_FOR Company A',
      'relation Joe INVOLVED_IN Copilot rollout {role=stakeholder,stance=skeptical}',
      'relation Company A USES Microsoft Copilot {stage=piloting}',
      'relation Microsoft Copilot OFFERED_BY Microsoft',
      'relation Copilot rollout CONCERNS Microsoft Copilot',
      'relation Copilot rollout CONCERNS licensing cost',
      'item risk "Licence budget not approved" about Copilot rollout {riskKind=blocker}',
    ]);
  });

  it('every proposed row cites the note, not an invented source', () => {
    const result = ok(validateExtraction(referenceAnswer(), noteOnlyContext()));
    for (const row of result.rows) {
      for (const ev of row.evidence) expect(ev).toMatchObject({ source: 'note', noteId: IDS.note });
    }
  });

  it('variant: a resistant sponsor keeps the sponsor role and the resistant stance', () => {
    const answer = referenceAnswer();
    answer.entities.push(entity('e7', 'Person', 'Ilse Brandvold', 'Ilse Brandvold'));
    answer.relations.push(
      relation('INVOLVED_IN', 'e7', 'e5', 'Ilse Brandvold is the executive sponsor and said she will not sign off the second wave', {
        role: 'sponsor',
        stance: 'resistant',
      }),
    );
    const rows = view(ok(validateExtraction(answer, noteOnlyContext())).rows);
    expect(rows).toContain('relation Ilse Brandvold INVOLVED_IN Copilot rollout {role=sponsor,stance=resistant}');
  });

  it('variant: a vendor partner is a symmetric Organization pair, recorded once', () => {
    const answer = referenceAnswer();
    answer.entities.push(entity('e7', 'Organization', 'Northgate Partners', 'Northgate Partners'));
    answer.relations.push(relation('PARTNER_OF', 'e7', 'e3', 'Northgate Partners is the integration partner of Microsoft'));
    const rows = view(ok(validateExtraction(answer, noteOnlyContext())).rows);
    expect(rows).toContain('relation Northgate Partners PARTNER_OF Microsoft');
  });

  describe('negative: no stance language, no stance', () => {
    it('a person who only attended is proposed without INVOLVED_IN or a stance when the model omits them', () => {
      const answer = referenceAnswer();
      answer.entities.push(entity('e7', 'Person', 'Nadia', 'Nadia from Company A'));
      answer.relations.push(relation('WORKS_FOR', 'e7', 'e2', 'Nadia from Company A'));
      const rows = view(ok(validateExtraction(answer, noteOnlyContext())).rows);
      expect(rows).toContain('entity Person Nadia');
      expect(rows.filter((r) => r.includes('Nadia') && r.includes('INVOLVED_IN'))).toEqual([]);
      expect(rows.filter((r) => r.includes('stance')).length).toBe(1); // Joe's only
    });

    it('an INVOLVED_IN with no role is dropped: the relation needs a stated role', () => {
      const answer = referenceAnswer();
      answer.entities.push(entity('e7', 'Person', 'Nadia', 'Nadia from Company A'));
      answer.relations.push(relation('INVOLVED_IN', 'e7', 'e5', 'Nadia from Company A joined', { stance: 'neutral' }));
      const result = ok(validateExtraction(answer, noteOnlyContext()));
      expect(view(result.rows).some((r) => r.includes('Nadia') && r.includes('INVOLVED_IN'))).toBe(false);
      expect(result.stats.dropped.invalid).toBeGreaterThanOrEqual(1);
    });

    it('the prompt tells the model to propose a stance only when the source states one', () => {
      const { systemPrompt } = assembleExtractionPrompt(noteOnlyContext());
      expect(systemPrompt).toContain('Propose a stance only when the source states one');
      expect(systemPrompt).toContain('Never infer stance from tone, a single question, or silence');
    });
  });

  describe('relation property vocabularies and endpoints are validated against the registry', () => {
    const dropped = (mutate: (a: ReturnType<typeof referenceAnswer>) => void) => {
      const answer = referenceAnswer();
      mutate(answer);
      return ok(validateExtraction(answer, noteOnlyContext()));
    };

    it.each([
      ['role', 'INVOLVED_IN', { role: 'boss', stance: 'skeptical' }],
      ['stance', 'INVOLVED_IN', { role: 'stakeholder', stance: 'annoyed' }],
      ['stage', 'USES', { stage: 'half-way' }],
    ])('drops a relation whose %s is outside the registry choices', (_prop, type, props) => {
      const result = dropped((a) => {
        a.relations.find((r) => r.type === type)!.props = props as never;
      });
      expect(view(result.rows).some((r) => r.includes(` ${type} `))).toBe(false);
      expect(result.stats.dropped.invalid).toBe(1);
    });

    it('drops USES from a Person to a Product: the ontology allows Organization or Project there', () => {
      const result = dropped((a) => {
        a.relations.find((r) => r.type === 'USES')!.from = 'e1';
      });
      expect(view(result.rows).some((r) => r.includes(' USES '))).toBe(false);
      expect(result.stats.dropped.invalid).toBe(1);
    });

    it('drops OFFERED_BY pointing from an Organization, and CONCERNS from a Person', () => {
      const result = dropped((a) => {
        a.relations.find((r) => r.type === 'OFFERED_BY')!.from = 'e3';
        a.relations.find((r) => r.type === 'OFFERED_BY')!.to = 'e2';
        a.relations.find((r) => r.type === 'CONCERNS')!.from = 'e1';
      });
      const rows = view(result.rows);
      expect(rows.some((r) => r.includes(' OFFERED_BY '))).toBe(false);
      expect(rows.some((r) => r.includes('Joe CONCERNS'))).toBe(false);
      expect(result.stats.dropped.invalid).toBe(2);
    });

    it('drops a Risk whose riskKind is not in the registry, and accepts every stage the registry lists', () => {
      const bad = dropped((a) => {
        (a.items[0] as { props: Record<string, unknown> }).props = { riskKind: 'catastrophe' };
      });
      expect(view(bad.rows).some((r) => r.startsWith('item risk'))).toBe(false);
      for (const stage of ['evaluating', 'piloting', 'rolling_out', 'adopted', 'retired']) {
        const good = dropped((a) => {
          a.relations.find((r) => r.type === 'USES')!.props = { stage } as never;
        });
        expect(view(good.rows)).toContain(`relation Company A USES Microsoft Copilot {stage=${stage}}`);
      }
    });
  });

  it('personal domain off: the prompt that carries the example names no personal type', () => {
    const { systemPrompt } = assembleExtractionPrompt(noteOnlyContext());
    expect(systemPrompt).toContain('Worked example:');
    for (const key of ['Interest', 'Trip', 'Milestone', 'SPOUSE_OF', 'FRIEND_OF']) expect(systemPrompt).not.toContain(key);
  });
});
