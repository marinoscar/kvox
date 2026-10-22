/**
 * `useHopQuotes` — the top quote under each hop of the shown path (GIC-13,
 * #674). One `GET /graph/evidence/by-subject` per distinct edge, newest source
 * first (the same call the inspector's Evidence tab makes), cached for the
 * life of the hook so switching between paths that share an edge asks once.
 *
 * A hop whose `evidenceSubject` is `null` (it touches a person fact, which may
 * be sensitive) is never asked about.
 */

import { useEffect, useRef, useState } from 'react';

import { useKvoxHost } from '../../../../../core/headless/index.js';
import { getSubjectEvidence, type EvidenceLink } from '../../../../headless/clients/graph.js';
import { isAbortError } from '../../../../headless/hooks/graphHookUtils.js';
import type { PathHopView } from './pathModel.js';

/**
 * The quote state of one hop.
 *
 * @stability experimental
 */
export interface HopQuote {
  /** `none` when the edge has no citation (or may not be asked about). */
  status: 'loading' | 'ready' | 'none' | 'error';
  /** The best citation: the newest whose source still exists, else the newest. */
  link: EvidenceLink | null;
}

/** The citation a hop shows: the newest whose source is still there, else the newest. */
export function topQuote(links: readonly EvidenceLink[]): EvidenceLink | null {
  return links.find((link) => link.source.available) ?? links[0] ?? null;
}

/**
 * Loads the top quote of every hop given, keyed by edge id.
 *
 * @param hops - The hops of the shown path.
 * @returns The quotes by edge id; a hop not yet asked about is absent.
 *
 * @stability experimental
 */
export function useHopQuotes(hops: readonly PathHopView[]): ReadonlyMap<string, HopQuote> {
  const host = useKvoxHost();
  const [quotes, setQuotes] = useState<ReadonlyMap<string, HopQuote>>(() => new Map());
  const asked = useRef(new Set<string>());
  const hopKey = hops.map((hop) => hop.edgeId).join('|');

  useEffect(() => {
    const controller = new AbortController();
    const fresh = hops.filter((hop) => !asked.current.has(hop.edgeId));
    if (fresh.length === 0) return undefined;
    const patch = (edgeId: string, quote: HopQuote) => setQuotes((previous) => new Map(previous).set(edgeId, quote));
    for (const hop of fresh) {
      asked.current.add(hop.edgeId);
      if (!hop.evidenceSubject) {
        patch(hop.edgeId, { status: 'none', link: null });
        continue;
      }
      patch(hop.edgeId, { status: 'loading', link: null });
      getSubjectEvidence(host, hop.evidenceSubject.kind, hop.evidenceSubject.id, controller.signal)
        .then((links) => {
          const link = topQuote(links);
          patch(hop.edgeId, { status: link ? 'ready' : 'none', link });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || controller.signal.aborted) {
            // Forget it, so the next render of this path asks again.
            asked.current.delete(hop.edgeId);
            return;
          }
          patch(hop.edgeId, { status: 'error', link: null });
        });
    }
    return () => controller.abort();
    // The edge ids stand for the hops.
  }, [hopKey]);

  return quotes;
}
