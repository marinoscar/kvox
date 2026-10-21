import { describe, expect, it } from 'vitest';

import { graphEdgeSchema, graphNodeSchema } from '../src/graph/graph-read.js';

const ID = '00000000-0000-4000-8000-00000000000a';
const node = { id: ID, nodeKind: 'entity', type: 'Person', label: 'Ana', depth: 0, degree: 1, status: null, occurredAt: null };
const edge = { id: 'r1', type: 'DISCUSSED', source: ID, target: ID, valid: null, confidence: null, virtual: false, props: {} };

describe('graph slice enrichment (GIC-10)', () => {
  it('parses an old fixture without the new fields', () => {
    expect(graphNodeSchema.parse(node)).toEqual(node);
    expect(graphEdgeSchema.parse(edge)).toEqual(edge);
  });

  it('parses the new optional fields', () => {
    const n = { ...node, mentionCount: 3, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    const e = { ...edge, evidenceCount: 2, lastEvidenceAt: null };
    expect(graphNodeSchema.parse(n)).toEqual(n);
    expect(graphEdgeSchema.parse(e)).toEqual(e);
  });

  it('rejects a negative count', () => {
    expect(graphNodeSchema.safeParse({ ...node, mentionCount: -1 }).success).toBe(false);
  });
});
