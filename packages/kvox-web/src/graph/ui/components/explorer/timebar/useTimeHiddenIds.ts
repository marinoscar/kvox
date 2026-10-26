/**
 * `useTimeHiddenIds` — the focused view's time filter (#768). With a range set,
 * it asks the API for the activity of the drawn nodes (`GET /api/graph/activity`,
 * the TimeBar's own source) and returns the nodes with NO evidence in the
 * window, which the page takes off the canvas: the time control FILTERS in both
 * views (the full view filters the overview request instead).
 *
 * The seeds and the selection always stay, so the view keeps its anchors; until
 * the activity arrives nothing is hidden.
 */

import { useMemo } from 'react';

import { useGraphActivity } from '../../../../headless/hooks/useGraphActivity.js';
import type { ExplorerState } from '../explorerModel.js';
import { timeHiddenIds } from '../fullGraphModel.js';
import { GRAPH_ACTIVITY_MAX_IDS } from '../../../../headless/clients/graph.js';
import { DAY_MS, bucketForSpan, parseDay, type TimeRange } from './timeAxis.js';
import { activeInRange } from './timeBarModel.js';

const NONE: ReadonlySet<string> = new Set();

/** The real nodes (no "+N more" stubs) to ask about, at most the API's limit (the TimeBar's own rule). */
function activityIds(state: ExplorerState, visibleIds: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const id of visibleIds) {
    if (!state.graph.hasNode(id) || state.graph.getNodeAttribute(id, 'isStub')) continue;
    ids.push(id);
    if (ids.length >= GRAPH_ACTIVITY_MAX_IDS) break;
  }
  return ids;
}

/**
 * The ids the time range takes off a focused view's canvas.
 *
 * @stability experimental
 */
export function useTimeHiddenIds(input: {
  state: ExplorerState;
  version: number;
  /** The ids drawn before the time filter. */
  visibleIds: ReadonlySet<string>;
  /** `null`: no range (All time), nothing hidden and nothing fetched. */
  range: TimeRange | null;
  /** Ids that always stay (the seeds, the selection). */
  keep: readonly string[];
  /** `false`: the filter is off (the full view). */
  enabled: boolean;
}): ReadonlySet<string> {
  const { state, version, visibleIds, range, keep, enabled } = input;
  const on = enabled && range !== null;
  // The graph is mutated in place: `version` is what changes.
  const ids = useMemo(
    () => (on ? activityIds(state, visibleIds) : []),
    [on, state, visibleIds, version],
  );
  const from = range ? parseDay(range.from) : null;
  const to = range ? parseDay(range.to) : null;
  const bucket = from !== null && to !== null ? bucketForSpan(to - from) : 'month';
  const { data } = useGraphActivity(ids, bucket);
  const keepKey = keep.join(',');
  return useMemo(() => {
    if (!on || !range || !data || from === null || to === null || to - from < DAY_MS) return NONE;
    const active = activeInRange(data, range);
    return timeHiddenIds(state, ids, active, new Set(keepKey ? keepKey.split(',') : []));
  }, [on, range?.from, range?.to, data, ids, keepKey, state, version]);
}
