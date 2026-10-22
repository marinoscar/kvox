import { describe, expect, it } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import { getGraphPaths, type GraphPathsResponse } from '../../src/graph/headless/clients/graph.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const response: GraphPathsResponse = {
  from: A,
  to: B,
  asOf: null,
  paths: [{ nodeIds: [A, B], edgeIds: ['r1'], hops: 1, score: 0.6931 }],
  slice: { seedIds: [A, B], asOf: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], truncated: false, cap: 300 },
  truncated: false,
};

describe('getGraphPaths (GIC-12)', () => {
  it('sends only the options it was given, with asOf as as_of and lists comma-joined', async () => {
    const seen: URLSearchParams[] = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /graph/paths': (request) => {
          seen.push(request.query);
          return response;
        },
      },
    });

    await expect(getGraphPaths(host, { from: A, to: B })).resolves.toEqual(response);
    expect([...seen[0].keys()].sort()).toEqual(['from', 'to']);

    await getGraphPaths(host, {
      from: A,
      to: B,
      k: 5,
      maxHops: 2,
      types: ['Person', 'Meeting'],
      relationTypes: ['ATTENDED'],
      asOf: '2024-01-15',
    });
    const q = seen[1];
    expect(q.get('k')).toBe('5');
    expect(q.get('maxHops')).toBe('2');
    expect(q.get('types')).toBe('Person,Meeting');
    expect(q.get('relationTypes')).toBe('ATTENDED');
    expect(q.get('as_of')).toBe('2024-01-15');
    expect(q.has('asOf')).toBe(false);
  });

  it('omits an empty filter rather than sending "nothing"', async () => {
    let query: URLSearchParams | undefined;
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /graph/paths': (request) => {
          query = request.query;
          return response;
        },
      },
    });
    await getGraphPaths(host, { from: A, to: B, types: [], relationTypes: [] });
    expect(query?.has('types')).toBe(false);
    expect(query?.has('relationTypes')).toBe(false);
  });

  it('rejects with the API error for a 404 and a 503', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'GET /graph/paths': (request) => {
          throw request.query.get('k') === '1'
            ? fakeApiError(503, 'slow', { reason: 'graph_query_timeout' })
            : fakeApiError(404, 'No such entity');
        },
      },
    });
    const notFound = await getGraphPaths(host, { from: A, to: B }).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(KvoxApiError);
    expect(notFound).toMatchObject({ status: 404 });
    const slow = await getGraphPaths(host, { from: A, to: B, k: 1 }).catch((e: unknown) => e);
    expect(slow).toMatchObject({ status: 503, reason: 'graph_query_timeout' });
  });
});
