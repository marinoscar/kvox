import { describe, expect, it } from 'vitest';

import { evidenceBySubjectQuerySchema, graphEntityDetailSchema } from '../src/graph/graph-read.js';

const ID = '00000000-0000-4000-8000-00000000000a';
const detail = {
  id: ID,
  type: 'Person',
  label: 'Ana',
  props: {},
  aliases: [],
  occurredAt: null,
  reviewStatus: 'accepted',
  ontologyVersion: '1.3.0',
  firstSeenAt: null,
  lastSeenAt: null,
  counts: {
    relations: 3,
    mentions: 2,
    evidence: 1,
    items: { commitment: 0, decision: 0, claim: 0, person_fact: 0, risk: 0 },
    openCommitments: 0,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('inspector contract (GIC-11)', () => {
  it('parses an entity detail without the per-type counts (an older API)', () => {
    expect(graphEntityDetailSchema.parse(detail)).toEqual(detail);
  });

  it('parses the per-type relation counts', () => {
    const next = {
      ...detail,
      counts: {
        ...detail.counts,
        relationsByType: { WORKS_FOR: 2, DISCUSSED: 1 },
        relationsByNeighborType: { Organization: 2, Meeting: 1 },
      },
    };
    expect(graphEntityDetailSchema.parse(next)).toEqual(next);
  });

  it('rejects a negative per-type count', () => {
    expect(
      graphEntityDetailSchema.safeParse({ ...detail, counts: { ...detail.counts, relationsByType: { WORKS_FOR: -1 } } })
        .success,
    ).toBe(false);
  });

  it('accepts the three evidence subject kinds and nothing else', () => {
    for (const kind of ['entity', 'relation', 'item']) {
      expect(evidenceBySubjectQuerySchema.safeParse({ kind, id: ID }).success).toBe(true);
    }
    expect(evidenceBySubjectQuerySchema.safeParse({ kind: 'evidence', id: ID }).success).toBe(false);
    expect(evidenceBySubjectQuerySchema.safeParse({ kind: 'entity', id: 'nope' }).success).toBe(false);
  });
});
