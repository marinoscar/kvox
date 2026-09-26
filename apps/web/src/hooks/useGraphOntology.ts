/**
 * The caller's effective ontology, fetched once per session (#367, epic #346).
 *
 * Every schema-driven form in the proposal review sheet (`SchemaForm`,
 * `ProposalItemEditor`, the relation-type picker) renders from this payload —
 * `docs/specs/ontology.md` §13/§17.4: a type added to the ontology needs zero
 * web changes. The payload changes only when the user edits their own
 * attributes or domains, so a module-level cache shared by every consumer is
 * enough; `invalidateGraphOntology()` drops it (the settings page may call it
 * after a write, and tests call it between cases).
 */

import { useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import { getGraphOntology } from '../services/graph';
import type { GraphOntology } from '../services/graph';
import { useIsMounted } from './useIsMounted';

let cached: GraphOntology | null = null;
let inFlight: Promise<GraphOntology> | null = null;

/** Forget the cached payload. The next consumer to mount fetches again. */
export function invalidateGraphOntology(): void {
  cached = null;
  inFlight = null;
}

function load(): Promise<GraphOntology> {
  if (!inFlight) {
    inFlight = getGraphOntology().then(
      (payload) => {
        cached = payload;
        return payload;
      },
      (err: unknown) => {
        // A failure is not cached: the next mount may try again.
        inFlight = null;
        throw err;
      },
    );
  }
  return inFlight;
}

export interface UseGraphOntologyReturn {
  ontology: GraphOntology | null;
  isLoading: boolean;
  error: string | null;
}

export function useGraphOntology(options: { enabled?: boolean } = {}): UseGraphOntologyReturn {
  const enabled = options.enabled ?? true;
  const [ontology, setOntology] = useState<GraphOntology | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled || ontology) return;
    load().then(
      (payload) => {
        if (isMounted()) setOntology(payload);
      },
      (err: unknown) => {
        if (isMounted()) {
          setError(err instanceof ApiError ? err.message : 'Your graph schema could not be loaded');
        }
      },
    );
  }, [enabled, isMounted, ontology]);

  return { ontology, isLoading: enabled && !ontology && !error, error };
}
