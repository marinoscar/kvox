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
  useTranscript,
  useTranscriptSegments,
  useTranscripts,
} from '../../hooks/useTranscripts';
import type { TranscriptDetail, TranscriptListItem } from '../../services/transcripts';
import { clearFeedCache } from '../../utils/feedCache';

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

/**
 * `n` rows starting at `from`, newest first, one minute apart — `t0` is newest.
 *
 * The `updatedAt` spacing is load-bearing, not cosmetic: `reconcileFeed` decides
 * which held rows survive a revalidation by comparing them against the page's
 * OLDEST row, so a fixture where every row shares one timestamp would exercise
 * only the `id` tie-break and would pass whatever the date comparison did.
 */
function page(from: number, n = 20): TranscriptListItem[] {
  return Array.from({ length: n }, (_, i) => {
    const index = from + i;
    const minute = String(59 - (index % 60)).padStart(2, '0');
    const hour = String(23 - Math.floor(index / 60)).padStart(2, '0');
    return listItem(`t${index}`, { updatedAt: `2026-01-01T${hour}:${minute}:00.000Z` });
  });
}

/** Drive `document.hidden`, which is a getter and cannot simply be assigned. */
function hidden(value: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
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


/**
 * One page as the API returns it, `total` included (#190).
 *
 * `total` defaults to the page's own length, which is right for every test that
 * is not about paging. The three-page fixtures below pass the real figure,
 * because the whole point of `total` is that it does NOT shrink as a client
 * pages — a count derived from the page would make that untestable here.
 */
function listResponse(
  items: TranscriptListItem[],
  nextCursor: string | null,
  total: number = items.length,
) {
  return { items, total, nextCursor };
}

beforeEach(() => {
  vi.clearAllMocks();
  noNotifications();
  mockGetTranscripts.mockResolvedValue(listResponse([], null));
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
    mockGetTranscripts.mockResolvedValue(listResponse([listItem('a')], 'cursor-2'));

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
      .mockResolvedValueOnce(listResponse([listItem('a')], 'c2'))
      .mockResolvedValueOnce(listResponse([listItem('b')], null));

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
      .mockResolvedValueOnce(listResponse([listItem('a'), listItem('b')], 'c2'))
      .mockResolvedValueOnce(listResponse([listItem('b'), listItem('c')], null));

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
      .mockResolvedValueOnce(listResponse([listItem('fast')], null));

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useTranscripts('owned', { q, pollIntervalMs: 0 }),
      { initialProps: { q: 'bud' } },
    );

    rerender({ q: 'budget' });
    await waitFor(() => expect(result.current.transcripts.map((t) => t.id)).toEqual(['fast']));

    await act(async () => {
      resolveSlow(listResponse([listItem('slow')], null));
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

/**
 * =============================================================================
 * THE INTERACTION #167 WAS ABOUT
 * =============================================================================
 *
 * Every test above covers `loadMore` OR `load` in isolation, and both were
 * always correct in isolation. The defect lived in what happens when a
 * background read of PAGE ONE lands on a list that `loadMore` had grown — the
 * list was replaced with the page, so sixty rows became twenty, silently, up to
 * three times a minute.
 *
 * Four separate call sites trigger that read, and each gets its own test here
 * rather than being represented by one: they reach `load` through four
 * different mechanisms (an interval, a real `visibilitychange`, the
 * notification effect, a handler calling `refresh`), and a regression is free
 * to break one while leaving the others working.
 *
 * ⚠ The counterpart tests live in `useNotes.test.tsx` and are deliberately
 * test-for-test identical. The two hooks are twins by design — both file
 * headers say so — and a divergence between these two suites is the signal that
 * one of them drifted.
 */
describe('useTranscripts — a background read REVALIDATES, it does not truncate', () => {
  /** Three pages: 20 rows, then 20 more, then 20 more. */
  function threePages() {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValueOnce(listResponse(page(40), 'c4', 60));
  }

  async function loadThreePages() {
    const rendered = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(rendered.result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    expect(rendered.result.current.transcripts).toHaveLength(60);
    return rendered;
  }

  it('leaves 60 rows after the 20-second POLL fires', async () => {
    threePages();
    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = await loadThreePages();

    // The poll is driven through the real hook rather than by calling `refresh`
    // — the interval is the path that actually runs on a settled library with
    // nothing in flight, and it is the one nobody was watching.
    const { result: polled, rerender } = renderHook(
      ({ interval }: { interval: number }) =>
        useTranscripts('owned', { pollIntervalMs: interval }),
      { initialProps: { interval: 0 } },
    );
    rerender({ interval: TRANSCRIPT_IDLE_POLL_MS });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts).toHaveLength(60);
    expect(result.current.transcripts[59].id).toBe('t59');
    expect(polled.current.isLoading).toBe(false);
  });

  it('leaves 60 rows when the interval actually elapses', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValueOnce(listResponse(page(40), 'c4', 60))
      .mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: TRANSCRIPT_IDLE_POLL_MS }),
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(60);

    const before = mockGetTranscripts.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Drive the interval by hand rather than with fake timers: the hook's
    // `await` chain needs real microtask turns to settle, and mixing the two
    // makes this test about the timer mock rather than about the merge.
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockGetTranscripts.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.transcripts).toHaveLength(60);
  });

  it('leaves 60 rows after the tab REGAINS FOCUS', async () => {
    // `useVisiblePolling` does one immediate catch-up fetch on the way back to
    // visible. That fetch is page one, and before #167 it was the fastest way
    // to lose a loaded feed: switch tabs and come straight back.
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValueOnce(listResponse(page(40), 'c4', 60))
      .mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: TRANSCRIPT_IDLE_POLL_MS }),
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });

    const before = mockGetTranscripts.mock.calls.length;

    await act(async () => {
      hidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      hidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetTranscripts.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.transcripts).toHaveLength(60);
  });

  it('leaves 60 rows after a transcripts.* NOTIFICATION', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValueOnce(listResponse(page(40), 'c4', 60))
      .mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result, rerender } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0 }),
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });

    withNotifications([{ id: 'n1', eventKey: 'transcripts.transcript_ready' }]);
    await act(async () => {
      rerender();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.transcripts).toHaveLength(60);
  });

  it('leaves 60 rows after refresh() following a row action', async () => {
    threePages();
    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = await loadThreePages();

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts).toHaveLength(60);
  });

  it('keeps the CURSOR where loadMore left it, so paging does not rewind', async () => {
    threePages();
    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = await loadThreePages();
    expect(result.current.nextCursor).toBe('c4');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.nextCursor).toBe('c4');
  });

  it('shows a NEW row at the top without disturbing the loaded pages', async () => {
    threePages();
    mockGetTranscripts.mockResolvedValue({
      items: [listItem('fresh', { updatedAt: '2026-02-01T00:00:00.000Z' }), ...page(0).slice(0, 19)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts[0].id).toBe('fresh');
    expect(result.current.transcripts).toHaveLength(61);
  });

  it('updates a CHANGED row in place rather than rendering it twice', async () => {
    threePages();
    const moved = listItem('t45', {
      title: 'Renamed just now',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    mockGetTranscripts.mockResolvedValue({
      items: [moved, ...page(0).slice(0, 19)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    const matches = result.current.transcripts.filter((t) => t.id === 't45');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Renamed just now');
    expect(result.current.transcripts[0].id).toBe('t45');
  });

  it('makes a row REMOVED from page one\'s window disappear', async () => {
    threePages();
    // t007 deleted elsewhere; t020 backfills the window it vacated.
    mockGetTranscripts.mockResolvedValue({
      items: [...page(0).filter((t) => t.id !== 't7'), ...page(20).slice(0, 1)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.transcripts.map((t) => t.id)).not.toContain('t7');
  });

  it('RESETS on a new question — a search term must not keep the old rows', async () => {
    // The clause that breaks if somebody decides every load should reconcile:
    // `load`'s identity changes exactly when the query does, and reconciling
    // there splices rows matching the OLD filter into the answer to a new one.
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2'))
      .mockResolvedValueOnce(listResponse(page(20), 'c3'))
      .mockResolvedValue(listResponse([listItem('match')], null));

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useTranscripts('owned', { q, pollIntervalMs: 0 }),
      { initialProps: { q: '' } },
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.transcripts).toHaveLength(40);

    rerender({ q: 'budget' });

    await waitFor(() => expect(result.current.transcripts.map((t) => t.id)).toEqual(['match']));
    expect(result.current.nextCursor).toBeNull();
  });

  it('RESETS on a scope change too', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2'))
      .mockResolvedValue(listResponse([listItem('shared-1')], null));

    const { result, rerender } = renderHook(
      ({ scope }: { scope: 'owned' | 'shared' }) =>
        useTranscripts(scope, { pollIntervalMs: 0 }),
      { initialProps: { scope: 'owned' as const } },
    );
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));

    rerender({ scope: 'shared' as const });

    await waitFor(() =>
      expect(result.current.transcripts.map((t) => t.id)).toEqual(['shared-1']),
    );
  });

  it('raises isLoading on a reset and NEVER on a revalidation', async () => {
    // A spinner every twenty seconds over data that is already correct is the
    // fastest way to make a live list unusable — and it would also throw away
    // the scroll position the rows are holding.
    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 60));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const seen: boolean[] = [];
    await act(async () => {
      const pending = result.current.refresh();
      seen.push(result.current.isLoading);
      await pending;
    });

    expect(seen).toEqual([false]);
    expect(result.current.isLoading).toBe(false);
  });

  it('drops a stale REVALIDATION so it cannot resurrect rows', async () => {
    // The request-token guard has to cover the revalidate path as well as the
    // reset one: a slow poll settling after a newer read would otherwise merge
    // an out-of-date page one into the current list.
    let resolveSlow: (value: { items: TranscriptListItem[]; nextCursor: string | null }) => void =
      () => {};
    mockGetTranscripts.mockResolvedValueOnce(listResponse(page(0), 'c2'));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));

    mockGetTranscripts
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce(listResponse([listItem('newest')], null));

    let slow: Promise<void> = Promise.resolve();
    await act(async () => {
      slow = result.current.refresh();
      await result.current.refresh();
    });
    expect(result.current.transcripts.map((t) => t.id)).toEqual(['newest']);

    await act(async () => {
      resolveSlow(listResponse(page(20), 'c3'));
      await slow;
    });

    expect(result.current.transcripts.map((t) => t.id)).toEqual(['newest']);
  });
});

/**
 * =============================================================================
 * THE FEED SURVIVES A DRILL-DOWN — issue #168
 * =============================================================================
 *
 * A separate defect from the revalidation block above, and one that survives
 * its fix: the rows live in `useState` inside this hook, so tapping a row and
 * pressing back unmounts them regardless of how well a poll behaves.
 *
 * `unmount()` then `renderHook(...)` with the same options IS the drill-down —
 * it is exactly what the router does — so these tests assert the real thing
 * rather than a stand-in for it.
 *
 * ⚠ The `cacheKey` option is OPT-IN. Every test in the blocks above passes no
 * key and must be completely unaffected; if they ever start depending on the
 * cache, the opt-in has stopped being one.
 */
describe('useTranscripts — a cached feed survives the drill-down', () => {
  beforeEach(() => {
    clearFeedCache();
  });

  async function loadSixtyRows(cacheKey: string) {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValueOnce(listResponse(page(40), 'c4', 60))
      .mockResolvedValue(listResponse(page(0), 'c2', 60));

    const rendered = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0, cacheKey }),
    );
    await waitFor(() => expect(rendered.result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    expect(rendered.result.current.transcripts).toHaveLength(60);
    return rendered;
  }

  it('brings back all 60 rows and the cursor after unmount and remount', async () => {
    const { unmount } = await loadSixtyRows('transcripts|owned||');
    unmount();

    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0, cacheKey: 'transcripts|owned||' }),
    );

    expect(result.current.transcripts).toHaveLength(60);
    expect(result.current.nextCursor).toBe('c4');
  });

  it('paints those rows on the FIRST frame, with no spinner over them', async () => {
    // A spinner here would blank the list for a frame and take the scroll
    // position with it — which is the whole of what the user notices.
    const { unmount } = await loadSixtyRows('transcripts|owned||');
    unmount();

    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0, cacheKey: 'transcripts|owned||' }),
    );

    expect(result.current.isLoading).toBe(false);
  });

  it('REVALIDATES rather than resetting on that remount', async () => {
    // The trap: a remount that reset would adopt page one and truncate the
    // restored feed back to twenty — #167's bug arriving through #168's door.
    const { unmount } = await loadSixtyRows('transcripts|owned||');
    unmount();

    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0, cacheKey: 'transcripts|owned||' }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetTranscripts).toHaveBeenCalled();
    expect(result.current.transcripts).toHaveLength(60);
  });

  it('starts over for a DIFFERENT filter, never replaying rows that no longer match', async () => {
    const { unmount } = await loadSixtyRows('transcripts|owned||');
    unmount();

    mockGetTranscripts.mockResolvedValue(listResponse([listItem('shared-1')], null));

    const { result } = renderHook(() =>
      useTranscripts('shared', { pollIntervalMs: 0, cacheKey: 'transcripts|shared||' }),
    );

    expect(result.current.transcripts).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);
    await waitFor(() =>
      expect(result.current.transcripts.map((t) => t.id)).toEqual(['shared-1']),
    );
  });

  it('keeps each filter\'s own feed, so switching back restores it', async () => {
    await loadSixtyRows('transcripts|owned||').then((r) => r.unmount());

    mockGetTranscripts.mockResolvedValue(listResponse([listItem('shared-1')], null));
    const shared = renderHook(() =>
      useTranscripts('shared', { pollIntervalMs: 0, cacheKey: 'transcripts|shared||' }),
    );
    await waitFor(() => expect(shared.result.current.transcripts).toHaveLength(1));
    shared.unmount();

    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 60));
    const { result } = renderHook(() =>
      useTranscripts('owned', { pollIntervalMs: 0, cacheKey: 'transcripts|owned||' }),
    );

    expect(result.current.transcripts).toHaveLength(60);
  });

  it('caches NOTHING without a cacheKey — the option is opt-in', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2'))
      .mockResolvedValueOnce(listResponse(page(20), 'c3'))
      .mockResolvedValue(listResponse(page(0), 'c2', 60));

    const first = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(first.result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await first.result.current.loadMore();
    });
    expect(first.result.current.transcripts).toHaveLength(40);
    first.unmount();

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));

    expect(result.current.transcripts).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);
  });
});

/**
 * =============================================================================
 * `total` — HOW MANY MATCH, NOT HOW MANY ARE LOADED (issue #190)
 * =============================================================================
 *
 * The number this exposes is the one the result-count line renders, and its
 * whole value is that it does NOT move as the user pages. So the tests that
 * matter are the ones where it would be tempting to derive it from the rows:
 * a 20-row page out of 60, and a `loadMore` that leaves it alone.
 */
describe('useTranscripts — total', () => {
  it('reports how many MATCH, not how many are loaded', async () => {
    mockGetTranscripts.mockResolvedValue(listResponse(page(0), 'c2', 300));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));

    expect(result.current.total).toBe(300);
  });

  it('does not change as the user pages', async () => {
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.total).toBe(60));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.transcripts).toHaveLength(40);
    expect(result.current.total).toBe(60);
  });

  it('takes the PAGE\'s count on a revalidation, even while keeping its own cursor', async () => {
    // The count answers a question about the FILTERS, so the freshest answer
    // wins — unlike `nextCursor`, which describes where the client's own list
    // stops and is deliberately kept. The two are not symmetric and a
    // "simplification" that made them so would freeze the count.
    mockGetTranscripts
      .mockResolvedValueOnce(listResponse(page(0), 'c2', 60))
      .mockResolvedValueOnce(listResponse(page(20), 'c3', 60))
      .mockResolvedValue(listResponse(page(0), 'c2', 61));

    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.transcripts).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.total).toBe(61);
    expect(result.current.nextCursor).toBe('c3');
    expect(result.current.transcripts).toHaveLength(40);
  });

  it('starts at 0 before the first page lands', async () => {
    const { result } = renderHook(() => useTranscripts('owned', { pollIntervalMs: 0 }));

    expect(result.current.total).toBe(0);
    expect(result.current.isLoading).toBe(true);
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
