import { BETWEENNESS_SAMPLE, betweennessSampleSize, sampledBetweenness } from './betweenness.js';

describe('sampledBetweenness', () => {
  const star: Array<readonly [number, number]> = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ];

  it('gives the hub of a star score 1 and the leaves 0 (exact below the sample size)', () => {
    const { scores, sources } = sampledBetweenness(5, star, 'x');
    expect(sources).toBe(5);
    expect(scores[0]).toBeCloseTo(1, 10);
    expect([...scores.slice(1)]).toEqual([0, 0, 0, 0]);
  });

  it('matches exact values on a path of 5', () => {
    const path: Array<readonly [number, number]> = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ];
    const { scores } = sampledBetweenness(5, path, 'x');
    expect(scores[2]).toBeCloseTo(4 / 6, 6); // pairs routed through the middle: 4 of 6
    expect(scores[1]).toBeCloseTo(3 / 6, 6);
    expect(scores[0]).toBe(0);
  });

  it('is deterministic per seed and scores nothing for tiny or edgeless graphs', () => {
    const big: Array<readonly [number, number]> = Array.from({ length: 499 }, (_, i) => [i, i + 1] as const);
    const a = sampledBetweenness(500, big, 's');
    expect([...sampledBetweenness(500, big, 's').scores]).toEqual([...a.scores]);
    expect(a.sources).toBe(BETWEENNESS_SAMPLE);
    expect(sampledBetweenness(2, [[0, 1]], 's').sources).toBe(0);
    expect(sampledBetweenness(4, [], 's').sources).toBe(0);
  });

  it('lowers the sample on a huge graph and never below the floor', () => {
    expect(betweennessSampleSize(20_000, 80_000)).toBe(200);
    expect(betweennessSampleSize(100_000, 2_000_000)).toBe(38);
    expect(betweennessSampleSize(100_000, 50_000_000)).toBe(16);
    expect(betweennessSampleSize(10, 20)).toBe(10);
  });
});
