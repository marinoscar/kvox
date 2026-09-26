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

import type { GraphSlice } from '../../../services/graph';
import GraphCanvas from './GraphCanvas';
import {
  createExplorerState,
  mergeSlice,
  type ExplorerGraph,
  type ExplorerPalette,
} from './explorerModel';

export interface NeighborhoodCanvasProps {
  slice: GraphSlice;
  selectedId: string | null;
  layout: 'forceatlas' | 'static';
  interactive: boolean;
  height: number | string;
  onNodeClick: (id: string, label: string, type: string, nodeKind: 'entity' | 'item') => void;
  onStageClick: () => void;
  ariaLabel: string;
}

export function buildNeighborhoodGraph(slice: GraphSlice, palette?: ExplorerPalette): ExplorerGraph {
  const state = createExplorerState();
  mergeSlice(state, slice, { palette });
  return state.graph;
}

export default function NeighborhoodCanvas({
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
