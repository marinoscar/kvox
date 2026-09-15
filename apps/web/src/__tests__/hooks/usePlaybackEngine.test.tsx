import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { usePlaybackEngine, SKIP_MS } from '../../hooks/usePlaybackEngine';
import type { TranscriptSegment, TranscriptAudio } from '../../services/transcripts';

/**
 * The engine, against a fake media element.
 *
 * WHY A HAND-ROLLED FAKE AND NOT jsdom's `HTMLAudioElement`: jsdom implements
 * the element's SHAPE and none of its behaviour — `play()` rejects, `duration`
 * is `NaN`, `currentTime` never advances, and no media event ever fires. Every
 * property this engine actually reasons about would therefore have to be
 * stubbed onto it one at a time, which is a fake with extra steps and a
 * confusing provenance. A small explicit class makes the seam obvious and lets
 * a test say "the playhead is now at 4.2 seconds" in one line.
 *
 * The engine takes `createAudio` and `fetchAudio` as options for exactly this
 * reason; production passes neither.
 */
class FakeAudio {
  currentTime = 0;
  duration = 600;
  paused = true;
  playbackRate = 1;
  preload = '';
  src = '';
  /** Every `src` ever assigned, so the expired-URL test can prove a reload. */
  readonly sources: string[] = [];

  private listeners = new Map<string, Set<EventListener>>();

  play = vi.fn(async () => {
    this.paused = false;
    this.emit('play');
  });

  pause = vi.fn(() => {
    this.paused = true;
    this.emit('pause');
  });

  load = vi.fn();

  /** Answers "probably" by default — the not-ready test overrides it. */
  canPlayType = vi.fn(() => 'probably');

  removeAttribute = vi.fn();

  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  /** Move the playhead and fire the event a real element would. */
  advanceTo(seconds: number) {
    this.currentTime = seconds;
    this.emit('timeupdate');
  }
}

/** `src` assignment is recorded through a setter the class cannot express. */
function makeAudio(): FakeAudio {
  const audio = new FakeAudio();
  let value = '';
  Object.defineProperty(audio, 'src', {
    get: () => value,
    set: (next: string) => {
      value = next;
      audio.sources.push(next);
    },
  });
  return audio;
}

function segment(
  id: string,
  speakerId: string,
  startMs: number,
  endMs: number,
): TranscriptSegment {
  return {
    id,
    speakerId,
    startMs,
    endMs,
    ordinal: startMs,
    text: `${speakerId} at ${startMs}`,
    wordsAlignment: 'exact',
    confidence: 0.9,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  };
}

/**
 * A → B → A → B, one second each with one second of the other between.
 * Ana's intervals are therefore [0,1000) and [2000,3000) — two windows with a
 * 1000ms gap, comfortably above the 300ms merge threshold.
 */
const SEGMENTS: TranscriptSegment[] = [
  segment('s1', 'ana', 0, 1000),
  segment('s2', 'ben', 1000, 2000),
  segment('s3', 'ana', 2000, 3000),
  segment('s4', 'ben', 3000, 4000),
];

const AUDIO: TranscriptAudio = {
  url: 'https://storage.example/signed-1',
  kind: 'playback',
  mimeType: 'audio/mp4',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

/** Drives the rAF loop by hand, so a frame happens when the test says so. */
let frameCallbacks: FrameRequestCallback[] = [];

function flushFrame() {
  const pending = frameCallbacks;
  frameCallbacks = [];
  for (const callback of pending) callback(performance.now());
}

beforeEach(() => {
  frameCallbacks = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEngine(
  overrides: Partial<Parameters<typeof usePlaybackEngine>[0]> = {},
  audio: FakeAudio = makeAudio(),
  fetchAudio = vi.fn(async () => AUDIO),
) {
  const result = renderHook(() =>
    usePlaybackEngine({
      transcriptId: 't1',
      segments: SEGMENTS,
      selectedSpeakerIds: [],
      title: 'Standup',
      createAudio: () => audio as unknown as HTMLAudioElement,
      fetchAudio,
      ...overrides,
    }),
  );
  return { ...result, audio, fetchAudio };
}

describe('usePlaybackEngine — loading the source', () => {
  it('signs a URL and points the element at it', async () => {
    const { result, audio, fetchAudio } = renderEngine();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchAudio).toHaveBeenCalledWith('t1');
    expect(audio.src).toBe(AUDIO.url);
    expect(result.current.audioKind).toBe('playback');
  });

  it('reports "preparing" — never an error — when the rendition is not ready and the original is unplayable', async () => {
    // The `canPlayType('') === ''` case: the browser is certain it cannot play
    // the original, and the rendition that exists to fix that is still being
    // produced. The transcript itself may be perfectly readable, so this must
    // not render as a failure.
    const audio = makeAudio();
    audio.canPlayType = vi.fn(() => '');
    const { result } = renderEngine(
      { playbackReady: false },
      audio,
      vi.fn(async () => ({ ...AUDIO, kind: 'original' as const, mimeType: 'audio/amr' })),
    );

    await waitFor(() => expect(result.current.status).toBe('preparing'));
    expect(result.current.error).toBeNull();
    expect(audio.src).toBe('');
  });

  it('plays the ORIGINAL when the browser says it can, even with no rendition', async () => {
    const audio = makeAudio();
    audio.canPlayType = vi.fn(() => 'maybe');
    const { result } = renderEngine(
      { playbackReady: false },
      audio,
      vi.fn(async () => ({ ...AUDIO, kind: 'original' as const, mimeType: 'audio/mpeg' })),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(audio.src).toBe(AUDIO.url);
  });

  it('surfaces a failed signing as an error the player can render', async () => {
    const { result } = renderEngine(
      {},
      makeAudio(),
      vi.fn(async () => {
        throw new Error('nope');
      }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(/could not be loaded/i);
  });
});

describe('usePlaybackEngine — speaker-only playback (spec §7.2)', () => {
  it('plays only the selected speaker’s windows and pauses after the last', async () => {
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.intervals).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]);

    act(() => result.current.play());
    expect(audio.paused).toBe(false);

    // Reaching the end of Ana's first window jumps to the start of her second,
    // skipping Ben entirely rather than playing him quietly.
    act(() => audio.advanceTo(1.0));
    expect(audio.currentTime).toBe(2.0);
    expect(audio.paused).toBe(false);

    // Past her LAST window it stops, rather than running on into Ben.
    act(() => audio.advanceTo(3.0));
    expect(audio.paused).toBe(true);
    // Parked on the last window's end, so the scrubber and the current segment
    // agree with where the audio actually stopped.
    expect(audio.currentTime).toBe(3.0);
  });

  it('does not interrupt playback inside a merged sub-300ms gap', async () => {
    // Two of Ana's segments a 200ms breath apart are ONE window: without
    // merging the engine would seek-pause-seek across it audibly.
    const tight = [segment('a1', 'ana', 0, 1000), segment('a2', 'ana', 1200, 2000)];
    const { result, audio } = renderEngine({
      segments: tight,
      selectedSpeakerIds: ['ana'],
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.intervals).toEqual([{ startMs: 0, endMs: 2000 }]);

    act(() => result.current.play());
    act(() => audio.advanceTo(1.1)); // inside the merged gap
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(1.1);
  });

  it('snaps a seek that lands outside a window forward to the next one', async () => {
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.seekToMs(1500)); // in Ben's segment
    expect(audio.currentTime).toBe(2.0);
  });

  it('snaps BEFORE starting playback, so no frame of the wrong speaker is heard', async () => {
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    audio.currentTime = 1.5;
    act(() => result.current.play());

    // The position moved before `play()` was called, not after a tick corrected
    // it — which is what the ordering inside `play()` guarantees.
    expect(audio.currentTime).toBe(2.0);
    expect(audio.play).toHaveBeenCalled();
  });

  it('wraps to the first window when play is pressed past the last one', async () => {
    // Rather than refusing, which would leave a dead Play button with nothing
    // on screen to explain it.
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.seekToMs(59_000));
    expect(audio.currentTime).toBe(0);
  });

  it('applies no filtering at all when nothing is selected', async () => {
    const { result, audio } = renderEngine({ selectedSpeakerIds: [] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.intervals).toEqual([]);
    act(() => result.current.seekToMs(1500));
    expect(audio.currentTime).toBe(1.5);

    act(() => result.current.play());
    act(() => audio.advanceTo(2.0));
    expect(audio.paused).toBe(false);
  });
});

describe('usePlaybackEngine — the two clocks', () => {
  it('enforces boundaries from the rAF loop while the page is visible', async () => {
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.play());
    // The playhead moves with NO media event — exactly what happens between
    // `timeupdate`s, which fire only ~4 times a second.
    audio.currentTime = 1.0;
    act(() => flushFrame());

    expect(audio.currentTime).toBe(2.0);
  });

  it('enforces the same boundaries from `timeupdate` when no frames are delivered', async () => {
    // The backgrounded case: browsers stop `rAF` for a hidden tab, and this is
    // the fallback that keeps per-speaker filtering working there (with the
    // documented ~250ms overshoot, which is the event's own firing interval and
    // not something this engine can narrow).
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    frameCallbacks = []; // no frames from here on
    act(() => result.current.play());
    act(() => audio.advanceTo(1.24)); // 240ms past the boundary

    expect(audio.currentTime).toBe(2.0);
  });
});

describe('usePlaybackEngine — the current segment', () => {
  it('tracks the segment under the playhead and answers -1 between segments', async () => {
    const gapped = [segment('g1', 'ana', 0, 1000), segment('g2', 'ben', 5000, 6000)];
    const { result, audio } = renderEngine({ segments: gapped });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => audio.advanceTo(0.5));
    expect(result.current.currentSegmentIndex).toBe(0);

    act(() => audio.advanceTo(3));
    expect(result.current.currentSegmentIndex).toBe(-1);

    act(() => audio.advanceTo(5.5));
    expect(result.current.currentSegmentIndex).toBe(1);
  });

  it('does not re-render when the playhead moves WITHIN one segment', async () => {
    // The published-on-change rule (spec §7.2). The alternative — publishing
    // every tick — re-renders a 6,000-row virtualized list sixty times a
    // second, which is the whole reason the binary search is separated from
    // the publish.
    const audio = makeAudio();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePlaybackEngine({
        transcriptId: 't1',
        segments: SEGMENTS,
        selectedSpeakerIds: [],
        title: 'Standup',
        createAudio: () => audio as unknown as HTMLAudioElement,
        fetchAudio: async () => AUDIO,
      });
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    // A first tick far enough from zero to PUBLISH, so the baseline the
    // threshold is measured against is a known 300ms rather than the initial 0.
    act(() => audio.advanceTo(0.3));

    const before = renders;

    // Three more ticks inside segment 0, each within the 250ms publish
    // threshold of that last published position — so neither the position nor
    // the segment index changes, and nothing is set.
    act(() => audio.advanceTo(0.35));
    act(() => audio.advanceTo(0.42));
    act(() => audio.advanceTo(0.5));

    expect(result.current.currentSegmentIndex).toBe(0);
    expect(renders).toBe(before);
  });
});

describe('usePlaybackEngine — transport', () => {
  it('skips by ±10 seconds — the interval the icons have always drawn', async () => {
    // MUI ships no Replay15/Forward15, so the bar drew "10" while its labels
    // said "15 seconds" (#108). `SKIP_MS` is the ten the glyphs meant.
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(SKIP_MS).toBe(10_000);

    act(() => result.current.seekToMs(60_000));
    act(() => result.current.skip(SKIP_MS));
    expect(audio.currentTime).toBe(70);

    act(() => result.current.skip(-SKIP_MS));
    expect(audio.currentTime).toBe(60);
  });

  it('never seeks before zero', async () => {
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.skip(-SKIP_MS));
    expect(audio.currentTime).toBe(0);
  });

  it('sets the element’s playback rate', async () => {
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.setRate(1.5));
    expect(audio.playbackRate).toBe(1.5);
    expect(result.current.rate).toBe(1.5);
  });

  it('steps to the next and previous segment', async () => {
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => audio.advanceTo(0.5)); // inside s1
    act(() => result.current.nextSegment());
    expect(audio.currentTime).toBe(1.0); // s2's start

    act(() => result.current.previousSegment());
    expect(audio.currentTime).toBe(0); // back to s1
  });

  it('steps over speakers the filter excludes', async () => {
    // With "only Ana", "next" must mean HER next line: stepping to Ben's would
    // seek into a gap the tick immediately skips out of, which reads as the
    // button doing nothing.
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => audio.advanceTo(0.5));
    act(() => result.current.nextSegment());
    expect(audio.currentTime).toBe(2.0); // s3, skipping Ben's s2
  });
});

describe('usePlaybackEngine — segment play (#108)', () => {
  it('seeks to the line’s start and plays it', async () => {
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[1]));

    expect(audio.currentTime).toBe(1.0); // s2 starts at 1000ms
    expect(audio.play).toHaveBeenCalled();
    expect(result.current.activeSegmentId).toBe('s2');
  });

  it('pauses ON the line’s end and leaves segment mode', async () => {
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[1]));
    act(() => audio.advanceTo(2.0)); // s2 ends at 2000ms

    expect(audio.paused).toBe(true);
    // Parked on the boundary, so the scrubber, the highlighted line and the
    // audio all agree about where it stopped.
    expect(audio.currentTime).toBe(2.0);
    expect(result.current.activeSegmentId).toBeNull();
  });

  it('plays a line whose speaker the filter EXCLUDES, without snapping away', async () => {
    // The regression guard for `handleTick`'s ordering. With "only Ana", s2 is
    // Ben's and sits in a gap the interval branch seeks straight out of — so if
    // segment mode did not take precedence, pressing play on Ben's line would
    // silently jump to Ana's next one, which is the one thing the button must
    // never do.
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[1]));
    expect(audio.currentTime).toBe(1.0);

    act(() => audio.advanceTo(1.4));
    act(() => flushFrame());

    expect(audio.currentTime).toBe(1.4);
    expect(audio.paused).toBe(false);
    expect(result.current.activeSegmentId).toBe('s2');
  });

  it('keeps publishing the position and the current segment while a line plays', async () => {
    // The early-return guard: an `if (seg) { … return; }` in `handleTick` would
    // freeze the scrubber and the active-line highlight for the whole length of
    // the line — the only two pieces of feedback the button produces.
    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[2])); // s3, 2000–3000ms
    act(() => audio.advanceTo(2.6));

    expect(result.current.positionMs).toBe(2600);
    expect(result.current.currentSegmentIndex).toBe(2);
  });

  it('lets the speaker filter reclaim the playhead once the line has ended', async () => {
    // The documented edge in the file header. s4 is Ben's LAST line
    // (3000–4000ms) and Ana's last window ends at 3000, so the boundary this
    // parks on is outside every window the filter allows. Segment mode has just
    // been cleared, so the interval branch resumes and pulls the playhead back
    // — the filter reasserting itself, not the boundary parking failing.
    const { result, audio } = renderEngine({ selectedSpeakerIds: ['ana'] });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[3]));
    expect(audio.currentTime).toBe(3.0); // bypassed the filter to get there

    act(() => audio.advanceTo(4.0));
    // Parked on the boundary first, exactly as the unfiltered case does.
    expect(audio.currentTime).toBe(4.0);
    expect(audio.paused).toBe(true);

    act(() => flushFrame());
    expect(audio.currentTime).toBe(3.0); // Ana's last window's end
    expect(audio.paused).toBe(true);
  });

  it.each([
    ['seekToMs', (engine: ReturnType<typeof usePlaybackEngine>) => engine.seekToMs(500)],
    ['skip', (engine: ReturnType<typeof usePlaybackEngine>) => engine.skip(SKIP_MS)],
    ['pause', (engine: ReturnType<typeof usePlaybackEngine>) => engine.pause()],
    ['playFromMs', (engine: ReturnType<typeof usePlaybackEngine>) => engine.playFromMs(500)],
  ])('leaves segment mode on %s', async (_name, invoke) => {
    // Every transport gesture ends segment mode, because each of them is the
    // user saying "carry on with the recording".
    const { result } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.playSegment(SEGMENTS[1]));
    expect(result.current.activeSegmentId).toBe('s2');

    act(() => invoke(result.current));

    expect(result.current.activeSegmentId).toBeNull();
  });
});

describe('usePlaybackEngine — an expired URL recovers', () => {
  it('re-signs on a media error and restores the position', async () => {
    // The six-hour signed URL against a recording somebody leaves open all
    // day. The listener must not be shown an error they can do nothing about.
    const second = { ...AUDIO, url: 'https://storage.example/signed-2' };
    const fetchAudio = vi
      .fn<() => Promise<TranscriptAudio>>()
      .mockResolvedValueOnce(AUDIO)
      .mockResolvedValueOnce(second);

    const { result, audio } = renderEngine({}, makeAudio(), fetchAudio);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.seekToMs(120_000));
    act(() => result.current.play());
    expect(audio.paused).toBe(false);

    // The element reports a failure. Assigning `src` resets `currentTime`, so
    // the engine has to have read the position BEFORE the reload.
    audio.currentTime = 120;
    await act(async () => {
      audio.emit('error');
    });

    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));
    expect(audio.sources).toEqual([AUDIO.url, second.url]);

    // The position comes back once the new source knows its own duration.
    audio.currentTime = 0;
    await act(async () => {
      audio.emit('loadedmetadata');
    });
    expect(audio.currentTime).toBe(120);
    // It was playing, so it resumes rather than leaving the listener to press
    // play again on an interruption they never asked for.
    expect(audio.play).toHaveBeenCalled();
  });

  it('gives up after ONE recovery attempt rather than looping', async () => {
    // A truncated object or a rejected codec raises the same `error` event,
    // and re-signing a URL for a broken file fails identically forever.
    const fetchAudio = vi.fn(async () => AUDIO);
    const { result, audio } = renderEngine({}, makeAudio(), fetchAudio);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      audio.emit('error');
    });
    await waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(2));

    await act(async () => {
      audio.emit('error');
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetchAudio).toHaveBeenCalledTimes(2);
  });
});

describe('usePlaybackEngine — Media Session (spec §7.3)', () => {
  it('registers handlers and maps previous/next TRACK to previous/next SEGMENT', async () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const setActionHandler = vi.fn(
      (action: string, handler: MediaSessionActionHandler | null) => {
        handlers.set(action, handler);
      },
    );
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaSession: { setActionHandler, setPositionState: vi.fn(), metadata: null },
    });
    // `MediaMetadata` does not exist in jsdom; the engine guards on it, and the
    // guard is what this stub proves does not skip the handler registration.
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor(public init: unknown) {}
      },
    );

    const { result, audio } = renderEngine();
    await waitFor(() => expect(result.current.status).toBe('ready'));

    for (const action of [
      'play',
      'pause',
      'seekbackward',
      'seekforward',
      'previoustrack',
      'nexttrack',
    ]) {
      expect(handlers.has(action), `${action} handler`).toBe(true);
    }

    act(() => audio.advanceTo(0.5));
    act(() => handlers.get('nexttrack')?.({ action: 'nexttrack' }));
    // Segment-scoped, not track-scoped: there is only ever one track here, so
    // a literal mapping would make the hardware keys dead.
    expect(audio.currentTime).toBe(1.0);

    act(() => handlers.get('seekforward')?.({ action: 'seekforward' }));
    expect(audio.currentTime).toBe(11.0);
  });
});
