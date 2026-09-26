/**
 * The caller's own attribute definitions and effective ontology (#369).
 *
 * Two reads the Knowledge graph settings page needs together: `GET
 * /api/graph/ontology` (domains, entity types, built-in attributes) and `GET
 * /api/graph/attribute-defs?includeDeprecated=true` (the user's own). The
 * ontology read is independent of the defs read, so a failure of one is not a
 * failure of the other — the domains section still renders without the defs.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import {
  createAttributeDef,
  deprecateAttributeDef,
  getGraphOntology,
  listAttributeDefs,
  patchAttributeDef,
} from '../services/graph';
import type {
  AttributeDef,
  CreateAttributeDefInput,
  GraphOntology,
  PatchAttributeDefInput,
} from '../services/graph';
import { useIsMounted } from './useIsMounted';

function messageFor(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

export interface UseGraphOntologyReturn {
  ontology: GraphOntology | null;
  isLoading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
}

export function useGraphOntology(): UseGraphOntologyReturn {
  const [ontology, setOntology] = useState<GraphOntology | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      const next = await getGraphOntology();
      if (isMounted()) setOntology(next);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load your graph schema'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ontology, isLoading, loadError, refresh };
}

export interface UseGraphAttributeDefsReturn {
  defs: AttributeDef[];
  isLoading: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  /** Throws the `ApiError` so the dialog can map it to a field. */
  create: (input: CreateAttributeDefInput) => Promise<AttributeDef>;
  update: (id: string, input: PatchAttributeDefInput) => Promise<AttributeDef>;
  deprecate: (id: string) => Promise<AttributeDef>;
}

export function useGraphAttributeDefs(): UseGraphAttributeDefsReturn {
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const next = await listAttributeDefs();
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
      const row = await createAttributeDef(input);
      replace(row);
      return row;
    },
    [replace],
  );

  const update = useCallback(
    async (id: string, input: PatchAttributeDefInput) => {
      const row = await patchAttributeDef(id, input);
      replace(row);
      return row;
    },
    [replace],
  );

  const deprecate = useCallback(
    async (id: string) => {
      const row = await deprecateAttributeDef(id);
      replace(row);
      return row;
    },
    [replace],
  );

  return { defs, isLoading, loadError, refresh, create, update, deprecate };
}
