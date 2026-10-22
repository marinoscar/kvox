import {
  HUB_FREE_DEGREE,
  buildAdjacency,
  enumeratePaths,
  hubFactor,
  nodeSetKey,
  scorePath,
  selectTopPaths,
  type PathEdgeInput,
  type ScoredPath,
} from './graph-path-ranking.js';

// graph-path-ranking.ts (GIC-12, #673): pure enumeration, scoring and dedup.

const e = (id: string, a: string, b: string, evidence = 1): PathEdgeInput => ({ id, a, b, evidence });
const never = (): boolean => false;

describe('scorePath', () => {
  it('is the mean of log(1 + evidence) over the edges', () => {
    expect(scorePath([1], [])).toBeCloseTo(Math.log(2));
    expect(scorePath([1, 3], [5])).toBeCloseTo((Math.log(2) + Math.log(4)) / 2);
    expect(scorePath([], [])).toBe(0);
  });

  it('prefers richer evidence', () => {
    expect(scorePath([10], [])).toBeGreaterThan(scorePath([1], []));
  });

  it('does not penalise a node up to the free degree, then discounts monotonically', () => {
    expect(hubFactor(0)).toBe(1);
    expect(hubFactor(HUB_FREE_DEGREE)).toBe(1);
    expect(hubFactor(100)).toBeLessThan(1);
    expect(hubFactor(5000)).toBeLessThan(hubFactor(100));
    expect(hubFactor(5000)).toBeGreaterThan(0);
  });

  it('lets a well-evidenced route through a quiet node beat one through a hub', () => {
    const viaMeeting = scorePath([4, 4], [3]);
    const viaHub = scorePath([4, 4], [5000]);
    expect(viaMeeting).toBeGreaterThan(viaHub);
  });
});

describe('buildAdjacency', () => {
  it('keeps the best of parallel edges and drops self loops', () => {
    const adj = buildAdjacency([e('r2', 'A', 'B', 1), e('r1', 'B', 'A', 5), e('r3', 'A', 'A', 9)]);
    expect(adj.get('A')).toEqual([{ node: 'B', edgeId: 'r1', evidence: 5 }]);
    expect(adj.get('B')).toEqual([{ node: 'A', edgeId: 'r1', evidence: 5 }]);
  });

  it('breaks an evidence tie by the lowest edge id', () => {
    const adj = buildAdjacency([e('r9', 'A', 'B', 2), e('r3', 'A', 'B', 2)]);
    expect(adj.get('A')?.[0].edgeId).toBe('r3');
  });
});

describe('enumeratePaths', () => {
  // A - B - D ; A - C - D ; A - D ; D - E
  const adj = buildAdjacency([e('ab', 'A', 'B'), e('bd', 'B', 'D'), e('ac', 'A', 'C'), e('cd', 'C', 'D'), e('ad', 'A', 'D'), e('de', 'D', 'E')]);

  it('lists every simple path within maxHops, shortest first', () => {
    const { paths, truncated } = enumeratePaths(adj, 'A', 'D', 3, never);
    expect(truncated).toBe(false);
    expect(paths.map((p) => p.nodeIds.join(''))).toEqual(['AD', 'ABD', 'ACD']);
    expect(paths[0].edgeIds).toEqual(['ad']);
  });

  it('respects maxHops', () => {
    expect(enumeratePaths(adj, 'A', 'D', 1, never).paths.map((p) => p.nodeIds.join(''))).toEqual(['AD']);
    expect(enumeratePaths(adj, 'A', 'E', 1, never).paths).toEqual([]);
  });

  it('never repeats a node', () => {
    const cyc = buildAdjacency([e('ab', 'A', 'B'), e('bc', 'B', 'C'), e('ca', 'C', 'A'), e('cd', 'C', 'D')]);
    const { paths } = enumeratePaths(cyc, 'A', 'D', 5, never);
    for (const p of paths) expect(new Set(p.nodeIds).size).toBe(p.nodeIds.length);
    expect(paths.map((p) => p.nodeIds.join(''))).toEqual(['ACD', 'ABCD']);
  });

  it('returns nothing for disconnected nodes or an unknown start', () => {
    expect(enumeratePaths(adj, 'A', 'Z', 5, never).paths).toEqual([]);
    expect(enumeratePaths(adj, 'Q', 'D', 5, never).paths).toEqual([]);
  });

  it('never passes through a leaf item, but accepts one as an endpoint', () => {
    // person P - item I - person Q ; P - M - Q
    const g = buildAdjacency([e('pi', 'P', 'I'), e('iq', 'I', 'Q'), e('pm', 'P', 'M'), e('mq', 'M', 'Q'), e('mi', 'M', 'I')]);
    const leaf = (n: string): boolean => n === 'I';
    expect(enumeratePaths(g, 'P', 'Q', 4, leaf).paths.map((p) => p.nodeIds.join(''))).toEqual(['PMQ']);
    expect(enumeratePaths(g, 'P', 'I', 4, leaf).paths.map((p) => p.nodeIds.join(''))).toEqual(['PI', 'PMI', 'PMQI']);
    expect(enumeratePaths(g, 'I', 'Q', 4, leaf).paths.map((p) => p.nodeIds.join(''))).toEqual(['IQ', 'IMQ', 'IPMQ']);
  });

  it('stops at the limit and says so', () => {
    const { paths, truncated } = enumeratePaths(adj, 'A', 'D', 3, never, 2);
    expect(paths).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe('selectTopPaths', () => {
  const p = (nodes: string, score: number, edges = nodes.slice(1)): ScoredPath => ({
    nodeIds: nodes.split(''),
    edgeIds: edges.split(''),
    hops: nodes.length - 1,
    score,
  });

  it('ranks by score, then fewer hops, and keeps at most k', () => {
    const top = selectTopPaths([p('ABD', 0.5), p('AD', 0.5), p('ACD', 0.9), p('AXD', 0.1)], 3);
    expect(top.map((x) => x.nodeIds.join(''))).toEqual(['ACD', 'AD', 'ABD']);
  });

  it('drops a path that repeats an earlier node set', () => {
    const top = selectTopPaths([p('ABCD', 0.9), p('ACBD', 0.8), p('AD', 0.7)], 5);
    expect(top.map((x) => x.nodeIds.join(''))).toEqual(['ABCD', 'AD']);
    expect(nodeSetKey(['C', 'A', 'B'])).toBe('A|B|C');
  });

  it('is deterministic on a full tie', () => {
    const one = selectTopPaths([p('ABD', 1), p('ACD', 1)], 2);
    const two = selectTopPaths([p('ACD', 1), p('ABD', 1)], 2);
    expect(one).toEqual(two);
  });
});
