import { describe, expect, it } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import { postGraphConnect, type GraphConnectResponse } from '../../src/graph/headless/clients/graph.js';
import { gid } from './graphData.js';

const response: GraphConnectResponse = {
  inputs: [],
  shared: [],
  paths: [],
  slice: { seedIds: [], asOf: '2026-01-01T00:00:00.000Z', nodes: [], edges: [], truncated: false, cap: 300 },
  truncated: false,
};

describe('postGraphConnect (GIC-14)', () => {
  it('posts only the inputs it was given, with asOf as as_of', async () => {
    const bodies: unknown[] = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /graph/connect': (request) => {
          bodies.push(request.body);
          return response;
        },
      },
    });

    await expect(postGraphConnect(host, { noteIds: [gid(1), gid(2)] })).resolves.toEqual(response);
    await postGraphConnect(host, { entityIds: [gid(3), gid(4)], asOf: '2024-01-15', maxHops: 3 });
    await postGraphConnect(host, { noteIds: [], transcriptIds: [gid(5)], entityIds: [] });

    expect(bodies[0]).toEqual({ noteIds: [gid(1), gid(2)] });
    expect(bodies[1]).toEqual({ entityIds: [gid(3), gid(4)], as_of: '2024-01-15', maxHops: 3 });
    // Empty lists are left out rather than sent as "nothing".
    expect(bodies[2]).toEqual({ transcriptIds: [gid(5)] });
  });

  it('rejects with the API error: a 404 for an unreadable input, a 503 for a timeout', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /graph/connect': () => {
          throw fakeApiError(404, 'One of those notes, transcripts or entities was not found');
        },
      },
    });
    const error = await postGraphConnect(host, { noteIds: [gid(1), gid(2)] }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(KvoxApiError);
    expect((error as KvoxApiError).status).toBe(404);
  });
});
