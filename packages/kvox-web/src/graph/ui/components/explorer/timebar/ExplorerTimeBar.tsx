/**
 * `ExplorerTimeBar` — {@link TimeBar} wired to the explorer (GIC-15, #676).
 *
 * It reads the visible graph's node ids, asks the API for their activity
 * (`GET /api/graph/activity`) and turns the brush and the pointer into the one
 * thing the canvas needs: the set of nodes to dim.
 *
 *   - a BRUSH dims every visible node with no evidence in the window (and a
 *     node the API has no dated evidence for);
 *   - POINTING at a bar lights the nodes active in that bucket and dims the rest.
 *
 * The page owns the URL (`from`, `to`) and the `as_of` it derives from the
 * range; this component only reports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GRAPH_ACTIVITY_MAX_IDS, type GraphActivityBucket } from '../../../../headless/clients/graph.js';
import { useGraphActivity } from '../../../../headless/hooks/useGraphActivity.js';
import type { ExplorerGraph } from '../explorerModel.js';
import { TimeBar } from './TimeBar.js';
import { parseDay, type TimeRange } from './timeAxis.js';
import { activeEntities, activeInRange, dimmedFrom } from './timeBarModel.js';

/**
 * Props of {@link ExplorerTimeBar}.
 *
 * @stability experimental
 */
export interface ExplorerTimeBarProps {
  /** The explorer's graph. It is mutated in place; `version` says when. */
  graph: ExplorerGraph;
  /** Increments on every mutation of `graph`. */
  version: number;
  /** The ids the canvas draws. */
  visibleIds: ReadonlySet<string>;
  /** The selected nodes (the inspector's node and the marked ones); their activity is overlaid. */
  selectedIds: readonly string[];
  /** The brush from the URL, or `null`. */
  range: TimeRange | null;
  /** Called with a new brush, or `null` to clear it. */
  onRangeChange: (range: TimeRange | null) => void;
  /** Called with the nodes to dim, or `null` for none. */
  onDimmedIdsChange: (ids: ReadonlySet<string> | null) => void;
  /** Label of a type key. */
  typeLabel?: (key: string) => string;
}

/** The ids to ask about: real nodes (no "+N more" stubs), at most the API's limit. */
export function activityIds(graph: ExplorerGraph, visibleIds: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const id of visibleIds) {
    if (!graph.hasNode(id) || graph.getNodeAttribute(id, 'isStub')) continue;
    ids.push(id);
    if (ids.length >= GRAPH_ACTIVITY_MAX_IDS) break;
  }
  return ids;
}

/**
 * The TimeBar for the explorer page.
 *
 * @stability experimental
 */
export function ExplorerTimeBar({
  graph,
  version,
  visibleIds,
  selectedIds,
  range,
  onRangeChange,
  onDimmedIdsChange,
  typeLabel,
}: ExplorerTimeBarProps) {
  const [bucket, setBucket] = useState<GraphActivityBucket>('month');
  const [hover, setHover] = useState<{ start: number; end: number } | null>(null);

  // The graph is mutated in place: `version` is what changes.
  const ids = useMemo(
    () => activityIds(graph, visibleIds),
    [graph, visibleIds, version],
  );
  const { data, isLoading, error } = useGraphActivity(ids, bucket);

  const visibleKey = ids.join(',');
  const dimmed = useMemo(() => {
    if (!data) return null;
    let active: Set<string> | null = null;
    if (hover) active = activeEntities(data, hover.start, hover.end);
    else if (range) active = activeInRange(data, range);
    return dimmedFrom(ids, active);
  }, [data, hover, range?.from, range?.to, visibleKey]);

  // Report only a real change: the set is rebuilt on every render of the page.
  const lastKey = useRef<string | null>('');
  useEffect(() => {
    const key = dimmed ? [...dimmed].sort().join(',') : null;
    if (key === lastKey.current) return;
    lastKey.current = key;
    onDimmedIdsChange(dimmed);
  }, [dimmed, onDimmedIdsChange]);
  useEffect(() => () => onDimmedIdsChange(null), [onDimmedIdsChange]);

  const onHoverBucket = useCallback((next: { start: number; end: number } | null) => setHover(next), []);

  return (
    <TimeBar
      activity={data}
      bucket={bucket}
      onBucketChange={setBucket}
      range={range && parseDay(range.from) !== null ? range : null}
      onRangeChange={onRangeChange}
      selectedIds={selectedIds}
      onHoverBucket={onHoverBucket}
      typeLabel={typeLabel}
      loading={isLoading}
      error={error}
    />
  );
}
