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

import { getGraphOntology } from '../clients/graph.js';
import type { GraphOntology } from '../clients/graph.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
let cached: GraphOntology | null = null;
let inFlight: Promise<GraphOntology> | null = null;

/**
 * Forget the cached payload. The next consumer to mount fetches again.
 *
 * @stability experimental
 */
export function invalidateGraphOntology(): void {
  cached = null;
  inFlight = null;
}

function load(host: KvoxWebHost): Promise<GraphOntology> {
  if (!inFlight) {
    inFlight = getGraphOntology(host).then(
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

/**
 * What {@link useGraphOntology} returns.
 *
 * @stability experimental
 */
export interface UseGraphOntologyReturn {
  /** The effective ontology, or `null` until it loads. */
  ontology: GraphOntology | null;
  /** The ontology is loading. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  error: string | null;
}

/**
 * Reads the effective ontology once per session and shares the cached payload between consumers.
 *
 * @stability experimental
 */
export function useGraphOntology(options: {
  /** Set `false` to skip reading (default `true`). */
  enabled?: boolean;
} = {}): UseGraphOntologyReturn {
  const host = useKvoxHost();
  const enabled = options.enabled ?? true;
  const [ontology, setOntology] = useState<GraphOntology | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!enabled || ontology) return;
    load(host).then(
      (payload) => {
        if (isMounted()) setOntology(payload);
      },
      (err: unknown) => {
        if (isMounted()) {
          setError(err instanceof KvoxApiError ? err.message : 'Your graph schema could not be loaded');
        }
      },
    );
  }, [enabled, host, isMounted, ontology]);

  return { ontology, isLoading: enabled && !ontology && !error, error };
}
