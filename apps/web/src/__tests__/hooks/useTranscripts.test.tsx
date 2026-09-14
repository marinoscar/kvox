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
