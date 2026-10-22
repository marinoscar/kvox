/**
 * `useExplorerLenses` — the user's saved lenses (GIC-17, #678).
 *
 * Stored in the per-user settings document under `graph.explorer.lenses` (the same
 * `GET/PATCH /api/user-settings` the graph preferences use; no table of their own). The
 * list is read once, and every change writes the WHOLE list with `If-Match` carrying the
 * document's version; a 409 (another writer bumped it: the rail, onboarding, another tab)
 * is retried once against the fresh document. On KVox Desktop the same API stores it on the
 * device, so a lens never leaves the machine.
 *
 * The limits (20 lenses, 300 pinned positions each) are checked BEFORE the request by
 * `addLens`, so the user gets a plain sentence; the server enforces them as well.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { KvoxApiError, kvoxGet, kvoxPatch, useIsMounted, useKvoxHost } from '../../../../../core/headless/index.js';
import {
  addLens,
  deleteLens,
  renameLens,
  type ExplorerLens,
} from './lensModel.js';

/** The part of `GET /api/user-settings` this hook reads. */
interface LensSettingsDocument {
  version: number;
  graph?: { explorer?: { lenses?: ExplorerLens[] } };
}

const CONFLICT_MESSAGE = 'Settings were updated elsewhere. Please try again.';

/**
 * What {@link useExplorerLenses} returns.
 *
 * @stability experimental
 */
export interface UseExplorerLensesResult {
  /** The user's saved lenses, oldest first. */
  lenses: ExplorerLens[];
  /** The first read has not settled. */
  isLoading: boolean;
  /** A write is in flight. */
  isSaving: boolean;
  /** A sentence when the last read or write failed or hit a limit, else `null`. */
  error: string | null;
  /** Saves a lens (a limit or a taken name resolves `false` with `error` set). */
  save: (lens: ExplorerLens) => Promise<boolean>;
  /** Renames a lens. */
  rename: (id: string, name: string) => Promise<boolean>;
  /** Deletes a lens. */
  remove: (id: string) => Promise<boolean>;
  /** Clears `error`. */
  clearError: () => void;
}

/**
 * Reads and writes the user's saved explorer lenses.
 *
 * @returns The lenses and the actions on them.
 *
 * @stability experimental
 */
export function useExplorerLenses(): UseExplorerLensesResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const [doc, setDocument] = useState<LensSettingsDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await kvoxGet<LensSettingsDocument>(host, '/user-settings');
        if (isMounted()) setDocument(loaded);
      } catch (err) {
        if (isMounted()) setError(err instanceof KvoxApiError ? err.message : 'Could not load your lenses.');
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    })();
  }, [host, isMounted]);

  const lenses = useMemo(() => doc?.graph?.explorer?.lenses ?? [], [doc]);

  const write = useCallback(
    async (next: ExplorerLens[]): Promise<boolean> => {
      if (!doc) {
        setError('Your lenses are not available right now.');
        return false;
      }
      setIsSaving(true);
      setError(null);
      const send = (version: number) =>
        kvoxPatch<LensSettingsDocument>(
          host,
          '/user-settings',
          { graph: { explorer: { lenses: next } } },
          { headers: { 'If-Match': String(version) } },
        );
      try {
        let saved: LensSettingsDocument;
        try {
          saved = await send(doc.version);
        } catch (err) {
          if (!(err instanceof KvoxApiError) || err.status !== 409) throw err;
          try {
            const fresh = await kvoxGet<LensSettingsDocument>(host, '/user-settings');
            saved = await send(fresh.version);
          } catch (retry) {
            if (retry instanceof KvoxApiError && retry.status === 409) throw new Error(CONFLICT_MESSAGE);
            throw retry;
          }
        }
        if (isMounted()) setDocument(saved);
        return true;
      } catch (err) {
        if (isMounted()) setError(err instanceof Error ? err.message : 'Could not save your lenses.');
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [doc, host, isMounted],
  );

  const save = useCallback(
    async (lens: ExplorerLens) => {
      const edit = addLens(lenses, lens);
      if (!edit.ok) {
        setError(edit.message);
        return false;
      }
      return write(edit.lenses);
    },
    [lenses, write],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      const edit = renameLens(lenses, id, name);
      if (!edit.ok) {
        setError(edit.message);
        return false;
      }
      return write(edit.lenses);
    },
    [lenses, write],
  );

  const remove = useCallback((id: string) => write(deleteLens(lenses, id)), [lenses, write]);
  const clearError = useCallback(() => setError(null), []);

  return { lenses, isLoading, isSaving, error, save, rename, remove, clearError };
}
