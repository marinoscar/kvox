import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/noteTemplates', () => ({
  getNoteTemplate: vi.fn(),
  getNoteTemplates: vi.fn(),
  createNoteTemplate: vi.fn(),
  updateNoteTemplate: vi.fn(),
  duplicateNoteTemplate: vi.fn(),
  deleteNoteTemplate: vi.fn(),
  hideNoteTemplate: vi.fn(),
  unhideNoteTemplate: vi.fn(),
}));

import {
  getNoteTemplate,
  getNoteTemplates,
  hideNoteTemplate,
  unhideNoteTemplate,
} from '../../services/noteTemplates';
import type { NoteTemplate } from '../../services/noteTemplates';
import { useNoteTemplateDetail, useNoteTemplates } from '../../hooks/useNoteTemplates';
import { ApiError } from '../../services/api';

/**
 * `useNoteTemplateDetail` — issue #109, epic #45.
 *
 * FIVE STATES, and the suite is organised by them because the distinctions are
 * the hook's whole product:
 *
 *   `idle`     nothing was asked, and nothing will be (a deleted template).
 *   `loading`  asked, no answer yet.
 *   `loaded`   the row.
 *   `missing`  404 or 403 — a permanent, correct answer, NOT a failure.
 *   `error`    anything else, with the message the caller should render.
 *
 * The one most likely to be broken by a well-meaning refactor is `missing`:
 * folding it into `error` compiles, passes any test that only checks
 * `template === null`, and puts a red alert in front of a user whose note is
 * perfectly fine.
 */

const mockGetNoteTemplate = vi.mocked(getNoteTemplate);
const mockGetNoteTemplates = vi.mocked(getNoteTemplates);
const mockHideNoteTemplate = vi.mocked(hideNoteTemplate);
const mockUnhideNoteTemplate = vi.mocked(unhideNoteTemplate);

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Executive summary',
    description: '',
    instructions: 'Write it up.',
    outputFormat: 'summary',
    structure: [],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn: false,
    hidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useNoteTemplateDetail — idle', () => {
  it('resolves to `idle` SYNCHRONOUSLY for a null id, and asks nothing', () => {
    // ⚠ NO SKELETON FLASH. A note whose template was deleted carries
    // `templateId: null`, and the panel that describes it must not render a
    // loading state for a row that is never going to arrive.
    const { result } = renderHook(() => useNoteTemplateDetail(null));

    expect(result.current).toEqual({ template: null, state: 'idle', error: null });
    expect(mockGetNoteTemplate).not.toHaveBeenCalled();
  });

  it('does the same for `undefined` — the note itself has not loaded yet', () => {
    const { result } = renderHook(() => useNoteTemplateDetail(undefined));

    expect(result.current.state).toBe('idle');
    expect(mockGetNoteTemplate).not.toHaveBeenCalled();
  });

  it('returns to `idle` when the id goes away', async () => {
    mockGetNoteTemplate.mockResolvedValue(template());
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNoteTemplateDetail(id),
      { initialProps: { id: 'tpl-1' as string | null } },
    );
    await waitFor(() => expect(result.current.state).toBe('loaded'));

    rerender({ id: null });

    expect(result.current).toEqual({ template: null, state: 'idle', error: null });
  });
});

describe('useNoteTemplateDetail — loading and loaded', () => {
  it('starts in `loading` for a real id, before anything resolves', () => {
    mockGetNoteTemplate.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    expect(result.current).toEqual({ template: null, state: 'loading', error: null });
    expect(mockGetNoteTemplate).toHaveBeenCalledWith('tpl-1');
  });

  it('hands back the row it read', async () => {
    mockGetNoteTemplate.mockResolvedValue(template({ name: 'Board brief' }));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    await waitFor(() => expect(result.current.state).toBe('loaded'));
    expect(result.current.template?.name).toBe('Board brief');
    expect(result.current.error).toBeNull();
  });

  it('re-reads when the id changes, and keeps the LAST id’s answer', async () => {
    // ⚠ THE RACE. `/notes/a` → `/notes/b` keeps this component mounted, so
    // without the in-effect cancellation the first template would win and be
    // rendered under the second note's heading.
    mockGetNoteTemplate.mockImplementation(async (id: string) =>
      template({ id, name: id === 'tpl-1' ? 'First' : 'Second' }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useNoteTemplateDetail(id), {
      initialProps: { id: 'tpl-1' },
    });
    await waitFor(() => expect(result.current.template?.name).toBe('First'));

    rerender({ id: 'tpl-2' });

    await waitFor(() => expect(result.current.template?.name).toBe('Second'));
    expect(mockGetNoteTemplate).toHaveBeenCalledTimes(2);
  });
});

describe('useNoteTemplateDetail — missing', () => {
  it('maps a 404 to `missing`, with NO error message', async () => {
    mockGetNoteTemplate.mockRejectedValue(new ApiError('Not found', 404));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    await waitFor(() => expect(result.current.state).toBe('missing'));
    // ⚠ `error` STAYS NULL. A caller that rendered `error` whenever it was set
    // must show nothing here, because nothing failed.
    expect(result.current.error).toBeNull();
    expect(result.current.template).toBeNull();
  });

  it('maps a 403 to `missing` too', async () => {
    mockGetNoteTemplate.mockRejectedValue(new ApiError('Forbidden', 403));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    await waitFor(() => expect(result.current.state).toBe('missing'));
    expect(result.current.error).toBeNull();
  });
});

describe('useNoteTemplateDetail — error', () => {
  it('reports a 500 as `error`, carrying the API’s own message', async () => {
    mockGetNoteTemplate.mockRejectedValue(new ApiError('The service is unavailable.', 500));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe('The service is unavailable.');
  });

  it('still says something true when the rejection was not an ApiError at all', async () => {
    mockGetNoteTemplate.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useNoteTemplateDetail('tpl-1'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe('This template could not be loaded');
  });
});

// =============================================================================
// useNoteTemplates — the list hook, and `setHidden` — issue #311
// =============================================================================

/**
 * `setHidden` is OPTIMISTIC and its rollback is SCOPED TO ONE ROW. Both claims
 * only really mean something under a concurrency scenario, so most of this
 * suite drives the mocked service call by hand (resolving/rejecting a held
 * promise) rather than letting `mockResolvedValue` settle immediately — that
 * is the only way to observe the state the UI actually sees mid-flight.
 */

describe('useNoteTemplates — the default request', () => {
  it('asks for the bare list, with no includeHidden, by default', async () => {
    mockGetNoteTemplates.mockResolvedValue({ items: [template()], total: 1 });
    const { result } = renderHook(() => useNoteTemplates());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetNoteTemplates).toHaveBeenCalledWith({});
  });

  it('sends includeHidden: true when asked for', async () => {
    mockGetNoteTemplates.mockResolvedValue({ items: [template()], total: 1 });
    const { result } = renderHook(() => useNoteTemplates({ includeHidden: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetNoteTemplates).toHaveBeenCalledWith({ includeHidden: true });
  });
});

describe('useNoteTemplates — setHidden, optimism and rollback', () => {
  it('flips the row in place when the list includes hidden rows', async () => {
    const rows = [template({ id: 'a', hidden: false }), template({ id: 'b', hidden: false })];
    mockGetNoteTemplates.mockResolvedValue({ items: rows, total: rows.length });
    let resolveHide!: () => void;
    mockHideNoteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHide = resolve;
      }),
    );
    const { result } = renderHook(() => useNoteTemplates({ includeHidden: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok: Promise<boolean>;
    act(() => {
      ok = result.current.setHidden('a', true);
    });

    // Optimistic: the row is flipped BEFORE the request settles, and the other
    // row is untouched.
    await waitFor(() =>
      expect(result.current.templates.find((t) => t.id === 'a')?.hidden).toBe(true),
    );
    expect(result.current.templates.find((t) => t.id === 'b')?.hidden).toBe(false);
    expect(result.current.templates).toHaveLength(2);

    resolveHide();
    await expect(ok!).resolves.toBe(true);
  });

  it('removes the row locally when the default (hidden-excluding) list is hiding it', async () => {
    const rows = [template({ id: 'a', hidden: false }), template({ id: 'b', hidden: false })];
    mockGetNoteTemplates.mockResolvedValue({ items: rows, total: rows.length });
    let resolveHide!: () => void;
    mockHideNoteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHide = resolve;
      }),
    );
    const { result } = renderHook(() => useNoteTemplates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.templates).toHaveLength(2);

    act(() => {
      void result.current.setHidden('a', true);
    });

    // Optimistic REMOVAL — a default picker list never shows a hidden row.
    await waitFor(() => expect(result.current.templates.map((t) => t.id)).toEqual(['b']));

    resolveHide();
  });

  it('rolls back ONLY the row that failed, restored at its original index, on a 500', async () => {
    const rows = [
      template({ id: 'a', hidden: false }),
      template({ id: 'b', hidden: false }),
      template({ id: 'c', hidden: false }),
    ];
    mockGetNoteTemplates.mockResolvedValue({ items: rows, total: rows.length });
    mockHideNoteTemplate.mockRejectedValue(new ApiError('Server error', 500));
    const { result } = renderHook(() => useNoteTemplates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Hide the MIDDLE row, so "restored at its original index" is a real
    // assertion rather than one a push-to-the-end implementation would also
    // satisfy.
    let ok: boolean;
    await act(async () => {
      ok = await result.current.setHidden('b', true);
    });

    expect(ok!).toBe(false);
    // Back exactly where it was, not appended at the end.
    expect(result.current.templates.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.templates.find((t) => t.id === 'b')?.hidden).toBe(false);
    // `messageFor` prefers the ApiError's own message for a non-403/404 status.
    expect(result.current.actionError).toBe('Server error');
  });

  it('rolls back an in-place flip (includeHidden list) on failure too', async () => {
    const rows = [template({ id: 'a', hidden: true }), template({ id: 'b', hidden: false })];
    mockGetNoteTemplates.mockResolvedValue({ items: rows, total: rows.length });
    mockUnhideNoteTemplate.mockRejectedValue(new ApiError('Server error', 500));
    const { result } = renderHook(() => useNoteTemplates({ includeHidden: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.setHidden('a', false);
    });

    expect(ok!).toBe(false);
    expect(result.current.templates.find((t) => t.id === 'a')?.hidden).toBe(true);
    expect(result.current.actionError).toBe('Server error');
  });

  it('reports "This template no longer exists." on a 404, distinct from every other failure', async () => {
    const rows = [template({ id: 'a', hidden: false })];
    mockGetNoteTemplates.mockResolvedValue({ items: rows, total: rows.length });
    mockHideNoteTemplate.mockRejectedValue(new ApiError('Not found', 404));
    const { result } = renderHook(() => useNoteTemplates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok: boolean;
    await act(async () => {
      ok = await result.current.setHidden('a', true);
    });

    expect(ok!).toBe(false);
    expect(result.current.actionError).toBe('This template no longer exists.');
  });
});
