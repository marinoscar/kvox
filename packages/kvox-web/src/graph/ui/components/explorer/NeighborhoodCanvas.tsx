/**
 * The entity page's neighbourhood drawing (#374; spec §13) — a slice turned
 * into a graphology graph by the same `explorerModel.mergeSlice` the explorer
 * uses (deterministic ring placement around the entity), drawn by the same
 * `GraphCanvas`. Lives under `explorer/` and is lazy-loaded by
 * `NeighborhoodWidget`, so graphology and sigma stay out of the entity page's
 * own chunk.
 */

import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';

import type { GraphSlice } from '../../../headless/clients/graph.js';
import { GraphCanvas } from './GraphCanvas.js';
import {
  createExplorerState,
  mergeSlice,
  type ExplorerGraph,
  type ExplorerPalette,
} from './explorerModel.js';

/**
 * The props of neighborhood canvas.
 *
 * @stability experimental
 */
export interface NeighborhoodCanvasProps {
  /** The slice. */
  slice: GraphSlice;
  /** The id of the selected. */
  selectedId: string | null;
  /** The layout. */
  layout: 'forceatlas' | 'static';
  /** Whether interactive applies. */
  interactive: boolean;
  /** The height. */
  height: number | string;
  /** Called when node click. */
  onNodeClick: (id: string, label: string, type: string, nodeKind: 'entity' | 'item') => void;
  /** Called when stage click. */
  onStageClick: () => void;
  /** The aria label. */
  ariaLabel: string;
}

export function buildNeighborhoodGraph(slice: GraphSlice, palette?: ExplorerPalette): ExplorerGraph {
  const state = createExplorerState();
  mergeSlice(state, slice, { palette });
  return state.graph;
}

export function NeighborhoodCanvas({
  slice,
  selectedId,
  layout,
  interactive,
  height,
  onNodeClick,
  onStageClick,
  ariaLabel,
}: NeighborhoodCanvasProps) {
  const theme = useTheme();
  const graph = useMemo(() => buildNeighborhoodGraph(slice, theme), [slice, theme]);
  const visibleIds = useMemo(() => new Set(graph.nodes()), [graph]);

  return (
    <GraphCanvas
      graph={graph}
      version={0}
      visibleIds={visibleIds}
      selectedId={selectedId}
      layout={layout}
      interactive={interactive}
      height={height}
      ariaLabel={ariaLabel}
      onNodeClick={(id) => {
        const attrs = graph.getNodeAttributes(id);
        onNodeClick(id, attrs.label, attrs.entityType, attrs.nodeKind);
      }}
      onNodeDoubleClick={() => undefined}
      onStageClick={onStageClick}
    />
  );
}
