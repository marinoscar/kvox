/**
 * Personal synonyms (#767):
 *
 *   - `useGraphSynonyms()` — the caller's synonym groups
 *     (`GET /api/graph/synonyms`), with `create`, `update` and `remove`
 *     (`POST`, `PATCH`, `DELETE /api/graph/synonyms[/:id]`) that keep the
 *     list in step without a second read.
 *
 * Like every graph hook it RESOLVES rather than throws: a failure is a string
 * the caller renders. Plain state plus an abort per read, no cache. The
 * server normalizes, de-duplicates and validates; the hook only reports.
 */

import { useCallback, useEffect, useState } from 'react';

import { SYNONYM_MAX_GROUPS } from '@marinoscar/kvox-contract/graph';

import { createSynonym, deleteSynonym, listSynonyms, synonymErrorReason, updateSynonym } from '../clients/graph.js';
import type { SynonymGroup, SynonymGroupInput } from '../clients/graph.js';
import { graphErrorMessage, isAbortError, useAbortControllers } from './graphHookUtils.js';

import { useIsMounted, useKvoxHost } from '../../../core/headless/index.js';

/**
 * The sentence for each reason the API refuses a synonym write with.
 *
 * @stability experimental
 */
export const SYNONYM_ERROR_COPY: Readonly<Record<string, string>> = {
  synonyms_too_few: 'Add at least two different names.',
  synonyms_invalid_term: 'One of the names is not valid. Use up to 120 characters, with at least one letter or number.',
  unknown_entity_type: 'That type is not in your schema. Pick another type, or Any type.',
  synonyms_limit: `You can keep up to ${SYNONYM_MAX_GROUPS} synonym groups. Delete one to add another.`,
};

/**
 * Turns a failed synonym write into the sentence a page renders: the copy for a known `details.reason`, otherwise the graph fallback.
 *
 * @stability experimental
 */
export function synonymErrorMessage(err: unknown, fallback: string): string {
  const reason = synonymErrorReason(err);
  if (reason && SYNONYM_ERROR_COPY[reason]) return SYNONYM_ERROR_COPY[reason];
  return graphErrorMessage(err, fallback);
}

/**
 * Options of {@link useGraphSynonyms}.
 *
 * @stability experimental
 */
export interface UseGraphSynonymsOptions {
  /** `false` skips the read (and reports an empty list); default `true`. */
  enabled?: boolean;
}

/**
 * What {@link useGraphSynonyms} returns.
 *
 * @stability experimental
 */
export interface UseGraphSynonymsResult {
  /** The groups, as the API orders them; empty until loaded or when loading failed. */
  groups: SynonymGroup[];
  /** The first load, or a `reload`, is in flight. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  error: string | null;
  /** Reads the list again. */
  reload: () => Promise<void>;
  /** Adds a group; resolves to it, or `null` when refused (see `actionError`). */
  create: (input: SynonymGroupInput) => Promise<SynonymGroup | null>;
  /** Replaces a group's names and type; resolves to it, or `null` when refused (see `actionError`). */
  update: (id: string, input: SynonymGroupInput) => Promise<SynonymGroup | null>;
  /** Deletes a group; resolves `true` when it is gone. */
  remove: (id: string) => Promise<boolean>;
  /** A write is in flight. */
  isSaving: boolean;
  /** The last write's failure, as a sentence, or `null`. Cleared when a write starts. */
  actionError: string | null;
  /** Clears `actionError`. */
  clearActionError: () => void;
}

/**
 * Loads and edits the caller's personal synonym groups.
 *
 * @stability experimental
 */
export function useGraphSynonyms(options: UseGraphSynonymsOptions = {}): UseGraphSynonymsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const nextController = useAbortControllers();
  const enabled = options.enabled ?? true;
  const [groups, setGroups] = useState<SynonymGroup[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const controller = nextController();
    setIsLoading(true);
    try {
      const rows = await listSynonyms(host, controller.signal);
      if (!isMounted() || controller.signal.aborted) return;
      setGroups(rows);
      setError(null);
    } catch (err) {
      if (!isMounted() || isAbortError(err) || controller.signal.aborted) return;
      setError(graphErrorMessage(err, 'Could not load your synonyms'));
    } finally {
      if (isMounted() && !controller.signal.aborted) setIsLoading(false);
    }
  }, [enabled, host, isMounted, nextController]);

  useEffect(() => {
    setGroups([]);
    setError(null);
    setIsLoading(enabled);
    void reload();
  }, [enabled, reload]);

  const write = useCallback(
    async <T,>(run: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsSaving(true);
      setActionError(null);
      try {
        return await run();
      } catch (err) {
        if (isMounted()) setActionError(synonymErrorMessage(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  const create = useCallback(
    async (input: SynonymGroupInput) => {
      const group = await write(() => createSynonym(host, input), 'Could not save these synonyms');
      if (group && isMounted()) setGroups((current) => [group, ...current.filter((row) => row.id !== group.id)]);
      return group;
    },
    [host, isMounted, write],
  );

  const update = useCallback(
    async (id: string, input: SynonymGroupInput) => {
      const group = await write(() => updateSynonym(host, id, input), 'Could not save these synonyms');
      if (group && isMounted()) setGroups((current) => current.map((row) => (row.id === id ? group : row)));
      return group;
    },
    [host, isMounted, write],
  );

  const remove = useCallback(
    async (id: string) => {
      const done = await write(async () => {
        await deleteSynonym(host, id);
        return true;
      }, 'Could not delete these synonyms');
      if (done && isMounted()) setGroups((current) => current.filter((row) => row.id !== id));
      return done === true;
    },
    [host, isMounted, write],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return { groups, isLoading, error, reload, create, update, remove, isSaving, actionError, clearActionError };
}
