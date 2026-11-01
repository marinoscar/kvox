import { describe, expect, it } from 'vitest';

import {
  FULL_VIEW_FORCED_LABELS,
  FULL_VIEW_NODE_CAP,
  FULL_VIEW_SIZE_MAX,
  FULL_VIEW_SIZE_MIN,
  buildFullGraphState,
  chipCount,
  fullViewListRows,
  fullViewNodeSize,
  timeHiddenIds,
  topDegreeIds,
} from '../../src/graph/ui/components/explorer/fullGraphModel.js';
import { createExplorerState, mergeSlice } from '../../src/graph/ui/components/explorer/explorerModel.js';
import { FULL_VIEW_LABEL_THRESHOLD, DEFAULT_BUDGETS, COMPACT_BUDGETS, fullViewBudgets } from '../../src/graph/ui/components/explorer/shell/explorerBudgets.js';
import { ACME_ID, ANA_ID, JOE_ID, LONE_ID, gid, overviewEdges, overviewNodes } from './graphData.js';

/** The full view's pure model (#768): no React, no sigma. */
describe('buildFullGraphState', () => {
  it('puts every node at its snapshot position, with no explorer cap, and every edge with both ends', () => {
    const state = buildFullGraphState({ nodes: overviewNodes, edges: overviewEdges });
    expect(state.cap).toBe(FULL_VIEW_NODE_CAP);
    expect(state.graph.order).toBe(overviewNodes.length);
    expect(state.graph.size).toBe(overviewEdges.length);
    expect(state.seedIds).toEqual([]);
    const joe = state.graph.getNodeAttributes(JOE_ID);
    expect([joe.x, joe.y]).toEqual([-330, 60]);
    expect(joe.entityType).toBe('Person');
    expect(joe.nodeKind).toBe('entity');
    expect(joe.image).toMatch(/^data:/);
    // Straight, thin edges with the relation type kept apart from sigma's program name.
    const edge = state.graph.getEdgeAttributes(overviewEdges[0].id);
    expect(edge).toMatchObject({ type: 'arrow', relationType: 'WORKS_FOR', curvature: 0 });
  });

  it('marks the owner\'s own node from the overview (#778)', () => {
    const nodes = overviewNodes.map((node) => (node.id === ANA_ID ? { ...node, isSelf: true } : node));
    const state = buildFullGraphState({ nodes, edges: overviewEdges });
    expect(state.graph.getNodeAttribute(ANA_ID, 'isSelf')).toBe(true);
    expect(state.graph.getNodeAttribute(JOE_ID, 'isSelf')).toBeUndefined();
  });

  it('skips an edge whose end is not returned, and a duplicate node', () => {
    const state = buildFullGraphState({
      nodes: [...overviewNodes, overviewNodes[0]],
      edges: [...overviewEdges, { id: gid(9999), source: JOE_ID, target: gid(123456), type: 'KNOWS' }],
    });
    expect(state.graph.order).toBe(overviewNodes.length);
    expect(state.graph.hasEdge(gid(9999))).toBe(false);
  });

  it('holds 5,000 nodes and 20,000 edges', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({
      id: gid(100_000 + i),
      label: `Node ${i}`,
      type: i % 2 ? 'Person' : 'Organization',
      x: i,
      y: -i,
      clusterId: 0,
      degree: i % 50,
    }));
    const edges = Array.from({ length: 20000 }, (_, i) => ({
      id: gid(200_000 + i),
      source: nodes[i % 5000].id,
      target: nodes[(i * 7 + 1) % 5000].id,
      type: 'KNOWS',
    }));
    const started = performance.now();
    const state = buildFullGraphState({ nodes, edges });
    expect(state.graph.order).toBe(5000);
    expect(state.graph.size).toBe(20000);
    // Generous: it is one pass each, no layout.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('labels only the best-connected nodes at every zoom', () => {
    const state = buildFullGraphState({ nodes: overviewNodes, edges: [] });
    const forced = state.graph.filterNodes((_id, attrs) => attrs.forceLabel === true);
    expect(forced.length).toBe(Math.min(FULL_VIEW_FORCED_LABELS, overviewNodes.length));
    expect(topDegreeIds(overviewNodes, 2)).toEqual(new Set([ACME_ID, JOE_ID]));
  });

  it('sizes by degree, clamped', () => {
    expect(fullViewNodeSize(0)).toBe(FULL_VIEW_SIZE_MIN);
    expect(fullViewNodeSize(4)).toBeGreaterThan(fullViewNodeSize(1));
    expect(fullViewNodeSize(10_000)).toBe(FULL_VIEW_SIZE_MAX);
  });
});

describe('fullViewListRows', () => {
  it('lists the best connected first, at most the limit', () => {
    const state = buildFullGraphState({ nodes: overviewNodes, edges: [] });
    const rows = fullViewListRows(state, 3);
    expect(rows.map((r) => r.id)).toEqual([ACME_ID, JOE_ID, rows[2].id]);
    expect(rows).toHaveLength(3);
    expect(fullViewListRows(state).at(-1)!.id).toBe(LONE_ID);
  });
});

describe('chipCount', () => {
  it('reads an entity type, 0 when absent, and no count for an item kind or without counts', () => {
    expect(chipCount('Person', { Person: 4 })).toBe(4);
    expect(chipCount('Product', { Person: 4 })).toBe(0);
    expect(chipCount('commitment', { Person: 4 })).toBeNull();
    expect(chipCount('Person', null)).toBeNull();
  });
});

describe('timeHiddenIds', () => {
  it('hides what is not active, keeps the kept ids, and hides nothing while activity is unknown', () => {
    const state = createExplorerState();
    mergeSlice(state, {
      seedIds: [JOE_ID],
      asOf: '2026-09-26T00:00:00.000Z',
      nodes: [
        { id: JOE_ID, nodeKind: 'entity', type: 'Person', label: 'Joe', depth: 0, degree: 2, status: null, occurredAt: null },
        { id: ANA_ID, nodeKind: 'entity', type: 'Person', label: 'Ana', depth: 1, degree: 1, status: null, occurredAt: null },
        { id: ACME_ID, nodeKind: 'entity', type: 'Organization', label: 'Acme', depth: 1, degree: 1, status: null, occurredAt: null },
      ],
      edges: [],
      truncated: false,
      cap: 300,
    });
    const ids = [JOE_ID, ANA_ID, ACME_ID];
    expect(timeHiddenIds(state, ids, null, new Set()).size).toBe(0);
    expect(timeHiddenIds(state, ids, new Set([ANA_ID]), new Set([JOE_ID]))).toEqual(new Set([ACME_ID]));
  });
});

describe('fullViewBudgets', () => {
  it('lifts the explorer cap to the server cap and thins the labels, keeping the device budgets', () => {
    const full = fullViewBudgets(DEFAULT_BUDGETS, FULL_VIEW_NODE_CAP);
    expect(full.visibleNodeCap).toBe(5000);
    expect(full.labelDensity).toBe('reduced');
    expect(full.labelSizeThreshold).toBe(FULL_VIEW_LABEL_THRESHOLD);
    expect(full.listViewDefaultAbove).toBe(Number.POSITIVE_INFINITY);
    const phone = fullViewBudgets(COMPACT_BUDGETS, FULL_VIEW_NODE_CAP);
    expect(phone.pixelRatioCap).toBe(COMPACT_BUDGETS.pixelRatioCap);
    expect(phone.hitTargetPx).toBe(COMPACT_BUDGETS.hitTargetPx);
  });
});
