import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor, act } from '@testing-library/react';
import { renderHook } from './helpers.js';
import { http, HttpResponse } from './msw-compat.js';

import { server } from './msw-compat.js';
import { JOE_ID, SPEAKER_A_ID, SPEAKER_B_ID, briefFixture, mockProposalDetail } from './graphData.js';
import { useGraphProposal } from '../../src/graph/headless/hooks/useGraphProposal.js';
import { useGraphBrief } from '../../src/graph/headless/hooks/useGraphBrief.js';
import { useGraphEntities } from '../../src/graph/headless/hooks/useGraphEntities.js';
import { speakerEntityMap, useGraphTranscriptPeople } from '../../src/graph/headless/hooks/useGraphTranscriptPeople.js';
import { useGraphEffectiveOntology } from '../../src/graph/headless/hooks/useGraphAttributeDefs.js';
import { useGraphMentions } from '../../src/graph/headless/hooks/useGraphMentions.js';
import { useGraphEntity } from '../../src/graph/headless/hooks/useGraphEntity.js';
import { GRAPH_NOT_FOUND_MESSAGE, graphErrorMessage } from '../../src/graph/headless/hooks/graphHookUtils.js';
import { KvoxApiError } from '../../src/core/headless/index.js';

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

describe('useGraphEffectiveOntology (#369, shared with the graph pages)', () => {
  it('loads the effective ontology', async () => {
    const { result } = renderHook(() => useGraphEffectiveOntology());
    await waitFor(() => expect(result.current.ontology).not.toBeNull());
    expect(requests.filter((url) => url.pathname.endsWith('/graph/ontology'))).toHaveLength(1);
  });

  it('reports a failure as a sentence', async () => {
    server.use(http.get('*/api/graph/ontology', () => HttpResponse.json({ message: 'nope' }, { status: 500 })));
    const { result } = renderHook(() => useGraphEffectiveOntology());
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
    expect(graphErrorMessage(new KvoxApiError('x', 403), 'f')).toMatch(/permission/);
    expect(graphErrorMessage(new KvoxApiError('', 500), 'f')).toBe('f');
    expect(graphErrorMessage(new Error('x'), 'f')).toBe('f');
  });
});

describe('useGraphProposal awaitUntil (#616)', () => {
  const proposalReads = () => requests.filter((url) => url.pathname.endsWith('/graph/notes/n1/proposal'));

  /** Answers null for the first `nullReads` reads, then an extracting proposal for `extractingReads` reads, then a draft. */
  function answerWith(nullReads: number, extractingReads: number) {
    let calls = 0;
    server.use(
      http.get('*/api/graph/notes/:noteId/proposal', () => {
        calls += 1;
        if (calls <= nullReads) return HttpResponse.json({ data: { proposal: null } });
        const state = calls <= nullReads + extractingReads ? 'extracting' : 'draft';
        return HttpResponse.json({ data: { proposal: mockProposalDetail(state) } });
      }),
    );
  }

  it('picks up a proposal created after the first read, then polls only while it extracts', async () => {
    answerWith(2, 2);
    const awaitUntil = Date.now() + 10_000;
    const { result } = renderHook(() => useGraphProposal({ noteId: 'n1' }, { pollMs: 20, awaitUntil }));

    // Reaching the draft means the null reads, then the extracting ones, were all polled (the
    // extracting state itself lasts two 20 ms ticks, too short for waitFor to catch reliably).
    await waitFor(() => expect(result.current.detail?.proposal.status).toBe('draft'), { timeout: 2000 });
    const settled = proposalReads().length;
    // 2 null reads + 2 extracting reads + the read that returned the draft.
    expect(settled).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(proposalReads().length).toBe(settled);
  });

  it('stops polling once awaitUntil has passed with still no proposal', async () => {
    answerWith(Number.MAX_SAFE_INTEGER, 0);
    // Fixed once: a deadline recomputed on every render would keep moving.
    const awaitUntil = Date.now() + 100;
    const { result } = renderHook(() => useGraphProposal({ noteId: 'n1' }, { pollMs: 20, awaitUntil }));

    await waitFor(() => expect(result.current.detail).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stopped = proposalReads().length;
    expect(stopped).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(proposalReads().length).toBe(stopped);
  });

  it('does not poll a null proposal without awaitUntil', async () => {
    answerWith(Number.MAX_SAFE_INTEGER, 0);
    const { result } = renderHook(() => useGraphProposal({ noteId: 'n1' }, { pollMs: 20 }));

    await waitFor(() => expect(result.current.detail).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(proposalReads()).toHaveLength(1);
  });
});
