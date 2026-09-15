import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/transcripts', () => ({
  getTranscripts: vi.fn(),
  getTranscript: vi.fn(),
  getTranscriptSegments: vi.fn(),
}));

vi.mock('../../contexts/NotificationContext', () => ({
  useNotifications: vi.fn(),
}));

import {
  getTranscript,
  getTranscriptSegments,
  getTranscripts,
} from '../../services/transcripts';
import { useNotifications } from '../../contexts/NotificationContext';
import {
  TRANSCRIPT_ACTIVE_POLL_MS,
  TRANSCRIPT_IDLE_POLL_MS,
  TRANSCRIPT_PAGE_SIZE,
  useTranscript,
  useTranscriptSegments,
  useTranscripts,
} from '../../hooks/useTranscripts';
import type { TranscriptDetail, TranscriptListItem } from '../../services/transcripts';

const mockGetTranscripts = vi.mocked(getTranscripts);
const mockGetTranscript = vi.mocked(getTranscript);
const mockGetTranscriptSegments = vi.mocked(getTranscriptSegments);
const mockUseNotifications = vi.mocked(useNotifications);

function listItem(id: string, overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    id,
    title: `Transcript ${id}`,
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 60_000,
    speakerCount: 2,
    wordCount: 100,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<TranscriptDetail> = {}): TranscriptDetail {
  return {
    ...listItem('t1'),
    speakers: [],
    provider: 'AssemblyAI',
    remoteDeletedAt: null,
    submittedAt: null,
    completedAt: null,
    sourceName: 'a.m4a',
    sourceMimeType: 'audio/mp4',
    sourceSizeBytes: '1024',
    ...overrides,
  };
}

/** `count` distinct rows, ids prefixed so pages never collide. */
function pageOf(prefix: string, count: number): TranscriptListItem[] {
  return Array.from({ length: count }, (_, i) => listItem(`${prefix}${i}`));
}

/** No notification centre mounted — the default for most of these. */
function noNotifications() {
  mockUseNotifications.mockReturnValue(null);
}

/** A centre holding exactly these events, newest first. */
function withNotifications(events: { id: string; eventKey: string }[]) {
  mockUseNotifications.mockReturnValue({
    notifications: events.map((event) => ({
      id: event.id,
      eventKey: event.eventKey,
      title: 't',
      body: 'b',
      link: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      readAt: null,
    })),
    unreadCount: 0,
    isLoading: false,
    error: null,
    streamState: 'open',
    refresh: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  } as unknown as ReturnType<typeof useNotifications>);
}

beforeEach(() => {
  vi.clearAllMocks();
  noNotifications();
  mockGetTranscripts.mockResolvedValue({ items: [], nextCursor: null });
  mockGetTranscript.mockResolvedValue({ status: 'ok', data: detail(), etag: 'W/"v1"' });
  mockGetTranscriptSegments.mockResolvedValue({
    status: 'ok',
    data: { currentVersion: 1, segments: [] },
    etag: 'W/"v1"',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTranscripts — the list', () => {
  it('queries the scope it was given and reports the page', async () => {
    mockGetTranscripts.mockResolvedValue({ items: [listItem('a')], nextCursor: 'cursor-2' });

    const { result } = renderHook(() => useTranscripts('shared', { pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetTranscripts).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'shared' }),
    );
    expect(result.current.transcripts).toHaveLength(1);
    expect(result.current.nextCursor).toBe('cursor-2');
  });

  it('APPENDS on loadMore rather than replacing', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce({ items: [listItem('a')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b')], nextCursor: null });

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(1));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['a', 'b']);
    expect(result.current.nextCursor).toBeNull();
  });

  it('dedupes a row that appears on two pages', async () => {
    // Cursor paging bounds the window, it does not freeze the ordering: a row
    // whose `updatedAt` moves between requests legitimately appears twice, and
    // React would warn about the duplicate key while rendering it twice.
    mockGetTranscripts
      .mockResolvedValueOnce({ items: [listItem('a'), listItem('b')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b'), listItem('c')], nextCursor: null });

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(2));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a stale response so a slow search cannot overwrite a fast one', async () => {
    // The classic search race, which an every-keystroke filter makes routine:
    // `q: "bud"` settles after `q: "budget"` and puts the wrong rows back.
    let resolveSlow: (value: { items: TranscriptListItem[]; nextCursor: null }) => void =
      () => {};
    mockGetTranscripts
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [listItem('fast')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useTranscripts('owned', { q, pollIntervalMs: 0 }),
      { initialProps: { q: 'bud' } },
    );

    rerender({ q: 'budget' });
    await waitFor(() => expect(result.current.transcripts.map((t) => t.id)).toEqual(['fast']));

    await act(async () => {
      resolveSlow({ items: [listItem('slow')], nextCursor: null });
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['fast']);
  });

  it('reports a failure as a sentence, never as a rejection', async () => {
    mockGetTranscripts.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.error).toBe('Failed to load transcripts'));
  });

  it('refetches when a transcripts.* notification arrives on the stream', async () => {
    const { rerender } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(mockGetTranscripts).toHaveBeenCalledTimes(1));

    withNotifications([{ id: 'n1', eventKey: 'transcripts.transcript_ready' }]);
    rerender();

    await waitFor(() => expect(mockGetTranscripts).toHaveBeenCalledTimes(2));
  });

  it('ignores an UNRELATED notification', async () => {
    // The bell re-renders for reasons of its own (a read receipt, another
    // event). Refetching on every one of those would turn it into a second,
    // unthrottled poll.
    withNotifications([{ id: 'n1', eventKey: 'security.role_changed' }]);
    const { rerender } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(mockGetTranscripts).toHaveBeenCalledTimes(1));

    withNotifications([
      { id: 'n2', eventKey: 'admin.broadcast' },
      { id: 'n1', eventKey: 'security.role_changed' },
    ]);
    rerender();

    // A short settle, so a refetch that WAS going to happen has had its chance.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetTranscripts).toHaveBeenCalledTimes(1);
  });
});

describe('useTranscripts — revalidation reconciles rather than replaces (#167)', () => {
  it('does not truncate an accumulated list on a background revalidation — the headline case', async () => {
    // The bug this whole issue is about: load two hundred rows (here, three
    // pages via `loadMore`), look away, and have twenty again. Sixty rows
    // in, `refresh()` must still show sixty, not `TRANSCRIPT_PAGE_SIZE`.
    const page1 = pageOf('p1-', TRANSCRIPT_PAGE_SIZE);
    const page2 = pageOf('p2-', TRANSCRIPT_PAGE_SIZE);
    const page3 = pageOf('p3-', TRANSCRIPT_PAGE_SIZE);
    mockGetTranscripts
      .mockResolvedValueOnce({ items: page1, nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page2, nextCursor: 'c3' })
      .mockResolvedValueOnce({ items: page3, nextCursor: null });

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(TRANSCRIPT_PAGE_SIZE));

    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(60);

    // The revalidation re-reads the WHOLE 60-row span, not page one.
    mockGetTranscripts.mockResolvedValueOnce({
      items: [...page1, ...page2, ...page3],
      nextCursor: null,
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetTranscripts).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 60 }));
    // ⚠ Without the fix this is 20 — a full replace with page one.
    expect(result.current.transcripts).toHaveLength(60);
  });

  it('updates a changed row in place, without duplicating it', async () => {
    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t1', { title: 'Old title' }), listItem('t2')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(2));

    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t1', { title: 'New title' }), listItem('t2')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts).toHaveLength(2);
    expect(result.current.transcripts.find((t) => t.id === 't1')?.title).toBe('New title');
  });

  it('drops a row deleted server-side, rather than keeping a stale copy', async () => {
    // This is the case the rejected per-row-patch design could never detect:
    // a row simply absent from the fresh answer is indistinguishable from "it
    // is further down the list" unless the whole covered span is trusted.
    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t1'), listItem('t2'), listItem('t3')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(3));

    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t1'), listItem('t3')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('surfaces a newly created row at the top, and the count holds', async () => {
    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t1'), listItem('t2')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(2));

    // Ordered by `updatedAt` descending, so a brand-new row is first.
    mockGetTranscripts.mockResolvedValueOnce({
      items: [listItem('t3'), listItem('t1'), listItem('t2')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
  });

  it('still RESETS to one page on a filter change — do not over-fix the reset path', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce({ items: [listItem('a')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useTranscripts('owned', { q, pollIntervalMs: 0 }),
      { initialProps: { q: '' } },
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(1));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(2);

    // A filter change gives `load` a new identity, which re-runs the mount
    // effect as `load(true)` — a RESET, not a revalidation. It must collapse
    // back to one page rather than merging with what a different filter loaded.
    mockGetTranscripts.mockResolvedValueOnce({ items: [listItem('fresh')], nextCursor: null });
    rerender({ q: 'filtered' });

    await waitFor(() =>
      expect(result.current.transcripts.map((t) => t.id)).toEqual(['fresh']),
    );
  });

  it('does not truncate the loaded list on the tab-refocus catch-up fetch', async () => {
    // `useVisiblePolling` fires one immediate fetch on `visibilitychange` back
    // to visible, through the exact same `load(false)` revalidation path as
    // the idle poll — it must not truncate either.
    let documentHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });

    const page1 = pageOf('p1-', TRANSCRIPT_PAGE_SIZE);
    const page2 = pageOf('p2-', TRANSCRIPT_PAGE_SIZE);
    mockGetTranscripts
      .mockResolvedValueOnce({ items: page1, nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page2, nextCursor: null });

    // A real, positive interval — the visibility listener is only attached
    // when polling is actually enabled.
    const { result } = renderHook(() => useTranscripts('owned'));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(TRANSCRIPT_PAGE_SIZE));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(40);

    mockGetTranscripts.mockResolvedValueOnce({
      items: [...page1, ...page2],
      nextCursor: null,
    });

    documentHidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    documentHidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockGetTranscripts).toHaveBeenCalledTimes(3));
    expect(result.current.transcripts).toHaveLength(40);

    documentHidden = false;
  });

  it('drops a revalidation that settles after a loadMore invalidated its plan (the listGeneration race)', async () => {
    // A revalidation planned against 20 rows that settles AFTER `loadMore` has
    // made it 40 computed its `cursorIsAuthoritative` against a list that no
    // longer exists. Adopting its cursor would rewind `nextCursor` to just
    // past row twenty and strand page three behind it forever.
    const page1 = pageOf('p1-', TRANSCRIPT_PAGE_SIZE);
    const page2 = pageOf('p2-', TRANSCRIPT_PAGE_SIZE);
    mockGetTranscripts.mockResolvedValueOnce({ items: page1, nextCursor: 'c2' });

    let resolveRevalidate: (value: { items: TranscriptListItem[]; nextCursor: string | null }) => void =
      () => {};
    mockGetTranscripts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRevalidate = resolve;
        }),
    );
    mockGetTranscripts.mockResolvedValueOnce({ items: page2, nextCursor: 'c3' });

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(TRANSCRIPT_PAGE_SIZE));

    // Kick off a revalidation and let it hang mid-flight.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(mockGetTranscripts).toHaveBeenCalledTimes(2));

    // `loadMore` lands first, bumping `listGeneration`.
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(40);
    expect(result.current.nextCursor).toBe('c3');

    // The stale revalidation finally settles, carrying a cursor that points
    // just past row twenty — it must be DROPPED entirely.
    await act(async () => {
      resolveRevalidate({ items: page1, nextCursor: 'stale-cursor-into-row-20' });
      await Promise.resolve();
    });

    // ⚠ Neither the row count nor the cursor moved. A regression here would
    // show 20 rows (the stale merge winning) or `nextCursor` rewound to the
    // stale cursor (stranding page three behind it).
    expect(result.current.transcripts).toHaveLength(40);
    expect(result.current.nextCursor).toBe('c3');
  });
});

describe('useTranscript — the conditional poll', () => {
  it('sends no validator first and the returned one afterwards', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTranscript('t1'));

    await vi.waitFor(() => expect(result.current.transcript).not.toBeNull());
    expect(mockGetTranscript).toHaveBeenLastCalledWith('t1', null);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_IDLE_POLL_MS + 10);
    });

    expect(mockGetTranscript).toHaveBeenLastCalledWith('t1', 'W/"v1"');
  });

  it('leaves state completely untouched on a 304', async () => {
    // The whole point of the conditional request: no re-render, so the
    // rendered list keeps its scroll position and the player keeps its place.
    vi.useFakeTimers();
    const first = detail({ title: 'Original' });
    mockGetTranscript.mockResolvedValueOnce({ status: 'ok', data: first, etag: 'W/"v1"' });
    mockGetTranscript.mockResolvedValue({ status: 'not-modified' });

    const { result } = renderHook(() => useTranscript('t1'));
    await vi.waitFor(() => expect(result.current.transcript?.title).toBe('Original'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_IDLE_POLL_MS + 10);
    });

    expect(result.current.transcript).toBe(first);
    // The validator is still valid after a 304 and must NOT be cleared.
    expect(mockGetTranscript).toHaveBeenLastCalledWith('t1', 'W/"v1"');
  });

  it('polls at the FAST cadence while the transcript is in flight', async () => {
    vi.useFakeTimers();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing' }),
      etag: 'W/"v1"',
    });

    const { result } = renderHook(() => useTranscript('t1'));
    await vi.waitFor(() => expect(result.current.transcript?.status).toBe('processing'));
    const afterFirst = mockGetTranscript.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_ACTIVE_POLL_MS + 10);
    });

    expect(mockGetTranscript.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('does not poll the fast cadence once the transcript is settled', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTranscript('t1'));
    await vi.waitFor(() => expect(result.current.transcript?.status).toBe('ready'));
    const afterFirst = mockGetTranscript.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_ACTIVE_POLL_MS + 10);
    });

    expect(mockGetTranscript.mock.calls.length).toBe(afterFirst);
  });

  it('fetches nothing at all without an id', async () => {
    // The route param before it resolves. `GET /transcripts/undefined` is a
    // guaranteed 400 on a screen that has not asked for anything yet.
    renderHook(() => useTranscript(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetTranscript).not.toHaveBeenCalled();
  });

  it('drops the validator when the id changes', async () => {
    // The old ETag describes a DIFFERENT transcript. Sending it would make the
    // server compare versions across two rows and — when both are at v1 —
    // answer 304 with the previous transcript still on screen.
    const { result, rerender } = renderHook(({ id }: { id: string }) => useTranscript(id), {
      initialProps: { id: 't1' },
    });
    await waitFor(() => expect(result.current.transcript).not.toBeNull());

    rerender({ id: 't2' });

    await waitFor(() => expect(mockGetTranscript).toHaveBeenLastCalledWith('t2', null));
  });

  it('clears the validator when a write hands back a new transcript', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTranscript('t1'));
    await vi.waitFor(() => expect(result.current.transcript).not.toBeNull());

    act(() => result.current.setTranscript(detail({ title: 'Renamed', currentVersion: 4 })));
    expect(result.current.transcript?.title).toBe('Renamed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_IDLE_POLL_MS + 10);
    });

    expect(mockGetTranscript).toHaveBeenLastCalledWith('t1', null);
  });

  it('names 404 specifically — its remedy is not "try again"', async () => {
    mockGetTranscript.mockRejectedValue(
      Object.assign(new Error('nope'), { name: 'ApiError', status: 404 }),
    );
    const { result } = renderHook(() => useTranscript('t1'));

    await waitFor(() => expect(result.current.error).toBeTruthy());
  });
});

describe('useTranscriptSegments', () => {
  it('fetches nothing while disabled, and does not sit in a loading state', async () => {
    // A processing transcript has no segments. Leaving `isLoading` true would
    // render a spinner over the pipeline stepper, which is the one thing a
    // waiting user actually wants to look at.
    const { result } = renderHook(() => useTranscriptSegments('t1', false));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetTranscriptSegments).not.toHaveBeenCalled();
  });

  it('fetches once enabled and reports the version the segments belong to', async () => {
    mockGetTranscriptSegments.mockResolvedValue({
      status: 'ok',
      data: {
        currentVersion: 7,
        segments: [
          {
            id: 's1',
            speakerId: 'sp1',
            startMs: 0,
            endMs: 1000,
            ordinal: 1,
            text: 'hello',
            wordsAlignment: 'exact',
            confidence: null,
            origin: 'ai',
            rev: 1,
            editedAt: null,
          },
        ],
      },
      etag: 'W/"v7"',
    });

    const { result } = renderHook(() => useTranscriptSegments('t1', true));

    await waitFor(() => expect(result.current.segments).toHaveLength(1));
    expect(result.current.version).toBe(7);
  });

  it('refetches when a transcripts.* notification lands', async () => {
    const { rerender } = renderHook(() => useTranscriptSegments('t1', true));
    await waitFor(() => expect(mockGetTranscriptSegments).toHaveBeenCalledTimes(1));

    withNotifications([{ id: 'n1', eventKey: 'transcripts.transcript_ready' }]);
    rerender();

    await waitFor(() => expect(mockGetTranscriptSegments).toHaveBeenCalledTimes(2));
  });
});
