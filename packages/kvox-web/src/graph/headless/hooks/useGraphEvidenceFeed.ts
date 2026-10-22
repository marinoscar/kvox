/**
 * `useGraphEvidenceFeed` — the quotes behind one entity, relation or item, a
 * page at a time (GIC-11, #672; the explorer inspector's Evidence tab).
 *
 * =============================================================================
 * WHERE THE IDS COME FROM, AND WHAT IS NEVER ASKED
 * =============================================================================
 *
 *   - a RELATION or an ITEM: `GET /graph/evidence/by-subject`, newest source
 *     first, at most 50, already resolved to links;
 *   - an ENTITY: the same call for the entity's own citations, then the
 *     `evidenceIds` of its timeline events, page after page. Those ids are
 *     resolved with `GET /graph/evidence?ids=` in windows of at most
 *     `EVIDENCE_BATCH_MAX` (50), so an entity with hundreds of citations costs
 *     a request per 50 and never one per card.
 *
 * Twenty cards show at a time ({@link EVIDENCE_PAGE_SIZE}); "show more" reveals
 * the next twenty, fetching a further window only when the loaded ones run out.
 *
 * A SENSITIVE PERSON FACT IS NEVER ASKED ABOUT. The timeline is requested
 * WITHOUT `includeSensitive`, a timeline event whose item is `sensitive` is
 * dropped here as well (the API already omits it), and a caller passes `null`
 * for a person fact: there is no code path from this hook to such a fact's
 * evidence.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { EVIDENCE_BATCH_MAX, getEntityTimeline, getEvidenceBatch, getSubjectEvidence } from '../clients/graph.js';
import type { EvidenceLink, EvidenceSubjectKind, TimelineEvent } from '../clients/graph.js';
import { graphErrorMessage, isAbortError } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * How many evidence cards show at a time.
 *
 * @stability experimental
 */
export const EVIDENCE_PAGE_SIZE = 20;

/** Timeline events asked for per page when collecting an entity's evidence ids. */
const TIMELINE_PAGE = 50;

/**
 * What the feed lists evidence for.
 *
 * @stability experimental
 */
export interface EvidenceFeedSubject {
  /** Whether the quotes support an entity, a relation or an item. */
  kind: EvidenceSubjectKind;
  /** The subject's id. */
  id: string;
}

/**
 * What {@link useGraphEvidenceFeed} returns.
 *
 * @stability experimental
 */
export interface UseGraphEvidenceFeedResult {
  /** The cards to show now: the first `visible` loaded links, in display order. */
  items: EvidenceLink[];
  /** The first window is loading. */
  isLoading: boolean;
  /** A further window is loading. */
  isLoadingMore: boolean;
  /** A message when a request failed, else `null`. */
  error: string | null;
  /** More quotes exist than are shown (loaded but hidden, or not loaded yet). */
  hasMore: boolean;
  /** Reveals the next {@link EVIDENCE_PAGE_SIZE}, loading more first when needed. */
  showMore: () => void;
  /** Tries the request that failed again. */
  retry: () => void;
}

/** Evidence ids of the events of one timeline page, without any belonging to a sensitive item. */
export function evidenceIdsOf(events: readonly TimelineEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.item?.sensitivity === 'sensitive') continue;
    ids.push(...event.evidenceIds);
  }
  return ids;
}

interface Run {
  token: number;
  loaded: EvidenceLink[];
  seen: Set<string>;
  queue: string[];
  /** `undefined`: the timeline has not started; `null`: it is exhausted (or never applies). */
  cursor: string | null | undefined;
  subjectDone: boolean;
  target: number;
  busy: boolean;
}

function freshRun(token: number): Run {
  return { token, loaded: [], seen: new Set(), queue: [], cursor: undefined, subjectDone: false, target: EVIDENCE_PAGE_SIZE, busy: false };
}

/**
 * Lists the quotes behind a subject, {@link EVIDENCE_PAGE_SIZE} at a time. Does nothing for a `null` subject.
 *
 * @stability experimental
 */
export function useGraphEvidenceFeed(subject: EvidenceFeedSubject | null): UseGraphEvidenceFeedResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const kind = subject?.kind ?? null;
  const id = subject?.id ?? null;

  const run = useRef<Run>(freshRun(0));
  const [loaded, setLoaded] = useState<EvidenceLink[]>([]);
  const [visible, setVisible] = useState(EVIDENCE_PAGE_SIZE);
  const [exhausted, setExhausted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fill = useCallback(
    async (current: Run) => {
      if (current.busy || kind === null || id === null) return;
      current.busy = true;
      const stale = () => !isMounted() || run.current !== current;
      try {
        if (!current.subjectDone) {
          const links = await getSubjectEvidence(host, kind, id);
          if (stale()) return;
          current.subjectDone = true;
          for (const link of links) {
            if (current.seen.has(link.id)) continue;
            current.seen.add(link.id);
            current.loaded.push(link);
          }
          // Only an entity has a timeline of its own to read more ids from.
          if (kind !== 'entity') current.cursor = null;
          setLoaded([...current.loaded]);
        }
        while (current.loaded.length < current.target) {
          if (current.queue.length > 0) {
            const window = current.queue.splice(0, EVIDENCE_BATCH_MAX);
            const links = await getEvidenceBatch(host, window);
            if (stale()) return;
            // Request order, whatever the answer's: an id the API omitted is simply absent.
            const byId = new Map(links.map((link) => [link.id, link]));
            for (const evidenceId of window) {
              const link = byId.get(evidenceId);
              if (link) current.loaded.push(link);
            }
            setLoaded([...current.loaded]);
          } else if (current.cursor !== null) {
            const page = await getEntityTimeline(
              host,
              id,
              { limit: TIMELINE_PAGE, ...(current.cursor ? { cursor: current.cursor } : {}) },
            );
            if (stale()) return;
            current.cursor = page.nextCursor;
            for (const evidenceId of evidenceIdsOf(page.items)) {
              if (current.seen.has(evidenceId)) continue;
              current.seen.add(evidenceId);
              current.queue.push(evidenceId);
            }
          } else {
            break;
          }
        }
        setExhausted(current.queue.length === 0 && current.cursor === null);
      } catch (err) {
        if (stale() || isAbortError(err)) return;
        setError(graphErrorMessage(err, 'Failed to load the evidence'));
      } finally {
        current.busy = false;
        if (!stale()) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [host, id, isMounted, kind],
  );

  useEffect(() => {
    const next = freshRun(run.current.token + 1);
    run.current = next;
    setLoaded([]);
    setVisible(EVIDENCE_PAGE_SIZE);
    setExhausted(false);
    setError(null);
    if (kind === null || id === null) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void fill(next);
  }, [fill, kind, id]);

  const showMore = useCallback(() => {
    const current = run.current;
    const nextVisible = visible + EVIDENCE_PAGE_SIZE;
    setVisible(nextVisible);
    current.target = nextVisible;
    if (current.loaded.length < nextVisible && !exhausted) {
      setIsLoadingMore(true);
      void fill(current);
    }
  }, [exhausted, fill, visible]);

  const retry = useCallback(() => {
    setError(null);
    const current = run.current;
    if (current.loaded.length === 0) setIsLoading(true);
    else setIsLoadingMore(true);
    void fill(current);
  }, [fill]);

  const items = loaded.slice(0, visible);
  return {
    items,
    isLoading,
    isLoadingMore,
    error,
    hasMore: loaded.length > visible || (!exhausted && error === null && !isLoading),
    showMore,
    retry,
  };
}
