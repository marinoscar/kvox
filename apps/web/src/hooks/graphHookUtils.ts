/**
 * Shared plumbing for the graph read hooks (#373).
 *
 * Every graph hook RESOLVES rather than throws and reports a failure as a
 * STRING the page renders — the contract `useNotes`/`useTranscripts` set.
 */

import { useCallback, useEffect, useRef } from 'react';

import { ApiError } from '../services/api';

/**
 * The graph API answers "not yours", "doesn't exist", "not reviewed" and
 * "merged away" with one identical 404 (#370). The copy must cover all four
 * without implying which.
 */
export const GRAPH_NOT_FOUND_MESSAGE =
  'This page does not exist, or you no longer have access to it';

export function graphErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return GRAPH_NOT_FOUND_MESSAGE;
    if (err.status === 403) return 'You do not have permission to view your knowledge graph';
    return err.message || fallback;
  }
  return fallback;
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * One `AbortController` per request, the previous one aborted when a new one
 * starts and the last one aborted on unmount — so a slow answer for the
 * previous entity can never land on the next one's page.
 */
export function useAbortControllers(): () => AbortController {
  const current = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      current.current?.abort();
    },
    [],
  );

  return useCallback(() => {
    current.current?.abort();
    const next = new AbortController();
    current.current = next;
    return next;
  }, []);
}
