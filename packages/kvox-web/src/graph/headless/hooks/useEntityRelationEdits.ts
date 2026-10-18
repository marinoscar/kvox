/**
 * `useEntityRelationEdits` — the manual relation edit of one entity (#586):
 * set a Person's manager, employer or role, or remove a wrong one.
 *
 * Mutations only; the caller re-reads whatever it shows (the connections, the
 * brief) once a call resolves. Like every graph hook it RESOLVES rather than
 * throws: a failure is the `error` string the dialog renders, and the call
 * returns `null`.
 */

import { useCallback, useState } from 'react';

import { removeEntityRelation, setEntityRelation } from '../clients/graph.js';
import type { RemoveEntityRelationResult, SetEntityRelationBody, SetEntityRelationResult } from '../clients/graph.js';
import { graphErrorMessage } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * What {@link useEntityRelationEdits} returns.
 *
 * @stability experimental
 */
export interface UseEntityRelationEditsResult {
  /** Sets a manager (`REPORTS_TO`), employer (`WORKS_FOR`) or role (`HAS_ROLE`); `null` when it failed (see `error`). */
  setRelation: (body: SetEntityRelationBody) => Promise<SetEntityRelationResult | null>;
  /** Removes a wrong relation from this entity; `null` when it failed (see `error`). */
  removeRelation: (relationId: string) => Promise<RemoveEntityRelationResult | null>;
  /** A call is in flight. */
  isSaving: boolean;
  /** The last failure's message, or `null`. Cleared when a call starts. */
  error: string | null;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * The manual relation edits of `entityId`.
 *
 * @stability experimental
 */
export function useEntityRelationEdits(entityId: string): UseEntityRelationEditsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(call: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsSaving(true);
      setError(null);
      try {
        return await call();
      } catch (err) {
        if (isMounted()) setError(graphErrorMessage(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  const setRelation = useCallback(
    (body: SetEntityRelationBody) => run(() => setEntityRelation(host, entityId, body), 'Could not save this change'),
    [entityId, host, run],
  );
  const removeRelation = useCallback(
    (relationId: string) => run(() => removeEntityRelation(host, entityId, relationId), 'Could not remove this'),
    [entityId, host, run],
  );
  const clearError = useCallback(() => setError(null), []);

  return { setRelation, removeRelation, isSaving, error, clearError };
}
