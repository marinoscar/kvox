/**
 * `useNoteGenerationContext` — issue #308.
 *
 * `services/notes` is mocked, but only `getNoteGenerationContext`:
 * `isNoGenerationError` is the real predicate, because the whole point of test
 * 2 below is an assertion about what it lets through — a note with no
 * generation yet is not an error, and this hook's `error` must stay `null` for
 * it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/notes', async () => {
  const actual = await vi.importActual<typeof import('../../services/notes')>('../../services/notes');
  return { ...actual, getNoteGenerationContext: vi.fn() };
});

import { ApiError } from '../../services/api';
import { getNoteGenerationContext } from '../../services/notes';
import type { NoteGenerationContext } from '../../services/notes';
import { useNoteGenerationContext } from '../../hooks/useNoteGenerationContext';

const mockGetContext = vi.mocked(getNoteGenerationContext);

function context(overrides: Partial<NoteGenerationContext> = {}): NoteGenerationContext {
  return {
    generationId: 'gen-1',
    kind: 'create',
    status: 'succeeded',
    stored: true,
    capturedAt: '2026-01-01T00:00:00.000Z',
    templateId: 'tpl-1',
    templateNameSnapshot: 'Meeting minutes',
    provider: 'openai',
    model: 'gpt-4o-mini',
    contextText: null,
    sourceType: 'transcript',
    sourceVersion: 7,
    sourceRedacted: false,
    systemPrompt: 'You write meeting notes.',
    userContent: 'Transcript text.',
    promptTokens: 500,
    completionTokens: 200,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetContext.mockReset();
});

describe('useNoteGenerationContext — disabled', () => {
  it('issues no request at all while disabled', () => {
    const { result } = renderHook(() => useNoteGenerationContext('n1', { enabled: false }));

    expect(mockGetContext).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.context).toBeNull();
  });
});

describe('useNoteGenerationContext — enabled', () => {
  it('fetches the CURRENT generation when no generationId is given', async () => {
    mockGetContext.mockResolvedValue(context());
    const { result } = renderHook(() => useNoteGenerationContext('n1', { enabled: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetContext).toHaveBeenCalledWith('n1', undefined);
    expect(result.current.context?.generationId).toBe('gen-1');
    expect(result.current.error).toBeNull();
  });

  it('fetches a SPECIFIC generation when a generationId is given', async () => {
    mockGetContext.mockResolvedValue(context({ generationId: 'gen-2' }));
    const { result } = renderHook(() =>
      useNoteGenerationContext('n1', { enabled: true, generationId: 'gen-2' }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockGetContext).toHaveBeenCalledWith('n1', 'gen-2');
    expect(result.current.context?.generationId).toBe('gen-2');
  });

  it('resolves to context: null, error: null on a "no_generation" 404 — it is not an error', async () => {
    mockGetContext.mockRejectedValue(
      new ApiError('Not found', 404, 'NOT_FOUND', { reason: 'no_generation' }),
    );
    const { result } = renderHook(() => useNoteGenerationContext('n1', { enabled: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.context).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets a message for any OTHER error', async () => {
    mockGetContext.mockRejectedValue(new ApiError('The service is down', 503));
    const { result } = renderHook(() => useNoteGenerationContext('n1', { enabled: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.context).toBeNull();
    expect(result.current.error).toBe('The service is down');
  });

  it('refetches when the generationId changes', async () => {
    mockGetContext.mockResolvedValue(context({ generationId: 'gen-1' }));
    const { result, rerender } = renderHook(
      ({ generationId }: { generationId?: string }) =>
        useNoteGenerationContext('n1', { enabled: true, generationId }),
      { initialProps: { generationId: undefined as string | undefined } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetContext).toHaveBeenCalledTimes(1);

    mockGetContext.mockResolvedValue(context({ generationId: 'gen-2' }));
    rerender({ generationId: 'gen-2' });

    await waitFor(() => expect(result.current.context?.generationId).toBe('gen-2'));
    expect(mockGetContext).toHaveBeenCalledTimes(2);
    expect(mockGetContext).toHaveBeenLastCalledWith('n1', 'gen-2');
  });

  it('refresh() re-issues the request', async () => {
    mockGetContext.mockResolvedValue(context());
    const { result } = renderHook(() => useNoteGenerationContext('n1', { enabled: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGetContext).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(mockGetContext).toHaveBeenCalledTimes(2));
  });
});
