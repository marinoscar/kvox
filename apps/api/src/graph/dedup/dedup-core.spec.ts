import { computeEffectiveSchema } from '@app/shared/ontology';

import type { ItemPayload, RelationPayload } from '../proposals/proposal-payload.schema';
import { rangeFromPrecision, type TemporalEdge } from '../temporal';
import { closedRangeLiteral, itemCommitAction, relationCommitAction } from './commit-contract';
import {
  ITEM_COSINE_THRESHOLD,
  endpointKey,
  isExclusiveTemporal,
  jaccard,
  mapItemVerdicts,
  proposedRelationRange,
  rejectionKey,
  relationKnown,
  resolveEndpoint,
  ruleForEffectiveRelation,
  selectCandidates,
  type ItemAdjudication,
  type ProposalEntityView,
} from './dedup-core';

const SCHEMA = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const rule = (type: string) => ruleForEffectiveRelation(SCHEMA.relationType(type)!);

const JOE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACME = 'aaaaaaaa-0000-4000-8000-000000000002';
const ITEM_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function rel(over: Partial<RelationPayload> = {}): RelationPayload {
  return {
    ref: 'r1',
    type: 'WORKS_FOR',
    from: { entityId: JOE },
    to: { entityId: ACME },
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...over,
  };
}

function edge(id: string, from: string, to: string | null, precision: 'year' | 'month' | 'day' = 'year', type = 'WORKS_FOR', props = {}): TemporalEdge {
  return {
    id,
    type,
    fromId: JOE,
    toId: ACME,
    props,
    valid: rangeFromPrecision(from, to, precision, { openEnded: to === null }).range,
    precision,
    reviewStatus: 'accepted',
  };
}

const verdict = (v: ItemAdjudication['verdict'], changes: Partial<ItemAdjudication['changes']> = {}): ItemAdjudication => ({
  verdict: v,
  changes: { status: null, dueAt: null, ...changes },
  rationale: `because ${v}`,
});

describe('relation rules come from the effective schema, not a list', () => {
  it('WORKS_FOR/HAS_ROLE/REPORTS_TO are exclusive temporal; ATTENDED is not', () => {
    expect(['WORKS_FOR', 'HAS_ROLE', 'REPORTS_TO'].map((t) => isExclusiveTemporal(rule(t)))).toEqual([true, true, true]);
    expect(isExclusiveTemporal(rule('ATTENDED'))).toBe(false);
    expect(rule('HAS_ROLE')).toEqual({ temporal: true, exclusive: 'soft', exclusiveScope: 'from_to', identityProps: ['title'] });
  });

  it('a fake type declared exclusive is treated as one', () => {
    const fake = ruleForEffectiveRelation({
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from',
      props: [{ key: 'seat', required: true } as never],
    });
    expect(isExclusiveTemporal(fake)).toBe(true);
    expect(fake.identityProps).toEqual(['seat']);
  });
});

describe('proposedRelationRange', () => {
  it('reads a start-only relation as a continuing state, or as a point', () => {
    const p = rel({ validFrom: '2026-03-14', precision: 'month' });
    expect(proposedRelationRange(p).range).toEqual({ from: new Date('2026-03-01T00:00:00Z'), to: null });
    expect(proposedRelationRange(p, 'point').range).toEqual({
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-04-01T00:00:00Z'),
    });
  });

  it('is null for unknown precision or no dates, and an inclusive end becomes exclusive', () => {
    expect(proposedRelationRange(rel({ validFrom: '2020-01-01', precision: 'unknown' })).range).toBeNull();
    expect(proposedRelationRange(rel({ precision: 'year' })).range).toBeNull();
    expect(proposedRelationRange(rel({ validFrom: '2019-01-01', validTo: '2025-01-01', precision: 'year' })).range).toEqual({
      from: new Date('2019-01-01T00:00:00Z'),
      to: new Date('2026-01-01T00:00:00Z'),
    });
  });
});

describe('relationKnown (§8 known, §5.4 out-of-order)', () => {
  it('a 2020 fact inside an accepted [2019, 2026) edge is known, never a new edge', () => {
    const existing = [edge('e1', '2019', '2025')];
    const p = rel({ validFrom: '2020-01-01', precision: 'year' });
    expect(relationKnown(existing, p, JOE, ACME, rule('WORKS_FOR'))).toEqual({ known: true, edgeId: 'e1' });
  });

  it('the same open edge restated is known; a period outside every known one is not', () => {
    const open = [edge('e1', '2019', null)];
    expect(relationKnown(open, rel({ validFrom: '2019-01-01', precision: 'year' }), JOE, ACME, rule('WORKS_FOR')).known).toBe(true);
    const closed = [edge('e1', '2019', '2020')];
    expect(relationKnown(closed, rel({ validFrom: '2023-01-01', precision: 'year' }), JOE, ACME, rule('WORKS_FOR')).known).toBe(false);
  });

  it('an undated restatement of a known fact is known', () => {
    expect(relationKnown([edge('e1', '2019', null)], rel(), JOE, ACME, rule('WORKS_FOR'))).toEqual({ known: true, edgeId: 'e1' });
  });

  it('a non-temporal relation with the same endpoints is known', () => {
    const attended: TemporalEdge = { ...edge('a1', '2019', null), type: 'ATTENDED', valid: null, precision: null };
    expect(relationKnown([attended], rel({ type: 'ATTENDED' }), JOE, ACME, rule('ATTENDED'))).toEqual({ known: true, edgeId: 'a1' });
    expect(relationKnown([], rel({ type: 'ATTENDED' }), JOE, ACME, rule('ATTENDED')).known).toBe(false);
  });

  it('a different role title is a different fact', () => {
    const engineer = edge('h1', '2019', null, 'year', 'HAS_ROLE', { title: 'Engineer' });
    const p = rel({ type: 'HAS_ROLE', props: { title: 'Staff Engineer' }, validFrom: '2026-03-01', precision: 'month' });
    expect(relationKnown([engineer], p, JOE, ACME, rule('HAS_ROLE')).known).toBe(false);
  });
});

describe('selectCandidates', () => {
  it('keeps cosine ≥ 0.80 or (without a vector) Jaccard ≥ 0.5, top five, best first', () => {
    const cands = [
      { itemId: 'c1', cosine: 0.79, lexical: null },
      { itemId: 'c2', cosine: ITEM_COSINE_THRESHOLD, lexical: null },
      { itemId: 'c3', cosine: 0.95, lexical: null },
      { itemId: 'c4', cosine: null, lexical: 0.49 },
      { itemId: 'c5', cosine: null, lexical: 0.6 },
      ...Array.from({ length: 5 }, (_, i) => ({ itemId: `d${i}`, cosine: 0.85, lexical: null })),
    ];
    const out = selectCandidates(cands).map((c) => c.itemId);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('c3');
    expect(out).not.toContain('c1');
    expect(out).not.toContain('c4');
  });

  it('jaccard is token-set overlap', () => {
    expect(jaccard('The pilot is in Q1', 'the pilot is in Q2')).toBeCloseTo(4 / 6);
    expect(jaccard('', 'x')).toBe(0);
  });
});

describe('mapItemVerdicts (§7 step 5)', () => {
  const a = { itemId: ITEM_A, cosine: 0.9, lexical: null };
  const b = { itemId: ITEM_B, cosine: 0.95, lexical: null };

  it('no candidates → new', () => {
    expect(mapItemVerdicts('claim', [], new Map())).toEqual({
      dedup: { verdict: 'new', targetItemId: null, changes: {}, rationale: null, score: null },
      flags: [],
    });
  });

  it('supersedes → flag supersedes, pointing at the old claim', () => {
    const out = mapItemVerdicts('claim', [a], new Map([[ITEM_A, verdict('supersedes')]]));
    expect(out.dedup).toMatchObject({ verdict: 'supersedes', targetItemId: ITEM_A, score: 0.9 });
    expect(out.flags).toEqual(['supersedes']);
  });

  it('same below 0.92 is flagged possible_duplicate; at or above it is not', () => {
    expect(mapItemVerdicts('claim', [a], new Map([[ITEM_A, verdict('same')]])).flags).toEqual(['possible_duplicate']);
    expect(mapItemVerdicts('claim', [b], new Map([[ITEM_B, verdict('same')]])).flags).toEqual([]);
  });

  it('changes are honoured for a commitment only', () => {
    const v = new Map([[ITEM_B, verdict('same', { dueAt: '2026-05-01', status: 'done' })]]);
    expect(mapItemVerdicts('commitment', [b], v).dedup.changes).toEqual({ dueAt: '2026-05-01', status: 'done' });
    expect(mapItemVerdicts('decision', [b], v).dedup.changes).toEqual({});
  });

  it('the best-scoring non-new candidate wins', () => {
    const v = new Map([
      [ITEM_A, verdict('same')],
      [ITEM_B, verdict('supersedes')],
    ]);
    expect(mapItemVerdicts('claim', [a, b], v).dedup).toMatchObject({ verdict: 'supersedes', targetItemId: ITEM_B });
    const onlyA = new Map([
      [ITEM_A, verdict('same')],
      [ITEM_B, verdict('new')],
    ]);
    expect(mapItemVerdicts('claim', [a, b], onlyA).dedup).toMatchObject({ verdict: 'same', targetItemId: ITEM_A });
  });

  it('all new → new; no adjudication → new, pointing at the best, possible_duplicate', () => {
    expect(mapItemVerdicts('claim', [a], new Map([[ITEM_A, verdict('new')]])).dedup.verdict).toBe('new');
    const off = mapItemVerdicts('claim', [a, b], null, 'adjudication off');
    expect(off.dedup).toMatchObject({ verdict: 'new', targetItemId: ITEM_B });
    expect(off.flags).toEqual(['possible_duplicate']);
  });
});

describe('rejection keys and endpoints', () => {
  const entities = new Map<string, ProposalEntityView>([
    ['e1', { ref: 'e1', type: 'Person', label: 'Joe', resolvedId: JOE }],
    ['e2', { ref: 'e2', type: 'Project', label: 'The Pilot', resolvedId: null }],
  ]);

  it('resolves refs through resolution, keeps new ones by type and label', () => {
    expect(resolveEndpoint({ ref: 'e1' }, entities)).toEqual({ kind: 'existing', entityId: JOE });
    expect(endpointKey(resolveEndpoint({ ref: 'e2' }, entities))).toBe('new:Project:the pilot');
    expect(resolveEndpoint({ ref: 'nope' }, entities)).toEqual({ kind: 'missing' });
  });

  it('a relation key includes its props; an item key its statement hash', () => {
    const engineer = rel({ type: 'HAS_ROLE', from: { ref: 'e1' }, props: { title: 'Engineer' } });
    const staff = rel({ type: 'HAS_ROLE', from: { ref: 'e1' }, props: { title: 'Staff Engineer' } });
    expect(rejectionKey('relation', engineer, entities)).not.toBe(rejectionKey('relation', staff, entities));
    expect(rejectionKey('relation', engineer, entities)).toBe(
      rejectionKey('relation', { ...engineer, from: { entityId: JOE }, props: { title: ' engineer ' } }, entities),
    );
    const claim = { kind: 'claim', subject: { ref: 'e2' }, statementHash: 'h1' } as unknown as ItemPayload;
    expect(rejectionKey('item', claim, entities)).toBe('item|claim|new:Project:the pilot|h1');
  });
});

describe('commit contract (#366 applies it)', () => {
  const dedup = (over: Partial<NonNullable<ItemPayload['dedup']>>) =>
    ({ verdict: 'new', targetItemId: ITEM_A, changes: {}, rationale: null, score: null, ...over }) as NonNullable<ItemPayload['dedup']>;

  it('maps each item verdict to its action', () => {
    expect(itemCommitAction({ kind: 'claim', dedup: null })).toEqual({ action: 'insert' });
    expect(itemCommitAction({ kind: 'claim', dedup: dedup({ verdict: 'known' }) })).toEqual({ action: 'attach_evidence', targetItemId: ITEM_A });
    expect(itemCommitAction({ kind: 'claim', dedup: dedup({ verdict: 'supersedes' }) })).toEqual({
      action: 'insert_and_supersede',
      targetItemId: ITEM_A,
    });
    expect(itemCommitAction({ kind: 'commitment', dedup: dedup({ verdict: 'same', changes: { dueAt: '2026-05-01' } }) })).toEqual({
      action: 'attach_and_update',
      targetItemId: ITEM_A,
      changes: { dueAt: '2026-05-01' },
    });
    expect(itemCommitAction({ kind: 'claim', dedup: dedup({ verdict: 'same', changes: { dueAt: '2026-05-01' } }) })).toEqual({
      action: 'attach_evidence',
      targetItemId: ITEM_A,
    });
    expect(itemCommitAction({ kind: 'claim', dedup: dedup({ verdict: 'new' }) })).toEqual({ action: 'insert' });
  });

  it('a known relation attaches; a new one inserts its state range, self-closed at candidateTo', () => {
    expect(relationCommitAction(rel({ dedup: { verdict: 'known', targetRelationId: ITEM_A, candidateTo: null } }), true)).toEqual({
      action: 'attach_evidence',
      targetRelationId: ITEM_A,
    });
    const older = rel({ validFrom: '2018-01-01', precision: 'year', dedup: { verdict: 'new', targetRelationId: null, candidateTo: '2019-01-01' } });
    expect(relationCommitAction(older, true)).toEqual({
      action: 'insert',
      valid: { from: new Date('2018-01-01T00:00:00Z'), to: new Date('2019-01-01T00:00:00Z') },
      precision: 'year',
    });
    expect(relationCommitAction(rel({ type: 'ATTENDED' }), false)).toEqual({ action: 'insert', valid: null, precision: 'unknown' });
  });

  it('a closing keeps the lower bound and ends at closeAt', () => {
    expect(closedRangeLiteral('["2019-01-01 00:00:00+00",)', { closeAt: '2026-03-01' })).toBe(
      '[2019-01-01T00:00:00.000Z,2026-03-01T00:00:00.000Z)',
    );
    expect(() => closedRangeLiteral('["2027-01-01 00:00:00+00",)', { closeAt: '2026-03-01' })).toThrow();
  });
});
