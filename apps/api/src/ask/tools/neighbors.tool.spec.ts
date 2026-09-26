import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { NeighborsTool } from './neighbors.tool';

// =============================================================================
// `neighbors` (#377): argument mapping (null → default, arrays → CSV), the
// 50-node cap, personal PersonFacts dropped with their edges, handles for
// nodes and stored edges only, uuid-free output.
// =============================================================================

const ACME = uid(1);
const SARAH = uid(2);
const COMMIT = uid(3);
const FACT_PERSONAL = uid(4);
const FACT_BUSINESS = uid(5);
const REL = uid(6);

const node = (id: string, nodeKind: 'entity' | 'item', type: string, label: string, depth: number) => ({
  id,
  nodeKind,
  type,
  label,
  depth,
  degree: 1,
  status: null,
  occurredAt: null,
});

const slice = {
  seedIds: [ACME],
  asOf: '2026-09-26T12:00:00.000Z',
  nodes: [
    node(ACME, 'entity', 'Organization', 'Acme', 0),
    node(SARAH, 'entity', 'Person', 'Sarah', 1),
    node(COMMIT, 'item', 'commitment', 'Send the contract', 1),
    node(FACT_PERSONAL, 'item', 'person_fact', 'Has two kids', 1),
    node(FACT_BUSINESS, 'item', 'person_fact', 'Speaks at conferences', 1),
  ],
  edges: [
    { id: REL, type: 'WORKS_AT', source: SARAH, target: ACME, valid: { from: '2019-03-01T00:00:00.000Z', to: null, precision: 'month' }, confidence: null, virtual: false },
    { id: `virt:${COMMIT}:OWES`, type: 'OWES', source: COMMIT, target: ACME, valid: null, confidence: null, virtual: true },
    { id: `virt:${FACT_PERSONAL}:ABOUT`, type: 'ABOUT', source: FACT_PERSONAL, target: SARAH, valid: null, confidence: null, virtual: true },
    { id: `virt:${FACT_BUSINESS}:ABOUT`, type: 'ABOUT', source: FACT_BUSINESS, target: SARAH, valid: { from: '2020-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z', precision: 'day' }, confidence: null, virtual: true },
  ],
  truncated: true,
  cap: 25,
};

function build() {
  const neighborhood = { neighborhood: jest.fn(async () => slice) };
  const prisma = {
    kgItem: {
      findMany: jest.fn(async () => [
        { id: FACT_PERSONAL, sensitivity: 'personal' },
        { id: FACT_BUSINESS, sensitivity: 'business' },
      ]),
    },
  };
  return { tool: new NeighborsTool(neighborhood as never, prisma as never), neighborhood, prisma };
}

describe('NeighborsTool', () => {
  it('maps null arguments to the defaults', async () => {
    const { tool, neighborhood } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, ACME);
    await tool.run(ctx, tool.input.parse({ entity: h, hops: null, types: null, relationTypes: null, asOf: null, limit: null }));
    expect(neighborhood.neighborhood).toHaveBeenCalledWith(ctx.user, ACME, {
      hops: 1,
      types: undefined,
      relationTypes: undefined,
      as_of: undefined,
      limit: 25,
    });
  });

  it('passes filters as CSV and caps the limit at 50', async () => {
    const { tool, neighborhood } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, ACME);
    await tool.run(ctx, tool.input.parse({ entity: h, hops: 2, types: ['Person', 'commitment'], relationTypes: ['WORKS_AT'], asOf: '2025-01-01', limit: 50 }));
    expect(neighborhood.neighborhood).toHaveBeenCalledWith(ctx.user, ACME, {
      hops: 2,
      types: 'Person,commitment',
      relationTypes: 'WORKS_AT',
      as_of: '2025-01-01',
      limit: 50,
    });
    expect(tool.input.safeParse({ entity: h, limit: 51 }).success).toBe(false);
    expect(tool.input.safeParse({ entity: h, hops: 3 }).success).toBe(false);
  });

  it('drops personal PersonFacts and their edges, registers handles, stays uuid-free', async () => {
    const { tool, prisma } = build();
    const ctx = makeCtx();
    const h = seedEntity(ctx, ACME, 'Acme');
    const res = await tool.run(ctx, tool.input.parse({ entity: h }));
    expect(prisma.kgItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: ctx.user.id, kind: 'person_fact' }) }),
    );
    expect(res.data).toEqual({
      asOf: '2026-09-26',
      nodes: [
        { ref: 'ent1', kind: 'entity', type: 'Organization', label: 'Acme', depth: 0 },
        { ref: 'ent2', kind: 'entity', type: 'Person', label: 'Sarah', depth: 1 },
        { ref: 'itm1', kind: 'item', type: 'commitment', label: 'Send the contract', depth: 1 },
        { ref: 'itm2', kind: 'item', type: 'person_fact', label: 'Speaks at conferences', depth: 1 },
      ],
      edges: [
        { ref: 'rel1', type: 'WORKS_AT', from: 'ent2', to: 'ent1', validFrom: '2019-03-01', validTo: null, precision: 'month' },
        { ref: null, type: 'OWES', from: 'itm1', to: 'ent1', validFrom: null, validTo: null },
        { ref: null, type: 'ABOUT', from: 'itm2', to: 'ent2', validFrom: '2020-01-01', validTo: '2021-01-01' },
      ],
      truncated: true,
    });
    expect(res.truncated).toBe(true);
    expect(res.summary).toBe('Connections of Acme · 3 nodes, 3 edges');
    expect(JSON.stringify(res.data)).not.toContain('two kids');
    expectNoUuid(res.data);
  });

  it('keeps personal PersonFacts with the opt-in', async () => {
    const { tool } = build();
    const ctx = makeCtx({ personalFactsAllowed: true });
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, ACME) }));
    expect(JSON.stringify(res.data)).toContain('two kids');
  });
});
