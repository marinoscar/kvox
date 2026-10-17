import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';

vi.mock('../../src/notes/headless/clients/notes.js', () => ({
  getNoteSummary: vi.fn(),
}));

import { getNoteSummary } from '../../src/notes/headless/clients/notes.js';
import { renderHook as renderHookOverHost } from './helpers.js';
import type { HostRenderHookOptions } from '../transcripts/helpers.js';
import { NOTE_ACTIVE_POLL_MS, useNoteSummary } from '../../src/notes/headless/hooks/useNotes.js';
import type { NoteListItem, NoteSummary } from '../../src/notes/headless/clients/notes.js';

/**
 * The home page's notes half — issue #107.
 *
 * The SERVICE is mocked rather than MSW, matching `useTranscripts.test.tsx`:
 * what is under test here is the hook's own policy (when it asks, when it does
 * not, what it keeps when an answer fails), and counting calls on a spy is the
 * only way to assert "issued no request at all" without inferring it from a
 * warning.
 *
 * The host's notification stream (`useLatestEventId`) is a variable the suite
 * controls, because it is optional on the host and the event-driven refresh has
 * to be exercised from both sides of that.
 */

const mockGetNoteSummary = vi.mocked(getNoteSummary);

/** The notifications the host's stream holds, newest first; `null` is a host with no stream at all. */
let notificationEvents: { id: string; eventKey: string }[] | null = [];

/** `renderHook` over a fake host whose notification stream holds {@link notificationEvents}. */
function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: HostRenderHookOptions<Props> = {},
) {
  return renderHookOverHost(callback, {
    hostOptions:
      notificationEvents === null
        ? {}
        : {
            useLatestEventId: (prefix) =>
              notificationEvents?.find((event) => event.eventKey.startsWith(prefix))?.id ?? null,
          },
    ...options,
  });
}

function listItem(id: string, overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id,
    title: `Note ${id}`,
    titleSource: 'ai',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: null,
    currentGenerationId: null,
    failureReason: null,
    excerpt: 'Something was decided.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function summary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  const recent = overrides.recent ?? [];
  const inProgress = overrides.inProgress ?? [];
  const failed = overrides.failed ?? [];
  return {
    inProgress,
    recent,
    failed,
    counts: {
      total: recent.length + inProgress.length + failed.length,
      ready: recent.length,
      inProgress: inProgress.length,
      failed: failed.length,
      ...overrides.counts,
    },
  };
}

/** No notification stream at all: the host leaves `useLatestEventId` out. */
function noNotifications() {
  notificationEvents = null;
}

/** A stream holding exactly these events, newest first. */
function withNotifications(events: { id: string; eventKey: string }[]) {
  notificationEvents = events;
}

beforeEach(() => {
  vi.clearAllMocks();
  noNotifications();
  mockGetNoteSummary.mockResolvedValue(summary());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNoteSummary — the first read', () => {
  it('asks once on mount', async () => {
    const { result } = renderHook(() => useNoteSummary());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetNoteSummary).toHaveBeenCalledTimes(1);
  });

  it('reports the summary it was given', async () => {
    mockGetNoteSummary.mockResolvedValue(summary({ recent: [listItem('a')] }));

    const { result } = renderHook(() => useNoteSummary());

    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.summary?.recent).toHaveLength(1);
    expect(result.current.summary?.counts.total).toBe(1);
  });

  it('starts out loading', () => {
    const { result } = renderHook(() => useNoteSummary());

    expect(result.current.isLoading).toBe(true);
  });

  it('reports a failure as a sentence rather than throwing', async () => {
    mockGetNoteSummary.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useNoteSummary());

    await waitFor(() => expect(result.current.error).toBe('Failed to load your notes'));
  });
});

describe('useNoteSummary — polling', () => {
  it('does NOT poll while nothing is generating', async () => {
    // The landing screen is the tab most likely to be left open overnight, and
    // a settled list changes for nobody.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await vi.advanceTimersByTimeAsync(NOTE_ACTIVE_POLL_MS * 6);

    expect(mockGetNoteSummary).toHaveBeenCalledTimes(1);
  });

  it('polls at the active cadence while something IS generating', async () => {
    mockGetNoteSummary.mockResolvedValue(
      summary({ inProgress: [listItem('g', { status: 'generating' })] }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await vi.advanceTimersByTimeAsync(NOTE_ACTIVE_POLL_MS * 2 + 100);

    await waitFor(() => expect(mockGetNoteSummary.mock.calls.length).toBeGreaterThan(1));
  });

  it('never raises isLoading for a poll', async () => {
    mockGetNoteSummary.mockResolvedValue(
      summary({ inProgress: [listItem('g', { status: 'generating' })] }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await vi.advanceTimersByTimeAsync(NOTE_ACTIVE_POLL_MS * 2 + 100);

    // A skeleton every five seconds over content that is already correct is the
    // fastest way to make a live section unusable.
    expect(result.current.isLoading).toBe(false);
  });

  it('KEEPS the last good summary when a poll fails', async () => {
    // A refresh that 500s mid-visit must not replace a correct list with an
    // error banner and nothing else.
    const good = summary({ inProgress: [listItem('g', { status: 'generating' })] });
    mockGetNoteSummary.mockResolvedValueOnce(good).mockRejectedValue(new Error('nope'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    await vi.advanceTimersByTimeAsync(NOTE_ACTIVE_POLL_MS + 100);

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.summary).toEqual(good);
  });
});

describe('useNoteSummary — disabled', () => {
  it('issues NO request at all', async () => {
    renderHook(() => useNoteSummary({ enabled: false }));

    // Awaited rather than asserted synchronously: a request fired from an
    // effect would land a microtask later, and a synchronous assertion would
    // pass whether or not the guard existed.
    await Promise.resolve();

    expect(mockGetNoteSummary).not.toHaveBeenCalled();
  });

  it('reports the empty, settled shape', () => {
    const { result } = renderHook(() => useNoteSummary({ enabled: false }));

    expect(result.current.summary).toBeNull();
    // NOT stuck loading: there is nothing to wait for, and a spinner that never
    // resolves is worse than no section.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not poll either', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useNoteSummary({ enabled: false }));

    await vi.advanceTimersByTimeAsync(NOTE_ACTIVE_POLL_MS * 6);

    expect(mockGetNoteSummary).not.toHaveBeenCalled();
  });
});

describe('useNoteSummary — the notification stream', () => {
  it('refreshes when a new notes.* event arrives', async () => {
    withNotifications([{ id: 'ev-1', eventKey: 'notes.note_ready' }]);
    const { result, rerender } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The BASELINE is recorded rather than assumed to be 1: an event already in
    // the centre at mount is itself a new id, so the first render legitimately
    // fires the initial read AND the event-driven one. What this test is about
    // is the NEXT id, not the arithmetic of the first frame.
    const baseline = mockGetNoteSummary.mock.calls.length;

    withNotifications([{ id: 'ev-2', eventKey: 'notes.note_ready' }]);
    rerender();

    await waitFor(() =>
      expect(mockGetNoteSummary.mock.calls.length).toBe(baseline + 1),
    );
  });

  it('ignores an event from another registry namespace', async () => {
    withNotifications([{ id: 'ev-1', eventKey: 'notes.note_ready' }]);
    const { result, rerender } = renderHook(() => useNoteSummary());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const baseline = mockGetNoteSummary.mock.calls.length;

    // The bell re-renders for reasons of its own; refetching on every one of
    // them would turn it into a second, unthrottled poll. The newest `notes.`
    // event is still `ev-1`, so nothing here is new to this hook.
    withNotifications([
      { id: 'ev-9', eventKey: 'transcripts.transcript_ready' },
      { id: 'ev-1', eventKey: 'notes.note_ready' },
    ]);
    rerender();

    expect(mockGetNoteSummary.mock.calls.length).toBe(baseline);
  });

  it('works with no notification provider mounted at all', async () => {
    // A host with no notification stream (`useLatestEventId` is optional) is
    // the visual harness and most tests, and that must not be a crash.
    noNotifications();

    const { result } = renderHook(() => useNoteSummary());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
