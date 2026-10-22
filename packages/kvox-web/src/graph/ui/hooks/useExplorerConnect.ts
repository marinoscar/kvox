/**
 * The explorer's "What connects these" state (GIC-14, #675), kept out of the page:
 *
 *   - "Find connections" on a multi-selection asks `POST /api/graph/connect` with
 *     the marked entities and merges the answer's slice into the canvas;
 *   - `?connectNotes=id1,id2,…` (the notes library and the note page) asks with
 *     those notes, seeds the canvas from the answer when the URL has no `seed`,
 *     and asks again on a reload so the shared entities are ringed again;
 *   - the shared entities (and a bridge the user shows) are ringed on the canvas.
 *
 * The URL carries `connectNotes` only; the answer itself is never in it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GraphSlice } from '../../headless/clients/graph.js';
import { GRAPH_CONNECT_MAX_DOCUMENTS, GRAPH_CONNECT_MAX_ENTITIES } from '../../headless/clients/graph.js';
import { connectSeedIds, sharedIdSet } from '../components/explorer/connect/connectModel.js';
import { useGraphConnect, type UseGraphConnectResult } from './useGraphConnect.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses `?connectNotes=`: distinct note ids, at most the API's limit, anything that is not a UUID dropped.
 *
 * @param raw - The parameter's value, or `null`.
 * @returns The ids, in order; empty for none.
 *
 * @stability experimental
 */
export function parseConnectNotes(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => UUID.test(id));
  return [...new Set(ids)].slice(0, GRAPH_CONNECT_MAX_DOCUMENTS);
}

/**
 * Options of {@link useExplorerConnect}.
 *
 * @stability experimental
 */
export interface UseExplorerConnectOptions {
  /** The raw `connectNotes` URL parameter. */
  connectNotesParam: string | null;
  /** Whether the URL already names `seed`s: then the answer does not seed the canvas. */
  hasSeedParam: boolean;
  /** Writes `seed` into the URL (the explorer then loads it). */
  setSeeds: (ids: string[]) => void;
  /** Removes `connectNotes` from the URL. */
  clearConnectNotes: () => void;
  /** Merges a slice into the canvas. */
  addSlice: (slice: GraphSlice) => void;
  /** The `as_of` date in force, or `null` for now. */
  asOf: string | null;
}

/**
 * What {@link useExplorerConnect} returns.
 *
 * @stability experimental
 */
export interface UseExplorerConnectResult {
  /** The request and its answer. */
  connect: UseGraphConnectResult;
  /** The results panel has something to show (an answer, a request, or an error). */
  open: boolean;
  /** Ask about these entities (the multi-selection's "Find connections"). */
  findConnections: (entityIds: string[]) => void;
  /** The nodes to ring: the shared entities, plus a bridge the user asked to see. The page keeps those the canvas draws. */
  ringIds: ReadonlySet<string>;
  /** Ring a bridge's nodes. */
  showBridge: (nodeIds: string[]) => void;
  /** Forget the answer and leave `?connectNotes`. */
  dismiss: () => void;
  /** Asks the same question again. */
  retry: () => void;
  /** `?connectNotes` was given but nothing can be drawn: say why instead of waiting. */
  earlyState: 'empty' | 'error' | null;
}

/**
 * Holds the explorer's connect request, answer and rings.
 *
 * @param options - See {@link UseExplorerConnectOptions}.
 * @returns See {@link UseExplorerConnectResult}.
 *
 * @stability experimental
 */
export function useExplorerConnect(options: UseExplorerConnectOptions): UseExplorerConnectResult {
  const { connectNotesParam, hasSeedParam, setSeeds, clearConnectNotes, addSlice, asOf } = options;
  const connect = useGraphConnect();
  const noteIds = useMemo(() => parseConnectNotes(connectNotesParam), [connectNotesParam]);
  const noteKey = noteIds.join(',');
  const [bridgeIds, setBridgeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const lastParams = useRef<Parameters<UseGraphConnectResult['run']>[0] | null>(null);
  const latest = useRef({ hasSeedParam, setSeeds, addSlice });
  latest.current = { hasSeedParam, setSeeds, addSlice };

  const run = connect.run;
  const clear = connect.clear;

  // `?connectNotes=`: ask, then seed the canvas from the answer (once per value) unless the URL already has seeds.
  useEffect(() => {
    if (!noteKey) return;
    const params = { noteIds: noteKey.split(','), ...(asOf ? { asOf } : {}) };
    lastParams.current = params;
    let cancelled = false;
    void run(params).then((response) => {
      if (cancelled || !response) return;
      if (!latest.current.hasSeedParam) {
        const seeds = connectSeedIds(response);
        if (seeds.length > 0) latest.current.setSeeds(seeds);
      }
      setSeededFor(noteKey);
    });
    return () => {
      cancelled = true;
    };
    // `asOf` re-asks: the rings follow the date.
  }, [noteKey, asOf, run]);

  const findConnections = useCallback(
    (entityIds: string[]) => {
      const ids = [...new Set(entityIds)].slice(0, GRAPH_CONNECT_MAX_ENTITIES);
      const params = { entityIds: ids, ...(asOf ? { asOf } : {}) };
      lastParams.current = params;
      setBridgeIds(new Set());
      void run(params).then((response) => {
        if (response) latest.current.addSlice(response.slice);
      });
    },
    [asOf, run],
  );

  const ringIds = useMemo(
    () => new Set<string>([...sharedIdSet(connect.result), ...bridgeIds]),
    [connect.result, bridgeIds],
  );

  const dismiss = useCallback(() => {
    clear();
    setBridgeIds(new Set());
    setSeededFor(null);
    lastParams.current = null;
    if (noteKey) clearConnectNotes();
  }, [clear, clearConnectNotes, noteKey]);

  const retry = useCallback(() => {
    if (lastParams.current) void run(lastParams.current);
  }, [run]);

  const open = connect.result !== null || connect.isLoading || connect.error !== null;
  let earlyState: UseExplorerConnectResult['earlyState'] = null;
  if (noteKey) {
    if (connect.error && !connect.isLoading) earlyState = 'error';
    else if (seededFor === noteKey && connect.result && connectSeedIds(connect.result).length === 0) earlyState = 'empty';
  }

  return {
    connect,
    open,
    findConnections,
    ringIds,
    showBridge: (nodeIds) => setBridgeIds(new Set(nodeIds)),
    dismiss,
    retry,
    earlyState,
  };
}
