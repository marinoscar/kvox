import { CandidateService } from './candidate.service.js';

const OWNER = '0a000000-0000-4000-8000-000000000001';

describe('CandidateService synonym expansion (#767)', () => {
  it('feeds the exact-alias arm the synonyms of the mention names', async () => {
    const calls: unknown[][] = [];
    const db = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push([strings.join('?'), ...values]);
        const sql = strings.join('?');
        if (sql.includes('FROM kg_synonyms')) return [{ normalized: ['ey', 'ernst & young'], entity_type: null }];
        if (sql.includes('a.normalized = ANY')) return [];
        return [];
      }),
      kgDistinctPair: { findMany: jest.fn() },
      kgEntity: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CandidateService(db as never);
    await service.forMention(OWNER, { type: 'Organization', label: 'EY', aliases: [] }, db as never);
    const exact = calls.find((c) => String(c[0]).includes('a.normalized = ANY'))!;
    expect(exact).toContain(OWNER);
    expect(exact.some((v) => Array.isArray(v) && v.includes('ey') && v.includes('ernst & young'))).toBe(true);
    const syn = calls.find((c) => String(c[0]).includes('FROM kg_synonyms'))!;
    expect(syn.some((v) => Array.isArray(v) && v.length === 1 && v[0] === 'ey')).toBe(true);
  });
});
