import { expectNoUuid, makeCtx, seedEntity, uid } from '../testing/ask-tool-fakes.js';
import { NeighborsTool } from './neighbors.tool.js';

// =============================================================================
// `neighbors` (#377): argument mapping (null → default, arrays → CSV), the
// 50-node cap, personal PersonFacts dropped with their edges, handles for
// nodes and stored edges only, uuid-free output.
// =============================================================================

const KAPPA = uid(1);
const SASHA = uid(2);
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
  seedIds: [KAPPA],
  asOf: '2026-09-26T12:00:00.000Z',
  nodes: [
    node(KAPPA, 'entity', 'Organization', 'Kappa', 0),
    node(SASHA, 'entity', 'Person', 'Sasha', 1),
    node(COMMIT, 'item', 'commitment', 'Send the contract', 1),
    node(FACT_PERSONAL, 'item', 'person_fact', 'Has two kids', 1),
    node(FACT_BUSINESS, 'item', 'person_fact', 'Speaks at conferences', 1),
  ],
  edges: [
    { id: REL, type: 'WORKS_AT', source: SASHA, target: KAPPA, valid: { from: '2019-03-01T00:00:00.000Z', to: null, precision: 'month' }, confidence: null, virtual: false },
    { id: `virt:${COMMIT}:OWES`, type: 'OWES', source: COMMIT, target: KAPPA, valid: null, confidence: null, virtual: true },
    { id: `virt:${FACT_PERSONAL}:ABOUT`, type: 'ABOUT', source: FACT_PERSONAL, target: SASHA, valid: null, confidence: null, virtual: true },
    { id: `virt:${FACT_BUSINESS}:ABOUT`, type: 'ABOUT', source: FACT_BUSINESS, target: SASHA, valid: { from: '2020-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z', precision: 'day' }, confidence: null, virtual: true },
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
    const h = seedEntity(ctx, KAPPA);
    await tool.run(ctx, tool.input.parse({ entity: h, hops: null, types: null, relationTypes: null, asOf: null, limit: null }));
    expect(neighborhood.neighborhood).toHaveBeenCalledWith(ctx.user, KAPPA, {
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
    const h = seedEntity(ctx, KAPPA);
    await tool.run(ctx, tool.input.parse({ entity: h, hops: 2, types: ['Person', 'commitment'], relationTypes: ['WORKS_AT'], asOf: '2025-01-01', limit: 50 }));
    expect(neighborhood.neighborhood).toHaveBeenCalledWith(ctx.user, KAPPA, {
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
    const h = seedEntity(ctx, KAPPA, 'Kappa');
    const res = await tool.run(ctx, tool.input.parse({ entity: h }));
    expect(prisma.kgItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: ctx.user.id, kind: 'person_fact' }) }),
    );
    expect(res.data).toEqual({
      asOf: '2026-09-26',
      nodes: [
        { ref: 'ent1', kind: 'entity', type: 'Organization', label: 'Kappa', depth: 0 },
        { ref: 'ent2', kind: 'entity', type: 'Person', label: 'Sasha', depth: 1 },
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
    expect(res.summary).toBe('Connections of Kappa · 3 nodes, 3 edges');
    expect(JSON.stringify(res.data)).not.toContain('two kids');
    expectNoUuid(res.data);
  });

  it('drops personal-domain entities and relations (#383) without the opt-in, keeps them with it', async () => {
    const MERCER = uid(20);
    const RUNNING = uid(21);
    const personalSlice = {
      ...slice,
      seedIds: [SASHA],
      nodes: [
        node(SASHA, 'entity', 'Person', 'Sasha', 0),
        node(MERCER, 'entity', 'Person', 'Mercer', 1),
        node(RUNNING, 'entity', 'Interest', 'Marathon running', 1),
        node(KAPPA, 'entity', 'Organization', 'Kappa', 1),
      ],
      edges: [
        { id: uid(22), type: 'SPOUSE_OF', source: SASHA, target: MERCER, valid: null, confidence: null, virtual: false },
        { id: uid(23), type: 'INTERESTED_IN', source: SASHA, target: RUNNING, valid: null, confidence: null, virtual: false },
        { id: REL, type: 'WORKS_FOR', source: SASHA, target: KAPPA, valid: null, confidence: null, virtual: false },
      ],
    };
    const neighborhood = { neighborhood: jest.fn(async () => personalSlice) };
    const prisma = { kgItem: { findMany: jest.fn(async () => []) } };
    const tool = new NeighborsTool(neighborhood as never, prisma as never);

    const ctx = makeCtx();
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, SASHA, 'Sasha') }));
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('Marathon running');
    expect(text).not.toContain('SPOUSE_OF');
    expect(text).not.toContain('INTERESTED_IN');
    // Mercer is a core Person: still a node, but the spouse edge that linked her is gone.
    expect((res.data as { edges: Array<{ type: string }> }).edges.map((e) => e.type)).toEqual(['WORKS_FOR']);

    const allowed = makeCtx({ personalFactsAllowed: true });
    const withOptIn = await tool.run(allowed, tool.input.parse({ entity: seedEntity(allowed, SASHA, 'Sasha') }));
    expect(JSON.stringify(withOptIn.data)).toContain('SPOUSE_OF');
    expect(JSON.stringify(withOptIn.data)).toContain('Marathon running');
  });

  it('keeps personal PersonFacts with the opt-in', async () => {
    const { tool } = build();
    const ctx = makeCtx({ personalFactsAllowed: true });
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, KAPPA) }));
    expect(JSON.stringify(res.data)).toContain('two kids');
  });
});
