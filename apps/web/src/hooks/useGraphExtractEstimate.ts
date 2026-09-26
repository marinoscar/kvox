/**
 * What extracting one note into the graph would cost (#368, epic #346;
 * ontology.md §20 "the estimate before spending").
 *
 * `GET /api/graph/extract/estimate?noteId&model` is counted with the
 * provider's tokenizer over the exact prompt a run would send, and needs no
 * API key — `keyConfigured` says whether the caller has one. The extract
 * dialog asks on open and again whenever the model changes, DEBOUNCED so a
 * user arrowing through the model list does not fire one request per row.
 *
 * A stale answer never lands: every request is tagged, and only the latest
 * one may write state.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { getExtractEstimate, graphConflictReason } from '../services/graph';
import type { ExtractionEstimate, GraphConflictReason } from '../services/graph';
import { useIsMounted } from './useIsMounted';

export const EXTRACT_ESTIMATE_DEBOUNCE_MS = 300;

export interface UseGraphExtractEstimateReturn {
  estimate: ExtractionEstimate | null;
  isLoading: boolean;
  /** A sentence for the dialog, or null. */
  error: string | null;
  /** `details.reason` of a 409 refusal, when that is what failed. */
  conflictReason: GraphConflictReason | null;
  /** The 400 named an unpermitted model (#360). */
  modelNotPermitted: boolean;
}

export function useGraphExtractEstimate(
  noteId: string,
  model: string | null,
  options: { enabled?: boolean } = {},
): UseGraphExtractEstimateReturn {
  const enabled = options.enabled ?? true;
  const [estimate, setEstimate] = useState<ExtractionEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictReason, setConflictReason] = useState<GraphConflictReason | null>(null);
  const [modelNotPermitted, setModelNotPermitted] = useState(false);
  const isMounted = useIsMounted();
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || !noteId) return;
    const id = ++requestId.current;
    setIsLoading(true);
    const timer = window.setTimeout(() => {
      getExtractEstimate(noteId, model ?? undefined).then(
        (answer) => {
          if (!isMounted() || id !== requestId.current) return;
          setEstimate(answer);
          setError(null);
          setConflictReason(null);
          setModelNotPermitted(false);
          setIsLoading(false);
        },
        (err: unknown) => {
          if (!isMounted() || id !== requestId.current) return;
          setEstimate(null);
          setConflictReason(graphConflictReason(err));
          const details = err instanceof ApiError ? (err.details as { reason?: unknown } | undefined) : undefined;
          setModelNotPermitted(
            err instanceof ApiError && err.status === 400 && details?.reason === 'model_not_permitted',
          );
          setError(err instanceof ApiError && err.message ? err.message : 'The cost could not be estimated');
          setIsLoading(false);
        },
      );
    }, EXTRACT_ESTIMATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, isMounted, model, noteId]);

  return { estimate, isLoading, error, conflictReason, modelNotPermitted };
}
