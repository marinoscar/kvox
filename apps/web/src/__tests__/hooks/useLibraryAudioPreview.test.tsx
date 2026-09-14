import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useLibraryAudioPreview } from '../../hooks/useLibraryAudioPreview';
import type { TranscriptAudio } from '../../services/transcripts';

/**
 * `useLibraryAudioPreview` (issue #98) — the shared element behind the
 * library's per-row Play controls. Against a hand-rolled fake media element,
 * for the identical reason `usePlaybackEngine.test.tsx` gives for its own:
 * jsdom's `HTMLAudioElement` implements the shape and none of the behaviour
 * this hook reasons about.
 *
 * ONE DELIBERATE PIECE OF REALISM: assigning `.src` fires a synchronous
 * `pause` event, exactly as the hook's own file header describes real
 * browsers doing during the load algorithm. That is what lets the "a pause
 * fired while loading must not repaint the row" guard get exercised by every
 * ordinary play, rather than only by one contrived test — and it is also why
 * a dedicated test for that guard has to stop the fake from also
 * auto-firing `play`, or the very next line would paper over a missing guard.
 */
class FakeAudio {
  currentTime = 0;
  paused = true;
  preload = '';
  error: { code: number } | null = null;
  readonly sources: string[] = [];

  private listeners = new Map<EventListener, { type: string; once: boolean }>();

  play = vi.fn(async () => {
    this.paused = false;
    this.emit('play');
  });

  pause = vi.fn(() => {
    this.paused = true;
    this.emit('pause');
  });

  load = vi.fn();
  removeAttribute = vi.fn();

  addEventListener = vi.fn(
    (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
      const once = typeof options === 'object' && Boolean(options.once);
      this.listeners.set(listener, { type, once });
    },
  );

  removeEventListener = vi.fn((_type: string, listener: EventListener) => {
    this.listeners.delete(listener);
  });

  emit(type: string) {
    for (const [listener, meta] of [...this.listeners]) {
      if (meta.type !== type) continue;
      if (meta.once) this.listeners.delete(listener);
      listener(new Event(type));
    }
  }
}

/** `src` assignment is recorded through a setter the class field cannot express. */
function makeAudio(): FakeAudio {
  const audio = new FakeAudio();
  let value = '';
  Object.defineProperty(audio, 'src', {
    get: () => value,
    set: (next: string) => {
      value = next;
      audio.sources.push(next);
      // The real load algorithm's own `pause`, fired at exactly the point the
      // hook has already published `loading` and already set the row it
      // belongs to — see the file header.
      audio.emit('pause');
    },
  });
  return audio;
}

function audioInfo(url: string): TranscriptAudio {
  return {
    url,
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function renderPreview(
  fetchAudio = vi.fn(async (id: string) => audioInfo(`https://storage.example/${id}`)),
  audio: FakeAudio = makeAudio(),
) {
  const createAudio = vi.fn(() => audio as unknown as HTMLAudioElement);
  const rendered = renderHook(() => useLibraryAudioPreview({ createAudio, fetchAudio }));
  return { ...rendered, audio, createAudio, fetchAudio };
}

describe('useLibraryAudioPreview — before the first press', () => {
  it('creates no element and fetches nothing', () => {
    const { createAudio, fetchAudio, result } = renderPreview();

    expect(createAudio).not.toHaveBeenCalled();
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(result.current.activeId).toBeNull();
    expect(result.current.status).toBe('idle');
  });
});

describe('useLibraryAudioPreview — a cold toggle', () => {
  it('fetches exactly one signed URL, assigns it, and plays: loading → playing', async () => {
    const { result, audio, fetchAudio } = renderPreview();

    act(() => result.current.toggle('t1'));
    expect(result.current.status).toBe('loading');
    expect(result.current.activeId).toBe('t1');

    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledWith('t1');
    expect(audio.src).toBe('https://storage.example/t1');
  });

  it('reports a failure, never throws, when the signed URL cannot be fetched', async () => {
    const fetchAudio = vi.fn(async () => {
      throw new Error('network down');
    });
    const { result } = renderPreview(fetchAudio);

    act(() => result.current.toggle('t1'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toEqual({
      transcriptId: 't1',
      message: expect.stringMatching(/could not be loaded/i),
    });
    // A failed row is left inactive, not stuck mid-load.
    expect(result.current.activeId).toBeNull();
  });
});

describe('useLibraryAudioPreview — pause and resume the same row', () => {
  it('pauses on a second press and resumes on a third, without refetching', async () => {
    const { result, audio, fetchAudio } = renderPreview();

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    act(() => result.current.toggle('t1'));
    expect(result.current.status).toBe('paused');
    expect(audio.paused).toBe(true);

    act(() => result.current.toggle('t1'));
    expect(result.current.status).toBe('playing');
    expect(audio.paused).toBe(false);

    // Cache hit both times — the round trip was spent once.
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });
});

describe('useLibraryAudioPreview — switching rows', () => {
  it('pauses the first row, makes the second active, and creates only one element', async () => {
    const { result, audio, createAudio, fetchAudio } = renderPreview();

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    act(() => result.current.toggle('t2'));
    await waitFor(() => expect(result.current.activeId).toBe('t2'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    expect(audio.src).toBe('https://storage.example/t2');
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    expect(fetchAudio).toHaveBeenNthCalledWith(1, 't1');
    expect(fetchAudio).toHaveBeenNthCalledWith(2, 't2');
  });
});

describe('useLibraryAudioPreview — recovering from a media error', () => {
  it('re-signs once and resumes, then fails on a second error without a third fetch', async () => {
    const first = audioInfo('https://storage.example/t1-a');
    const second = audioInfo('https://storage.example/t1-b');
    const fetchAudio = vi
      .fn<() => Promise<TranscriptAudio>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { result, audio } = renderPreview(fetchAudio);

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    audio.error = { code: 2 }; // MEDIA_ERR_NETWORK — not the codec case
    await act(async () => {
      audio.emit('error');
    });

    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    expect(audio.src).toBe(second.url);
    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(result.current.error).toBeNull();

    // The SECOND failure must not loop into a third fetch.
    await act(async () => {
      audio.emit('error');
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    expect(result.current.error?.transcriptId).toBe('t1');
    expect(result.current.activeId).toBeNull();
  });

  it('reports the codec-specific message for MediaError code 4', async () => {
    const fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1'));
    const { result, audio } = renderPreview(fetchAudio);

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    audio.error = { code: 4 }; // MEDIA_ERR_SRC_NOT_SUPPORTED
    await act(async () => {
      audio.emit('error'); // first attempt: recovers
    });
    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    await act(async () => {
      audio.emit('error'); // second attempt: gives up, with the codec wording
    });

    await waitFor(() =>
      expect(result.current.error?.message).toMatch(/cannot be played in this browser/i),
    );
  });

  it('reports a generic stopped message for any other MediaError code', async () => {
    const fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1'));
    const { result, audio } = renderPreview(fetchAudio);

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    audio.error = { code: 2 };
    await act(async () => {
      audio.emit('error');
    });
    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    await act(async () => {
      audio.emit('error');
    });

    await waitFor(() =>
      expect(result.current.error?.message).toMatch(/stopped and could not be resumed/i),
    );
  });
});

describe('useLibraryAudioPreview — a blocked play()', () => {
  it('surfaces the blocked-playback message when play() rejects', async () => {
    const audio = makeAudio();
    audio.play = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1'));
    const { result } = renderHook(() =>
      useLibraryAudioPreview({
        createAudio: () => audio as unknown as HTMLAudioElement,
        fetchAudio,
      }),
    );

    act(() => result.current.toggle('t1'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toEqual({
      transcriptId: 't1',
      message: expect.stringMatching(/blocked playback/i),
    });
  });
});

describe('useLibraryAudioPreview — the standing error', () => {
  it('carries the row it belongs to, and any subsequent toggle clears it', async () => {
    const fetchAudio = vi
      .fn<(id: string) => Promise<TranscriptAudio>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(audioInfo('https://storage.example/t2'));
    const { result } = renderPreview(fetchAudio);

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.error?.transcriptId).toBe('t1'));

    act(() => result.current.toggle('t2'));
    // Cleared synchronously by the press itself — before t2 has even loaded.
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(result.current.activeId).toBe('t2');
  });
});

describe('useLibraryAudioPreview — the loading guard', () => {
  it('ignores a pause fired by the load algorithm while the row is still loading', async () => {
    const audio = makeAudio();
    // Deliberately does not auto-fire its own `play` event — so the ONLY thing
    // that could move status off whatever the guarded pause left it at, before
    // this test fires `play` by hand, is the guard itself.
    audio.play = vi.fn(async () => {
      audio.paused = false;
    });
    const fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1'));
    const { result } = renderHook(() =>
      useLibraryAudioPreview({
        createAudio: () => audio as unknown as HTMLAudioElement,
        fetchAudio,
      }),
    );

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(audio.play).toHaveBeenCalled());

    // The `src` assignment inside `assign()` already fired the fake's `pause`
    // event while `status` was `loading` — if the guard were missing this
    // would already read `paused`, with nothing left to move it off that.
    expect(result.current.status).not.toBe('paused');

    act(() => audio.emit('play'));
    expect(result.current.status).toBe('playing');
  });
});

describe('useLibraryAudioPreview — unmount', () => {
  it('pauses the element, removes every listener, and drops its source', async () => {
    const { result, audio, unmount } = renderPreview();

    act(() => result.current.toggle('t1'));
    await waitFor(() => expect(result.current.status).toBe('playing'));

    unmount();

    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
    // play, pause, ended, error — the four listeners `ensureAudio` attaches.
    expect(audio.removeEventListener).toHaveBeenCalledTimes(4);
  });
});
