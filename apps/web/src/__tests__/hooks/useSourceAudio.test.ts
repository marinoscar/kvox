import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  useSourceAudio,
  SOURCE_AUDIO_EXPIRY_MARGIN_MS,
  SOURCE_AUDIO_UNAVAILABLE,
} from '../../hooks/useSourceAudio';
import { ApiError } from '../../services/api';
import type { TranscriptAudio } from '../../services/transcripts';

/**
 * `useSourceAudio` (issue #309) — the lazy, single-recording player behind a
 * note's source-recording card. Against a hand-rolled fake media element, for
 * the same reason `useLibraryAudioPreview.test.tsx` gives for its own: jsdom's
 * `HTMLAudioElement` implements the shape and none of the behaviour the hook
 * reasons about.
 *
 * ONE DELIBERATE PIECE OF REALISM, carried over from that sibling suite:
 * assigning `.src` fires a synchronous `pause` event, matching the load
 * algorithm the hook's own header describes.
 */
class FakeAudio {
  currentTime = 0;
  paused = true;
  preload = '';
  duration = NaN;
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
      // hook has already published `loading`.
      audio.emit('pause');
    },
  });
  return audio;
}

function audioInfo(url: string, overrides: Partial<TranscriptAudio> = {}): TranscriptAudio {
  return {
    url,
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function renderSource(
  fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1')),
  audio: FakeAudio = makeAudio(),
  now?: () => number,
) {
  const createAudio = vi.fn(() => audio as unknown as HTMLAudioElement);
  const rendered = renderHook(() =>
    useSourceAudio('t1', { createAudio, fetchAudio, ...(now ? { now } : {}) }),
  );
  return { ...rendered, audio, createAudio, fetchAudio };
}

describe('useSourceAudio — before the first press', () => {
  it('creates no element and fetches nothing', () => {
    const { createAudio, fetchAudio, result } = renderSource();

    expect(createAudio).not.toHaveBeenCalled();
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.positionMs).toBe(0);
    expect(result.current.durationMs).toBeNull();
  });
});

describe('useSourceAudio — the first toggle', () => {
  it('fetches exactly once, assigns the URL, and plays', async () => {
    const { result, audio, fetchAudio, createAudio } = renderSource();

    act(() => result.current.toggle());
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(fetchAudio).toHaveBeenCalledWith('t1');
    expect(audio.src).toBe('https://storage.example/t1');
  });
});

describe('useSourceAudio — pause and resume', () => {
  it('pauses on a second press and plays on a third, without refetching', async () => {
    const { result, audio, fetchAudio } = renderSource();

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('playing'));

    act(() => result.current.toggle());
    expect(result.current.status).toBe('paused');
    expect(audio.paused).toBe(true);

    act(() => result.current.toggle());
    expect(result.current.status).toBe('playing');
    expect(audio.paused).toBe(false);

    // Cache hit both times.
    expect(fetchAudio).toHaveBeenCalledTimes(1);
  });
});

describe('useSourceAudio — near-expiry', () => {
  it('re-signs before use when the cached URL is about to lapse, and resumes from currentTime', async () => {
    const first = audioInfo('https://storage.example/t1-a', {
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const second = audioInfo('https://storage.example/t1-b');
    const fetchAudio = vi
      .fn<() => Promise<TranscriptAudio>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const audio = makeAudio();

    // `now` starts well before expiry, then jumps to inside the margin.
    let now = Date.now();
    const { result } = renderSource(fetchAudio, audio, () => now);

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    // Pause, then move the clock inside the expiry margin and simulate elapsed
    // playback the resume must carry forward.
    act(() => result.current.toggle());
    expect(result.current.status).toBe('paused');
    audio.currentTime = 42;
    now = Date.parse(first.expiresAt) - SOURCE_AUDIO_EXPIRY_MARGIN_MS + 1;

    act(() => result.current.toggle());
    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    expect(audio.src).toBe(second.url);
    await waitFor(() => expect(result.current.status).toBe('playing'));
  });
});

describe('useSourceAudio — recovering from a media error', () => {
  it('re-signs once and resumes, then fails on a second error without a third fetch', async () => {
    const first = audioInfo('https://storage.example/t1-a');
    const second = audioInfo('https://storage.example/t1-b');
    const fetchAudio = vi
      .fn<() => Promise<TranscriptAudio>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { result, audio } = renderSource(fetchAudio);

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('playing'));

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

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe(SOURCE_AUDIO_UNAVAILABLE);
  });
});

describe('useSourceAudio — a signing failure', () => {
  it('reports status error without throwing, on a rejected fetch (e.g. a 404)', async () => {
    const fetchAudio = vi.fn(async () => {
      throw new ApiError('Not found', 404, 'NOT_FOUND');
    });
    const { result } = renderSource(fetchAudio);

    expect(() => act(() => result.current.toggle())).not.toThrow();

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(SOURCE_AUDIO_UNAVAILABLE);
  });

  it('recovers via retry()', async () => {
    const fetchAudio = vi
      .fn<() => Promise<TranscriptAudio>>()
      .mockRejectedValueOnce(new ApiError('Not found', 404))
      .mockResolvedValueOnce(audioInfo('https://storage.example/t1'));
    const { result } = renderSource(fetchAudio);

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('error'));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('playing'));
    expect(result.current.error).toBeNull();
    expect(fetchAudio).toHaveBeenCalledTimes(2);
  });
});

describe('useSourceAudio — a blocked play()', () => {
  it('falls back to paused when play() rejects', async () => {
    const audio = makeAudio();
    audio.play = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const fetchAudio = vi.fn(async () => audioInfo('https://storage.example/t1'));
    const { result } = renderHook(() =>
      useSourceAudio('t1', { createAudio: () => audio as unknown as HTMLAudioElement, fetchAudio }),
    );

    act(() => result.current.toggle());

    await waitFor(() => expect(result.current.status).toBe('paused'));
  });
});

describe('useSourceAudio — seeking before playback', () => {
  it('sets the start position before the first press', () => {
    const { result } = renderSource();

    act(() => result.current.seek(15_000));

    expect(result.current.positionMs).toBe(15_000);
  });
});

describe('useSourceAudio — unmount', () => {
  it('pauses the element and clears its source', async () => {
    const { result, audio, unmount } = renderSource();

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.status).toBe('playing'));

    unmount();

    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
  });
});
