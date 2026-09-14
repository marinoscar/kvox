/**
 * Word timings for the window the player is currently inside — issue #30.
 *
 * WHY A WINDOW AND NOT THE WHOLE TRANSCRIPT: a six-hour recording's word index
 * is hundreds of megabytes, which is exactly why `GET /:id/segments` excludes
 * words and `GET /:id/words` takes a range (the API caps it at thirty minutes
 * and silently narrows anything wider). Word-level highlighting only ever needs
 * the words around the playhead.
 *
 * =============================================================================
 * QUANTISED WINDOWS, SO THE PLAYHEAD DOES NOT DRIVE THE NETWORK
 * =============================================================================
 *
 * The naive version fetches `[position, position + 5min)` and refetches as the
 * position moves — which is a request every time the position is published,
 * four times a second. Instead the timeline is divided into FIXED five-minute
 * buckets and the fetch key is the bucket index: playing through 00:00–05:00
 * issues exactly one request, and crossing into the next bucket issues exactly
 * one more.
 *
 * Each fetch asks for TWO buckets — the current one and the next — so the words
 * for the moment after a boundary are already in hand when the playhead reaches
 * it, rather than arriving a round trip late and blinking the highlight off.
 *
 * Fetched windows are remembered for the life of the hook. A ten-hour recording
 * played end to end is 120 windows of a few hundred kilobytes; a listener who
 * scrubs back and forth over the same five minutes pays for it once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getTranscriptWords } from '../services/transcripts';
import type { TranscriptWord } from '../services/transcripts';
import { useIsMounted } from './useIsMounted';

/** One bucket. Matches the API's own default window width. */
export const WORD_WINDOW_MS = 5 * 60_000;

export interface UseTranscriptWordsResult {
  /** Segment id → its word timings, for every window fetched so far. */
  wordsBySegment: Map<string, TranscriptWord[]>;
}

/**
 * `enabled` is false while the transcript is not ready, or while nothing has
 * word timings worth highlighting. It disables the fetch entirely rather than
 * fetching and discarding — a processing transcript has no words, and asking
 * for them on a schedule is a guaranteed-empty response per window.
 */
export function useTranscriptWords(
  transcriptId: string | undefined,
  positionMs: number,
  enabled = true,
): UseTranscriptWordsResult {
  const [wordsBySegment, setWordsBySegment] = useState<Map<string, TranscriptWord[]>>(
    () => new Map(),
  );
  const isMounted = useIsMounted();

  /** Bucket indices already fetched (or in flight), so nothing is asked twice. */
  const fetchedWindows = useRef<Set<number>>(new Set());

  // A new transcript is a new index. Without this, scrolling straight from one
  // transcript to another would highlight the previous one's words wherever a
  // segment id happened to collide, and would skip fetches for windows it
  // believes it already has.
  useEffect(() => {
    fetchedWindows.current = new Set();
    setWordsBySegment(new Map());
  }, [transcriptId]);

  const fetchWindow = useCallback(
    async (bucket: number) => {
      if (!transcriptId) return;
      if (fetchedWindows.current.has(bucket)) return;
      // Marked BEFORE the await: two publishes in the same tick would otherwise
      // both see an unfetched bucket and issue the same request twice.
      fetchedWindows.current.add(bucket);

      try {
        const fromMs = bucket * WORD_WINDOW_MS;
        const response = await getTranscriptWords(
          transcriptId,
          fromMs,
          fromMs + WORD_WINDOW_MS * 2,
        );
        if (!isMounted()) return;
        setWordsBySegment((current) => {
          const next = new Map(current);
          for (const segment of response.segments) {
            next.set(segment.segmentId, segment.words);
          }
          return next;
        });
      } catch {
        // A failed window is FORGOTTEN, so moving back into it retries. Word
        // highlighting is a polish layer: its failure must never surface as an
        // error on a page whose text is perfectly readable without it.
        fetchedWindows.current.delete(bucket);
      }
    },
    [isMounted, transcriptId],
  );

  const bucket = Math.max(0, Math.floor(positionMs / WORD_WINDOW_MS));

  useEffect(() => {
    if (!enabled || !transcriptId) return;
    void fetchWindow(bucket);
  }, [bucket, enabled, fetchWindow, transcriptId]);

  return { wordsBySegment };
}
