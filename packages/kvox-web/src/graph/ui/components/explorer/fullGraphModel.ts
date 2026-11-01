/**
 * The full-graph view's pure model (#768): the WHOLE graph, drawn from the
 * stored layout snapshot (`GET /api/graph/overview?edges=true`).
 *
 * NO REACT, NO SIGMA — the `explorerModel.ts` discipline. What it builds is an
 * ordinary {@link ExplorerState} (same node and edge attributes, same reducers,
 * same inspector), so everything that reads the explorer's graph reads this one
 * too. What makes it a DISTINCT MODE:
 *
 *   - no node cap of the explorer's (300 / 120): the server already caps the
 *     snapshot at `OVERVIEW_MAX_NODES` (5,000) nodes and `OVERVIEW_MAX_EDGES`
 *     (20,000) edges, so `state.cap` is the server's cap;
 *   - NOTHING IS LAID OUT. Positions are the snapshot's `x`/`y`, stable across
 *     reads, and the canvas draws them with the `static` layout (a client-side
 *     layout of a whole graph is what spec §22.3 rules out);
 *   - smaller nodes (a thousand 6px discs are a blob) and thin, straight edges
 *     (no curve program for 20,000 edges);
 *   - labels: only the top {@link FULL_VIEW_FORCED_LABELS} nodes by degree are
 *     labelled whatever the zoom; the rest appear as zooming in makes them big
 *     enough (`fullViewBudgets` raises the canvas's label threshold).
 */

import type { GraphOverview } from '../../../headless/clients/graph.js';
import { edgeLabel } from './explorerEncoding.js';
import {
  DEFAULT_EXPLORER_PALETTE,
  createExplorerState,
  edgeStyle,
  nodeStyle,
  type ExplorerPalette,
  type ExplorerState,
} from './explorerModel.js';
import type { ExplorerListRow } from './explorerModel.js';

/** The most nodes the full view holds: the server's own cap (`OVERVIEW_MAX_NODES`). */
export const FULL_VIEW_NODE_CAP = 5000;
/** The most edges the server returns with `edges=true` (`OVERVIEW_MAX_EDGES`). */
export const FULL_VIEW_EDGE_CAP = 20000;
/** How many of the best-connected nodes keep a label at every zoom. */
export const FULL_VIEW_FORCED_LABELS = 25;
/** Smallest and largest node radius in the full view. */
export const FULL_VIEW_SIZE_MIN = 2.5;
export const FULL_VIEW_SIZE_MAX = 14;
/** Edge width in the full view: thin, so 20,000 of them stay a texture, not a wall. */
export const FULL_VIEW_EDGE_SIZE = 0.6;
/** The most rows the list view shows for the full graph (best connected first). */
export const FULL_VIEW_LIST_MAX = 500;

/** The banner a trimmed snapshot shows (#768). */
export const FULL_VIEW_TRUNCATED_TEXT = `Showing the ${FULL_VIEW_NODE_CAP.toLocaleString('en-US')} most connected entities`;
/** The banner when only the edges were trimmed. */
export const FULL_VIEW_EDGES_TRUNCATED_TEXT = `Showing the ${FULL_VIEW_EDGE_CAP.toLocaleString('en-US')} strongest connections`;

/** `2.5 + 1.2·√degree`, clamped: a hub is a few times a leaf, never a wall. */
export function fullViewNodeSize(degree: number): number {
  const size = FULL_VIEW_SIZE_MIN + 1.2 * Math.sqrt(Math.max(0, degree));
  return Math.round(Math.min(FULL_VIEW_SIZE_MAX, size) * 100) / 100;
}

/**
 * The ids of the `count` best-connected nodes (degree, then label, then id), the ones labelled at every zoom.
 */
export function topDegreeIds(
  nodes: readonly { id: string; label: string; degree: number }[],
  count: number = FULL_VIEW_FORCED_LABELS,
): Set<string> {
  const sorted = [...nodes].sort(
    (a, b) => b.degree - a.degree || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return new Set(sorted.slice(0, Math.max(0, count)).map((node) => node.id));
}

/**
 * The whole graph as an explorer state: every overview node at its snapshot
 * position, coloured and pictogrammed by type (`explorerEncoding`), sized by
 * degree; every returned edge whose two ends are present. No seeds, nothing
 * expanded, and the cap is the server's.
 */
export function buildFullGraphState(
  overview: Pick<GraphOverview, 'nodes' | 'edges'>,
  palette: ExplorerPalette = DEFAULT_EXPLORER_PALETTE,
): ExplorerState {
  const state = createExplorerState(FULL_VIEW_NODE_CAP);
  const { graph } = state;
  const labelled = topDegreeIds(overview.nodes);
  for (const node of overview.nodes) {
    if (graph.hasNode(node.id)) continue;
    const nodeKind = /^[a-z]/.test(node.type) ? 'item' : 'entity';
    const style = nodeStyle({ nodeKind, type: node.type, label: node.label, degree: node.degree }, palette);
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: fullViewNodeSize(node.degree),
      color: style.color,
      label: node.label,
      nodeKind,
      entityType: node.type,
      degree: node.degree,
      status: null,
      occurredAt: null,
      mentionCount: null,
      lastSeenAt: null,
      isSeed: false,
      image: style.image,
      iconColor: style.iconColor,
      ...(labelled.has(node.id) ? { forceLabel: true } : {}),
      ...(node.isSelf === true ? { isSelf: true } : {}),
    });
  }
  const muted = edgeStyle(palette).color;
  for (const edge of overview.edges ?? []) {
    if (graph.hasEdge(edge.id) || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
      type: 'arrow',
      relationType: edge.type,
      valid: null,
      confidence: null,
      virtual: false,
      props: {},
      size: FULL_VIEW_EDGE_SIZE,
      color: muted,
      evidenceCount: null,
      stance: null,
      dashed: false,
      label: edgeLabel(edge.type, {}),
      curvature: 0,
    });
  }
  return state;
}

/** Re-apply colours after a theme change, keeping the full view's own sizes. */
export function restyleFullGraph(state: ExplorerState, palette: ExplorerPalette): void {
  const { graph } = state;
  graph.forEachNode((id, attrs) => {
    const style = nodeStyle(
      { nodeKind: attrs.nodeKind, type: attrs.entityType, label: attrs.label, degree: attrs.degree },
      palette,
    );
    graph.mergeNodeAttributes(id, { color: style.color, image: style.image, iconColor: style.iconColor });
  });
  const muted = edgeStyle(palette).color;
  graph.forEachEdge((id) => graph.mergeEdgeAttributes(id, { color: muted }));
}

/** The list view of the full graph: best connected first, at most `max` rows. */
export function fullViewListRows(state: ExplorerState, max: number = FULL_VIEW_LIST_MAX): ExplorerListRow[] {
  const rows: ExplorerListRow[] = [];
  state.graph.forEachNode((id, attrs) => {
    rows.push({
      id,
      label: attrs.label,
      type: attrs.entityType,
      nodeKind: attrs.nodeKind,
      degree: attrs.degree,
      depthFromSeed: Number.POSITIVE_INFINITY,
      isSeed: false,
      expandable: attrs.nodeKind === 'entity',
    });
  });
  rows.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
  return rows.slice(0, max);
}

/**
 * The type-chip count of a node type in the full view (#768), from the
 * overview's live `typeCounts` (entities only, time-filtered, not
 * type-filtered). `null` for an item kind: the overview does not count items,
 * so its chip shows no count and is never disabled for one.
 */
export function chipCount(key: string, counts: Readonly<Record<string, number>> | null): number | null {
  if (!counts) return null;
  if (/^[a-z]/.test(key)) return null;
  return counts[key] ?? 0;
}

/**
 * The focused view's time filter (#768): the nodes to TAKE OFF the canvas for
 * having no evidence in the window. `active` is the set of ids with evidence
 * in it (`null` while unknown: nothing is hidden). A node in `keep` (the seeds,
 * the selection) always stays, and a "+N more" stub goes with its parent.
 */
export function timeHiddenIds(
  state: ExplorerState,
  candidates: Iterable<string>,
  active: ReadonlySet<string> | null,
  keep: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  if (!active) return hidden;
  const { graph } = state;
  for (const id of candidates) {
    if (!graph.hasNode(id) || keep.has(id)) continue;
    if (graph.getNodeAttribute(id, 'isStub')) continue;
    if (!active.has(id)) hidden.add(id);
  }
  graph.forEachNode((id, attrs) => {
    if (attrs.isStub && attrs.stubParentId && hidden.has(attrs.stubParentId)) hidden.add(id);
  });
  return hidden;
}
