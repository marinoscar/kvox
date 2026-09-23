/**
 * `useSourceAudio` — a lazy, single-recording player for a note's source
 * recording (issue #309).
 *
 * The sibling of `useLibraryAudioPreview`, and deliberately built the same way
 * rather than extracted from it: the library hook's contract is "one element
 * shared by a list, always from the start", this one's is "one recording,
 * seekable, resumable". Sharing an implementation would have meant teaching the
 * library hook about seeking it must never do, so the library's behaviour (and
 * its tests) stay exactly as they were.
 *
 * What is carried over, on purpose:
 *
 *   • LAZY. `GET /api/transcripts/:id/audio` mints a signed URL, so it is called
 *     from `toggle`/`retry` and nowhere else. Rendering a note page never signs
 *     anything, and no `HTMLAudioElement` exists until the first press.
 *   • CACHED. A second press reuses the URL it already has.
 *   • RE-FETCHED ONCE. A media `error` during playback signs a fresh URL once
 *     and resumes from where the listener was; only the second failure is
 *     reported. Unlike the list, this page also knows the URL's `expiresAt`, so
 *     a press within a minute of it signs a fresh one up front rather than
 *     waiting to be told by a failed load.
 *   • NEVER THROWS. Every failure — a 404/409 from the signing call, a source
 *     the browser will not decode — becomes `status: 'error'` with a message
 *     the caller renders inline beside a Retry button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscriptAudio } from '../services/transcripts';
import type { TranscriptAudio } from '../services/transcripts';
import { useIsMounted } from './useIsMounted';

export type SourceAudioStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface SourceAudio {
  status: SourceAudioStatus;
  /** A short sentence to render inline when `status === 'error'`, else null. */
  error: string | null;
  /** Playback position, in milliseconds. */
  positionMs: number;
  /** The element's own duration once known, else null (fall back to the API's). */
  durationMs: number | null;
  /** Play (fetching the URL on the first press), or pause when playing. */
  toggle: () => void;
  /** Move the playhead. Before the first press it sets where playback starts. */
  seek: (ms: number) => void;
  /** Clear a failure and try again from the current position. */
  retry: () => void;
}

export interface SourceAudioOptions {
  /** Test seam. Production passes nothing and gets `new Audio()`. */
  createAudio?: () => HTMLAudioElement;
  /** Test seam. Production passes nothing and gets `getTranscriptAudio`. */
  fetchAudio?: (transcriptId: string) => Promise<TranscriptAudio>;
  /** Test seam for the expiry check. Defaults to `Date.now`. */
  now?: () => number;
}

/** A URL this close to its `expiresAt` is re-signed before use. */
export const SOURCE_AUDIO_EXPIRY_MARGIN_MS = 60_000;

/** The one sentence every failure renders as. */
export const SOURCE_AUDIO_UNAVAILABLE = 'Audio unavailable';

function isExpiring(info: TranscriptAudio, now: number): boolean {
  const expiresAt = Date.parse(info.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return now > expiresAt - SOURCE_AUDIO_EXPIRY_MARGIN_MS;
}

export function useSourceAudio(
  transcriptId: string,
  options: SourceAudioOptions = {},
): SourceAudio {
  // Seams read at call time, for `useLibraryAudioPreview`'s reason: an inline
  // function from the caller must not invalidate anything owning the element.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const isMounted = useIsMounted();

  const [status, setStatus] = useState<SourceAudioStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  const statusRef = useRef<SourceAudioStatus>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const infoRef = useRef<TranscriptAudio | null>(null);
  /** Has the current source already spent its one recovery attempt? */
  const retriedRef = useRef(false);
  /** Where the next source assignment should start, in ms. */
  const positionRef = useRef(0);

  const publish = useCallback((next: SourceAudioStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const fail = useCallback(() => {
    audioRef.current?.pause?.();
    infoRef.current = null;
    publish('error');
    setError(SOURCE_AUDIO_UNAVAILABLE);
  }, [publish]);

  const fetchInfo = useCallback((): Promise<TranscriptAudio> => {
    const fetcher = optionsRef.current.fetchAudio;
    return fetcher ? fetcher(transcriptId) : getTranscriptAudio(transcriptId);
  }, [transcriptId]);

  const startPlay = useCallback(
    (audio: HTMLAudioElement) => {
      const started = audio.play?.();
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          if (!isMounted()) return;
          // Almost always the autoplay policy after the awaited fetch; the URL
          // is cached now, so a second press reaches play() inside the gesture.
          if (statusRef.current === 'loading' || statusRef.current === 'playing') {
            publish('paused');
          }
        });
      }
    },
    [isMounted, publish],
  );

  /** Point the element at a signed URL, seek to `startMs`, and play. */
  const assign = useCallback(
    (audio: HTMLAudioElement, info: TranscriptAudio, startMs: number) => {
      publish('loading');
      infoRef.current = info;
      audio.src = info.url;
      audio.load?.();
      if (startMs > 0) {
        audio.addEventListener(
          'loadedmetadata',
          () => {
            audio.currentTime = startMs / 1000;
          },
          { once: true },
        );
      }
      startPlay(audio);
    },
    [publish, startPlay],
  );

  const loadAndPlay = useCallback(
    async (audio: HTMLAudioElement, startMs: number) => {
      publish('loading');
      try {
        const info = await fetchInfo();
        if (!isMounted() || audioRef.current !== audio) return;
        assign(audio, info, startMs);
      } catch {
        if (!isMounted()) return;
        fail();
      }
    },
    [assign, fail, fetchInfo, isMounted, publish],
  );

  const ensureAudio = useCallback((): HTMLAudioElement | null => {
    if (audioRef.current) return audioRef.current;
    const factory = optionsRef.current.createAudio;
    if (!factory && typeof Audio === 'undefined') return null;

    const audio = factory ? factory() : new Audio();
    audio.preload = 'none';

    const onPlay = () => {
      if (statusRef.current === 'error') return;
      publish('playing');
    };
    const onPause = () => {
      // The load algorithm fires `pause` when a src is reassigned; a starting
      // or failed player must not be repainted by it.
      if (statusRef.current === 'loading' || statusRef.current === 'error') return;
      publish('paused');
    };
    const onEnded = () => publish('paused');
    const onTime = () => {
      if (!Number.isFinite(audio.currentTime)) return;
      const ms = audio.currentTime * 1000;
      positionRef.current = ms;
      setPositionMs(ms);
    };
    const onDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDurationMs(audio.duration * 1000);
      }
    };
    const onError = () => {
      if (statusRef.current === 'error' || !infoRef.current) return;
      if (!retriedRef.current) {
        retriedRef.current = true;
        infoRef.current = null;
        const resumeMs = Number.isFinite(audio.currentTime)
          ? Math.max(audio.currentTime * 1000, positionRef.current)
          : positionRef.current;
        void loadAndPlay(audio, resumeMs);
        return;
      }
      fail();
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('error', onError);
    disposeRef.current = () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onDuration);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('error', onError);
    };

    audioRef.current = audio;
    return audio;
  }, [fail, loadAndPlay, publish]);

  const toggle = useCallback(() => {
    if (statusRef.current === 'loading') return;
    const audio = ensureAudio();
    if (!audio) {
      fail();
      return;
    }

    if (statusRef.current === 'playing' && !audio.paused) {
      audio.pause();
      return;
    }

    setError(null);
    const info = infoRef.current;
    const now = (optionsRef.current.now ?? Date.now)();
    if (info && !isExpiring(info, now)) {
      if (statusRef.current === 'error') publish('paused');
      startPlay(audio);
      return;
    }

    // First press, or a URL about to lapse: sign a fresh one and resume from
    // wherever the listener was. A fresh source earns a fresh recovery attempt.
    retriedRef.current = false;
    const resumeMs =
      info && Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : positionRef.current;
    void loadAndPlay(audio, resumeMs);
  }, [ensureAudio, fail, loadAndPlay, publish, startPlay]);

  const retry = useCallback(() => {
    infoRef.current = null;
    publish('idle');
    setError(null);
    toggle();
  }, [publish, toggle]);

  const seek = useCallback((ms: number) => {
    const clamped = Math.max(0, Number.isFinite(ms) ? ms : 0);
    positionRef.current = clamped;
    setPositionMs(clamped);
    const audio = audioRef.current;
    if (audio && infoRef.current) {
      audio.currentTime = clamped / 1000;
    }
  }, []);

  useEffect(
    () => () => {
      disposeRef.current?.();
      disposeRef.current = null;
      const audio = audioRef.current;
      audio?.pause?.();
      // Dropped, not merely paused: a paused element with a live src keeps
      // buffering after the page is gone.
      audio?.removeAttribute?.('src');
      audioRef.current = null;
    },
    [],
  );

  return useMemo(
    () => ({ status, error, positionMs, durationMs, toggle, seek, retry }),
    [durationMs, error, positionMs, retry, seek, status, toggle],
  );
}

export default useSourceAudio;
