import { MultiDirectedGraph } from 'graphology';
import { describe, expect, it } from 'vitest';

import { concentricPositions, hopDepths } from '../../../src/graph/ui/components/explorer/layout/concentric.js';

function ego() {
  const graph = new MultiDirectedGraph();
  graph.addNode('seed', { degree: 4 });
  graph.addNode('a', { degree: 1 });
  graph.addNode('b', { degree: 9 });
  graph.addNode('c', { degree: 5 });
  graph.addNode('far', { degree: 1 });
  graph.addNode('lost', { degree: 0 });
  graph.addDirectedEdge('seed', 'a');
  graph.addDirectedEdge('b', 'seed');
  graph.addDirectedEdge('seed', 'c');
  graph.addDirectedEdge('a', 'far');
  return graph;
}

const radius = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

describe('concentric layout', () => {
  it('computes hop depth from the seeds', () => {
    const depths = hopDepths(ego(), ['seed']);
    expect(depths.get('seed')).toBe(0);
    expect(depths.get('a')).toBe(1);
    expect(depths.get('far')).toBe(2);
    expect(depths.has('lost')).toBe(false);
  });

  it('puts the seed at the centre and depth-1 nodes on ring 1', () => {
    const positions = concentricPositions(ego(), ['seed']);
    expect(positions.get('seed')).toEqual({ x: 0, y: 0 });
    const ring1 = ['a', 'b', 'c'].map((id) => radius(positions.get(id)!));
    expect(ring1[0]).toBeCloseTo(ring1[1]!, 2);
    expect(ring1[1]).toBeCloseTo(ring1[2]!, 2);
    expect(ring1[0]).toBeGreaterThan(0);
    expect(radius(positions.get('far')!)).toBeGreaterThan(ring1[0]!);
    expect(radius(positions.get('lost')!)).toBeGreaterThan(radius(positions.get('far')!));
  });

  it('orders a ring by degree (highest first, clockwise from twelve o\'clock) when there is no DOI', () => {
    const positions = concentricPositions(ego(), ['seed']);
    // b (9), c (5), a (1): b is first, so it sits at the top.
    expect(positions.get('b')!.x).toBeCloseTo(0, 2);
    expect(positions.get('b')!.y).toBeLessThan(0);
    const angle = (id: string) => {
      const p = positions.get(id)!;
      return (Math.atan2(p.y, p.x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    };
    expect(angle('b')).toBeLessThan(angle('c'));
    expect(angle('c')).toBeLessThan(angle('a'));
  });

  it('orders a ring by DOI when nodes carry one', () => {
    const graph = ego();
    graph.setNodeAttribute('a', 'doi', 0.9);
    graph.setNodeAttribute('b', 'doi', 0.2);
    graph.setNodeAttribute('c', 'doi', 0.5);
    const positions = concentricPositions(graph, ['seed']);
    const angle = (id: string) => {
      const p = positions.get(id)!;
      return (Math.atan2(p.y, p.x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    };
    expect(angle('a')).toBeLessThan(angle('c'));
    expect(angle('c')).toBeLessThan(angle('b'));
  });

  it('is deterministic and shares a small ring between several seeds', () => {
    const graph = ego();
    const one = concentricPositions(graph, ['seed', 'far']);
    const two = concentricPositions(graph, ['seed', 'far']);
    expect(one).toEqual(two);
    expect(radius(one.get('seed')!)).toBeGreaterThan(0);
    expect(radius(one.get('seed')!)).toBeCloseTo(radius(one.get('far')!), 2);
  });
});
