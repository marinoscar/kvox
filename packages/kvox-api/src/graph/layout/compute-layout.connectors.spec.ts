import { computeLayout, type LayoutInput } from './compute-layout.js';

// =============================================================================
// Connectors: sampled betweenness inside computeLayout (GIC-16, #677)
// =============================================================================

function id(prefix: string, i: number): string {
  return `${prefix}0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

/** Two 6-cliques joined only through one bridge node. */
function twoCliquesWithBridge(): { input: LayoutInput; bridge: string } {
  const nodes: LayoutInput['nodes'] = [];
  const edges: LayoutInput['edges'] = [];
  for (const c of ['1', '2']) {
    const ids = Array.from({ length: 6 }, (_, i) => id(c, i));
    ids.forEach((n) => nodes.push({ id: n, type: 'Person' }));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) edges.push({ source: ids[i], target: ids[j], weight: 1 });
    }
  }
  const bridge = id('9', 0);
  nodes.push({ id: bridge, type: 'Person' });
  edges.push({ source: bridge, target: id('1', 0), weight: 1 }, { source: bridge, target: id('2', 0), weight: 1 });
  return { input: { nodes, edges }, bridge };
}

describe('computeLayout connectors', () => {
  it('ranks the bridge between two cliques first and lists both clusters it connects', () => {
    const { input, bridge } = twoCliquesWithBridge();
    const out = computeLayout(input, { seed: 'seed' });
    expect(out.connectors[0].id).toBe(bridge);
    expect(out.connectors[0].clusterIds.length).toBeGreaterThanOrEqual(2);
    expect(out.connectors[0].score).toBeGreaterThan(out.connectors[1].score);
    // 13 nodes is below the sample size: the estimate is exact.
    expect(out.betweennessSources).toBe(13);
  });

  it('is deterministic with the seeded rng, whatever the input order', () => {
    const { input } = twoCliquesWithBridge();
    const a = computeLayout(input, { seed: 's' });
    const b = computeLayout({ nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() }, { seed: 's' });
    expect(b.connectors).toEqual(a.connectors);
  });

  it('keeps at most 50 connectors and samples at most 200 sources', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({ id: id('3', i), type: 'Person' }));
    const edges = nodes.slice(1).map((node, i) => ({ source: nodes[i].id, target: node.id, weight: 1 })); // a path
    const out = computeLayout({ nodes, edges }, { seed: 's' });
    expect(out.connectors).toHaveLength(50);
    expect(out.betweennessSources).toBe(200);
    expect(out.connectors.map((c) => c.id)).not.toContain(nodes[0].id);
  });

  it('computes nothing for an edgeless graph', () => {
    const out = computeLayout(
      { nodes: [{ id: id('1', 0), type: 'Person' }, { id: id('1', 1), type: 'Person' }], edges: [] },
      { seed: 's' },
    );
    expect(out.connectors).toEqual([]);
    expect(out.betweennessSources).toBe(0);
  });
});
