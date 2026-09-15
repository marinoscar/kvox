/**
 * `usePlaybackEngine` — one `HTMLAudioElement`, driven by segment intervals.
 *
 * Issue #30, epic #19; the design is `docs/specs/transcription.md` §7.2–7.3 and
 * that section is the authority for every number in this file.
 *
 * =============================================================================
 * ONE STREAM, NOT A PLAYLIST
 * =============================================================================
 *
 * "Play only this speaker" is implemented as **skipping** on a single stream:
 * the selected speakers' segments become a sorted, merged list of intervals,
 * and the engine seeks past everything between them. The rejected alternative —
 * slicing per-segment clips and playing them as a playlist — needs server-side
 * slicing and roughly doubles storage for every transcript, to produce audio the
 * listener cannot distinguish from this.
 *
 * =============================================================================
 * TWO CLOCKS, BECAUSE A BACKGROUNDED TAB HAS NO FRAMES
 * =============================================================================
 *
 * While the page is visible, a `requestAnimationFrame` loop checks the position
 * against the current interval's end on every frame. Frame-rate resolution
 * matters here in a way it rarely does: merging closes gaps below 300 ms, so a
 * boundary crossed even a hundred milliseconds late is an audible fragment of
 * the NEXT speaker's actual word.
 *
 * When the tab is hidden, Chrome and Safari stop firing `rAF` entirely — audio
 * keeps playing, the loop does not — so the engine falls back to the
 * `timeupdate` media event, whose spec-minimum firing interval is about 250 ms.
 * The overshoot past a boundary is therefore **up to roughly 250 ms while
 * backgrounded**, and that is documented, bounded and deliberate: a user who
 * backgrounds the app to read a notification should not lose per-speaker
 * filtering altogether, and "occasionally plays a quarter-second of someone
 * else" is a far better failure than "silently plays the whole recording".
 *
 * `handleTick` is the ONE function both clocks call. Two copies of the boundary
 * logic — one per clock — is exactly how the foreground and background paths
 * would drift apart, and the background one is the copy nobody is watching.
 *
 * =============================================================================
 * WHAT IS AND IS NOT REACT STATE
 * =============================================================================
 *
 * The position is read from the element sixty times a second. Putting that in
 * state unthrottled would re-render the viewer — including a virtualized list
 * of up to 6,000 segments — on every frame. So:
 *
 *   • `positionMs` is published at ~4 Hz (`POSITION_PUBLISH_MS`), which is finer
 *     than a scrubber can show and coarser than a render budget cares about.
 *   • `currentSegmentIndex` is published ONLY when the binary search's answer
 *     changes, which is a few times a minute.
 *   • Everything the loop reads (intervals, the selection, the element) lives in
 *     refs, so the loop is built once and never torn down by a re-render.
 *
 * =============================================================================
 * PLAYING ONE LINE — `playSegment` (issue #108)
 * =============================================================================
 *
 * Every transcript row carries a play/pause button that plays THAT LINE and
 * stops at its end. That is a second, temporary mode layered over the single
 * stream above, and the rules it follows are all consequences of one idea: the
 * user pointed at a specific line, so nothing may quietly move them off it.
 *
 *   • The speaker filter is BYPASSED while segment mode is active. `seekToMs`
 *     snaps out of any window the filter excludes, so routing this through it
 *     would make "play this line" do nothing at all on a line whose speaker is
 *     filtered out — the one case where a user most obviously wants to hear it.
 *     `playSegment` therefore writes `currentTime` directly.
 *   • At `endMs` the engine pauses ON the boundary — the same parking rule the
 *     interval branch uses for the last window's end — so the scrubber, the
 *     highlighted line and the audio all agree about where it stopped. The
 *     NEXT ordinary Play goes through `seekToMs` and so snaps per the filter
 *     again, exactly as before.
 *
 *     ⚠ With one documented exception, which falls out of the loop rather than
 *     out of segment mode: when a speaker filter is active AND that boundary
 *     lies outside every one of its windows (playing a filtered-out speaker's
 *     LAST line), the interval branch resumes on the very next tick — segment
 *     mode has just been cleared — and pulls the playhead back to the nearest
 *     position the selection allows. That is the filter reasserting itself, and
 *     it is the better of the two available answers: the alternative is leaving
 *     the playhead parked somewhere the next Press of Play would jump away from
 *     anyway, with nothing on screen explaining the jump.
 *   • Scrubbing, skipping, tapping a timestamp, previous/next segment, Space
 *     and the transport's own buttons ALL end segment mode. They each reach
 *     `seekToMs` or `pause`, which is where the clearing lives, rather than
 *     each carrying their own copy of it.
 *   • A Media Session `play` from the lock screen resumes ORDINARY playback,
 *     because it goes through `play` → `seekToMs`. That is documented rather
 *     than special-cased: a hardware key has no way to express "and stay inside
 *     the one line", and resuming the recording is the less surprising of the
 *     two possible answers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscriptAudio } from '../services/transcripts';
import type { TranscriptAudio, TranscriptSegment } from '../services/transcripts';
import {
  buildIntervals,
  findSegmentIndexAt,
  intervalIndexAt,
  nextIntervalIndexFrom,
  resolveSeekTarget,
  toMs,
  toSeconds,
  type PlaybackInterval,
} from '../utils/playbackIntervals';

/** How often the position is published to React. See the file header. */
export const POSITION_PUBLISH_MS = 250;

/**
 * The ±skip the in-app buttons and the Media Session handlers both use.
 *
 * TEN, not fifteen (issue #108). MUI ships only `Replay`/`Forward` 5, 10 and 30
 * — there is no 15 — so the bar has always DRAWN a "10" while its accessible
 * names said "15 seconds". A sighted user and a screen-reader user were being
 * told different things about the same button, and the labels were the half
 * that was wrong: the icon is the one of the two that cannot be corrected
 * without inventing an asset.
 */
export const SKIP_MS = 10_000;

/** The speeds the player offers. 2× is the ceiling browsers keep intelligible. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/**
 * What the engine can be doing, as one value the page switches on.
 *
 * `preparing` is NOT an error and must not render as one: it means the playback
 * rendition is still being produced and the original is a format this browser
 * will not play. The transcript itself may be perfectly readable.
 */
export type PlaybackEngineStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'preparing'
  | 'error';

export interface PlaybackEngineOptions {
  transcriptId: string | undefined;
  /**
   * The transcript's segments, in reading order.
   *
   * ⚠ Assumed sorted by `startMs` — `findSegmentIndexAt` binary-searches them
   * and returns an index INTO THIS ARRAY, so it cannot sort a copy. The API
   * returns them in reading order and `ordinal` is what makes reading order
   * and time order agree.
   */
  segments: TranscriptSegment[];
  /** Restrict playback to these speakers. Empty means "no filter". */
  selectedSpeakerIds: readonly string[];
  /** Shown on the lock screen. */
  title: string;
  /** Resolves a segment's speaker id to a display name, for Media Session. */
  speakerName?: (speakerId: string) => string;
  /**
   * Whether a purpose-built, seekable rendition exists yet.
   *
   * Used ONLY to decide whether an unplayable original means "preparing" or
   * "this file is broken" — the URL itself always comes from `GET /:id/audio`,
   * which makes that choice server-side.
   */
  playbackReady?: boolean;
  /** Test seam. Production passes nothing and gets `new Audio()`. */
  createAudio?: () => HTMLAudioElement;
  /** Test seam. Production passes nothing and gets `getTranscriptAudio`. */
  fetchAudio?: (transcriptId: string) => Promise<TranscriptAudio>;
}

export interface PlaybackEngine {
  status: PlaybackEngineStatus;
  /** A sentence the player renders when `status === 'error'`. */
  error: string | null;
  isPlaying: boolean;
  /** Current position, milliseconds, published at ~4 Hz. */
  positionMs: number;
  /** Media duration in milliseconds, or 0 before metadata has loaded. */
  durationMs: number;
  rate: PlaybackRate;
  /** Index into `segments`, or -1 between segments. */
  currentSegmentIndex: number;
  /** The merged, sorted windows playback is restricted to. Empty = unfiltered. */
  intervals: PlaybackInterval[];
  /** Which file is playing — `original` means the rendition was not ready. */
  audioKind: TranscriptAudio['kind'] | null;
  /**
   * The segment currently being played in ISOLATION (issue #108), or null.
   *
   * Distinct from `currentSegmentIndex`, which is "whatever the playhead is
   * over" and keeps updating during ordinary playback. This one is non-null
   * only while a row's own play button is driving the element, which is what
   * lets exactly one row render a Pause icon.
   */
  activeSegmentId: string | null;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  /** Seek, snapping forward out of a skipped gap when a filter is active. */
  seekToMs: (ms: number) => void;
  /** Seek AND play — what tapping a timestamp does. */
  playFromMs: (ms: number) => void;
  skip: (deltaMs: number) => void;
  setRate: (rate: PlaybackRate) => void;
  /** Jump to the previous/next segment. Also the hardware media keys (§7.3). */
  previousSegment: () => void;
  nextSegment: () => void;
  /**
   * Play THIS line and stop at its end (issue #108).
   *
   * Takes the three fields it needs rather than a whole `TranscriptSegment`, so
   * a caller holding a projection (a search result, a preview row) can drive it
   * without manufacturing text and revisions it does not have.
   */
  playSegment: (segment: Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>) => void;
}

/** `navigator.mediaSession`, or null where the browser has none. */
function mediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession ?? null;
}

export function usePlaybackEngine(options: PlaybackEngineOptions): PlaybackEngine {
  const {
    transcriptId,
    segments,
    selectedSpeakerIds,
    title,
    speakerName,
    playbackReady = true,
    createAudio,
    fetchAudio,
  } = options;

  const [status, setStatus] = useState<PlaybackEngineStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [rate, setRateState] = useState<PlaybackRate>(1);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [audioKind, setAudioKind] = useState<TranscriptAudio['kind'] | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);

  /**
   * The three injectables, held in refs and read at CALL time.
   *
   * ⚠ NOT effect dependencies, and that is load-bearing rather than tidy. The
   * effect below CREATES the media element; anything in its dependency list is
   * therefore something that can tear the element down and rebuild it. A caller
   * that passes an inline `fetchAudio`, or whose `playbackReady` flips from
   * false to true when the transcode finishes, would otherwise destroy the
   * element mid-listen — pausing the audio, losing the position, and re-signing
   * a URL for no reason. The element's lifetime is tied to ONE thing, the
   * transcript id, because that is the only input that genuinely means "this is
   * different audio".
   *
   * The `preparing` → `ready` transition that `playbackReady` used to force
   * through this effect is handled by its own effect further down, which
   * reloads the SOURCE without discarding the element.
   */
  const createAudioRef = useRef(createAudio);
  createAudioRef.current = createAudio;
  const fetchAudioRef = useRef(fetchAudio);
  fetchAudioRef.current = fetchAudio;
  const playbackReadyRef = useRef(playbackReady);
  playbackReadyRef.current = playbackReady;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** The last position published to React, so `handleTick` can throttle. */
  const publishedPositionRef = useRef(0);
  const segmentIndexRef = useRef(-1);
  /**
   * Guards the expired-URL recovery against becoming a loop.
   *
   * A media error that is NOT an expired URL (a truncated object, a codec the
   * browser rejected mid-stream) produces the same `error` event, and refetching
   * a fresh signed URL for the same broken file fails identically. One attempt
   * per source turns an infinite refetch loop into a single retry and then an
   * honest error.
   */
  const recoveringRef = useRef(false);
  /**
   * The line being played in isolation, and where to stop (issue #108).
   *
   * A REF as well as state because `handleTick` reads it sixty times a second
   * and must not be rebuilt when it changes — the same reason the intervals and
   * the segments live in refs. The state is the render-visible copy.
   */
  const segmentPlayRef = useRef<{ id: string; stopAtMs: number } | null>(null);

  /**
   * Leave segment mode.
   *
   * ⚠ The state is only touched when the ref was actually set. Every ordinary
   * seek calls this, and an unconditional `setActiveSegmentId(null)` would
   * therefore queue a state update on every scrub, skip and timestamp tap — a
   * re-render of a 6,000-row virtualized list for a value that was already
   * null. Empty dependency list, so `seekToMs`'s own list does not churn.
   */
  const clearSegmentPlay = useCallback(() => {
    if (segmentPlayRef.current === null) return;
    segmentPlayRef.current = null;
    setActiveSegmentId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // The intervals
  // ---------------------------------------------------------------------------

  /**
   * `selectedSpeakerIds` arrives as a fresh array on most renders (a page
   * building it from state), so it is joined into a string for the dependency
   * list: the intervals must be rebuilt when the SELECTION changes, not when
   * its container identity does.
   */
  const selectionKey = [...selectedSpeakerIds].sort().join(',');

  const intervals = useMemo(() => {
    if (selectedSpeakerIds.length === 0) return [];
    const selected = new Set(selectedSpeakerIds);
    return buildIntervals(segments.filter((segment) => selected.has(segment.speakerId)));
    // `selectionKey` stands in for `selectedSpeakerIds` — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, selectionKey]);

  const intervalsRef = useRef<PlaybackInterval[]>(intervals);
  intervalsRef.current = intervals;

  const segmentsRef = useRef<TranscriptSegment[]>(segments);
  segmentsRef.current = segments;

  // ---------------------------------------------------------------------------
  // The shared tick — both clocks call exactly this
  // ---------------------------------------------------------------------------

  const handleTick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const nowMs = toMs(audio.currentTime);
    const windows = intervalsRef.current;

    /**
     * Segment mode (issue #108) and the speaker filter are MUTUALLY EXCLUSIVE,
     * written as an if/else rather than as two independent checks: a line the
     * filter excludes is still a line the user explicitly pointed at, and
     * letting the interval branch run underneath would seek straight back out
     * of it on the very first tick.
     */
    const seg = segmentPlayRef.current;
    if (seg) {
      if (nowMs >= seg.stopAtMs) {
        audio.pause();
        // Parked ON the boundary, the same reason the interval branch parks on
        // the last window's end: the scrubber, the highlighted line and the
        // audio must all agree about where playback stopped.
        audio.currentTime = toSeconds(seg.stopAtMs);
        clearSegmentPlay();
      }
    } else if (windows.length > 0) {
      const index = intervalIndexAt(windows, nowMs);
      if (index === -1) {
        // Outside every window. Jump to the next one, or stop: there is nothing
        // left this selection wants to play.
        const next = nextIntervalIndexFrom(windows, nowMs);
        if (next === -1) {
          audio.pause();
          // Parked ON the last interval's end rather than wherever the element
          // happened to be, so the scrubber and the "current segment" agree
          // with where the audio actually stopped.
          audio.currentTime = toSeconds(windows[windows.length - 1].endMs);
        } else {
          audio.currentTime = toSeconds(windows[next].startMs);
        }
      }
    }

    // ⚠ EVERYTHING BELOW RUNS ON EVERY TICK, SEGMENT MODE INCLUDED. An early
    // `return` out of the branch above would be the obvious way to write it and
    // would freeze the scrubber and the active-line highlight for the whole
    // length of the line being played — the two pieces of feedback that tell
    // the user the button did anything at all.
    const position = toMs(audio.currentTime);

    // Published at ~4 Hz — see the file header. `Math.abs` so a backwards seek
    // (a skip, a scrub) publishes immediately rather than waiting for the
    // position to climb back past the threshold.
    if (Math.abs(position - publishedPositionRef.current) >= POSITION_PUBLISH_MS) {
      publishedPositionRef.current = position;
      setPositionMs(position);
    }

    // Binary search every tick (it is ~13 comparisons over 6,000 segments), but
    // published only on a CHANGE — which is what keeps a 6,000-row virtualized
    // list from re-rendering sixty times a second.
    const index = findSegmentIndexAt(segmentsRef.current, position);
    if (index !== segmentIndexRef.current) {
      segmentIndexRef.current = index;
      setCurrentSegmentIndex(index);
    }
    // `clearSegmentPlay` has an empty dependency list of its own, so this stays
    // the stable identity the two clocks were built against.
  }, [clearSegmentPlay]);

  const handleTickRef = useRef(handleTick);
  handleTickRef.current = handleTick;

  // ---------------------------------------------------------------------------
  // Loading the source
  // ---------------------------------------------------------------------------

  /**
   * Point the element at a freshly signed URL.
   *
   * `restoreMs` is what makes expired-URL recovery invisible: assigning `src`
   * resets `currentTime` to zero, so the position has to be read BEFORE the
   * assignment and written back once the browser has enough of the new source
   * to accept a seek.
   */
  const loadSource = useCallback(
    async (id: string, restoreMs: number | null, resume: boolean) => {
      const audio = audioRef.current;
      if (!audio) return;

      setStatus((current) => (current === 'ready' ? current : 'loading'));
      try {
        const fetcher = fetchAudioRef.current;
        const info = await (fetcher ? fetcher(id) : getTranscriptAudio(id));
        if (audioRef.current !== audio) return;

        // A browser that will not play the ORIGINAL while the rendition is
        // still being produced is the "Preparing audio…" case (spec §7.1), not
        // an error: `canPlayType` answering `''` means "definitely not", and
        // the rendition exists precisely to make that answer irrelevant.
        if (info.kind === 'original' && !playbackReadyRef.current) {
          const verdict = audio.canPlayType?.(info.mimeType) ?? '';
          if (verdict === '') {
            setAudioKind(info.kind);
            setStatus('preparing');
            return;
          }
        }

        setAudioKind(info.kind);
        audio.src = info.url;
        audio.load?.();
        if (restoreMs !== null && restoreMs > 0) {
          // `loadedmetadata`, not `canplay`: seeking is legal from the moment
          // the duration is known, and waiting for `canplay` adds a visible
          // jump back to zero on a slow network.
          const restore = () => {
            audio.currentTime = toSeconds(restoreMs);
            if (resume) void audio.play?.().catch(() => {});
          };
          audio.addEventListener('loadedmetadata', restore, { once: true });
        } else if (resume) {
          void audio.play?.().catch(() => {});
        }
        setStatus('ready');
        setError(null);
      } catch {
        if (audioRef.current !== audio) return;
        setStatus('error');
        setError('The audio for this transcript could not be loaded.');
      }
    },
    // EMPTY, deliberately: everything this reads lives in a ref (see above), so
    // the identity is stable for the life of the hook and the element effect
    // below cannot be torn down by a caller's re-render.
    [],
  );

  // Create the element once, and wire every listener it needs.
  useEffect(() => {
    if (!transcriptId) {
      setStatus('idle');
      return;
    }

    const factory = createAudioRef.current;
    const audio = factory ? factory() : new Audio();
    audio.preload = 'metadata';
    audioRef.current = audio;
    recoveringRef.current = false;
    publishedPositionRef.current = 0;
    segmentIndexRef.current = -1;
    setPositionMs(0);
    setCurrentSegmentIndex(-1);
    setDurationMs(0);
    setIsPlaying(false);

    const onLoadedMetadata = () => {
      // `Infinity` is what a stream with no known length reports, and it would
      // render as an infinite scrubber; 0 is the honest "not known yet".
      const value = audio.duration;
      setDurationMs(Number.isFinite(value) ? toMs(value) : 0);
    };
    const onPlay = () => setIsPlaying(true);
    // Segment mode ends whenever the ELEMENT stops, not only when this hook's
    // own `pause` is called: the browser's native controls, a media key the
    // Media Session never registered, and a stream that simply runs out all
    // stop playback without going through any of our callbacks, and a row left
    // showing Pause in any of those cases is a lie about what is happening.
    const onPause = () => {
      setIsPlaying(false);
      clearSegmentPlay();
    };
    const onEnded = () => {
      setIsPlaying(false);
      clearSegmentPlay();
    };
    // Fires in EVERY state, foreground included. Harmless there — `handleTick`
    // is idempotent — and it is the only clock a hidden tab has.
    const onTimeUpdate = () => handleTickRef.current();
    const onSeeked = () => handleTickRef.current();

    /**
     * A media error. The overwhelmingly likely cause is the signed URL having
     * expired mid-listen (six-hour TTL against a recording somebody may leave
     * open all day), so the response is to sign a new one and put the listener
     * back where they were — not to show them an error they can do nothing
     * about.
     */
    const onError = () => {
      if (recoveringRef.current) {
        setStatus('error');
        setError('Playback stopped and could not be resumed.');
        return;
      }
      recoveringRef.current = true;
      const restoreMs = toMs(audio.currentTime);
      const wasPlaying = !audio.paused;
      void loadSource(transcriptId, restoreMs, wasPlaying);
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('error', onError);

    void loadSource(transcriptId, null, false);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('error', onError);
      audio.pause?.();
      // Dropped rather than merely paused: a paused element with a live `src`
      // keeps buffering, and leaving one behind on every navigation is how a
      // long session ends up holding several hours of audio in memory.
      audio.removeAttribute?.('src');
      audioRef.current = null;
    };
    // ONE dependency that can rebuild the element: the transcript. See the ref
    // block above for why the injectables are deliberately absent —
    // `loadSource` and `clearSegmentPlay` are both `useCallback`s with empty
    // dependency lists, so neither can change for the life of the hook.
  }, [clearSegmentPlay, loadSource, transcriptId]);

  /**
   * The rendition finished while the page was open.
   *
   * `playbackReady` flips false → true when the transcode lands, and the ONLY
   * state that cares is `preparing` — where the browser refused the original
   * and there was nothing to play. Re-signing then turns "Preparing audio…"
   * into a working player without the reader reloading the page. Every other
   * status is left alone: a `ready` player must not be interrupted because a
   * poll noticed a status field move.
   */
  useEffect(() => {
    if (!transcriptId || !playbackReady || status !== 'preparing') return;
    void loadSource(transcriptId, null, false);
  }, [loadSource, playbackReady, status, transcriptId]);

  // ---------------------------------------------------------------------------
  // The rAF clock (visible only)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return;
    }

    const loop = () => {
      handleTickRef.current();
      rafRef.current = window.requestAnimationFrame(loop);
    };

    const start = () => {
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(loop);
    };
    const stop = () => {
      if (rafRef.current === null) return;
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };

    // Explicitly cancelled when hidden rather than relying on the browser to
    // stop delivering frames: the throttling is neither uniform nor guaranteed,
    // and `timeupdate` is doing the work in that state anyway.
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  const seekToMs = useCallback(
    (ms: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      // ONE place ends segment mode for the scrubber, `play`, `playFromMs`,
      // `skip` and previous/next segment — they all come through here, so none
      // of them carries its own copy of the rule (issue #108).
      clearSegmentPlay();
      const windows = intervalsRef.current;
      const target = resolveSeekTarget(windows, Math.max(0, ms));
      // `null` is "past the last window of this selection". Wrapping to the
      // first one rather than refusing matches what pressing play at the end of
      // any media does, and refusing would leave a dead Play button with no
      // explanation on screen.
      const resolved = target ?? (windows.length > 0 ? windows[0].startMs : 0);
      audio.currentTime = toSeconds(resolved);
      publishedPositionRef.current = resolved;
      setPositionMs(resolved);
      handleTickRef.current();
    },
    [clearSegmentPlay],
  );

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Snap BEFORE playing, not after: starting playback inside a skipped gap
    // and letting the tick correct it means a frame or two of the wrong
    // speaker's audio actually reaches the listener.
    seekToMs(toMs(audio.currentTime));
    void audio.play?.().catch(() => {});
  }, [seekToMs]);

  const pause = useCallback(() => {
    // Explicit, even though the element's own `pause` listener also clears:
    // `pause()` on an element with no source fires no event, and leaving the
    // ref set there would strand a Pause icon on a row that is not playing.
    clearSegmentPlay();
    audioRef.current?.pause?.();
  }, [clearSegmentPlay]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play();
    else pause();
  }, [pause, play]);

  const playFromMs = useCallback(
    (ms: number) => {
      seekToMs(ms);
      void audioRef.current?.play?.().catch(() => {});
    },
    [seekToMs],
  );

  /**
   * Play one line and stop at its end (issue #108).
   *
   * ⚠ `currentTime` IS WRITTEN DIRECTLY, NOT THROUGH `seekToMs`. `seekToMs`
   * snaps to the speaker filter's intervals, so routing this through it would
   * pull playback out of the exact line the user pointed at whenever that
   * line's speaker happens to be filtered out — which is precisely when a
   * "hear this one" button is most useful.
   */
  const playSegment = useCallback(
    (segment: Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>) => {
      const audio = audioRef.current;
      if (!audio) return;

      audio.currentTime = toSeconds(segment.startMs);
      publishedPositionRef.current = segment.startMs;
      setPositionMs(segment.startMs);
      // Set LAST of the position work, so nothing this call triggers on its way
      // here can clear the mode it is about to enter.
      segmentPlayRef.current = { id: segment.id, stopAtMs: segment.endMs };
      setActiveSegmentId(segment.id);
      void audio.play?.().catch(() => {});
    },
    [],
  );

  const skip = useCallback(
    (deltaMs: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seekToMs(toMs(audio.currentTime) + deltaMs);
    },
    [seekToMs],
  );

  const setRate = useCallback((next: PlaybackRate) => {
    setRateState(next);
    const audio = audioRef.current;
    if (audio) audio.playbackRate = next;
  }, []);

  /**
   * Step to a neighbouring segment.
   *
   * Steps over segments the current filter excludes: with "only Ana" active,
   * "next" must mean her next line, not the next line in the transcript — the
   * engine would otherwise seek into a gap and the tick would immediately skip
   * out of it, which reads as the button doing nothing.
   */
  const stepSegment = useCallback(
    (direction: 1 | -1) => {
      const audio = audioRef.current;
      if (!audio) return;
      const list = segmentsRef.current;
      if (list.length === 0) return;

      const windows = intervalsRef.current;
      const playable = (segment: TranscriptSegment) =>
        windows.length === 0 || intervalIndexAt(windows, segment.startMs) !== -1;

      const nowMs = toMs(audio.currentTime);
      let index = findSegmentIndexAt(list, nowMs);
      if (index === -1) {
        // In a silence: "next" is the first segment starting after now, and
        // "previous" is the last one that started before it.
        index = list.findIndex((segment) => segment.startMs > nowMs);
        if (direction === 1) {
          if (index === -1) return;
        } else {
          index = index === -1 ? list.length : index;
        }
      } else {
        index += direction;
      }

      for (let i = index; i >= 0 && i < list.length; i += direction) {
        if (!playable(list[i])) continue;
        playFromMs(list[i].startMs);
        return;
      }
    },
    [playFromMs],
  );

  const previousSegment = useCallback(() => stepSegment(-1), [stepSegment]);
  const nextSegment = useCallback(() => stepSegment(1), [stepSegment]);

  // ---------------------------------------------------------------------------
  // Media Session (spec §7.3)
  // ---------------------------------------------------------------------------

  const currentSegment =
    currentSegmentIndex >= 0 ? segments[currentSegmentIndex] : undefined;
  const currentSpeakerName = currentSegment
    ? (speakerName?.(currentSegment.speakerId) ?? '')
    : '';

  useEffect(() => {
    const session = mediaSession();
    if (!session || typeof MediaMetadata === 'undefined') return;
    session.metadata = new MediaMetadata({
      title,
      // The lock screen's "artist" line is the most useful place for WHO is
      // talking: it is the one field that changes as the recording plays.
      artist: currentSpeakerName || undefined,
    });
  }, [currentSpeakerName, title]);

  useEffect(() => {
    const session = mediaSession();
    if (!session?.setActionHandler) return;

    // `previoustrack`/`nexttrack` are mapped to the previous/next SEGMENT
    // rather than to a literal track: there is only ever one track here, so the
    // hardware keys would otherwise be dead, and segment-stepping is exactly
    // what tapping a timestamp in the list already does.
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => play()],
      ['pause', () => pause()],
      ['seekbackward', () => skip(-SKIP_MS)],
      ['seekforward', () => skip(SKIP_MS)],
      ['previoustrack', () => previousSegment()],
      ['nexttrack', () => nextSegment()],
    ];

    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // A browser that does not implement one action throws on registering
        // it. Losing one hardware key must not cost the other five.
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* see above */
        }
      }
    };
  }, [nextSegment, pause, play, previousSegment, skip]);

  useEffect(() => {
    const session = mediaSession();
    if (!session?.setPositionState || durationMs <= 0) return;
    try {
      session.setPositionState({
        duration: toSeconds(durationMs),
        playbackRate: rate,
        // Clamped: a position past `duration` (a rounding artefact at the very
        // end) makes Chrome throw and drop the whole position state.
        position: Math.min(toSeconds(positionMs), toSeconds(durationMs)),
      });
    } catch {
      /* Not every browser accepts every combination; the scrubber is a bonus. */
    }
  }, [durationMs, positionMs, rate]);

  return {
    status,
    error,
    isPlaying,
    positionMs,
    durationMs,
    rate,
    currentSegmentIndex,
    intervals,
    audioKind,
    activeSegmentId,
    play,
    pause,
    togglePlay,
    seekToMs,
    playFromMs,
    skip,
    setRate,
    previousSegment,
    nextSegment,
    playSegment,
  };
}
