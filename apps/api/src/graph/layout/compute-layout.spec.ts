import {
  CLUSTER_SAMPLE_SIZE,
  clusterRadius,
  computeLayout,
  fa2Iterations,
  LAYOUT_EXTENT,
  UNCONNECTED_CLUSTER_ID,
  type LayoutInput,
} from './compute-layout';
import { layoutSeed, mulberry32, seedFrom } from './seeded-rng';

// =============================================================================
// computeLayout (#371) — pure, deterministic whole-graph clusters and positions
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';

function id(prefix: string, i: number): string {
  // A uuid-shaped, sortable id: prefix nibble + zero-padded index.
  const hex = i.toString(16).padStart(12, '0');
  return `${prefix}0000000-0000-4000-8000-${hex}`;
}

/** `k` disjoint cliques of `size` nodes each, weight 1. */
function cliques(k: number, size: number, type = 'Person'): LayoutInput {
  const nodes: LayoutInput['nodes'] = [];
  const edges: LayoutInput['edges'] = [];
  for (let c = 0; c < k; c += 1) {
    const ids = Array.from({ length: size }, (_, i) => id(String(c + 1), i));
    ids.forEach((n) => nodes.push({ id: n, type }));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) edges.push({ source: ids[i], target: ids[j], weight: 1 });
    }
  }
  return { nodes, edges };
}

describe('seeded-rng', () => {
  it('mulberry32 is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(Array.from({ length: 100 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it('seedFrom hashes the string to a uint32 and layoutSeed has the issue shape', () => {
    expect(seedFrom('x')).toBe(seedFrom('x'));
    expect(seedFrom('x')).not.toBe(seedFrom('y'));
    expect(Number.isInteger(seedFrom('x')) && seedFrom('x') >= 0).toBe(true);
    expect(layoutSeed(OWNER, 3, 4)).toBe(`${OWNER}:3:4`);
  });
});

describe('computeLayout', () => {
  it('returns byte-identical output for the same input, whatever the input order', () => {
    const input = cliques(3, 6);
    const seed = layoutSeed(OWNER, input.nodes.length, input.edges.length);
    const first = JSON.stringify(computeLayout(input, { seed }));
    const second = JSON.stringify(computeLayout(input, { seed }));
    const shuffled = JSON.stringify(
      computeLayout({ nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() }, { seed }),
    );
    expect(second).toBe(first);
    expect(shuffled).toBe(first);
  });

  it('finds three clusters in three disconnected cliques, with no Unconnected cluster', () => {
    const out = computeLayout(cliques(3, 6), { seed: 's' });
    expect(out.clusters.map((c) => c.id)).toEqual([0, 1, 2]);
    expect(out.clusters.every((c) => c.size === 6)).toBe(true);
    expect(out.modularity).toBeGreaterThan(0.5);
    expect(out.clusterEdges).toEqual([]);
    // Every clique's members share one cluster.
    for (let c = 0; c < 3; c += 1) {
      const ids = new Set(Array.from({ length: 6 }, (_, i) => id(String(c + 1), i)));
      const clusterIds = new Set(out.positions.filter((p) => ids.has(p[0])).map((p) => p[3]));
      expect(clusterIds.size).toBe(1);
    }
  });

  it('pools isolated nodes into cluster -1 with no label candidate', () => {
    const input = cliques(1, 4);
    input.nodes.push({ id: id('a', 1), type: 'Person' }, { id: id('a', 2), type: 'Project' });
    const out = computeLayout(input, { seed: 's' });
    const unconnected = out.clusters.find((c) => c.id === UNCONNECTED_CLUSTER_ID);
    expect(unconnected).toMatchObject({ size: 2, labelEntityId: null, typeCounts: { Person: 1, Project: 1 } });
    expect(out.clusters[out.clusters.length - 1].id).toBe(UNCONNECTED_CLUSTER_ID);
    const isolated = out.positions.filter((p) => p[0].startsWith('a'));
    expect(isolated.map((p) => p[3])).toEqual([UNCONNECTED_CLUSTER_ID, UNCONNECTED_CLUSTER_ID]);
  });

  it('an edgeless graph is all Unconnected, with modularity 0', () => {
    const out = computeLayout({ nodes: [{ id: id('a', 1), type: 'Person' }], edges: [] }, { seed: 's' });
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]).toMatchObject({ id: -1, size: 1, x: 0, y: 0 });
    expect(out.positions).toEqual([[id('a', 1), 0, 0, -1, 0, 0]]);
    expect(out.modularity).toBe(0);
  });

  it('an empty graph produces nothing, without error', () => {
    const out = computeLayout({ nodes: [], edges: [] }, { seed: 's' });
    expect(out).toMatchObject({ clusters: [], positions: [], nodeCount: 0, edgeCount: 0, tooLarge: false });
  });

  it('merges parallel edges by summing weight and drops self loops and dangling ends', () => {
    const a = id('a', 1);
    const b = id('a', 2);
    const c = id('a', 3);
    const out = computeLayout(
      {
        nodes: [
          { id: a, type: 'Person' },
          { id: b, type: 'Person' },
          { id: c, type: 'Meeting' },
        ],
        edges: [
          { source: a, target: b, weight: 1 },
          { source: b, target: a, weight: 0.5 },
          { source: a, target: a, weight: 1 },
          { source: a, target: id('f', 9), weight: 1 },
          { source: b, target: c, weight: 1 },
        ],
      },
      { seed: 's' },
    );
    expect(out.edgeCount).toBe(2);
    expect(out.nodeCount).toBe(3);
    // Degree counts merged neighbours: a–b once, b–c once.
    const degree = Object.fromEntries(out.positions.map((p) => [p[0], p[5]]));
    expect(degree).toEqual({ [a]: 1, [b]: 2, [c]: 1 });
  });

  it('labels a cluster after a Person rather than a better-connected Meeting', () => {
    const meeting = id('b', 0);
    const people = [id('a', 1), id('a', 2), id('a', 3)];
    const edges = people.map((p) => ({ source: meeting, target: p, weight: 1 }));
    edges.push({ source: people[0], target: people[1], weight: 0.5 });
    const out = computeLayout(
      { nodes: [{ id: meeting, type: 'Meeting' }, ...people.map((p) => ({ id: p, type: 'Person' }))], edges },
      { seed: 's' },
    );
    expect(out.clusters).toHaveLength(1);
    // people[0] and people[1] tie on weighted degree 1.5; the id breaks the tie.
    expect(out.clusters[0].labelEntityId).toBe(people[0]);
    // Samples are by degree: the meeting (3) first.
    expect(out.clusters[0].sampleIds[0]).toBe(meeting);
  });

  it('falls back to a Meeting label when a cluster has nothing else', () => {
    const m1 = id('b', 1);
    const m2 = id('b', 2);
    const out = computeLayout(
      { nodes: [{ id: m1, type: 'Meeting' }, { id: m2, type: 'Meeting' }], edges: [{ source: m1, target: m2, weight: 1 }] },
      { seed: 's' },
    );
    expect(out.clusters[0].labelEntityId).toBe(m1);
  });

  it('computes centroid, radius, type counts and a bounded sample', () => {
    const out = computeLayout(cliques(1, 12, 'Organization'), { seed: 's' });
    const [cluster] = out.clusters;
    const xs = out.positions.map((p) => p[1]);
    const ys = out.positions.map((p) => p[2]);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    expect(cluster.x).toBeCloseTo(mean(xs), 1);
    expect(cluster.y).toBeCloseTo(mean(ys), 1);
    expect(cluster.radius).toBe(clusterRadius(12));
    expect(clusterRadius(4)).toBe(40);
    expect(cluster.typeCounts).toEqual({ Organization: 12 });
    expect(cluster.sampleIds).toHaveLength(CLUSTER_SAMPLE_SIZE);
    expect(out.types).toEqual(['Organization']);
  });

  it('normalizes every coordinate into [-1000, 1000] and touches the extent', () => {
    const out = computeLayout(cliques(4, 5), { seed: 's' });
    const all = out.positions.flatMap((p) => [p[1], p[2]]);
    expect(all.every((v) => v >= -LAYOUT_EXTENT && v <= LAYOUT_EXTENT)).toBe(true);
    expect(Math.max(...all.map(Math.abs))).toBeCloseTo(LAYOUT_EXTENT, 0);
  });

  it('keeps only the top maxNodes by degree for positions but clusters the full graph', () => {
    const input = cliques(2, 5);
    // A third, smaller clique whose nodes have lower degree.
    const small = [id('9', 1), id('9', 2)];
    small.forEach((n) => input.nodes.push({ id: n, type: 'Project' }));
    input.edges.push({ source: small[0], target: small[1], weight: 1 });

    const out = computeLayout(input, { seed: 's', maxNodes: 10 });
    expect(out.positions).toHaveLength(10);
    expect(out.positions.some((p) => small.includes(p[0]))).toBe(false);
    expect(out.clusters.reduce((s, c) => s + c.size, 0)).toBe(12);
    // Positions are ordered highest degree first.
    const degrees = out.positions.map((p) => p[5]);
    expect([...degrees].sort((a, b) => b - a)).toEqual(degrees);
  });

  it('reports tooLarge above the Louvain ceiling, with no clusters or positions', () => {
    const nodes = Array.from({ length: 100_001 }, (_, i) => ({ id: `n${String(i).padStart(6, '0')}`, type: 'Person' }));
    const out = computeLayout({ nodes, edges: [] }, { seed: 's' });
    expect(out).toMatchObject({ tooLarge: true, clusters: [], positions: [], nodeCount: 100_001 });
  });

  it('sums inter-cluster weights into clusterEdges', () => {
    const input = cliques(2, 5);
    input.edges.push({ source: id('1', 0), target: id('2', 0), weight: 0.5 });
    input.edges.push({ source: id('1', 1), target: id('2', 1), weight: 0.5 });
    const out = computeLayout(input, { seed: 's' });
    expect(out.clusters.filter((c) => c.id >= 0)).toHaveLength(2);
    expect(out.clusterEdges).toEqual([{ a: 0, b: 1, weight: 1 }]);
  });

  it('picks the FA2 iteration budget by size', () => {
    expect(fa2Iterations(10)).toBe(300);
    expect(fa2Iterations(1000)).toBe(150);
    expect(fa2Iterations(10_000)).toBe(80);
  });

  it('lays out a 10k-node / 40k-edge graph within budget', () => {
    const rng = mulberry32(7);
    const n = 10_000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(5, '0')}`, type: i % 5 === 0 ? 'Meeting' : 'Person' }));
    const edges: LayoutInput['edges'] = [];
    // Community structure: 100 groups of 100, most edges inside a group.
    for (let e = 0; e < 40_000; e += 1) {
      const a = Math.floor(rng() * n);
      const group = Math.floor(a / 100);
      const b = rng() < 0.9 ? group * 100 + Math.floor(rng() * 100) : Math.floor(rng() * n);
      edges.push({ source: nodes[a].id, target: nodes[b].id, weight: 1 });
    }
    const started = Date.now();
    const out = computeLayout({ nodes, edges }, { seed: 'perf' });
    const ms = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`computeLayout 10k/40k: ${ms} ms, ${out.clusters.length} clusters, modularity ${out.modularity}`);
    expect(out.positions).toHaveLength(n);
    expect(ms).toBeLessThan(5 * 60_000);
  }, 5 * 60_000);
});
