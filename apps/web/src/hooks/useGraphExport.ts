/**
 * `useGraphExport` — request, poll and list RDF exports of the caller's own
 * knowledge graph (#386, epic #349; spec §18.2).
 *
 * `start(format)` POSTs `/api/graph/exports`. A 200 `reused: true` export is
 * normally already `ready`, so the loop below settles on the FIRST answer and
 * the download is offered at once — the point of content addressing. Otherwise
 * it polls `GET /api/graph/exports/:id` every `pollIntervalMs` (2 s) for at
 * most `timeoutMs` (10 min, the job's own runtime cap). The timeout is not a
 * cancellation: the job keeps running, and asking again picks the same export
 * up (the identical request reuses the row).
 *
 * ⚠ EVERY ASYNC RESOLUTION IS GUARDED BY A RUN COUNTER, bumped by `start`,
 * `reset` and unmount — so a closed dialog, or a second Export, never has a
 * stale answer land on top of the new state.
 *
 * Resolves rather than throws, like every graph hook: a failure is a string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  exportGraph,
  getGraphExport,
  graphConflictReason,
  listGraphExports,
  type GraphExport,
  type GraphExportFormat,
} from '../services/graph';
import { graphErrorMessage } from './graphHookUtils';

/** How often a pending export is re-read. */
export const GRAPH_EXPORT_POLL_MS = 2_000;
/** How long an export is polled before the dialog says "still working". */
export const GRAPH_EXPORT_POLL_TIMEOUT_MS = 10 * 60_000;

export type GraphExportPhase = 'idle' | 'working' | 'ready' | 'error' | 'timeout';

export interface UseGraphExportOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface UseGraphExportResult {
  phase: GraphExportPhase;
  /** The export being made (or just made). */
  current: GraphExport | null;
  error: string | null;
  /** The caller's unexpired exports, newest first. */
  exports: GraphExport[];
  listLoading: boolean;
  listError: string | null;
  start: (format: GraphExportFormat) => Promise<void>;
  /** Forget the current export (a new format was chosen) and stop polling. */
  reset: () => void;
  refreshList: () => Promise<void>;
}

const settled = (e: GraphExport) => e.status === 'ready' || e.status === 'failed';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useGraphExport(enabled: boolean, options: UseGraphExportOptions = {}): UseGraphExportResult {
  const pollIntervalMs = options.pollIntervalMs ?? GRAPH_EXPORT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? GRAPH_EXPORT_POLL_TIMEOUT_MS;

  const [phase, setPhase] = useState<GraphExportPhase>('idle');
  const [current, setCurrent] = useState<GraphExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<GraphExport[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const runId = useRef(0);
  const listRun = useRef(0);

  useEffect(
    () => () => {
      runId.current += 1;
      listRun.current += 1;
    },
    [],
  );

  const refreshList = useCallback(async () => {
    listRun.current += 1;
    const run = listRun.current;
    setListLoading(true);
    try {
      const rows = await listGraphExports();
      if (listRun.current !== run) return;
      setExports(rows);
      setListError(null);
    } catch (err) {
      if (listRun.current !== run) return;
      setListError(graphErrorMessage(err, 'Your recent exports could not be loaded.'));
    } finally {
      if (listRun.current === run) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    runId.current += 1;
    setPhase('idle');
    setCurrent(null);
    setError(null);
    void refreshList();
  }, [enabled, refreshList]);

  const reset = useCallback(() => {
    runId.current += 1;
    setPhase('idle');
    setCurrent(null);
    setError(null);
  }, []);

  const start = useCallback(
    async (format: GraphExportFormat) => {
      runId.current += 1;
      const run = runId.current;
      setPhase('working');
      setError(null);
      setCurrent(null);
      try {
        let row = (await exportGraph(format)).export;
        if (runId.current !== run) return;
        setCurrent(row);
        const deadline = Date.now() + timeoutMs;
        while (!settled(row)) {
          if (Date.now() > deadline) {
            if (runId.current === run) setPhase('timeout');
            return;
          }
          await delay(pollIntervalMs);
          if (runId.current !== run) return;
          row = await getGraphExport(row.id);
          if (runId.current !== run) return;
          setCurrent(row);
        }
        if (row.status === 'failed') {
          setPhase('error');
          setError(row.errorMessage ?? 'The export could not be completed. Try again.');
        } else {
          setPhase('ready');
        }
        void refreshList();
      } catch (err) {
        if (runId.current !== run) return;
        setPhase('error');
        setError(
          graphConflictReason(err) === 'graph_empty'
            ? 'Your graph has nothing to export yet. Review a note’s proposal to add people and organizations.'
            : err instanceof ApiError && err.status === 404
              ? 'That export is no longer available. Export again to make a fresh one.'
              : graphErrorMessage(err, 'The export could not be started.'),
        );
      }
    },
    [pollIntervalMs, refreshList, timeoutMs],
  );

  return { phase, current, error, exports, listLoading, listError, start, reset, refreshList };
}
