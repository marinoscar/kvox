import { describe, expect, it } from 'vitest';

import { graphPathsQuerySchema, graphPathsResponseSchema } from '../src/graph/graph-read.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const node = (id: string) => ({ id, nodeKind: 'entity', type: 'Person', label: 'x', depth: 0, degree: 1, status: null, occurredAt: null });

describe('graph paths contract (GIC-12)', () => {
  it('defaults k to 3 and maxHops to 4, and coerces query strings', () => {
    expect(graphPathsQuerySchema.parse({ from: A, to: B })).toMatchObject({ k: 3, maxHops: 4 });
    expect(graphPathsQuerySchema.parse({ from: A, to: B, k: '5', maxHops: '1' })).toMatchObject({ k: 5, maxHops: 1 });
  });

  it('bounds k and maxHops to 1-5', () => {
    for (const bad of [{ k: 0 }, { k: 6 }, { maxHops: 0 }, { maxHops: 6 }, { k: 'x' }]) {
      expect(graphPathsQuerySchema.safeParse({ from: A, to: B, ...bad }).success).toBe(false);
    }
  });

  it('requires two distinct uuids and a valid as_of', () => {
    expect(graphPathsQuerySchema.safeParse({ from: A, to: A }).success).toBe(false);
    expect(graphPathsQuerySchema.safeParse({ from: 'nope', to: B }).success).toBe(false);
    expect(graphPathsQuerySchema.safeParse({ from: A }).success).toBe(false);
    expect(graphPathsQuerySchema.safeParse({ from: A, to: B, as_of: '2024-01-15' }).success).toBe(true);
    expect(graphPathsQuerySchema.safeParse({ from: A, to: B, as_of: 'yesterday' }).success).toBe(false);
  });

  it('parses a response, including the empty one', () => {
    const slice = { seedIds: [A, B], asOf: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], truncated: false, cap: 300 };
    const empty = { from: A, to: B, asOf: null, paths: [], slice, truncated: false };
    expect(graphPathsResponseSchema.parse(empty)).toEqual(empty);
    const one = {
      ...empty,
      paths: [{ nodeIds: [A, B], edgeIds: ['r1'], hops: 1, score: 0.69 }],
      slice: { ...slice, nodes: [node(A), node(B)] },
    };
    expect(graphPathsResponseSchema.parse(one).paths).toHaveLength(1);
    expect(graphPathsResponseSchema.safeParse({ ...one, paths: [{ ...one.paths[0], hops: 6 }] }).success).toBe(false);
  });
});
