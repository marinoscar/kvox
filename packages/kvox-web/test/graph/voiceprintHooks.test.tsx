import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';

import { renderHook } from './helpers.js';
import { http, HttpResponse, server } from './msw-compat.js';
import {
  SPEAKER_ALREADY_NAMED_MESSAGE,
  useSpeakerSuggestions,
} from '../../src/graph/headless/hooks/useSpeakerSuggestions.js';
import { useEntityVoiceprint } from '../../src/graph/headless/hooks/useEntityVoiceprint.js';
import { useVoiceprintSettings } from '../../src/graph/headless/hooks/useVoiceprintSettings.js';
import type { SpeakerSuggestion } from '../../src/graph/headless/clients/voiceprints.js';

/** The voiceprint hooks (#827): suggestions with optimistic decisions, a Person's voice, the opt-in. */

const TRANSCRIPT_ID = '33333333-3333-4333-8333-333333333333';
const PERSON_ID = '44444444-4444-4444-8444-444444444444';

function suggestion(id: string, speakerId: string, score: number): SpeakerSuggestion {
  return {
    id,
    speakerId,
    entityId: PERSON_ID,
    entityName: 'Person A',
    score,
    margin: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
}

const FIRST = suggestion('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sp1', 0.9);
const SECOND = suggestion('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sp2', 0.8);

let listCalls: number;

beforeEach(() => {
  listCalls = 0;
  server.use(
    http.get('*/api/graph/speaker-suggestions', () => {
      listCalls += 1;
      return HttpResponse.json({ data: [FIRST, SECOND] });
    }),
  );
});

describe('useSpeakerSuggestions', () => {
  it('lists the pending suggestions of a transcript', async () => {
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID));
    await waitFor(() => expect(result.current.suggestions).toEqual([FIRST, SECOND]));
    expect(result.current.isLoading).toBe(false);
  });

  it('asks nothing while disabled', async () => {
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID, false));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listCalls).toBe(0);
    expect(result.current.suggestions).toEqual([]);
  });

  it('stays silent when the read fails', async () => {
    server.use(http.get('*/api/graph/speaker-suggestions', () => HttpResponse.json({ message: 'Boom' }, { status: 500 })));
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('accepts: removes the suggestion at once and posts the decision', async () => {
    let release: () => void = () => undefined;
    const accepted: string[] = [];
    server.use(
      http.post('*/api/graph/speaker-suggestions/:id/accept', async ({ params }) => {
        accepted.push(String(params.id));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ data: { id: params.id, status: 'accepted', decidedAt: '2026-01-03T00:00:00.000Z' } });
      }),
    );
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));

    let outcome: Promise<boolean> = Promise.resolve(false);
    act(() => {
      outcome = result.current.accept(FIRST.id);
    });
    await waitFor(() => expect(result.current.suggestions).toEqual([SECOND]));
    expect(result.current.busyId).toBe(FIRST.id);
    await waitFor(() => expect(accepted).toEqual([FIRST.id]));
    release();
    await act(async () => {
      expect(await outcome).toBe(true);
    });
    expect(result.current.busyId).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('puts a dismissed suggestion back and surfaces the error when the dismiss fails', async () => {
    server.use(
      http.post('*/api/graph/speaker-suggestions/:id/dismiss', () =>
        HttpResponse.json({ message: 'Something went wrong' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    await act(async () => {
      expect(await result.current.dismiss(SECOND.id)).toBe(false);
    });
    expect(result.current.suggestions).toEqual([FIRST, SECOND]);
    expect(result.current.error).toBe('Something went wrong');
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('keeps the suggestion gone when the speaker was named in the meantime', async () => {
    server.use(
      http.post('*/api/graph/speaker-suggestions/:id/accept', () =>
        HttpResponse.json(
          { statusCode: 409, message: 'Already named', details: { reason: 'SPEAKER_ALREADY_NAMED' } },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderHook(() => useSpeakerSuggestions(TRANSCRIPT_ID));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    await act(async () => {
      expect(await result.current.accept(FIRST.id)).toBe(false);
    });
    expect(result.current.suggestions).toEqual([SECOND]);
    expect(result.current.error).toBe(SPEAKER_ALREADY_NAMED_MESSAGE);
  });
});

describe('useEntityVoiceprint', () => {
  it('reads the voice and forgets it', async () => {
    const deleted: string[] = [];
    server.use(
      http.get('*/api/graph/entities/:id/voiceprint', () =>
        HttpResponse.json({
          data: { enrolled: true, samples: 2, speechMs: 120_000, lastUpdatedAt: '2026-01-02T00:00:00.000Z', modelId: 'm' },
        }),
      ),
      http.delete('*/api/graph/entities/:id/voiceprint', ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderHook(() => useEntityVoiceprint(PERSON_ID));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data?.samples).toBe(2));

    await act(async () => {
      expect(await result.current.forget()).toBe(true);
    });
    expect(deleted).toEqual([PERSON_ID]);
    expect(result.current.data).toMatchObject({ enrolled: false, samples: 0 });
  });

  it('asks nothing while disabled', async () => {
    const reads = vi.fn();
    server.use(
      http.get('*/api/graph/entities/:id/voiceprint', () => {
        reads();
        return HttpResponse.json({ data: {} });
      }),
    );
    const { result } = renderHook(() => useEntityVoiceprint(PERSON_ID, false));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a failed forget', async () => {
    server.use(
      http.delete('*/api/graph/entities/:id/voiceprint', () => HttpResponse.json({ message: 'Nope' }, { status: 500 })),
    );
    const { result } = renderHook(() => useEntityVoiceprint(PERSON_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(await result.current.forget()).toBe(false);
    });
    expect(result.current.forgetError).toBe('Nope');
  });
});

describe('useVoiceprintSettings', () => {
  let enabled: boolean;

  beforeEach(() => {
    enabled = false;
    server.use(
      http.get('*/api/graph/voiceprints/summary', () =>
        HttpResponse.json({
          data: { enabled, consentAt: enabled ? '2026-01-02T00:00:00.000Z' : null, people: 1, samples: 4 },
        }),
      ),
      http.delete('*/api/graph/voiceprints', () =>
        HttpResponse.json({ data: { deletedSamples: 4, deletedSuggestions: 2 } }),
      ),
    );
  });

  it('enables through the preferences write, then reads the summary again', async () => {
    const update = vi.fn(async () => {
      enabled = true;
      return true;
    });
    const { result } = renderHook(() => useVoiceprintSettings({ update }));
    await waitFor(() => expect(result.current.summary?.enabled).toBe(false));

    await act(async () => {
      expect(await result.current.setEnabled(true)).toBe(true);
    });
    expect(update).toHaveBeenCalledWith({ voiceprints: { enabled: true } });
    expect(result.current.summary).toMatchObject({ enabled: true, consentAt: '2026-01-02T00:00:00.000Z' });
  });

  it('reports a write that did not land', async () => {
    const update = vi.fn(async () => false);
    const { result } = renderHook(() => useVoiceprintSettings({ update }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(await result.current.setEnabled(true)).toBe(false);
    });
    expect(result.current.summary?.enabled).toBe(false);
  });

  it('deletes all and resolves the counts', async () => {
    const { result } = renderHook(() => useVoiceprintSettings({ update: vi.fn(async () => true) }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(await result.current.deleteAll()).toEqual({ deletedSamples: 4, deletedSuggestions: 2 });
    });
    expect(result.current.actionError).toBeNull();
  });
});
