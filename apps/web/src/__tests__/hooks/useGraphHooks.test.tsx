import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { JOE_ID, SPEAKER_A_ID, SPEAKER_B_ID, briefFixture } from '../mocks/graphData';
import { useGraphBrief } from '../../hooks/useGraphBrief';
import { useGraphEntities } from '../../hooks/useGraphEntities';
import { speakerEntityMap, useGraphTranscriptPeople } from '../../hooks/useGraphTranscriptPeople';
import { useGraphOntology } from '../../hooks/useGraphAttributeDefs';
import { useGraphMentions } from '../../hooks/useGraphMentions';
import { useGraphEntity } from '../../hooks/useGraphEntity';
import { GRAPH_NOT_FOUND_MESSAGE, graphErrorMessage } from '../../hooks/graphHookUtils';
import { ApiError } from '../../services/api';

/** The graph read hooks (#373) — the parts a page test cannot pin down cheaply. */

let requests: URL[];

beforeEach(() => {
  requests = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    requests.push(new URL(request.url));
  });
});

const briefReads = () => requests.filter((url) => url.pathname.endsWith('/brief'));

describe('useGraphBrief', () => {
  it('polls while a digest is pending and stops once it lands', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/graph/entities/:id/brief', () => {
        calls += 1;
        return HttpResponse.json({
          data: briefFixture({ digestPending: calls < 3, digestStale: calls < 3 }),
        });
      }),
    );
    const { result } = renderHook(() => useGraphBrief(JOE_ID, { pollIntervalMs: 30 }));

    await waitFor(() => expect(result.current.data?.digestPending).toBe(false), { timeout: 2000 });
    expect(result.current.isPolling).toBe(false);
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toBe(settled);
    // First read marks the view, every poll does not.
    expect(briefReads()[0].searchParams.get('markViewed')).toBe('true');
    expect(briefReads().slice(1).every((url) => url.searchParams.get('markViewed') === 'false')).toBe(true);
  });

  it('gives up after the window even while still pending, until a manual refresh', async () => {
    server.use(
      http.get('*/api/graph/entities/:id/brief', () =>
        HttpResponse.json({ data: briefFixture({ digestPending: true, digestStale: true }) }),
      ),
    );
    const { result } = renderHook(() => useGraphBrief(JOE_ID, { pollIntervalMs: 20, pollMaxMs: 60 }));

    await waitFor(() => expect(result.current.data).not.toBeNull());
    await waitFor(() => expect(result.current.isPolling).toBe(false), { timeout: 2000 });
    const stopped = briefReads().length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(briefReads().length).toBe(stopped);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.isPolling).toBe(true);
  });
});

describe('useGraphEntities', () => {
  it('does nothing while disabled', async () => {
    const { result } = renderHook(() => useGraphEntities({ enabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.isLoading).toBe(false);
    expect(requests.filter((url) => url.pathname.endsWith('/graph/entities'))).toHaveLength(0);
  });
});

describe('useGraphTranscriptPeople', () => {
  it('folds persons into a speaker → entity map', async () => {
    server.use(
      http.get('*/api/graph/entities', () =>
        HttpResponse.json({
          data: {
            items: [
              { id: 'p1', type: 'Person', label: 'Ana', aliases: [], mentionCount: 1, lastSeenAt: null, speakerIds: [SPEAKER_A_ID] },
              { id: 'p2', type: 'Person', label: 'Ben', aliases: [], mentionCount: 1, lastSeenAt: null, speakerIds: [SPEAKER_B_ID, SPEAKER_A_ID] },
            ],
            nextCursor: null,
          },
        }),
      ),
    );
    const { result } = renderHook(() => useGraphTranscriptPeople('t1', true));
    await waitFor(() => expect(result.current).toEqual({ [SPEAKER_A_ID]: 'p1', [SPEAKER_B_ID]: 'p2' }));
    expect(requests.find((url) => url.pathname.endsWith('/graph/entities'))?.searchParams.get('transcriptId')).toBe('t1');
  });

  it('is an empty map on failure or when disabled', async () => {
    server.use(http.get('*/api/graph/entities', () => HttpResponse.json({}, { status: 500 })));
    const { result } = renderHook(() => useGraphTranscriptPeople('t1', true));
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(result.current).toEqual({});
    expect(speakerEntityMap([])).toEqual({});
  });
});

describe('useGraphOntology (#369, shared with the graph pages)', () => {
  it('loads the effective ontology', async () => {
    const { result } = renderHook(() => useGraphOntology());
    await waitFor(() => expect(result.current.ontology).not.toBeNull());
    expect(requests.filter((url) => url.pathname.endsWith('/graph/ontology'))).toHaveLength(1);
  });

  it('reports a failure as a sentence', async () => {
    server.use(http.get('*/api/graph/ontology', () => HttpResponse.json({ message: 'nope' }, { status: 500 })));
    const { result } = renderHook(() => useGraphOntology());
    await waitFor(() => expect(result.current.loadError).toBe('nope'));
  });
});

describe('useGraphMentions / useGraphEntity', () => {
  it('pages mentions', async () => {
    server.use(
      http.get('*/api/graph/entities/:id/mentions', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json({
          data: cursor
            ? { items: [{ kind: 'note', id: 'n2', title: 'Two', occurredAt: null, available: true }], nextCursor: null }
            : { items: [{ kind: 'note', id: 'n1', title: 'One', occurredAt: null, available: true }], nextCursor: 'm2' },
        });
      }),
    );
    const { result } = renderHook(() => useGraphMentions(JOE_ID));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.data.map((m) => m.id)).toEqual(['n1', 'n2']);
    expect(result.current.nextCursor).toBeNull();
  });

  it('flags a 404 as notFound', async () => {
    const { result } = renderHook(() => useGraphEntity('00000000-0000-4000-8000-000000009999'));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.error).toBe(GRAPH_NOT_FOUND_MESSAGE);
  });

  it('graphErrorMessage names 403 and falls back otherwise', () => {
    expect(graphErrorMessage(new ApiError('x', 403), 'f')).toMatch(/permission/);
    expect(graphErrorMessage(new ApiError('', 500), 'f')).toBe('f');
    expect(graphErrorMessage(new Error('x'), 'f')).toBe('f');
  });
});
