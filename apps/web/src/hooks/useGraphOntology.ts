/**
 * `useGraphOntology` — the caller's effective ontology (`GET /api/graph/ontology`),
 * the payload every graph form and type filter is generated from (§13, §17.4).
 *
 * MODULE-LEVEL CACHE, one fetch per session: the effective schema changes only
 * when the user toggles a domain or defines an attribute, both rare, and every
 * graph surface wants it. `clearGraphOntologyCache()` is exported for tests and
 * for the settings card that changes it.
 *
 * ⚠ Issue #367 specifies this same hook (`{ ontology, isLoading, error }`).
 * This is a minimal implementation of that contract, created here because #367
 * had not merged; whichever lands second keeps one file.
 */

import { useEffect, useState } from 'react';

import { getGraphOntology } from '../services/graph';
import type { GraphOntology } from '../services/graph';
import { graphErrorMessage } from './graphHookUtils';
import { useIsMounted } from './useIsMounted';

let cached: GraphOntology | null = null;
let inflight: Promise<GraphOntology> | null = null;

export function clearGraphOntologyCache(): void {
  cached = null;
  inflight = null;
}

function loadOntology(): Promise<GraphOntology> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = getGraphOntology()
      .then((payload) => {
        cached = payload;
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export interface UseGraphOntologyResult {
  ontology: GraphOntology | null;
  isLoading: boolean;
  error: string | null;
}

export function useGraphOntology(enabled = true): UseGraphOntologyResult {
  const [ontology, setOntology] = useState<GraphOntology | null>(cached);
  const [isLoading, setIsLoading] = useState(enabled && !cached);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    if (cached) {
      setOntology(cached);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void loadOntology()
      .then((payload) => {
        if (!isMounted()) return;
        setOntology(payload);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!isMounted()) return;
        setError(graphErrorMessage(err, 'Failed to load your graph schema'));
      })
      .finally(() => {
        if (isMounted()) setIsLoading(false);
      });
  }, [enabled, isMounted]);

  return { ontology, isLoading, error };
}
