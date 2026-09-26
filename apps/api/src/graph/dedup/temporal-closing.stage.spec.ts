import { computeEffectiveSchema } from '@app/shared/ontology';

import { ProposalStageRegistry } from '../extraction/proposal-stage';
import { rangeFromPrecision, type TemporalEdge } from '../temporal';
import { FakeProposalDb, entityPayload, linked } from '../../../test/graph/dedup-fakes';
import type { ExistingItemRow } from './item-candidates.service';
import { TemporalClosingStage } from './temporal-closing.stage';

const SCHEMA = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const JOE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACME = 'aaaaaaaa-0000-4000-8000-000000000002';
const GLOBEX = 'aaaaaaaa-0000-4000-8000-000000000003';
const JANE = 'aaaaaaaa-0000-4000-8000-000000000004';
const WILL = 'aaaaaaaa-0000-4000-8000-000000000005';
const EDGE = 'cccccccc-0000-4000-8000-000000000001';
const EDGE2 = 'cccccccc-0000-4000-8000-000000000002';
const COMMIT_1 = 'dddddddd-0000-4000-8000-000000000001';
const COMMIT_2 = 'dddddddd-0000-4000-8000-000000000002';

const LABELS: Record<string, string> = { [JOE]: 'Joe', [ACME]: 'Acme', [GLOBEX]: 'Globex', [JANE]: 'Jane', [WILL]: 'Will' };

function edge(over: Partial<TemporalEdge> & { from?: string; to?: string | null; prec?: 'year' | 'month' | 'day' }): TemporalEdge {
  const { from = '2019', to = null, prec = 'year', ...rest } = over;
  return {
    id: EDGE,
    type: 'WORKS_FOR',
    fromId: JOE,
    toId: ACME,
    props: {},
    valid: rangeFromPrecision(from, to, prec, { openEnded: to === null }).range,
    precision: prec,
    reviewStatus: 'accepted',
    ...rest,
  };
}

function rel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'r1',
    type: 'WORKS_FOR',
    from: { ref: 'e1' },
    to: { entityId: GLOBEX },
    props: {},
    validFrom: '2026-03-01',
    validTo: null,
    precision: 'month',
    ...over,
  };
}

function build(edges: TemporalEdge[], commitments: ExistingItemRow[] = [], schema: unknown = SCHEMA) {
  const db = new FakeProposalDb();
  db.add('entity', entityPayload('e1', 'Person', 'Joe'), { resolution: linked(JOE) });
  db.add('entity', entityPayload('e9', 'Person', 'Someone new'), { resolution: linked(null) });
  const graph = {
    liveEdges: jest.fn(async (_o: string, type: string) => edges.filter((e) => e.type === type)),
    openCommitments: jest.fn(async () => commitments),
    entityLabels: jest.fn(async (_o: string, ids: string[]) => new Map(ids.map((id) => [id, { label: LABELS[id] ?? '?', type: 'X' }]))),
  };
  const registry = new ProposalStageRegistry();
  const stage = new TemporalClosingStage(registry, { effectiveSchemaFor: async () => schema } as never, graph as never);
  stage.onModuleInit();
  return { db, stage, graph, registry };
}

function commitment(id: string, over: Partial<ExistingItemRow>): ExistingItemRow {
  return {
    id,
    kind: 'commitment',
    title: null,
    statement: 'Joe sends the draft contract.',
    status: 'open',
    occurredAt: null,
    dueAt: null,
    ownerPersonId: null,
    counterpartyId: null,
    ...over,
  };
}

describe('temporal-closing stage', () => {
  it('registers at order 300', () => {
    expect(build([]).registry.ordered().map((s) => [s.name, s.order])).toEqual([['temporal-closing', 300]]);
  });

  it('a promotion yields exactly one closing row, never pre-checked, with the documented copy fields', async () => {
    const engineer = edge({ type: 'HAS_ROLE', props: { title: 'Engineer' } });
    const { db, stage } = build([engineer]);
    const r = db.add('relation', rel({ type: 'HAS_ROLE', to: { entityId: ACME }, props: { title: 'Staff Engineer' } }));
    db.cite(r, 'Joe was promoted to Staff Engineer in March');
    const ctx = db.ctx();
    await stage.run(ctx);

    const closings = db.closings();
    expect(closings).toHaveLength(1);
    expect(closings[0]).toMatchObject({ decision: 'pending', origin: 'ai', flags: [] });
    expect(closings[0].payload).toEqual({
      relationId: EDGE,
      relationType: 'HAS_ROLE',
      fromLabel: 'Joe',
      toLabel: 'Acme',
      roleTitle: 'Engineer',
      previousValid: { from: '2019-01-01', to: null, precision: 'year' },
      closeAt: '2026-03-01',
      precision: 'month',
      closedByRef: 'r1',
      affectedCommitments: [],
    });
    // The closing cites copies of the new fact's evidence.
    expect(db.evidence.filter((e) => e.subjectId === closings[0].id).map((e) => e.quote)).toEqual([
      'Joe was promoted to Staff Engineer in March',
    ]);
    expect(db.byRef('r1').flags).toEqual([]); // the new edge itself is not blocked
    expect(ctx.stats).toMatchObject({ closings: 1, overlaps: 0 });
  });

  it('a manager change closes the old REPORTS_TO edge', async () => {
    const { db, stage } = build([edge({ type: 'REPORTS_TO', toId: JANE, from: '2020' })]);
    db.add('relation', rel({ type: 'REPORTS_TO', to: { entityId: WILL } }));
    await stage.run(db.ctx());
    expect(db.closings().map((c) => [c.payload.relationType, c.payload.toLabel, c.payload.closeAt])).toEqual([
      ['REPORTS_TO', 'Jane', '2026-03-01'],
    ]);
  });

  it('a company change lists the person’s open commitments and flags the closing', async () => {
    const { db, stage } = build(
      [edge({})],
      [
        commitment(COMMIT_1, { ownerPersonId: JOE, title: 'Send the contract' }),
        commitment(COMMIT_2, { counterpartyId: JOE }),
      ],
    );
    db.add('relation', rel());
    const ctx = db.ctx();
    await stage.run(ctx);
    const [closing] = db.closings();
    expect(closing.flags).toEqual(['closing_affects_commitments']);
    expect(closing.payload.affectedCommitments).toEqual([
      { itemId: COMMIT_1, title: 'Send the contract', role: 'owner' },
      { itemId: COMMIT_2, title: 'Joe sends the draft contract.', role: 'counterparty' },
    ]);
    expect(ctx.stats).toMatchObject({ affectedCommitments: 2 });
  });

  it('a HAS_ROLE closing never lists commitments', async () => {
    const { db, stage } = build([edge({ type: 'HAS_ROLE', props: { title: 'Engineer' } })], [commitment(COMMIT_1, { ownerPersonId: JOE })]);
    db.add('relation', rel({ type: 'HAS_ROLE', to: { entityId: ACME }, props: { title: 'Lead' } }));
    await stage.run(db.ctx());
    expect(db.closings()[0].payload.affectedCommitments).toEqual([]);
    expect(db.closings()[0].flags).toEqual([]);
  });

  it('a relation work-item-dedup found known opens and closes nothing', async () => {
    const { db, stage, graph } = build([edge({ from: '2019', to: '2025' })]);
    db.add('relation', rel({ to: { entityId: ACME }, validFrom: '2020-01-01', precision: 'year', dedup: { verdict: 'known', targetRelationId: EDGE, candidateTo: null } }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
    expect(graph.liveEdges).not.toHaveBeenCalled();
  });

  it('a new range overlapping an accepted closed edge is flagged overlaps and still proposed', async () => {
    const { db, stage } = build([edge({ from: '2019', to: '2024' })]);
    db.add('relation', rel({ to: { entityId: GLOBEX }, validFrom: '2023-01-01', validTo: '2025-01-01', precision: 'year' }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
    expect(db.byRef('r1').flags).toEqual(['overlaps']);
    expect(db.byRef('r1').kind).toBe('relation');
  });

  it('an unknown start never closes, and is flagged unordered against an open different fact', async () => {
    const { db, stage } = build([edge({})]);
    db.add('relation', rel({ validFrom: null, precision: 'unknown' }));
    db.add('relation', rel({ ref: 'r2', validFrom: '2026-03-01', precision: 'unknown' }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
    expect(db.byRef('r1').flags).toEqual(['unordered']);
    expect(db.byRef('r2').flags).toEqual(['unordered']);
  });

  it('HAS_ROLE at a different organization closes nothing (exclusive within one organization)', async () => {
    const { db, stage } = build([edge({ type: 'HAS_ROLE', props: { title: 'Engineer' } })]);
    db.add('relation', rel({ type: 'HAS_ROLE', to: { entityId: GLOBEX }, props: { title: 'Advisor' } }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
  });

  it('an older, open fact is committed already closed at the next edge’s start (candidateTo)', async () => {
    const { db, stage } = build([edge({ from: '2019' })]);
    db.add('relation', rel({ to: { entityId: GLOBEX }, validFrom: '2015-01-01', precision: 'year' }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
    expect(db.byRef('r1').payload.dedup).toEqual({ verdict: 'new', targetRelationId: null, candidateTo: '2019-01-01' });
    expect(db.byRef('r1').flags).toEqual([]);
  });

  it('a proposal-new person has nothing to close; a non-exclusive type is never planned', async () => {
    const { db, stage, graph } = build([edge({})]);
    db.add('relation', rel({ from: { ref: 'e9' } }));
    db.add('relation', rel({ ref: 'r2', type: 'ATTENDED', to: { entityId: ACME }, validFrom: null, precision: 'unknown' }));
    await stage.run(db.ctx());
    expect(db.closings()).toEqual([]);
    expect(graph.liveEdges).not.toHaveBeenCalled();
  });

  it('exclusivity comes from the effective schema: a fake exclusive type closes, WORKS_FOR declared non-exclusive does not', async () => {
    const works = SCHEMA.relationType('WORKS_FOR')!;
    const fake = { ...works, key: 'HOLDS_SEAT', props: [] };
    const stub = {
      relationType: (key: string) =>
        key === 'HOLDS_SEAT' ? fake : key === 'WORKS_FOR' ? { ...works, exclusive: 'none' } : SCHEMA.relationType(key),
    };
    const { db, stage } = build([edge({ type: 'HOLDS_SEAT' }), edge({ id: EDGE2 })], [], stub);
    db.add('relation', rel({ type: 'HOLDS_SEAT' }));
    db.add('relation', rel({ ref: 'r2' }));
    await stage.run(db.ctx());
    expect(db.closings().map((c) => [c.payload.relationType, c.payload.relationId])).toEqual([['HOLDS_SEAT', EDGE]]);
  });

  it('is idempotent: a re-run replaces its own closing rows', async () => {
    const { db, stage } = build([edge({})]);
    const r = db.add('relation', rel());
    db.cite(r, 'Joe moved to Globex');
    await stage.run(db.ctx());
    await stage.run(db.ctx());
    expect(db.closings()).toHaveLength(1);
    expect(db.evidence.filter((e) => e.quote === 'Joe moved to Globex')).toHaveLength(2); // the relation's + one copy
  });

  it('two new facts closing the same edge propose it once', async () => {
    const { db, stage } = build([edge({})]);
    db.add('relation', rel());
    db.add('relation', rel({ ref: 'r2', to: { entityId: JANE } }));
    await stage.run(db.ctx());
    expect(db.closings()).toHaveLength(1);
    expect(db.closings()[0].payload.closedByRef).toBe('r1');
  });
});
