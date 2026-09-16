/**
 * `useSearch` — issue #176, epic #164.
 *
 * Three behaviours this hook exists for, each of which is invisible in the UI
 * until it is wrong:
 *
 *   1. It DEBOUNCES, so a typed word is one ranked full-text query and not six.
 *   2. It ABORTS the superseded request rather than merely ignoring its answer,
 *      so a fast typist does not leave a trail of open queries behind them.
 *   3. It treats a **400 on a cursor** as "start over from page one", silently,
 *      because the server refuses a stale cursor on purpose and the client is
 *      the only party that knows a human pressed a button.
 *
 * `services/search` is mocked, but only its `search` function: `isStaleCursorError`
 * is the real one, because test 3 is precisely an assertion about what that
 * predicate lets through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/search', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/search')>('../../services/search');
  return { ...actual, search: vi.fn() };
});

import { ApiError } from '../../services/api';
import { search } from '../../services/search';
import type { SearchResponse, SearchResult, SearchType } from '../../services/search';
import { SEARCH_DEBOUNCE_MS, useSearch } from '../../hooks/useSearch';

const mockSearch = vi.mocked(search);

const TYPES: SearchType[] = ['transcript'];

function result(id: string): SearchResult {
  return {
    type: 'transcript',
    id,
    title: `Transcript ${id}`,
    score: 0.5,
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'ready',
    snippets: [{ html: 'the <mark>budget</mark> line', startMs: 1000, field: 'segment' }],
  };
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    results: [result('t1')],
    matchedDocuments: 1,
    truncated: false,
    nextCursor: null,
    degraded: null,
    searchedTypes: ['transcript'],
    semantic: true,
    semanticReason: null,
    unindexedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockResolvedValue(response());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSearch — an empty box is not a search', () => {
  it('issues no request at all for an empty query', async () => {
    const { result: hook } = renderHook(() => useSearch({ q: '', types: TYPES }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));
    });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(hook.current.isIdle).toBe(true);
    expect(hook.current.isLoading).toBe(false);
    expect(hook.current.searchedTypes).toBeNull();
  });

  it('treats an all-whitespace box the same way, and says so via isIdle', async () => {
    const { result: hook } = renderHook(() => useSearch({ q: '   ', types: TYPES }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 50));
    });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(hook.current.isIdle).toBe(true);
  });
});

describe('useSearch — the debounce', () => {
  it('turns a burst of keystrokes into ONE request, for the LAST term', async () => {
    vi.useFakeTimers();

    const { rerender } = renderHook(({ q }) => useSearch({ q, types: TYPES }), {
      initialProps: { q: 'b' },
    });
    rerender({ q: 'bu' });
    rerender({ q: 'bud' });
    rerender({ q: 'budget' });

    // Nothing yet: every rerender restarted the timer.
    expect(mockSearch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls[0][0]).toMatchObject({ q: 'budget', types: TYPES });
  });

  it('raises isLoading immediately, before the timer fires', () => {
    vi.useFakeTimers();

    const { result: hook } = renderHook(() => useSearch({ q: 'budget', types: TYPES }));

    // The reason "No matches" never flashes over a search in progress.
    expect(mockSearch).not.toHaveBeenCalled();
    expect(hook.current.isLoading).toBe(true);
  });

  it('runs immediately when the caller asks for no debounce', async () => {
    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );

    await waitFor(() => expect(hook.current.results).toHaveLength(1));
    expect(hook.current.matchedDocuments).toBe(1);
    expect(hook.current.searchedTypes).toEqual(['transcript']);
  });
});

describe('useSearch — a superseded request is aborted', () => {
  it('aborts the in-flight request when the query changes', async () => {
    // Never resolves: the request is still open when the next keystroke lands,
    // which is exactly the situation the abort exists for.
    mockSearch.mockImplementation(() => new Promise<SearchResponse>(() => {}));

    const { rerender } = renderHook(({ q }) => useSearch({ q, types: TYPES, debounceMs: 0 }), {
      initialProps: { q: 'bud' },
    });

    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1));
    const first = mockSearch.mock.calls[0][0];
    expect(first.signal?.aborted).toBe(false);

    rerender({ q: 'budget' });

    await waitFor(() => expect(first.signal?.aborted).toBe(true));
  });

  it('drops a stale answer that arrives after a newer one', async () => {
    let settleSlow: ((value: SearchResponse) => void) | undefined;
    mockSearch
      .mockImplementationOnce(
        () =>
          new Promise<SearchResponse>((resolve) => {
            settleSlow = resolve;
          }),
      )
      .mockResolvedValueOnce(response({ results: [result('fresh')] }));

    const { result: hook, rerender } = renderHook(
      ({ q }) => useSearch({ q, types: TYPES, debounceMs: 0 }),
      { initialProps: { q: 'bud' } },
    );
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1));

    rerender({ q: 'budget' });
    await waitFor(() => expect(hook.current.results[0]?.id).toBe('fresh'));

    // The slow first request settles LAST. Its answer must not win.
    await act(async () => {
      settleSlow?.(response({ results: [result('stale')] }));
      await Promise.resolve();
    });

    expect(hook.current.results[0]?.id).toBe('fresh');
  });

  it('does not report an abort as an error', async () => {
    mockSearch.mockImplementation(
      () =>
        new Promise<SearchResponse>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 0);
        }),
    );

    const { result: hook, rerender } = renderHook(
      ({ q }) => useSearch({ q, types: TYPES, debounceMs: 0 }),
      { initialProps: { q: 'bud' } },
    );
    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(1));
    rerender({ q: 'budget' });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(hook.current.error).toBeNull();
  });
});

describe('useSearch — paging, and the opaque cursor', () => {
  it('passes the cursor back VERBATIM and appends the page', async () => {
    mockSearch
      .mockResolvedValueOnce(response({ results: [result('t1')], nextCursor: 'OPAQUE::1' }))
      .mockResolvedValueOnce(response({ results: [result('t2')], nextCursor: null }));

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );
    await waitFor(() => expect(hook.current.nextCursor).toBe('OPAQUE::1'));

    await act(async () => {
      await hook.current.loadMore();
    });

    expect(mockSearch.mock.calls[1][0].cursor).toBe('OPAQUE::1');
    expect(hook.current.results.map((item) => item.id)).toEqual(['t1', 't2']);
    expect(hook.current.nextCursor).toBeNull();
  });

  it('⚠ resets to page one on a 400 from a stale cursor, WITHOUT an error', async () => {
    mockSearch
      .mockResolvedValueOnce(response({ results: [result('t1')], nextCursor: 'OPAQUE::1' }))
      .mockRejectedValueOnce(new ApiError('Invalid cursor', 400))
      .mockResolvedValueOnce(response({ results: [result('t1')], nextCursor: 'OPAQUE::2' }));

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );
    await waitFor(() => expect(hook.current.nextCursor).toBe('OPAQUE::1'));

    await act(async () => {
      await hook.current.loadMore();
    });

    await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(3));
    // The recovery is page ONE: no cursor at all.
    expect(mockSearch.mock.calls[2][0].cursor).toBeUndefined();
    // Silently. The user pressed a button and got a list; a banner about a
    // cursor would describe a protocol detail they cannot act on.
    expect(hook.current.error).toBeNull();
    expect(hook.current.results.map((item) => item.id)).toEqual(['t1']);
  });

  it('still SURFACES a 400 that did not involve a cursor', async () => {
    // The narrowness of `isStaleCursorError` is the point: a 400 about `q`,
    // `types` or `limit` is the caller's bug and must stay visible.
    mockSearch.mockRejectedValueOnce(new ApiError('q must be at most 256 characters', 400));

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );

    await waitFor(() =>
      expect(hook.current.error).toBe('q must be at most 256 characters'),
    );
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('dedupes an appended page on type:id', async () => {
    mockSearch
      .mockResolvedValueOnce(response({ results: [result('t1')], nextCursor: 'OPAQUE::1' }))
      .mockResolvedValueOnce(
        response({ results: [result('t1'), result('t2')], nextCursor: null }),
      );

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );
    await waitFor(() => expect(hook.current.nextCursor).toBe('OPAQUE::1'));

    await act(async () => {
      await hook.current.loadMore();
    });

    expect(hook.current.results.map((item) => item.id)).toEqual(['t1', 't2']);
  });
});

describe('useSearch — what the answer says about itself', () => {
  it('passes through matchedDocuments, truncated, degraded and searchedTypes', async () => {
    mockSearch.mockResolvedValue(
      response({ matchedDocuments: 200, truncated: true, degraded: 'stopwords', searchedTypes: ['note'] }),
    );

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'the and of', types: TYPES, debounceMs: 0 }),
    );

    await waitFor(() => expect(hook.current.matchedDocuments).toBe(200));
    expect(hook.current.truncated).toBe(true);
    expect(hook.current.degraded).toBe('stopwords');
    // Asked for transcripts, told only notes were searched — the caller lacks
    // `transcripts:read`, and the view says so rather than showing nothing.
    expect(hook.current.searchedTypes).toEqual(['note']);
  });

  it('reports `semantic`, `semanticReason` and `unindexedCount` as the server sent them', async () => {
    mockSearch.mockResolvedValue(
      response({ semantic: false, semanticReason: 'ai_key_missing', unindexedCount: 9 }),
    );

    const { result: hook } = renderHook(() =>
      useSearch({ q: 'budget', types: TYPES, debounceMs: 0 }),
    );

    await waitFor(() => expect(hook.current.semantic).toBe(false));
    expect(hook.current.semanticReason).toBe('ai_key_missing');
    expect(hook.current.unindexedCount).toBe(9);
  });

  it('reports `semantic: null` before any answer has landed', () => {
    // ⚠ `null`, NOT `false`. "Nobody has asked yet" is not "the answer was
    // keyword-only", and a view that conflated them would flash the
    // degradation notice during every first keystroke's debounce.
    const { result: hook } = renderHook(() => useSearch({ q: '', types: TYPES, debounceMs: 0 }));

    expect(hook.current.semantic).toBeNull();
    expect(hook.current.semanticReason).toBeNull();
    expect(hook.current.unindexedCount).toBe(0);
  });

  it('shows no rows under an error, rather than the previous query\'s rows', async () => {
    mockSearch
      .mockResolvedValueOnce(response({ results: [result('t1')] }))
      .mockRejectedValueOnce(new ApiError('Boom', 500));

    const { result: hook, rerender } = renderHook(
      ({ q }) => useSearch({ q, types: TYPES, debounceMs: 0 }),
      { initialProps: { q: 'budget' } },
    );
    await waitFor(() => expect(hook.current.results).toHaveLength(1));

    rerender({ q: 'pricing' });

    await waitFor(() => expect(hook.current.error).toBe('Boom'));
    expect(hook.current.results).toEqual([]);
  });
});
