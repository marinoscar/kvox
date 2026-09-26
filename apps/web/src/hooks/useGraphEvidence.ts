/**
 * `useGraphEvidence` — one citation's evidence link, for `EvidenceChip` (#373,
 * reused by #380's Ask citations).
 *
 * =============================================================================
 * COALESCED, AND CACHED BY ID
 * =============================================================================
 *
 * A brief renders dozens of numbered chips, each wanting its source's title for
 * its accessible name. One request per chip would be dozens of round trips for
 * one screen, so every id requested in the same tick is collected and fetched
 * with ONE `GET /api/graph/evidence?ids=…` (chunked at 50 by the service). The
 * result lands in a module-level cache keyed by evidence id, so re-rendering a
 * brief — or opening a second entity citing the same line — costs nothing.
 *
 * An id the API silently omits (#370: unknown ids are dropped, never a 404) is
 * cached as `null` — the chip renders "Source no longer available".
 */

import { useEffect, useState } from 'react';

import { getEvidenceBatch } from '../services/graph';
import type { EvidenceLink } from '../services/graph';
import { useIsMounted } from './useIsMounted';

type Settled = EvidenceLink | null;

const cache = new Map<string, Settled>();
const waiting = new Map<string, Array<(value: Settled) => void>>();
const failing = new Map<string, Array<(err: unknown) => void>>();
let queued: Set<string> | null = null;

/** Test seam — forget everything. */
export function clearEvidenceCache(): void {
  cache.clear();
  waiting.clear();
  failing.clear();
  queued = null;
}

async function flush(ids: string[]): Promise<void> {
  try {
    const links = await getEvidenceBatch(ids);
    const byId = new Map(links.map((link) => [link.id, link]));
    for (const id of ids) {
      const value = byId.get(id) ?? null;
      cache.set(id, value);
      for (const resolve of waiting.get(id) ?? []) resolve(value);
      waiting.delete(id);
      failing.delete(id);
    }
  } catch (err) {
    for (const id of ids) {
      for (const reject of failing.get(id) ?? []) reject(err);
      waiting.delete(id);
      failing.delete(id);
    }
  }
}

/** Resolve one evidence id, joining whatever batch is being collected this tick. */
export function requestEvidence(id: string): Promise<Settled> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  return new Promise<Settled>((resolve, reject) => {
    const alreadyQueued = waiting.has(id);
    waiting.set(id, [...(waiting.get(id) ?? []), resolve]);
    failing.set(id, [...(failing.get(id) ?? []), reject]);
    if (alreadyQueued) return;
    if (!queued) {
      queued = new Set();
      // A macrotask, not a microtask: sibling chips' effects run in one
      // commit, but React may flush passive effects across more than one
      // microtask. One timer boundary catches every chip of one render.
      setTimeout(() => {
        const ids = [...(queued ?? [])];
        queued = null;
        void flush(ids);
      }, 0);
    }
    queued.add(id);
  });
}

export interface UseGraphEvidenceResult {
  /** `undefined` while loading; `null` when the source is gone or unknown. */
  data: EvidenceLink | null | undefined;
  isLoading: boolean;
  error: boolean;
}

export function useGraphEvidence(id: string | undefined): UseGraphEvidenceResult {
  const [data, setData] = useState<Settled | undefined>(() =>
    id && cache.has(id) ? (cache.get(id) ?? null) : undefined,
  );
  const [error, setError] = useState(false);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!id) return;
    if (cache.has(id)) {
      setData(cache.get(id) ?? null);
      return;
    }
    setData(undefined);
    setError(false);
    requestEvidence(id).then(
      (value) => {
        if (isMounted()) setData(value);
      },
      () => {
        if (isMounted()) setError(true);
      },
    );
  }, [id, isMounted]);

  return { data, isLoading: data === undefined && !error, error };
}
