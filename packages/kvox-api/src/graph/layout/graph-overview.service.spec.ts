import { BadRequestException } from '@nestjs/common';

import { jobsMock } from '../__fixtures__/jobs-mock.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import { GraphLayoutEnqueuer } from './graph-layout.enqueuer.js';
import { GraphOverviewService } from './graph-overview.service.js';
import { graphOverviewQuerySchema } from '@marinoscar/kvox-contract/graph';
import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

// =============================================================================
// GraphOverviewService filters (#768): types, window, typeCounts — mocked SQL
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

let edgeRows: Array<Record<string, string>> = [];

function harness() {
  const queries: string[] = [];
  const prisma = {
    kgGraphLayout: {
      findFirst: jest.fn(async () => ({
        computedAt: new Date('2026-01-01T00:00:00Z'),
        sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        nodeCount: 3,
        edgeCount: 2,
        clusters: {
          version: 1,
          items: [{ id: 0, labelEntityId: A, size: 3, x: 0, y: 0, radius: 1, typeCounts: {}, sampleIds: [A, B, C] }],
          clusterEdges: [],
          modularity: 0,
          tooLarge: false,
        },
        positions: {
          version: 1,
          types: ['Person', 'Project'],
          nodes: [
            [A, 1, 1, 0, 0, 5],
            [B, 2, 2, 0, 1, 3],
            [C, 3, 3, 0, 0, 1],
          ],
        },
      })),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      queries.push(sql);
      if (sql.includes('FROM kg_relations r') && sql.includes('LIMIT')) return edgeRows;
      if (sql.includes('FROM active a')) return [{ id: A }, { id: B }]; // C has no evidence in the window
      if (sql.includes('GROUP BY e.type')) return [{ type: 'Person', n: 2 }, { type: 'Project', n: 1 }];
      if (sql.includes('MAX(') || sql.includes('max(')) return [{ at: new Date('2026-01-01T00:00:00Z') }];
      return [
        { id: A, label: 'Ann', type: 'Person' },
        { id: B, label: 'Apollo', type: 'Project' },
        { id: C, label: 'Cy', type: 'Person' },
      ];
    }),
  };
  const enqueuer = new GraphLayoutEnqueuer(jobsMock() as never);
  const ontology = { effectiveSchemaFor: jest.fn(async () => computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] })) };
  const service = new GraphOverviewService(prisma as unknown as KvoxGraphDb, enqueuer, ontology as never);
  return { service, prisma, queries, ontology };
}

describe('GraphOverviewService filters', () => {
  it('returns every live node and typeCounts with no filter, without a window query', async () => {
    const { service, queries } = harness();
    const view = await service.overview(OWNER);
    expect(view.nodes.map((n) => n.id)).toEqual([A, B, C]);
    expect(view.typeCounts).toEqual({ Person: 2, Project: 1 });
    expect(queries.some((q) => q.includes('FROM active a'))).toBe(false);
  });

  it('keeps only nodes with evidence in the window and leaves positions untouched', async () => {
    const { service } = harness();
    const view = await service.overview(OWNER, { from: '2026-01-01' });
    expect(view.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      [A, 1, 1],
      [B, 2, 2],
    ]);
    expect(view.clusters[0]?.memberSample.map((m) => m.id)).toEqual([A, B]);
  });

  it('rejects an unknown type with a 400', async () => {
    const { service } = harness();
    await expect(service.overview(OWNER, { types: 'Spaceship' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats a blank types value as no filter', async () => {
    const { service } = harness();
    const view = await service.overview(OWNER, { types: ' , ' });
    expect(view.nodes).toHaveLength(3);
  });

  it('filters by entity type', async () => {
    const { service } = harness();
    const view = await service.overview(OWNER, { types: 'Person' });
    expect(view.nodes.map((n) => n.id)).toEqual([A, C]);
    // typeCounts is never type-filtered: the chips still show every type.
    expect(view.typeCounts).toEqual({ Person: 2, Project: 1 });
  });
});

describe('GraphOverviewService edges', () => {
  const edge = (n: number, source: string, target: string) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, source, target, type: 'WORKS_ON' });

  it('omits edges without the flag', async () => {
    const { service, queries } = harness();
    const view = await service.overview(OWNER);
    expect(view).not.toHaveProperty('edges');
    expect(view).not.toHaveProperty('edgesTruncated');
    expect(queries.some((q) => q.includes('LIMIT'))).toBe(false);
  });

  it('returns edges among the returned nodes with edges=true', async () => {
    edgeRows = [edge(1, A, B)];
    const { service } = harness();
    const view = await service.overview(OWNER, { edges: true });
    expect(view.edges).toEqual(edgeRows);
    expect(view.edgesTruncated).toBe(false);
  });

  it('flags truncation when more than the cap matched', async () => {
    edgeRows = Array.from({ length: 20001 }, (_, i) => edge(1, A, B));
    const { service } = harness();
    const view = await service.overview(OWNER, { edges: true });
    expect(view.edges).toHaveLength(20000);
    expect(view.edgesTruncated).toBe(true);
    edgeRows = [];
  });

  it('parses the flag from the query string', () => {
    expect(graphOverviewQuerySchema.parse({ edges: 'true' }).edges).toBe(true);
    expect(graphOverviewQuerySchema.parse({}).edges).toBeUndefined();
    expect(graphOverviewQuerySchema.safeParse({ edges: 'yes' }).success).toBe(false);
  });
});

describe('graphOverviewQuerySchema', () => {
  it('accepts an empty query, dates and datetimes; rejects junk dates', () => {
    expect(graphOverviewQuerySchema.safeParse({}).success).toBe(true);
    expect(graphOverviewQuerySchema.safeParse({ from: '2026-01-01', to: '2026-02-01T00:00:00Z' }).success).toBe(true);
    expect(graphOverviewQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});
