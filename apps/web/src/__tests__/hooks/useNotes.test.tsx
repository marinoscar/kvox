import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/notes', () => ({
  getNotes: vi.fn(),
}));

import { getNotes } from '../../services/notes';
import { NOTE_PAGE_SIZE, useNotes } from '../../hooks/useNotes';
import type { NoteListItem } from '../../services/notes';

/**
 * `useNotes` — the list hook, twin of `useTranscripts.test.tsx`'s list
 * coverage. `useNoteSummary.test.tsx` covers the home-page summary hook that
 * lives in the same file; this file is the list hook only.
 *
 * The SERVICE is mocked rather than MSW, matching `useTranscripts.test.tsx`:
 * what is under test is the hook's own policy — when it asks, what it merges,
 * what it drops — and counting calls on a spy is the only way to assert "no
 * request was issued" without inferring it from a warning.
 *
 * ⚠ NO `NotificationContext` mock here, unlike `useTranscripts.test.tsx`:
 * unlike `useTranscripts`'/`useNoteSummary`'s list/summary hooks, `useNotes`
 * (the list hook) does not wire up `useLatestNoteEventId` at all — it relies
 * solely on its derived poll (`anyInFlight ? NOTE_ACTIVE_POLL_MS : 0`). That
 * asymmetry predates issue #167 and is out of this fix's scope, so it is not
 * asserted here either way — only noted so a future reader does not "fix" a
 * gap this file deliberately leaves untested.
 */

const mockGetNotes = vi.mocked(getNotes);

function listItem(id: string, overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id,
    title: `Note ${id}`,
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
    currentGenerationId: null,
    failureReason: null,
    excerpt: 'Something was decided.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** `count` distinct rows, ids prefixed so pages never collide. */
function pageOf(prefix: string, count: number): NoteListItem[] {
  return Array.from({ length: count }, (_, i) => listItem(`${prefix}${i}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNotes.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNotes — the list', () => {
  it('queries the filters it was given and reports the page', async () => {
    mockGetNotes.mockResolvedValue({ items: [listItem('a')], nextCursor: 'cursor-2' });

    const { result } = renderHook(() =>
      useNotes({ sourceTranscriptId: 't1', pollIntervalMs: 0 }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetNotes).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTranscriptId: 't1' }),
    );
    expect(result.current.notes).toHaveLength(1);
    expect(result.current.nextCursor).toBe('cursor-2');
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

describe('useNotes — revalidation reconciles rather than replaces (#167)', () => {
  it('does not truncate an accumulated list on a background revalidation — the headline case', async () => {
    // The twin of `useTranscripts.test.tsx`'s own headline test: load 60 rows
    // through two `loadMore` presses, `refresh()`, and still have 60 — not
    // `NOTE_PAGE_SIZE`.
    const page1 = pageOf('p1-', NOTE_PAGE_SIZE);
    const page2 = pageOf('p2-', NOTE_PAGE_SIZE);
    const page3 = pageOf('p3-', NOTE_PAGE_SIZE);
    mockGetNotes
      .mockResolvedValueOnce({ items: page1, nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page2, nextCursor: 'c3' })
      .mockResolvedValueOnce({ items: page3, nextCursor: null });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(NOTE_PAGE_SIZE));

    await act(async () => {
      await result.current.loadMore();
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes).toHaveLength(60);

    mockGetNotes.mockResolvedValueOnce({
      items: [...page1, ...page2, ...page3],
      nextCursor: null,
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockGetNotes).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 60 }));
    // ⚠ Without the fix this is `NOTE_PAGE_SIZE` — a full replace with page one.
    expect(result.current.notes).toHaveLength(60);
  });

  it('updates a changed row in place, without duplicating it', async () => {
    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n1', { title: 'Old title' }), listItem('n2')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(2));

    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n1', { title: 'New title' }), listItem('n2')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes).toHaveLength(2);
    expect(result.current.notes.find((n) => n.id === 'n1')?.title).toBe('New title');
  });

  it('drops a row deleted server-side, rather than keeping a stale copy', async () => {
    // The case the rejected per-row-patch design could never detect: a row
    // simply absent from the fresh answer is indistinguishable from "further
    // down the list" unless the whole covered span is trusted.
    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n1'), listItem('n2'), listItem('n3')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(3));

    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n1'), listItem('n3')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['n1', 'n3']);
  });

  it('surfaces a newly created row at the top, and the count holds', async () => {
    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n1'), listItem('n2')],
      nextCursor: null,
    });
    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(2));

    mockGetNotes.mockResolvedValueOnce({
      items: [listItem('n3'), listItem('n1'), listItem('n2')],
      nextCursor: null,
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes.map((n) => n.id)).toEqual(['n3', 'n1', 'n2']);
  });

  it('still RESETS to one page on a filter change — do not over-fix the reset path', async () => {
    mockGetNotes
      .mockResolvedValueOnce({ items: [listItem('a')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [listItem('b')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useNotes({ q, pollIntervalMs: 0 }),
      { initialProps: { q: '' } },
    );
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes).toHaveLength(2);

    mockGetNotes.mockResolvedValueOnce({ items: [listItem('fresh')], nextCursor: null });
    rerender({ q: 'filtered' });

    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['fresh']));
  });

  it('does not truncate the loaded list on the tab-refocus catch-up fetch', async () => {
    // `pollIntervalMs` is passed explicitly (rather than left to the derived
    // "poll only while something is generating" default) purely so the
    // visibility listener is attached regardless of the mocked rows' status —
    // the mechanism under test is `useVisiblePolling`'s own, already covered
    // for its timer behaviour in `useJobs.test.ts`.
    let documentHidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });

    const page1 = pageOf('p1-', NOTE_PAGE_SIZE);
    const page2 = pageOf('p2-', NOTE_PAGE_SIZE);
    mockGetNotes
      .mockResolvedValueOnce({ items: page1, nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: page2, nextCursor: null });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 5_000 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(NOTE_PAGE_SIZE));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes).toHaveLength(40);

    mockGetNotes.mockResolvedValueOnce({
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

    await waitFor(() => expect(mockGetNotes).toHaveBeenCalledTimes(3));
    expect(result.current.notes).toHaveLength(40);

    documentHidden = false;
  });

  it('drops a revalidation that settles after a loadMore invalidated its plan (the listGeneration race)', async () => {
    const page1 = pageOf('p1-', NOTE_PAGE_SIZE);
    const page2 = pageOf('p2-', NOTE_PAGE_SIZE);
    mockGetNotes.mockResolvedValueOnce({ items: page1, nextCursor: 'c2' });

    let resolveRevalidate: (value: { items: NoteListItem[]; nextCursor: string | null }) => void =
      () => {};
    mockGetNotes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRevalidate = resolve;
        }),
    );
    mockGetNotes.mockResolvedValueOnce({ items: page2, nextCursor: 'c3' });

    const { result } = renderHook(() => useNotes({ pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.notes).toHaveLength(NOTE_PAGE_SIZE));

    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(mockGetNotes).toHaveBeenCalledTimes(2));

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes).toHaveLength(40);
    expect(result.current.nextCursor).toBe('c3');

    await act(async () => {
      resolveRevalidate({ items: page1, nextCursor: 'stale-cursor-into-row-20' });
      await Promise.resolve();
    });

    // ⚠ Neither the row count nor the cursor moved — the stale answer, whose
    // plan a concurrent `loadMore` had already invalidated, was dropped.
    expect(result.current.notes).toHaveLength(40);
    expect(result.current.nextCursor).toBe('c3');
  });
});
