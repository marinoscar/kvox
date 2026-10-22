import { describe, expect, it } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import {
  GRAPH_ACTIVITY_MAX_IDS,
  getGraphActivity,
  type GraphActivityResponse,
} from '../../src/graph/headless/clients/graph.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const response: GraphActivityResponse = {
  bucket: 'month',
  series: [{ start: '2026-01-01', total: 2, byType: { Person: 2 } }],
  byEntity: { [A]: [{ start: '2026-01-01', count: 2 }] },
};

describe('getGraphActivity (GIC-15)', () => {
  it('sends the ids comma-joined and only the options it was given', async () => {
    const seen: URLSearchParams[] = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /graph/activity': (request) => {
          seen.push(request.query);
          return response;
        },
      },
    });

    await expect(getGraphActivity(host, { ids: [A, B] })).resolves.toEqual(response);
    expect(seen[0].get('ids')).toBe(`${A},${B}`);
    expect([...seen[0].keys()]).toEqual(['ids']);

    await getGraphActivity(host, { ids: [A], bucket: 'week', from: '2026-01-01', to: '2026-04-01' });
    expect(seen[1].get('bucket')).toBe('week');
    expect(seen[1].get('from')).toBe('2026-01-01');
    expect(seen[1].get('to')).toBe('2026-04-01');
  });

  it('exposes the API limit', () => {
    expect(GRAPH_ACTIVITY_MAX_IDS).toBe(300);
  });

  it('rejects with the API error for a 400, a 404 and a 503', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /graph/activity': (request) => {
          const ids = request.query.get('ids') ?? '';
          if (ids === 'many') throw fakeApiError(400, 'too many ids');
          if (ids === 'slow') throw fakeApiError(503, 'slow', { reason: 'graph_query_timeout' });
          throw fakeApiError(404, 'No such entity');
        },
      },
    });
    expect(await getGraphActivity(host, { ids: ['many'] }).catch((e: unknown) => e)).toMatchObject({ status: 400 });
    expect(await getGraphActivity(host, { ids: ['slow'] }).catch((e: unknown) => e)).toMatchObject({
      status: 503,
      reason: 'graph_query_timeout',
    });
    const missing = await getGraphActivity(host, { ids: [A] }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(KvoxApiError);
    expect(missing).toMatchObject({ status: 404 });
  });
});
