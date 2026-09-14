/**
 * The pure arithmetic behind per-speaker playback — issue #30, epic #19.
 *
 * Every function here is a total function of its arguments with no clock, no
 * media element and no React. That separation is the point: the engine
 * (`hooks/usePlaybackEngine.ts`) is hard to test because it owns an
 * `HTMLAudioElement` and a `requestAnimationFrame` loop, while THIS file holds
 * the three decisions that are actually easy to get wrong — where the windows
 * are, which one comes next, and which segment is playing — and each can be
 * checked with a table of numbers.
 *
 * MILLISECONDS EVERYWHERE. `HTMLMediaElement.currentTime` is in SECONDS and is
 * the only place in this feature that is; the engine converts at the boundary
 * (`toMs`/`toSeconds` below) so nothing in the middle has to remember which
 * unit it is holding. Segment and word timings arrive from the API in
 * milliseconds and stay that way.
 *
 * See `docs/specs/transcription.md` §7.2 for the design these functions
 * implement, including why the gap threshold is 300 ms.
 */

/** One window of audio to play, in milliseconds. `end` is exclusive. */
export interface PlaybackInterval {
  startMs: number;
  endMs: number;
}

/**
 * The gap below which two consecutive intervals of the same selection are one
 * interval (spec §7.2).
 *
 * Diarization routinely leaves a few milliseconds of silence or a breath
 * between two segments that are really one continuous thought. Without
 * merging, the engine seek-pause-seeks across dozens of sub-second gaps a
 * listener cannot perceive as separate at all, which sounds like a stutter
 * rather than like filtering. 300 ms sits comfortably below the threshold of a
 * perceptible pause in ordinary speech while still respecting a genuine
 * multi-second silence between two different thoughts.
 */
export const INTERVAL_MERGE_GAP_MS = 300;

/** Anything with a start and an end — a segment, or an interval already. */
interface TimedRange {
  startMs: number;
  endMs: number;
}

/**
 * Build the sorted, merged interval list for a selection of segments.
 *
 * Three things happen, in this order, and all three are load-bearing:
 *
 *  1. **Zero- and negative-length ranges are dropped.** A segment whose
 *     `endMs <= startMs` is a window the engine could never leave: the
 *     "have we passed the end" test would be true on the frame it seeks in,
 *     so it would seek to the same place forever.
 *  2. **Sorted by start.** The caller passes segments in READING order, which
 *     is the same order only while nobody has edited them; `ordinal` is a
 *     gap-based float precisely so an insert does not renumber, and an
 *     inserted segment can legitimately sort before its predecessor in time.
 *     Every other function in this file binary-searches this array, so an
 *     unsorted input is not a cosmetic problem.
 *  3. **Merged** when the next range starts within `gapMs` of the running
 *     interval's end — INCLUDING when it starts before it, which overlapping
 *     diarization output produces and which would otherwise leave the engine
 *     seeking backwards.
 */
export function buildIntervals(
  ranges: readonly TimedRange[],
  gapMs: number = INTERVAL_MERGE_GAP_MS,
): PlaybackInterval[] {
  const usable = ranges
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: PlaybackInterval[] = [];
  for (const range of usable) {
    const last = merged[merged.length - 1];
    if (last && range.startMs - last.endMs <= gapMs) {
      // `Math.max`, not assignment: a fully contained range must not SHORTEN
      // the interval it merges into.
      last.endMs = Math.max(last.endMs, range.endMs);
      continue;
    }
    merged.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return merged;
}

/**
 * Which interval contains `positionMs`, or `-1` when it falls in a gap.
 *
 * Half-open (`start <= t < end`) so the instant one interval ends is already
 * inside the next when the two are adjacent — which merging makes common.
 */
export function intervalIndexAt(
  intervals: readonly PlaybackInterval[],
  positionMs: number,
): number {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const interval = intervals[mid];
    if (positionMs < interval.startMs) high = mid - 1;
    else if (positionMs >= interval.endMs) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * The first interval that starts at or after `positionMs`, or `-1` past the
 * last one.
 *
 * This is what makes "pressing play in a gap does not play the other speaker"
 * work: the engine asks for the next interval and seeks to its start rather
 * than letting the element run through whoever is speaking in between.
 */
export function nextIntervalIndexFrom(
  intervals: readonly PlaybackInterval[],
  positionMs: number,
): number {
  let low = 0;
  let high = intervals.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (intervals[mid].startMs >= positionMs) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

/**
 * Where playback should actually go for a requested position.
 *
 * `null` means "past the last interval — stop", which the engine renders as a
 * pause rather than as a seek to the end. Inside an interval the answer is the
 * position itself, unchanged: snapping a legitimate in-window seek to the
 * interval's start would make scrubbing inside one speaker's long monologue
 * impossible.
 */
export function resolveSeekTarget(
  intervals: readonly PlaybackInterval[],
  positionMs: number,
): number | null {
  // No selection means no filtering: the whole recording is playable, so every
  // position is its own answer. Returning `null` here would make an empty
  // speaker filter silently un-playable.
  if (intervals.length === 0) return positionMs;

  if (intervalIndexAt(intervals, positionMs) !== -1) return positionMs;

  const next = nextIntervalIndexFrom(intervals, positionMs);
  return next === -1 ? null : intervals[next].startMs;
}

/**
 * The index of the segment playing at `positionMs`, or `-1`.
 *
 * BINARY SEARCH, and the reason is in the spec (§7.2): the `requestAnimationFrame`
 * loop asks this question up to sixty times a second, and issue #30's own
 * benchmark fixture is 6,000 segments. A linear scan is ~360,000 comparisons a
 * second for an answer that changes a few times a minute.
 *
 * Segments are half-open like intervals, and a position in the silence BETWEEN
 * two segments answers `-1` rather than rounding to the nearer one — the caller
 * renders "no current segment", which is honest, instead of highlighting a
 * speaker who is not talking.
 *
 * ⚠ `segments` MUST be sorted by `startMs`. `buildIntervals` sorts its own
 * copy; this one cannot, because it returns an INDEX into the array it was
 * given and a sorted copy's indices would point at the wrong rows.
 */
export function findSegmentIndexAt(
  segments: readonly TimedRange[],
  positionMs: number,
): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (positionMs < segment.startMs) high = mid - 1;
    else if (positionMs >= segment.endMs) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * The index of the word playing at `positionMs` within one segment's words.
 *
 * Linear, unlike its segment counterpart, and deliberately: a segment holds a
 * few dozen words at most, the array is re-scanned only while ONE segment is
 * current, and a linear scan needs no sortedness guarantee from a provider
 * whose word list is occasionally not quite monotonic.
 */
export function findWordIndexAt(
  words: readonly { s: number; e: number }[],
  positionMs: number,
): number {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (positionMs >= word.s && positionMs < word.e) return index;
  }
  return -1;
}

/** `HTMLMediaElement.currentTime` (seconds) → milliseconds. */
export function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** Milliseconds → `HTMLMediaElement.currentTime` (seconds). */
export function toSeconds(ms: number): number {
  return ms / 1000;
}

/**
 * `h:mm:ss` past an hour, `m:ss` below it.
 *
 * No hour segment on a four-minute recording — a leading `0:` on every
 * timestamp in a list of thousands is noise, and a transcript's segment list is
 * read as a column of numbers where the extra digits genuinely cost scanning
 * speed. Negatives and `NaN` clamp to zero rather than rendering `-1:-1`.
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A spoken-language duration for a card ("1 hr 12 min", "48 sec").
 *
 * Distinct from `formatTimestamp` on purpose: a clock face is the right shape
 * for a POSITION inside a recording and the wrong shape for its LENGTH, where
 * `1:12:03` reads as a timestamp and invites the question "in what?".
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} sec`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}
