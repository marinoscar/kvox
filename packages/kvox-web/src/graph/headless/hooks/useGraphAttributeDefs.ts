/**
 * The caller's own attribute definitions and effective ontology (#369).
 *
 * Two reads the Knowledge graph settings page needs together:
 * `GET /api/graph/ontology` (domains, entity types, built-in attributes) and
 * `GET /api/graph/attribute-defs?includeDeprecated=true` (the user's own). The
 * ontology read is independent of the defs read, so a failure of one is not a
 * failure of the other — the domains section still renders without the defs.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  createAttributeDef,
  deprecateAttributeDef,
  getGraphOntology,
  listAttributeDefs,
  patchAttributeDef,
} from '../clients/graph.js';
import type {
  AttributeDef,
  CreateAttributeDefInput,
  GraphOntology,
  PatchAttributeDefInput,
} from '../clients/graph.js';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
function messageFor(err: unknown, fallback: string): string {
  return err instanceof KvoxApiError && err.message ? err.message : fallback;
}

/**
 * What {@link useGraphEffectiveOntology} returns.
 *
 * @stability experimental
 */
export interface UseGraphEffectiveOntologyReturn {
  /** The effective ontology, or `null` until it loads. */
  ontology: GraphOntology | null;
  /** The ontology is loading. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  loadError: string | null;
  /** Reads the ontology again. */
  refresh: () => Promise<void>;
}

/**
 * The effective ontology, re-readable (`refresh`); the settings page, the index,
 * the explorer and the overview read it. The cached, enabled-gated variant the
 * review sheet uses is {@link useGraphOntology}.
 *
 * @returns The ontology and its load state.
 *
 * @stability experimental
 */
export function useGraphEffectiveOntology(): UseGraphEffectiveOntologyReturn {
  const host = useKvoxHost();
  const [ontology, setOntology] = useState<GraphOntology | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      const next = await getGraphOntology(host);
      if (isMounted()) setOntology(next);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load your graph schema'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [host, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ontology, isLoading, loadError, refresh };
}

/**
 * What {@link useGraphAttributeDefs} returns.
 *
 * @stability experimental
 */
export interface UseGraphAttributeDefsReturn {
  /** The caller's own attribute definitions, deprecated ones included. */
  defs: AttributeDef[];
  /** The definitions are loading. */
  isLoading: boolean;
  /** A message when loading failed, else `null`. */
  loadError: string | null;
  /** Reads the definitions again. */
  refresh: () => Promise<void>;
  /** Creates a definition and reloads the list. Rejects with the `KvoxApiError` so the dialog can map it to a field. */
  create: (input: CreateAttributeDefInput) => Promise<AttributeDef>;
  /** Changes a definition and reloads the list. Rejects with the `KvoxApiError` so the dialog can map it to a field. */
  update: (id: string, input: PatchAttributeDefInput) => Promise<AttributeDef>;
  /** Deprecates a definition (it is hidden, its values are kept) and reloads the list. */
  deprecate: (id: string) => Promise<AttributeDef>;
}

/**
 * Loads the caller's own attribute definitions and exposes create, update and deprecate.
 *
 * @stability experimental
 */
export function useGraphAttributeDefs(): UseGraphAttributeDefsReturn {
  const host = useKvoxHost();
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await listAttributeDefs(host);
      if (isMounted()) setDefs(next);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load your attributes'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const replace = useCallback(
    (row: AttributeDef) => {
      if (!isMounted()) return;
      setDefs((current) => {
        const index = current.findIndex((d) => d.id === row.id);
        if (index === -1) return [...current, row];
        const next = [...current];
        next[index] = row;
        return next;
      });
    },
    [isMounted],
  );

  const create = useCallback(
    async (input: CreateAttributeDefInput) => {
      const row = await createAttributeDef(host, input);
      replace(row);
      return row;
    },
    [replace],
  );

  const update = useCallback(
    async (id: string, input: PatchAttributeDefInput) => {
      const row = await patchAttributeDef(host, id, input);
      replace(row);
      return row;
    },
    [replace],
  );

  const deprecate = useCallback(
    async (id: string) => {
      const row = await deprecateAttributeDef(host, id);
      replace(row);
      return row;
    },
    [replace],
  );

  return { defs, isLoading, loadError, refresh, create, update, deprecate };
}
