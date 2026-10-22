// =============================================================================
// The 10k-node / 40k-edge layout benchmark (#371), run as a PLAIN Node process
// =============================================================================
//
// Spawned by `src/graph/layout/compute-layout.spec.ts` rather than run inside
// Jest: Jest evaluates code in a `vm` context, where every global lookup in
// ForceAtlas2's hot loop (`Math.*`, typed arrays) goes through the context's
// global proxy — measured ~12× slower than production, which runs the handler
// in an ordinary Node process. Timing the job inside Jest would measure Jest.
//
// Prints one JSON line: { ms, nodes, positions, clusters, modularity }.
// =============================================================================

import { computeLayout, type LayoutInput } from '../../src/graph/layout/compute-layout.js';
import { sampledBetweenness } from '../../src/graph/layout/betweenness.js';
import { mulberry32 } from '../../src/graph/layout/seeded-rng.js';

// `PERF_NODES=20000` for the GIC-16 (#677) 20k-entity run; edges stay 4 per node.
const N = Number(process.env.PERF_NODES ?? 10_000);
const E = N * 4;

const rng = mulberry32(7);
const nodes = Array.from({ length: N }, (_, i) => ({
  id: `n${String(i).padStart(5, '0')}`,
  type: i % 5 === 0 ? 'Meeting' : 'Person',
}));
const edges: LayoutInput['edges'] = [];
// Community structure: 100 groups of 100, most edges inside a group.
for (let e = 0; e < E; e += 1) {
  const a = Math.floor(rng() * N);
  const group = Math.floor(a / 100);
  const b = rng() < 0.9 ? group * 100 + Math.floor(rng() * 100) : Math.floor(rng() * N);
  edges.push({ source: nodes[a].id, target: nodes[b].id, weight: 1 });
}

const started = Date.now();
const out = computeLayout({ nodes, edges }, { seed: 'perf' });
const ms = Date.now() - started;

// Betweenness alone (already included in `ms`), to show what the connectors cost.
const index = new Map(nodes.map((n, i) => [n.id, i]));
const pairs = edges.map((e) => [index.get(e.source) as number, index.get(e.target) as number] as const);
const btStarted = Date.now();
const bt = sampledBetweenness(N, pairs, 'perf');
const betweennessMs = Date.now() - btStarted;

process.stdout.write(
  `${JSON.stringify({ ms, betweennessMs, betweennessSources: bt.sources, connectors: out.connectors.length, nodes: out.nodeCount, positions: out.positions.length, clusters: out.clusters.length, modularity: out.modularity })}\n`,
);
