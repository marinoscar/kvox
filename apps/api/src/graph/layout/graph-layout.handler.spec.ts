import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { KG_GRAPH_LAYOUT_JOB_TYPE } from '../job-types';
import {
  GRAPH_LAYOUT_RETAINED,
  KG_GRAPH_LAYOUT_PROFILE,
  KgGraphLayoutHandler,
  readGraphLayoutPayload,
} from './graph-layout.handler';
import { storedClustersSchema, storedPositionsSchema } from './layout-snapshot';

// =============================================================================
// `kg.graph_layout` handler (#371) — Prisma mocked: what it reads, what it writes
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_AT = new Date('2026-09-01T00:00:00Z');

interface RawCall {
  sql: string;
  values: unknown[];
}

function harness(opts: { nodes?: Array<{ id: string; type: string }> } = {}) {
  const nodes = opts.nodes ?? [
    { id: A, type: 'Person' },
    { id: B, type: 'Person' },
    { id: C, type: 'Meeting' },
  ];
  const raw: RawCall[] = [];
  const tx = {
    kgGraphLayout: {
      create: jest.fn(async () => ({})),
      findMany: jest.fn(async () => [{ id: 'keep-1' }, { id: 'keep-2' }]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    kgEntity: { findMany: jest.fn(async () => nodes) },
    kgGraphLayout: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      raw.push({ sql, values });
      if (sql.includes('GREATEST')) return [{ at: SOURCE_AT }];
      if (sql.includes('FROM kg_relations')) return [{ source: A, target: C }, { source: B, target: C }];
      if (sql.includes('FROM kg_items')) return [{ source: A, target: B }];
      return [];
    }),
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const registry = new JobHandlerRegistry();
  const handler = new KgGraphLayoutHandler(registry, prisma as unknown as PrismaService);
  return { handler, registry, prisma, tx, raw };
}

const job = (payload: unknown) => ({ id: 'job-1', payload }) as never;

describe('KgGraphLayoutHandler — registration and profile', () => {
  it('registers under kg.graph_layout with the canonical profile', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();
    expect(registry.get(KG_GRAPH_LAYOUT_JOB_TYPE)).toBe(handler);
    expect(handler.profile).toEqual({ maxRuntimeMs: 15 * 60_000, maxAttempts: 2 });
    expect(KG_GRAPH_LAYOUT_PROFILE).toEqual({ maxRuntimeMs: 900_000, maxAttempts: 2 });
  });

  it('is server-only — no node members, listed in serverOnlyTypes()', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain(KG_GRAPH_LAYOUT_JOB_TYPE);
  });

  it('reads only a uuid ownerId payload', () => {
    expect(readGraphLayoutPayload({ ownerId: OWNER })).toEqual({ ownerId: OWNER });
    expect(readGraphLayoutPayload({ ownerId: 'nope' })).toBeNull();
    expect(readGraphLayoutPayload(null)).toBeNull();
  });
});

describe('KgGraphLayoutHandler.process', () => {
  it('reads readable, non-merged entities of this owner only', async () => {
    const { handler, prisma } = harness();
    await handler.process(job({ ownerId: OWNER }));
    expect(prisma.kgEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: OWNER, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
      }),
    );
  });

  it('reads readable relations valid NOW with an entity on both ends, owner-scoped', async () => {
    const { handler, raw } = harness();
    await handler.process(job({ ownerId: OWNER }));
    const rel = raw.find((c) => c.sql.includes('FROM kg_relations') && !c.sql.includes('GREATEST'));
    expect(rel).toBeDefined();
    expect(rel!.sql).toContain('r.from_id IS NOT NULL');
    expect(rel!.sql).toContain('r.owner_id =');
    expect(rel!.values).toContain(OWNER);
    expect(rel!.values).toContainEqual(['accepted', 'edited']);
    const asOf = rel!.values.find(
      (v) => typeof v === 'object' && v !== null && typeof (v as { sql?: unknown }).sql === 'string',
    ) as { sql: string; values: unknown[] };
    expect(asOf.sql).toContain('r.valid IS NULL OR r.valid @>');
    const at = asOf.values[0] as Date;
    expect(Math.abs(at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('builds item edges from subject–owner and subject–counterparty, excluding sensitive person facts', async () => {
    const { handler, raw } = harness();
    await handler.process(job({ ownerId: OWNER }));
    const items = raw.find((c) => c.sql.includes('FROM kg_items'));
    expect(items).toBeDefined();
    expect(items!.sql).toContain('i.owner_person_id');
    expect(items!.sql).toContain('i.counterparty_id');
    expect(items!.sql).toContain('i.sensitivity IS NULL OR i.sensitivity::text <>');
    expect(items!.values.filter((v) => v === 'sensitive')).toHaveLength(2);
    expect(items!.values.filter((v) => v === OWNER)).toHaveLength(2);
  });

  it('writes one snapshot of ids and numbers, then keeps only the newest two in the same transaction', async () => {
    const { handler, prisma, tx } = harness();
    await handler.process(job({ ownerId: OWNER }));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.kgGraphLayout.create).toHaveBeenCalledTimes(1);
    const data = (tx.kgGraphLayout.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ ownerId: OWNER, nodeCount: 3, edgeCount: 3, sourceUpdatedAt: SOURCE_AT });
    expect(typeof data.ontologyVersion).toBe('string');
    const clusters = storedClustersSchema.parse(data.clusters);
    const positions = storedPositionsSchema.parse(data.positions);
    expect(positions.nodes.map((n) => n[0]).sort()).toEqual([A, B, C]);
    expect(clusters.items.length).toBeGreaterThan(0);
    // No label anywhere: the snapshot is ids and coordinates only.
    expect(JSON.stringify(data)).not.toMatch(/label"\s*:\s*"/);

    expect(tx.kgGraphLayout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: OWNER }, take: GRAPH_LAYOUT_RETAINED }),
    );
    expect(tx.kgGraphLayout.deleteMany).toHaveBeenCalledWith({
      where: { ownerId: OWNER, id: { notIn: ['keep-1', 'keep-2'] } },
    });
  });

  it('stamps sourceUpdatedAt before reading the graph', async () => {
    const { handler, prisma, raw } = harness();
    await handler.process(job({ ownerId: OWNER }));
    expect(raw[0].sql).toContain('GREATEST');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.kgEntity.findMany.mock.invocationCallOrder[0],
    );
  });

  it('writes nothing for an empty graph and drops that owner’s old snapshots', async () => {
    const { handler, prisma } = harness({ nodes: [] });
    await handler.process(job({ ownerId: OWNER }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.kgGraphLayout.deleteMany).toHaveBeenCalledWith({ where: { ownerId: OWNER } });
  });

  it('returns without reading anything for an unreadable payload', async () => {
    const { handler, prisma } = harness();
    await expect(handler.process(job({ nope: true }))).resolves.toBeUndefined();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.kgEntity.findMany).not.toHaveBeenCalled();
  });
});
