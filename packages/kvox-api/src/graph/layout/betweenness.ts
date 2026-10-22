// =============================================================================
// Sampled betweenness centrality (GIC-16, #677; docs/specs/ontology.md §22.3)
// =============================================================================
//
// PURE and dependency-free: node indexes and an edge list in, scores out. Brandes'
// algorithm on the UNWEIGHTED graph (an edge's weight is how strongly two things
// are tied, not how far apart they are), run from a SAMPLE of source nodes and
// scaled by `n / k` (Brandes & Pich 2007). With `k = n` it is exact.
//
// Why not `graphology-metrics`: its `betweenness` always runs from every node and
// has no source sampling, which is exactly the part that keeps this inside the job's
// profile on a 20k-node graph. The sampling here owns its OWN seeded generator
// (derived from the layout seed), so adding connectors never shifts the random
// stream Louvain and the initial positions draw from: existing snapshots keep their
// picture.
//
// Cost: O(k * (n + m)) with typed arrays. `k` is `min(BETWEENNESS_SAMPLE, n)` and is
// lowered further when `k * (n + m)` would exceed `BETWEENNESS_WORK_BUDGET`.
// =============================================================================

import { mulberry32, seedFrom } from './seeded-rng.js';

/** Most BFS sources sampled. */
export const BETWEENNESS_SAMPLE = 200;

/** Cap on `k * (n + m)`, the work a run may do; keeps a very large graph inside the profile. */
export const BETWEENNESS_WORK_BUDGET = 80_000_000;

/** Fewest sources even a huge graph is sampled from. */
export const BETWEENNESS_MIN_SAMPLE = 16;

/** Result of {@link sampledBetweenness}. */
export interface BetweennessResult {
  /** Normalized to `[0, 1]` (`1` = on every shortest path), indexed like the input nodes. */
  scores: Float64Array;
  /** Sources actually used. `sources === n` means the scores are exact. */
  sources: number;
}

/** How many sources to sample for a graph of `n` nodes and `m` edges. */
export function betweennessSampleSize(n: number, m: number): number {
  if (n <= 0) return 0;
  const byBudget = Math.floor(BETWEENNESS_WORK_BUDGET / Math.max(1, n + m));
  return Math.min(n, BETWEENNESS_SAMPLE, Math.max(BETWEENNESS_MIN_SAMPLE, byBudget));
}

/**
 * Approximate betweenness centrality of an undirected graph given as `n` nodes (0..n-1)
 * and `edges` as index pairs (no self loops, no duplicates required but tolerated).
 */
export function sampledBetweenness(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  seed: string,
): BetweennessResult {
  const scores = new Float64Array(n);
  if (n < 3 || edges.length === 0) return { scores, sources: 0 };

  // CSR adjacency.
  const deg = new Int32Array(n + 1);
  for (const [a, b] of edges) {
    deg[a + 1] += 1;
    deg[b + 1] += 1;
  }
  for (let i = 0; i < n; i += 1) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[n]);
  const fill = deg.slice(0, n);
  for (const [a, b] of edges) {
    adj[fill[a]++] = b;
    adj[fill[b]++] = a;
  }

  // Seeded partial Fisher-Yates: the first k of a shuffled index list.
  const k = betweennessSampleSize(n, edges.length);
  const order = Int32Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(seedFrom(`${seed}:betweenness`));
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }

  const dist = new Int32Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const queue = new Int32Array(n); // BFS order doubles as the stack, read in reverse

  for (let s = 0; s < k; s += 1) {
    const src = order[s];
    dist.fill(-1);
    sigma.fill(0);
    delta.fill(0);
    let head = 0;
    let tail = 0;
    queue[tail++] = src;
    dist[src] = 0;
    sigma[src] = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let e = deg[v]; e < deg[v + 1]; e += 1) {
        const w = adj[e];
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue[tail++] = w;
        }
        if (dist[w] === dist[v] + 1) sigma[w] += sigma[v];
      }
    }
    for (let i = tail - 1; i > 0; i -= 1) {
      const w = queue[i];
      const coefficient = (1 + delta[w]) / sigma[w];
      for (let e = deg[w]; e < deg[w + 1]; e += 1) {
        const v = adj[e];
        if (dist[v] === dist[w] - 1) delta[v] += sigma[v] * coefficient;
      }
      scores[w] += delta[w];
    }
  }

  // Scale the sample to all sources, halve for the undirected double count, then
  // normalize by the largest possible value ((n-1)(n-2)/2 pairs).
  const scale = n / k / 2 / (((n - 1) * (n - 2)) / 2);
  for (let i = 0; i < n; i += 1) scores[i] = Math.min(1, scores[i] * scale);
  return { scores, sources: k };
}
