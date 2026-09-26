import { computeEffectiveSchema } from '@app/shared/ontology';

import { RateLimitError } from '../../jobs/rate-limit.error';
import { ProposalStageRegistry } from '../extraction/proposal-stage';
import { rangeFromPrecision, type TemporalEdge } from '../temporal';
import { FakeProposalDb, OWNER, entityPayload, linked } from '../../../test/graph/dedup-fakes';
import type { ItemAdjudication } from './dedup-core';
import type { ItemCandidateResult } from './item-candidates.service';
import { WorkItemDedupStage } from './work-item-dedup.stage';

const SCHEMA = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const JOE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACME = 'aaaaaaaa-0000-4000-8000-000000000002';
const PILOT = 'aaaaaaaa-0000-4000-8000-000000000003';
const OLD_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const OLD_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function candidate(itemId: string, cosine: number | null, lexical: number | null = null): ItemCandidateResult {
  return {
    itemId,
    cosine,
    lexical,
    row: {
      id: itemId,
      kind: 'claim',
      title: 'Pilot timing',
      statement: 'The pilot is in Q1.',
      status: 'active',
      occurredAt: '2026-01-10',
      dueAt: null,
      ownerPersonId: null,
      counterpartyId: null,
    },
  };
}

function itemPayload(ref: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    kind: 'claim',
    title: 'Pilot moved',
    statement: 'The pilot moved to Q2.',
    subject: { ref: 'e2' },
    owner: null,
    counterparty: null,
    meeting: null,
    status: null,
    occurredAt: '2026-04-02',
    dueAt: null,
    sensitivity: null,
    statementHash: `hash-${ref}`,
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...over,
  };
}

function build(options: {
  known?: Record<string, string>;
  candidates?: Record<string, ItemCandidateResult[]>;
  verdicts?: (pairs: Array<{ pairId: string; existing: { statement: string } }>) => Map<string, ItemAdjudication & { model: string }>;
  edges?: TemporalEdge[];
  embedded?: 'ok' | 'skipped:ai_key_missing';
  adjudicateThrows?: unknown;
} = {}) {
  const db = new FakeProposalDb();
  db.add('entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(JOE) });
  db.add('entity', entityPayload('e2', 'Project', 'The Pilot'), { resolution: linked(PILOT) });
  db.add('entity', entityPayload('e3', 'Project', 'Brand new'), { resolution: linked(null) });

  const graph = {
    knownItem: jest.fn(async (_o: string, q: { statementHash: string }) => options.known?.[q.statementHash] ?? null),
    itemCandidates: jest.fn(async (_o: string, q: { statement: string; vector: unknown }) => options.candidates?.[q.statement] ?? []),
    liveEdges: jest.fn(async () => options.edges ?? []),
    entityLabels: jest.fn(async (_o: string, ids: string[]) => new Map(ids.map((id) => [id, { label: `L-${id.slice(-1)}`, type: 'Project' }]))),
    proposalQuotes: jest.fn(async () => new Map<string, string[]>()),
  };
  const resolution = {
    embedMentions: jest.fn(async (_u: string, texts: string[]) =>
      options.embedded === 'skipped:ai_key_missing'
        ? { vectors: texts.map(() => null), vectorArm: 'skipped:ai_key_missing' }
        : { vectors: texts.map(() => ({ values: [1], model: 'm' })), vectorArm: 'ok' },
    ),
  };
  const adjudication = {
    adjudicateItems: jest.fn(async (_u: string, pairs: Array<{ pairId: string; existing: { statement: string } }>) => {
      if (options.adjudicateThrows) throw options.adjudicateThrows;
      return options.verdicts ? options.verdicts(pairs) : new Map();
    }),
  };
  const registry = new ProposalStageRegistry();
  const stage = new WorkItemDedupStage(
    registry,
    { effectiveSchemaFor: async () => SCHEMA } as never,
    graph as never,
    resolution as never,
    adjudication as never,
  );
  stage.onModuleInit();
  return { db, stage, graph, resolution, adjudication, registry };
}

const v = (verdict: ItemAdjudication['verdict'], changes: Partial<ItemAdjudication['changes']> = {}) => ({
  verdict,
  changes: { status: null, dueAt: null, ...changes },
  rationale: `r-${verdict}`,
  model: 'gpt',
});

describe('work-item-dedup stage', () => {
  it('registers at order 200, after resolution', () => {
    const { registry } = build();
    expect(registry.ordered().map((s) => [s.name, s.order])).toEqual([['work-item-dedup', 200]]);
  });

  it('a restated fact known by hash is known, flagged, pre-accepted, and never adjudicated', async () => {
    const { db, stage, adjudication } = build({ known: { 'hash-i1': OLD_A } });
    db.add('item', itemPayload('i1'));
    const ctx = db.ctx();
    await stage.run(ctx);
    const row = db.byRef('i1');
    expect(row.payload.dedup).toEqual({ verdict: 'known', targetItemId: OLD_A, changes: {}, rationale: null, score: null });
    expect(row.flags).toEqual(['known']);
    expect(row.decision).toBe('accept');
    expect(adjudication.adjudicateItems).not.toHaveBeenCalled();
    expect(ctx.stats).toMatchObject({ known: 1, items: 1 });
  });

  it('an item about a proposal-new subject is new without a lookup', async () => {
    const { db, stage, graph } = build();
    db.add('item', itemPayload('i1', { subject: { ref: 'e3' } }));
    await stage.run(db.ctx());
    expect(db.byRef('i1').payload.dedup).toMatchObject({ verdict: 'new', targetItemId: null });
    expect(graph.knownItem).not.toHaveBeenCalled();
  });

  it('"the pilot moved to Q2" after "the pilot is in Q1" → supersedes', async () => {
    const { db, stage, adjudication } = build({
      candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.88)] },
      verdicts: (pairs) => new Map(pairs.map((p) => [p.pairId, v('supersedes')])),
    });
    db.add('item', itemPayload('i1'));
    const ctx = db.ctx();
    await stage.run(ctx);
    const row = db.byRef('i1');
    expect(row.payload.dedup).toMatchObject({ verdict: 'supersedes', targetItemId: OLD_A, score: 0.88, rationale: 'r-supersedes' });
    expect(row.flags).toEqual(['supersedes']);
    expect(adjudication.adjudicateItems).toHaveBeenCalledWith(OWNER, expect.any(Array), { jobType: 'kg.extract' });
    expect(ctx.stats).toMatchObject({ supersedes: 1, adjudicated: 1 });
  });

  it('a commitment restated with a new due date → same + changes.dueAt', async () => {
    const { db, stage } = build({
      candidates: { 'Sarah ships the migration by May.': [candidate(OLD_A, 0.95)] },
      verdicts: (pairs) => new Map(pairs.map((p) => [p.pairId, v('same', { dueAt: '2026-05-01' })])),
    });
    db.add('item', itemPayload('c1', { kind: 'commitment', statement: 'Sarah ships the migration by May.', owner: { ref: 'e1' } }));
    await stage.run(db.ctx());
    const row = db.byRef('c1');
    expect(row.payload.dedup).toMatchObject({ verdict: 'same', targetItemId: OLD_A, changes: { dueAt: '2026-05-01' } });
    expect(row.flags).toEqual([]); // cosine ≥ 0.92: no possible_duplicate
  });

  it('a commitment whose owner is proposal-new is never matched', async () => {
    const { db, stage, graph } = build();
    db.add('entity', entityPayload('e9', 'Person', 'Newbie'), { resolution: linked(null) });
    db.add('item', itemPayload('c1', { kind: 'commitment', owner: { ref: 'e9' } }));
    await stage.run(db.ctx());
    expect(db.byRef('c1').payload.dedup).toMatchObject({ verdict: 'new' });
    expect(graph.itemCandidates).not.toHaveBeenCalled();
  });

  it('a candidate below 0.80 cosine is not adjudicated', async () => {
    const { db, stage, adjudication } = build({ candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.79)] } });
    db.add('item', itemPayload('i1'));
    await stage.run(db.ctx());
    expect(adjudication.adjudicateItems).not.toHaveBeenCalled();
    expect(db.byRef('i1').payload.dedup).toMatchObject({ verdict: 'new', targetItemId: null });
  });

  it('falls back to lexical matching without an embedding, and records it', async () => {
    const { db, stage, adjudication } = build({
      embedded: 'skipped:ai_key_missing',
      candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, null, 0.6), candidate(OLD_B, null, 0.3)] },
      verdicts: (pairs) => new Map(pairs.map((p) => [p.pairId, v('same')])),
    });
    db.add('item', itemPayload('i1'));
    const ctx = db.ctx();
    await stage.run(ctx);
    expect(ctx.stats).toMatchObject({ fallback: 'lexical', embedding: 'skipped:ai_key_missing' });
    expect(adjudication.adjudicateItems.mock.calls[0][1]).toHaveLength(1); // only the 0.6 one
    const row = db.byRef('i1');
    expect(row.payload.dedup).toMatchObject({ verdict: 'same', targetItemId: OLD_A, score: null });
    expect(row.flags).toEqual(['possible_duplicate']);
  });

  it('ignores changes for a non-commitment and picks the best of several candidates', async () => {
    const { db, stage } = build({
      candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.85), candidate(OLD_B, 0.9)] },
      verdicts: (pairs) => new Map(pairs.map((p) => [p.pairId, v('same', { status: 'done' })])),
    });
    db.add('item', itemPayload('i1', { kind: 'decision' }));
    await stage.run(db.ctx());
    expect(db.byRef('i1').payload.dedup).toMatchObject({ verdict: 'same', targetItemId: OLD_B, changes: {} });
  });

  it('adjudication off → new, pointing at the candidate, possible_duplicate', async () => {
    const { db, stage, adjudication } = build({ candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.9)] } });
    db.add('item', itemPayload('i1'));
    const ctx = db.ctx({ adjudication: 'off' });
    await stage.run(ctx);
    expect(adjudication.adjudicateItems).not.toHaveBeenCalled();
    expect(db.byRef('i1').payload.dedup).toMatchObject({ verdict: 'new', targetItemId: OLD_A });
    expect(db.byRef('i1').flags).toEqual(['possible_duplicate']);
    expect(ctx.stats).toMatchObject({ adjudication: 'off' });
  });

  it('degrades when adjudication is refused, and rethrows a rate limit', async () => {
    const refused = build({
      candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.9)] },
      adjudicateThrows: new Error('nope'),
    });
    refused.db.add('item', itemPayload('i1'));
    const ctx = refused.db.ctx();
    await refused.stage.run(ctx);
    expect(ctx.stats).toMatchObject({ adjudication: 'unavailable:Error' });
    expect(refused.db.byRef('i1').flags).toEqual(['possible_duplicate']);

    const limited = build({
      candidates: { 'The pilot moved to Q2.': [candidate(OLD_A, 0.9)] },
      adjudicateThrows: new RateLimitError('slow', 1000),
    });
    limited.db.add('item', itemPayload('i1'));
    await expect(limited.stage.run(limited.db.ctx())).rejects.toBeInstanceOf(RateLimitError);
  });

  it('a new sensitive person fact is never sent to a model', async () => {
    const { db, stage, graph, resolution } = build({ candidates: { 'x': [candidate(OLD_A, 0.99)] } });
    db.add('item', itemPayload('p1', { kind: 'person_fact', subject: { ref: 'e1' }, sensitivity: 'sensitive', statement: 'x' }));
    await stage.run(db.ctx());
    expect(db.byRef('p1').payload.dedup).toMatchObject({ verdict: 'new' });
    expect(graph.itemCandidates).not.toHaveBeenCalled();
    expect(resolution.embedMentions).toHaveBeenCalledWith(OWNER, [], 'kg.extract');
  });

  describe('relations', () => {
    const edge = (valid: TemporalEdge['valid'], type = 'WORKS_FOR'): TemporalEdge => ({
      id: 'cccccccc-0000-4000-8000-000000000001',
      type,
      fromId: JOE,
      toId: ACME,
      props: {},
      valid,
      precision: valid ? 'year' : null,
      reviewStatus: 'accepted',
    });
    const rel = (over: Record<string, unknown> = {}) => ({
      ref: 'r1',
      type: 'WORKS_FOR',
      from: { ref: 'e1' },
      to: { entityId: ACME },
      props: {},
      validFrom: '2020-01-01',
      validTo: null,
      precision: 'year',
      ...over,
    });

    it('a temporal fact inside an accepted edge is known', async () => {
      const { db, stage } = build({ edges: [edge(rangeFromPrecision('2019', '2025', 'year').range)] });
      db.add('relation', rel());
      await stage.run(db.ctx());
      const row = db.byRef('r1');
      expect(row.payload.dedup).toEqual({ verdict: 'known', targetRelationId: 'cccccccc-0000-4000-8000-000000000001', candidateTo: null });
      expect(row.flags).toEqual(['known']);
    });

    it('a non-temporal relation with the same endpoints is known; different endpoints are new', async () => {
      const meeting = 'aaaaaaaa-0000-4000-8000-000000000009';
      const attended = { ...edge(null, 'ATTENDED'), toId: meeting };
      const { db, stage } = build({ edges: [attended] });
      db.add('relation', rel({ ref: 'r1', type: 'ATTENDED', to: { entityId: meeting }, validFrom: null, precision: 'unknown' }));
      db.add('relation', rel({ ref: 'r2', type: 'ATTENDED', to: { entityId: ACME }, validFrom: null, precision: 'unknown' }));
      await stage.run(db.ctx());
      expect(db.byRef('r1').payload.dedup).toMatchObject({ verdict: 'known' });
      expect(db.byRef('r2').payload.dedup).toMatchObject({ verdict: 'new', targetRelationId: null });
    });

    it('a relation with a proposal-new endpoint is new without a lookup', async () => {
      const { db, stage, graph } = build();
      db.add('relation', rel({ to: { ref: 'e3' } }));
      await stage.run(db.ctx());
      expect(db.byRef('r1').payload.dedup).toMatchObject({ verdict: 'new' });
      expect(graph.liveEdges).not.toHaveBeenCalled();
    });
  });
});
