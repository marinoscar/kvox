/**
 * The notes LIST hook — issue #167, epic #162.
 *
 * =============================================================================
 * THIS SUITE IS `useTranscripts.test.tsx`'s TWIN, ON PURPOSE
 * =============================================================================
 *
 * `useNotes` and `useTranscripts` are twins by design — both hook files say so
 * in their own headers — and #167 was a defect they shared exactly: a
 * background read of PAGE ONE replaced the accumulated list instead of merging
 * into it, so every page the user had pressed "Load more" for was thrown away.
 * The fix is one shared module (`utils/feedReconcile.ts`) wired identically
 * into both, and these two suites are written test-for-test alike so that a
 * divergence between them is the signal that one hook drifted from the other.
 *
 * Read the counterpart file's header for the argument; it is not repeated here.
 *
 * =============================================================================
 * ⚠ ONE TEST IS MISSING HERE, AND THE ASYMMETRY IS TRACKED
 * =============================================================================
 *
 * `useTranscripts.test.tsx` has "leaves 60 rows after a transcripts.*
 * NOTIFICATION". There is no `notes.*` counterpart, because there is nothing to
 * assert: `useNotes.ts` defines `useLatestNoteEventId` but wires it into
 * `useNoteSummary` only — the LIST hook never subscribes.
 *
 * That gap is **issue #169**, filed separately and deliberately not fixed as
 * part of #167 (wiring up an event subscription is a behaviour change, not a
 * revalidation bug fix, and it should not ride along inside one). It matters
 * more here than it would on the transcripts side because this hook's poll is
 * CONDITIONAL — `anyInFlight ? NOTE_ACTIVE_POLL_MS : 0` — so a settled notes
 * list has no interval AND no subscription, and updates only when the user
 * navigates or changes a filter.
 *
 * When #169 lands, add the missing test beside the others and delete this note.
 *
 * =============================================================================
 * WHY EVERY TEST PASSES AN EXPLICIT `pollIntervalMs`
 * =============================================================================
 *
 * Because of that same conditional interval. A fixture of `ready` notes derives
 * an interval of `0`, which `useVisiblePolling` treats as "no interval at all",
 * so a test that did not pass one would silently be asserting nothing about
 * polling. Passing it explicitly makes each test say which mechanism it is
 * exercising instead of depending on the status of its fixture rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/notes', () => ({
  getNotes: vi.fn(),
  getNote: vi.fn(),
  getNoteSummary: vi.fn(),
}));

vi.mock('../../contexts/NotificationContext', () => ({
  useNotifications: vi.fn(),
}));

import { getNote, getNoteSummary, getNotes } from '../../services/notes';
import { useNotifications } from '../../contexts/NotificationContext';
import { NOTE_ACTIVE_POLL_MS, useNotes } from '../../hooks/useNotes';
import type { NoteListItem } from '../../services/notes';
import { clearFeedCache } from '../../utils/feedCache';

const mockGetNotes = vi.mocked(getNotes);
const mockGetNote = vi.mocked(getNote);
const mockGetNoteSummary = vi.mocked(getNoteSummary);
const mockUseNotifications = vi.mocked(useNotifications);

function listItem(id: string, overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id,
    title: `Note ${id}`,
    titleSource: 'ai',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-x',
    sourceType: 'transcript',
    sourceTranscriptId: 'tr-1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting summary',
    currentGenerationId: null,
    failureReason: null,
    excerpt: 'An excerpt.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * `n` rows starting at `from`, newest first, one minute apart — `n0` is newest.
 *
 * The `updatedAt` spacing is load-bearing, not cosmetic: `reconcileFeed` decides
 * which held rows survive a revalidation by comparing them against the page's
 * OLDEST row, so a fixture where every row shares one timestamp would exercise
 * only the `id` tie-break and would pass whatever the date comparison did.
 */
function page(from: number, n = 20): NoteListItem[] {
  return Array.from({ length: n }, (_, i) => {
    const index = from + i;
    const minute = String(59 - (index % 60)).padStart(2, '0');
    const hour = String(23 - Math.floor(index / 60)).padStart(2, '0');
    return listItem(`n${index}`, { updatedAt: `2026-01-01T${hour}:${minute}:00.000Z` });
  });
}

/** Drive `document.hidden`, which is a getter and cannot simply be assigned. */
function hidden(value: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseNotifications.mockReturnValue(null);
  mockGetNotes.mockResolvedValue({ items: [], nextCursor: null });
  mockGetNote.mockResolvedValue(listItem('n1') as never);
  mockGetNoteSummary.mockResolvedValue({
    inProgress: [],
    recent: [],
    failed: [],
    counts: { total: 0, ready: 0, inProgress: 0, failed: 0 },
  });
  hidden(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNotes — the list', () => {
  it('reports the page and its cursor', async () => {
    mockGetNotes.mockResolvedValue({ items: [listItem('a')], nextCursor: 'cursor-2' });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.nextCursor).toBe('cursor-2');
  });

  it('passes the source filter a transcript page asks for', async () => {
    renderHook(() => useNotes({ sourceTranscriptId: 'tr-9', pollIntervalMs: 0 }));

    await waitFor(() =>
      expect(mockGetNotes).toHaveBeenCalledWith(
        expect.objectContaining({ sourceTranscriptId: 'tr-9' }),
      ),
    );
  });

  it('APPENDS on loadMore rather than replacing', async () => {
    mockGetNotes
      .mockResolvedValueOnce({ items: [listItem('a')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b')], nextCursor: null });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(result.current.nextCursor).toBeNull();
  });

  it('dedupes a row that appears on two pages', async () => {
    // Cursor paging bounds the window, it does not freeze the ordering: a row
    // whose `updatedAt` moves between requests legitimately appears twice, and
    // React would warn about the duplicate key while rendering it twice.
    mockGetNotes
      .mockResolvedValueOnce({ items: [listItem('a'), listItem('b')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b'), listItem('c')], nextCursor: null });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(2));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a stale response so a slow search cannot overwrite a fast one', async () => {
    let resolveSlow: (value: { items: NoteListItem[]; nextCursor: null }) => void = () => {};
    mockGetNotes
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [listItem('fast')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useNotes({ q, pollIntervalMs: 0 }),
      { initialProps: { q: 'bud' } },
    );

    rerender({ q: 'budget' });
    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['fast']));

    await act(async () => {
      resolveSlow({ items: [listItem('slow')], nextCursor: null });
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['fast']);
  });

  it('reports a failure as a sentence, never as a rejection', async () => {
    mockGetNotes.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.error).toBe('Failed to load notes'));
  });
});

/**
 * =============================================================================
 * THE INTERACTION #167 WAS ABOUT
 * =============================================================================
 *
 * Every test above covers `loadMore` OR `load` in isolation, and both were
 * always correct in isolation. The defect lived in what happens when a
 * background read of PAGE ONE lands on a list that `loadMore` had grown.
 *
 * Three call sites reach it here — the derived-interval poll, the tab-refocus
 * catch-up fetch, and `refresh()` after a row action. The transcripts twin has
 * a fourth (the notification effect); see this file's header and issue #169 for
 * why that one has no counterpart yet.
 */
describe('useNotes — a background read REVALIDATES, it does not truncate', () => {
  function threePages() {
    mockGetNotes
      .mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page(20), nextCursor: 'c3' })
      .mockResolvedValueOnce({ items: page(40), nextCursor: 'c4' });
  }

  async function loadThreePages(pollIntervalMs = 0) {
    const rendered = renderHook(() => useNotes({ pollIntervalMs }));
    await waitFor(() => expect(rendered.result.current.notes).toHaveLength(20));
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    expect(rendered.result.current.notes).toHaveLength(60);
    return rendered;
  }

  it('leaves 60 rows after the POLL fires', async () => {
    threePages();
    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const { result } = await loadThreePages(NOTE_ACTIVE_POLL_MS);

    const before = mockGetNotes.mock.calls.length;
    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetNotes.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.notes).toHaveLength(60);
    expect(result.current.notes[59].id).toBe('n59');
  });

  it('leaves 60 rows after the tab REGAINS FOCUS', async () => {
    // `useVisiblePolling` does one immediate catch-up fetch on the way back to
    // visible. That fetch is page one, and before #167 it was the fastest way
    // to lose a loaded feed: switch tabs and come straight back.
    threePages();
    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const { result } = await loadThreePages(NOTE_ACTIVE_POLL_MS);
    const before = mockGetNotes.mock.calls.length;

    await act(async () => {
      hidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      hidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetNotes.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.notes).toHaveLength(60);
  });

  it('leaves 60 rows after refresh() following a row action', async () => {
    threePages();
    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const { result } = await loadThreePages();

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes).toHaveLength(60);
  });

  it('keeps the CURSOR where loadMore left it, so paging does not rewind', async () => {
    threePages();
    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const { result } = await loadThreePages();
    expect(result.current.nextCursor).toBe('c4');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.nextCursor).toBe('c4');
  });

  it('shows a NEW row at the top without disturbing the loaded pages', async () => {
    threePages();
    mockGetNotes.mockResolvedValue({
      items: [listItem('fresh', { updatedAt: '2026-02-01T00:00:00.000Z' }), ...page(0).slice(0, 19)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes[0].id).toBe('fresh');
    expect(result.current.notes).toHaveLength(61);
  });

  it('updates a CHANGED row in place rather than rendering it twice', async () => {
    threePages();
    const moved = listItem('n45', {
      title: 'Renamed just now',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    mockGetNotes.mockResolvedValue({
      items: [moved, ...page(0).slice(0, 19)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    const matches = result.current.notes.filter((n) => n.id === 'n45');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Renamed just now');
    expect(result.current.notes[0].id).toBe('n45');
  });

  it('makes a row REMOVED from page one\'s window disappear', async () => {
    threePages();
    mockGetNotes.mockResolvedValue({
      items: [...page(0).filter((n) => n.id !== 'n7'), ...page(20).slice(0, 1)],
      nextCursor: 'c2',
    });

    const { result } = await loadThreePages();
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes.map((n) => n.id)).not.toContain('n7');
  });

  it('RESETS on a new question — a search term must not keep the old rows', async () => {
    // The clause that breaks if somebody decides every load should reconcile:
    // `load`'s identity changes exactly when the query does, and reconciling
    // there splices rows matching the OLD filter into the answer to a new one.
    mockGetNotes
      .mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page(20), nextCursor: 'c3' })
      .mockResolvedValue({ items: [listItem('match')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useNotes({ q, pollIntervalMs: 0 }),
      { initialProps: { q: '' } },
    );
    await waitFor(() => expect(result.current.notes).toHaveLength(20));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes).toHaveLength(40);

    rerender({ q: 'budget' });

    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['match']));
    expect(result.current.nextCursor).toBeNull();
  });

  it('RESETS on a source-filter change too', async () => {
    mockGetNotes
      .mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' })
      .mockResolvedValue({ items: [listItem('from-tr-9')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ source }: { source: string | undefined }) =>
        useNotes({ sourceTranscriptId: source, pollIntervalMs: 0 }),
      { initialProps: { source: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.notes).toHaveLength(20));

    rerender({ source: 'tr-9' });

    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['from-tr-9']));
  });

  it('raises isLoading on a reset and NEVER on a revalidation', async () => {
    // A spinner every five seconds over data that is already correct is the
    // fastest way to make a live list unusable — and it would also throw away
    // the scroll position the rows are holding.
    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
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
    let resolveSlow: (value: { items: NoteListItem[]; nextCursor: string | null }) => void =
      () => {};
    mockGetNotes.mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(20));

    mockGetNotes
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [listItem('newest')], nextCursor: null });

    let slow: Promise<void> = Promise.resolve();
    await act(async () => {
      slow = result.current.refresh();
      await result.current.refresh();
    });
    expect(result.current.notes.map((n) => n.id)).toEqual(['newest']);

    await act(async () => {
      resolveSlow({ items: page(20), nextCursor: 'c3' });
      await slow;
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['newest']);
  });
});

/**
 * =============================================================================
 * THE FEED SURVIVES A DRILL-DOWN — issue #168
 * =============================================================================
 *
 * `useTranscripts.test.tsx`'s twin block, and the same reasoning: a separate
 * defect from the revalidation one above, surviving its fix, because the rows
 * live in `useState` inside this hook and unmount with the page.
 *
 * `unmount()` then `renderHook(...)` with the same options IS the drill-down.
 *
 * ⚠ `cacheKey` is OPT-IN, and the transcript detail page's note list is the
 * reason it has to be: it calls this same hook with a `sourceTranscriptId` and
 * must neither read from nor evict entries in the library's cache. The last
 * test in this block pins that.
 */
describe('useNotes — a cached feed survives the drill-down', () => {
  beforeEach(() => {
    clearFeedCache();
  });

  async function loadSixtyRows(cacheKey: string) {
    mockGetNotes
      .mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page(20), nextCursor: 'c3' })
      .mockResolvedValueOnce({ items: page(40), nextCursor: 'c4' })
      .mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const rendered = renderHook(() => useNotes({ pollIntervalMs: 0, cacheKey }));
    await waitFor(() => expect(rendered.result.current.notes).toHaveLength(20));
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    await act(async () => {
      await rendered.result.current.loadMore();
    });
    expect(rendered.result.current.notes).toHaveLength(60);
    return rendered;
  }

  it('brings back all 60 rows and the cursor after unmount and remount', async () => {
    const { unmount } = await loadSixtyRows('notes||');
    unmount();

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0, cacheKey: 'notes||' }));

    expect(result.current.notes).toHaveLength(60);
    expect(result.current.nextCursor).toBe('c4');
  });

  it('paints those rows on the FIRST frame, with no spinner over them', async () => {
    const { unmount } = await loadSixtyRows('notes||');
    unmount();

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0, cacheKey: 'notes||' }));

    expect(result.current.isLoading).toBe(false);
  });

  it('REVALIDATES rather than resetting on that remount', async () => {
    // The trap: a remount that reset would adopt page one and truncate the
    // restored feed back to twenty — #167's bug arriving through #168's door.
    const { unmount } = await loadSixtyRows('notes||');
    unmount();

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0, cacheKey: 'notes||' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockGetNotes).toHaveBeenCalled();
    expect(result.current.notes).toHaveLength(60);
  });

  it('starts over for a DIFFERENT filter, never replaying rows that no longer match', async () => {
    const { unmount } = await loadSixtyRows('notes||');
    unmount();

    mockGetNotes.mockResolvedValue({ items: [listItem('match')], nextCursor: null });

    const { result } = renderHook(() =>
      useNotes({ q: 'budget', pollIntervalMs: 0, cacheKey: 'notes|budget|' }),
    );

    expect(result.current.notes).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['match']));
  });

  it('keeps each filter\'s own feed, so switching back restores it', async () => {
    await loadSixtyRows('notes||').then((r) => r.unmount());

    mockGetNotes.mockResolvedValue({ items: [listItem('match')], nextCursor: null });
    const searched = renderHook(() =>
      useNotes({ q: 'budget', pollIntervalMs: 0, cacheKey: 'notes|budget|' }),
    );
    await waitFor(() => expect(searched.result.current.notes).toHaveLength(1));
    searched.unmount();

    mockGetNotes.mockResolvedValue({ items: page(0), nextCursor: 'c2' });
    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0, cacheKey: 'notes||' }));

    expect(result.current.notes).toHaveLength(60);
  });

  it('caches NOTHING without a cacheKey — what the transcript detail page gets', async () => {
    mockGetNotes
      .mockResolvedValueOnce({ items: page(0), nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page(20), nextCursor: 'c3' })
      .mockResolvedValue({ items: page(0), nextCursor: 'c2' });

    const first = renderHook(() =>
      useNotes({ sourceTranscriptId: 'tr-1', pollIntervalMs: 0 }),
    );
    await waitFor(() => expect(first.result.current.notes).toHaveLength(20));
    await act(async () => {
      await first.result.current.loadMore();
    });
    expect(first.result.current.notes).toHaveLength(40);
    first.unmount();

    const { result } = renderHook(() =>
      useNotes({ sourceTranscriptId: 'tr-1', pollIntervalMs: 0 }),
    );

    expect(result.current.notes).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);
  });
});
