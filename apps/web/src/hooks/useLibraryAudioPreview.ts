/**
 * `useLibraryAudioPreview` — one `HTMLAudioElement` for a whole list of rows.
 *
 * Issue #98, epic #19. The library's Transcripts tab grew a per-row Play
 * control so a recording can be heard without opening it; this hook is what
 * makes fifty of those controls behave like one player.
 *
 * =============================================================================
 * ONE ELEMENT OWNED BY THE LIST, NOT ONE PER ROW
 * =============================================================================
 *
 * "Exactly one row plays at a time" is the requirement, and there are two ways
 * to get it. A `<audio>` per row plus a rule that each row pauses the others is
 * a rule — something every future row variant has to remember, and something
 * that is silently wrong the moment a row unmounts mid-playback (a filter
 * change, a page of results appended) and its element keeps buffering with
 * nothing on screen able to stop it. One element owned by the list is a
 * STRUCTURE: starting row B assigns B's source to the same element, which is
 * what stopping row A physically consists of. There is no rule to forget.
 *
 * It also settles the cost question. `preload` is `'none'` and no element even
 * exists until the first press, so a list of fifty rows costs one signed URL
 * when somebody asks for one and zero otherwise.
 *
 * =============================================================================
 * THE SIGNED URL IS FETCHED ON PRESS, CACHED PER ROW, AND RE-FETCHED ONCE
 * =============================================================================
 *
 * `GET /:id/audio` mints a six-hour signed URL, so:
 *
 *   • It is called from `toggle` and nowhere else. Rendering a row must never
 *     mint one — fifty rows would be fifty signatures for audio nobody asked
 *     to hear.
 *   • The answer is cached per transcript, so pause/resume and a second press
 *     on a row heard earlier cost nothing. The cache is deliberately NOT given
 *     a TTL of its own: the expiry we would be guessing at is already reported
 *     authoritatively, by the element failing to play.
 *   • A media `error` therefore refetches ONCE before giving up — the same
 *     recovery, and the same one-attempt guard, `usePlaybackEngine` documents
 *     for the viewer. A list left open all day is exactly where a six-hour TTL
 *     runs out, and "press play, get an error, press play again and it works"
 *     is a worse experience than the retry nobody sees.
 *
 * Only the SECOND failure is reported, and its wording is chosen from
 * `MediaError.code` — a source the browser refuses to decode is a different
 * sentence from a stream that died, and telling a user to try again when the
 * file's codec is the problem is telling them to do something that cannot work.
 *
 * =============================================================================
 * ONE ERROR AT A TIME, ON THE ROW IT HAPPENED TO
 * =============================================================================
 *
 * `error` carries the transcript id, so the list renders it inline on that row
 * rather than as a page-level banner about a transcript the reader may have to
 * scroll to find. It is a single value rather than a map because a press —
 * anywhere in the list — clears it: the message describes the last attempt, and
 * keeping older rows' failures on screen after the user has moved on would
 * leave a list of stale complaints nothing ever removes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscriptAudio } from '../services/transcripts';
import type { TranscriptAudio } from '../services/transcripts';
import { useIsMounted } from './useIsMounted';

/**
 * What one row's control is doing.
 *
 * `loading` is the signed URL being minted — a state the button has to show,
 * because on a cold row it is a network round trip between the press and the
 * first sound.
 */
export type AudioPreviewState = 'idle' | 'loading' | 'playing' | 'paused';

export interface AudioPreviewFailure {
  /** The row the message belongs to. */
  transcriptId: string;
  /** A short sentence the row renders inline. Never empty. */
  message: string;
}

export interface LibraryAudioPreview {
  /** The row the shared element currently holds, or null when nothing does. */
  activeId: string | null;
  /** What `activeId` is doing. `idle` whenever `activeId` is null. */
  status: AudioPreviewState;
  /** The last failure, and which row to render it on. */
  error: AudioPreviewFailure | null;
  /** Play this row, or pause it when it is already the one playing. */
  toggle: (transcriptId: string) => void;
  /** Stop and forget the active row — what a row leaving the list means. */
  stop: () => void;
}

export interface LibraryAudioPreviewOptions {
  /** Test seam. Production passes nothing and gets `new Audio()`. */
  createAudio?: () => HTMLAudioElement;
  /** Test seam. Production passes nothing and gets `getTranscriptAudio`. */
  fetchAudio?: (transcriptId: string) => Promise<TranscriptAudio>;
}

/** `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED`, spelled out for the comparison. */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** The URL could not be signed at all — the API call itself failed. */
const LOAD_MESSAGE = 'That recording could not be loaded.';

/** Two attempts at a source the browser will not decode. */
const FORMAT_MESSAGE = 'This recording cannot be played in this browser.';

/** Two attempts, and the second one died too. */
const STOPPED_MESSAGE = 'Playback stopped and could not be resumed.';

/**
 * `play()` was rejected.
 *
 * Almost always the autoplay policy rather than the media: the signed-URL fetch
 * puts an `await` between the click and the call, and Safari in particular no
 * longer counts that as a user gesture. The URL is cached by the time this is
 * read, so the second press reaches `play()` synchronously inside the gesture —
 * which is exactly what the sentence asks for.
 */
const BLOCKED_MESSAGE = 'The browser blocked playback. Press play again.';

export function useLibraryAudioPreview(
  options: LibraryAudioPreviewOptions = {},
): LibraryAudioPreview {
  const { createAudio, fetchAudio } = options;

  /**
   * Both seams live in refs and are read at CALL time, for the reason
   * `usePlaybackEngine` states about its own: a caller passing an inline
   * function must not be able to invalidate anything that owns the element.
   */
  const createAudioRef = useRef(createAudio);
  createAudioRef.current = createAudio;
  const fetchAudioRef = useRef(fetchAudio);
  fetchAudioRef.current = fetchAudio;

  const isMounted = useIsMounted();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioPreviewState>('idle');
  const [error, setError] = useState<AudioPreviewFailure | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Removes every listener the element was created with. */
  const disposeRef = useRef<(() => void) | null>(null);

  /**
   * Three refs that look like duplicates of the state above and are not.
   *
   * The media events fire from the browser, outside React's render cycle, and
   * each one has to answer "is this still the row the user is on?" against the
   * value as of NOW rather than as of the render that attached the listener.
   *
   * `activeIdRef` is the row the USER chose; `sourceIdRef` is the row whose URL
   * is actually assigned to the element. They differ for exactly as long as a
   * fetch is in flight, and telling them apart is what stops a `pause` event
   * queued while switching rows from landing on the new row's state.
   */
  const activeIdRef = useRef<string | null>(null);
  const sourceIdRef = useRef<string | null>(null);
  const statusRef = useRef<AudioPreviewState>('idle');

  /** Transcript id → the signed URL last minted for it. See the file header. */
  const urlsRef = useRef(new Map<string, TranscriptAudio>());
  /** Has the CURRENT source already spent its one recovery attempt? */
  const retriedRef = useRef(false);

  const publish = useCallback((next: AudioPreviewState) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** Back to "nothing is playing", without touching the failure message. */
  const clearActive = useCallback(() => {
    activeIdRef.current = null;
    // The element keeps its `src` — dropping it here would fire a second
    // `error` for a source we have already stopped caring about — but nothing
    // answers to it any more, which is what this null means.
    sourceIdRef.current = null;
    setActiveId(null);
    publish('idle');
  }, [publish]);

  const fail = useCallback(
    (transcriptId: string, message: string) => {
      audioRef.current?.pause?.();
      // The cached URL goes with the failure: whatever the next attempt is, it
      // should not begin by reusing the signature that just did not work.
      urlsRef.current.delete(transcriptId);
      clearActive();
      setError({ transcriptId, message });
    },
    [clearActive],
  );

  /**
   * Point the element at a signed URL and start it.
   *
   * `publish('loading')` FIRST, and not as decoration: assigning `src` to a
   * playing element runs the media load algorithm, which fires `pause`. The
   * `pause` handler ignores the loading state precisely so that event cannot
   * repaint a row that is in the middle of starting.
   */
  const assign = useCallback(
    (transcriptId: string, info: TranscriptAudio, resumeMs: number) => {
      const audio = audioRef.current;
      if (!audio) return;

      publish('loading');
      sourceIdRef.current = transcriptId;
      audio.src = info.url;
      audio.load?.();

      if (resumeMs > 0) {
        // `loadedmetadata`, not `canplay`: seeking is legal as soon as the
        // duration is known, and waiting longer shows a visible jump back to
        // the start of a recovery the listener was not supposed to notice.
        audio.addEventListener(
          'loadedmetadata',
          () => {
            audio.currentTime = resumeMs / 1000;
          },
          { once: true },
        );
      }

      const started = audio.play?.();
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          if (!isMounted()) return;
          // Only for the source still assigned: a rejection that arrives after
          // the user has moved to another row is about a row nobody is on.
          if (sourceIdRef.current !== transcriptId) return;
          fail(transcriptId, BLOCKED_MESSAGE);
        });
      }
    },
    [fail, isMounted, publish],
  );

  /** Sign a fresh URL for a source that died, and pick the listener back up. */
  const recover = useCallback(
    async (transcriptId: string, resumeMs: number) => {
      retriedRef.current = true;
      urlsRef.current.delete(transcriptId);

      try {
        const fetcher = fetchAudioRef.current;
        const info = await (fetcher ? fetcher(transcriptId) : getTranscriptAudio(transcriptId));
        urlsRef.current.set(transcriptId, info);
        if (!isMounted() || activeIdRef.current !== transcriptId) return;
        assign(transcriptId, info, resumeMs);
      } catch {
        if (!isMounted() || activeIdRef.current !== transcriptId) return;
        fail(transcriptId, STOPPED_MESSAGE);
      }
    },
    [assign, fail, isMounted],
  );

  /**
   * Create the element on the first press, with every listener it needs.
   *
   * Never called from render — see the file header. Returns null in an
   * environment with no `Audio` constructor, so a server render or a test that
   * has not provided the seam degrades to a control that reports a failure
   * rather than throwing through a click handler.
   */
  const ensureAudio = useCallback((): HTMLAudioElement | null => {
    if (audioRef.current) return audioRef.current;

    const factory = createAudioRef.current;
    if (!factory && typeof Audio === 'undefined') return null;

    const audio = factory ? factory() : new Audio();
    // Nothing is fetched until a `src` is assigned, which is the whole point of
    // a lazy preview: the element exists, the bytes do not.
    audio.preload = 'none';

    const onPlay = () => {
      if (sourceIdRef.current === null) return;
      if (activeIdRef.current !== sourceIdRef.current) return;
      publish('playing');
    };
    const onPause = () => {
      // See `assign`: a `pause` fired by the load algorithm must not repaint a
      // row that is starting, and one fired while switching rows belongs to the
      // row being left, not the one being joined.
      if (statusRef.current === 'loading') return;
      if (sourceIdRef.current === null) return;
      if (activeIdRef.current !== sourceIdRef.current) return;
      publish('paused');
    };
    const onEnded = () => {
      if (activeIdRef.current !== sourceIdRef.current) return;
      // Left `paused` rather than reset to idle: the row stays the active one,
      // and the spec rewinds a finished element on the next `play()`, so the
      // button the user is looking at does the obvious thing when pressed.
      publish('paused');
    };
    const onError = () => {
      const transcriptId = sourceIdRef.current;
      if (!transcriptId || activeIdRef.current !== transcriptId) return;

      if (!retriedRef.current) {
        const resumeMs = Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0;
        void recover(transcriptId, resumeMs);
        return;
      }

      const code = audio.error?.code ?? 0;
      fail(
        transcriptId,
        code === MEDIA_ERR_SRC_NOT_SUPPORTED ? FORMAT_MESSAGE : STOPPED_MESSAGE,
      );
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    disposeRef.current = () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };

    audioRef.current = audio;
    return audio;
  }, [fail, publish, recover]);

  const toggle = useCallback(
    (transcriptId: string) => {
      // Any press clears the standing message — including the press that is
      // about to fail again, which then writes a fresh one.
      setError(null);

      const audio = ensureAudio();
      if (!audio) {
        setError({ transcriptId, message: LOAD_MESSAGE });
        return;
      }

      if (activeIdRef.current === transcriptId) {
        // A press while the URL is still being signed is ignored on purpose:
        // the button is already showing a busy state, and the alternative —
        // cancelling a signature we are about to need — buys nothing.
        if (statusRef.current === 'loading') return;
        if (audio.paused) {
          const started = audio.play?.();
          if (started && typeof started.catch === 'function') {
            started.catch(() => {
              if (!isMounted() || sourceIdRef.current !== transcriptId) return;
              fail(transcriptId, BLOCKED_MESSAGE);
            });
          }
        } else {
          audio.pause();
        }
        return;
      }

      // Starting a second row stops the first. One element, so this IS the
      // stopping — see the file header.
      audio.pause();
      activeIdRef.current = transcriptId;
      setActiveId(transcriptId);
      retriedRef.current = false;

      const cached = urlsRef.current.get(transcriptId);
      if (cached) {
        // From the start, not from wherever this row was left: a preview is a
        // few seconds of "what is this recording", and resuming a row the user
        // last touched ten minutes ago in the middle of a word is not that.
        assign(transcriptId, cached, 0);
        return;
      }

      publish('loading');
      void (async () => {
        try {
          const fetcher = fetchAudioRef.current;
          const info = await (fetcher
            ? fetcher(transcriptId)
            : getTranscriptAudio(transcriptId));
          // Cached even when the user has already moved on — the round trip is
          // spent either way, and the next press on this row should be free.
          urlsRef.current.set(transcriptId, info);
          if (!isMounted() || activeIdRef.current !== transcriptId) return;
          assign(transcriptId, info, 0);
        } catch {
          if (!isMounted() || activeIdRef.current !== transcriptId) return;
          fail(transcriptId, LOAD_MESSAGE);
        }
      })();
    },
    [assign, ensureAudio, fail, isMounted, publish],
  );

  const stop = useCallback(() => {
    audioRef.current?.pause?.();
    clearActive();
    // The message described a row that is no longer on screen; leaving it
    // behind would attach it to whatever row scrolls into its place.
    setError(null);
  }, [clearActive]);

  useEffect(
    () => () => {
      disposeRef.current?.();
      disposeRef.current = null;
      const audio = audioRef.current;
      audio?.pause?.();
      // Dropped rather than merely paused, for `usePlaybackEngine`'s reason: a
      // paused element with a live `src` keeps buffering, and one left behind
      // per navigation is how a long session ends up holding hours of audio.
      audio?.removeAttribute?.('src');
      audioRef.current = null;
    },
    [],
  );

  return useMemo(
    () => ({ activeId, status, error, toggle, stop }),
    [activeId, error, status, stop, toggle],
  );
}

export default useLibraryAudioPreview;
