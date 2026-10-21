import { describe, expect, it } from 'vitest';

import {
  applyLayoutPositions,
  buildLayoutRequest,
  planLayout,
  snapshotPositions,
} from '../../../src/graph/ui/components/explorer/layout/incremental.js';
import { runLayout } from '../../../src/graph/ui/components/explorer/layout/layoutEngine.js';
import { ringPosition } from '../../../src/graph/ui/components/explorer/explorerModel.js';
import { seededGraph } from './fixtures.js';

async function layOut(graph: ReturnType<typeof seededGraph>, plan: ReturnType<typeof planLayout>) {
  const request = buildLayoutRequest(graph, plan, 60_000);
  const result = await runLayout(request, {
    sliceMs: 1000,
    yieldToHost: () => Promise.resolve(),
    isCancelled: () => false,
    onFrame: () => undefined,
  });
  expect(result).not.toBeNull();
  applyLayoutPositions(graph, request, result!.positions);
  return result!;
}

describe('incremental layout', () => {
  it('expanding keeps every existing position exactly and moves only the new nodes', async () => {
    const graph = seededGraph(30);
    const all = new Set(graph.nodes());
    await layOut(graph, planLayout(graph, new Set()));
    const before = snapshotPositions(graph);

    // "Expand n3": four new nodes ringed around it, as mergeSlice does.
    const parent = graph.getNodeAttributes('n3');
    const added: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `new${i}`;
      graph.addNode(id, { ...ringPosition(parent.x as number, parent.y as number, i), size: 5, degree: 1, fixed: false });
      graph.addDirectedEdge('n3', id, { weight: 1 });
      added.push(id);
    }
    const seeded = snapshotPositions(graph);

    const plan = planLayout(graph, all);
    expect([...plan.movable].sort()).toEqual(added.sort());
    await layOut(graph, plan);

    const after = snapshotPositions(graph);
    for (const id of all) expect(after.get(id)).toEqual(before.get(id));
    expect(added.some((id) => after.get(id)!.x !== seeded.get(id)!.x || after.get(id)!.y !== seeded.get(id)!.y)).toBe(true);
  });

  it('"Re-layout all" moves existing nodes, but never a pinned one', async () => {
    const graph = seededGraph(30);
    const all = new Set(graph.nodes());
    graph.setNodeAttribute('n5', 'fixed', true);
    const before = snapshotPositions(graph);

    const plan = planLayout(graph, all, { all: true });
    expect(plan.movable.has('n5')).toBe(false);
    expect(plan.movable.size).toBe(29);
    await layOut(graph, plan);

    const after = snapshotPositions(graph);
    expect(after.get('n5')).toEqual(before.get('n5'));
    expect(graph.nodes().filter((id) => id !== 'n5').some((id) => after.get(id)!.x !== before.get(id)!.x)).toBe(true);
  });

  it('carries the nodes of an interrupted run into the next one', () => {
    const graph = seededGraph(10);
    const plan = planLayout(graph, new Set(graph.nodes()), { carry: new Set(['n2', 'n4']) });
    expect([...plan.movable].sort()).toEqual(['n2', 'n4']);
  });

  it('sends fixed flags, sizes and weights in the request', () => {
    const graph = seededGraph(6);
    const request = buildLayoutRequest(graph, { movable: new Set(['n1']) }, 1500);
    expect(request.budgetMs).toBe(1500);
    expect(request.nodes.find((n) => n.id === 'n1')!.fixed).toBe(false);
    expect(request.nodes.find((n) => n.id === 'n0')!.fixed).toBe(true);
    expect(request.nodes[0]!.size).toBe(6);
    expect(request.edges.every((e) => e.w === 1)).toBe(true);
  });
});
