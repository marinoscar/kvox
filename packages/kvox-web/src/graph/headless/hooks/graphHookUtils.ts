/**
 * Shared plumbing for the graph read hooks (#373).
 *
 * Every graph hook RESOLVES rather than throws and reports a failure as a
 * STRING the page renders — the contract `useNotes`/`useTranscripts` set.
 */

import { useCallback, useEffect, useRef } from 'react';


import { KvoxApiError } from '../../../core/headless/index.js';
/**
 * The graph API answers "not yours", "doesn't exist", "not reviewed" and
 * "merged away" with one identical 404 (#370). The copy must cover all four
 * without implying which.
 *
 * @stability experimental
 */
export const GRAPH_NOT_FOUND_MESSAGE =
  'This page does not exist, or you no longer have access to it';

/**
 * Turns a failed graph request into the sentence a page renders: the not-found copy for a 404, a permission message for a 403, otherwise the API's message or the fallback.
 *
 * @stability experimental
 */
export function graphErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof KvoxApiError) {
    if (err.status === 404) return GRAPH_NOT_FOUND_MESSAGE;
    if (err.status === 403) return 'You do not have permission to view your knowledge graph';
    return err.message || fallback;
  }
  return fallback;
}

/**
 * Tells whether an error is an `AbortError`, which hooks ignore because it comes from their own cancelled request.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
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
