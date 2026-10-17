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
 * Props of `NeighborhoodCanvas`, an entity's neighbourhood slice drawn on the shared canvas.
 *
 * @stability experimental
 */
export interface NeighborhoodCanvasProps {
  /** The neighbourhood to draw. */
  slice: GraphSlice;
  /** Id of the selected node, or `null` for none. */
  selectedId: string | null;
  /** `forceatlas` settles the layout; `static` keeps the deterministic ring placement. */
  layout: 'forceatlas' | 'static';
  /** `false` turns off pan, zoom, drag and clicks, so the canvas does not trap scrolling on a phone. */
  interactive: boolean;
  /** Height of the canvas, as a CSS length or a number of pixels. */
  height: number | string;
  /** Called when a node is clicked, with its id, label, type key and whether it is an entity or an item. */
  onNodeClick: (id: string, label: string, type: string, nodeKind: 'entity' | 'item') => void;
  /** Called when empty space is clicked. */
  onStageClick: () => void;
  /** Accessible name of the drawing surface. */
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
