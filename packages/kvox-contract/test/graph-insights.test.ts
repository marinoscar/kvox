import { describe, expect, it } from 'vitest';

import { graphInsightsQuerySchema, graphInsightsResponseSchema } from '../src/graph/graph-insights.js';

const A = '00000000-0000-4000-8000-00000000000a';

describe('graph insights contract (GIC-16)', () => {
  it('defaults the window to 30d and accepts only 30d, 90d and 365d', () => {
    expect(graphInsightsQuerySchema.parse({})).toEqual({ window: '30d' });
    expect(graphInsightsQuerySchema.parse({ window: '365d' })).toEqual({ window: '365d' });
    expect(graphInsightsQuerySchema.safeParse({ window: '7d' }).success).toBe(false);
  });

  it('parses an empty response and one with every section', () => {
    const base = {
      window: { key: '30d', days: 30, from: '2026-09-22T00:00:00.000Z', previousFrom: '2026-08-23T00:00:00.000Z' },
      status: 'ready',
      pending: false,
      computedAt: '2026-10-22T00:00:00.000Z',
      stale: false,
      tooLarge: false,
      connectorsReady: true,
      themes: [],
      connectors: [],
      rising: [],
      fadingTies: [],
      openRisks: [],
    };
    expect(graphInsightsResponseSchema.parse(base)).toEqual(base);
    const entity = { id: A, label: 'Joe', type: 'Person' };
    const full = {
      ...base,
      themes: [{ clusterId: 0, label: 'Copilot', labelEntityId: A, size: 9, typeCounts: { Person: 9 }, memberSample: [{ ...entity, degree: 3 }] }],
      connectors: [{ entity, score: 0.4, clusters: [{ id: 0, label: 'Copilot' }], reason: 'Joe connects the Copilot group.' }],
      rising: [{ entity, count: 5, previous: 1, reason: 'x' }],
      fadingTies: [{ from: entity, to: entity, relationTypes: ['KNOWS'], lastEvidenceAt: '2026-01-01T00:00:00.000Z', evidenceBefore: 4, reason: 'x' }],
      openRisks: [{ id: A, title: null, statement: 's', severity: 'high', subject: entity, occurredAt: null }],
    };
    expect(graphInsightsResponseSchema.parse(full).connectors).toHaveLength(1);
    expect(graphInsightsResponseSchema.safeParse({ ...full, openRisks: [{ ...full.openRisks[0], severity: 'urgent' }] }).success).toBe(false);
  });
});
