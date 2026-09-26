/**
 * `useGraphTranscriptPeople` — which speakers of one transcript are a Person
 * in the caller's graph (#373's speaker chips).
 *
 * `listGraphEntities({ transcriptId })` answers Persons IDENTIFIED_AS a speaker
 * of that transcript, each with its `speakerIds` (#370). This folds that into
 * `Record<speakerId, entityId>`, the shape `SpeakerFilter` takes.
 *
 * SILENT ON FAILURE: an empty map, never an error. A transcript page must not
 * show a graph error because an optional enhancement could not load.
 */

import { useEffect, useState } from 'react';

import { listGraphEntities } from '../services/graph';
import type { GraphEntitySummary } from '../services/graph';
import { useIsMounted } from './useIsMounted';

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

export function speakerEntityMap(
  items: readonly GraphEntitySummary[],
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const item of items) {
    for (const speakerId of item.speakerIds ?? []) {
      // First writer wins: #356 allows one IDENTIFIED_AS per speaker, so a
      // collision is a data bug, and a stable answer beats a flickering one.
      if (!(speakerId in map)) map[speakerId] = item.id;
    }
  }
  return map;
}

export function useGraphTranscriptPeople(
  transcriptId: string | undefined,
  enabled: boolean,
): Readonly<Record<string, string>> {
  const [map, setMap] = useState<Readonly<Record<string, string>>>(EMPTY);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled || !transcriptId) {
      setMap(EMPTY);
      return undefined;
    }
    const controller = new AbortController();
    void listGraphEntities({ transcriptId, limit: 50 }, controller.signal)
      .then((page) => {
        if (isMounted() && !controller.signal.aborted) setMap(speakerEntityMap(page.items));
      })
      .catch(() => {
        if (isMounted() && !controller.signal.aborted) setMap(EMPTY);
      });
    return () => controller.abort();
  }, [enabled, isMounted, transcriptId]);

  return map;
}
