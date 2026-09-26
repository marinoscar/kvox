/**
 * The whole-graph overview's pure model (#375, epic #347; spec §5.7, §22.3).
 *
 * NO REACT, NO SIGMA — the `explorerModel.ts` discipline. Every rule the
 * overview has (what a cluster looks like, which colour it is, which members
 * a drill-down hands the explorer, what the list view shows and in what
 * order) lives here and is covered by plain unit tests; `GraphCanvas` (#374,
 * reused, not forked) only draws the `x`/`y`/`size`/`color`/`label`
 * attributes written below.
 *
 * NOTHING IS LAID OUT HERE. Positions and clusters come from the server's
 * stored snapshot (`kg.graph_layout`, #371); a client-side layout of a whole
 * graph is exactly what spec §22.3 rules out. Both builders are pure
 * functions of the snapshot and the theme, so the same response always draws
 * the same picture — which the visual baselines rely on.
 *
 * ⚠ ATTRIBUTE NAMES. Sigma reads a node's or edge's `type` attribute as the
 * WebGL program to draw it with, so an entity's type lives in `entityType`
 * (the `explorerModel.ts` convention) and cluster edges carry `type: 'line'`
 * (an undirected cluster-to-cluster link has no direction to arrow).
 *
 * LABELS ARE LIVE. A cluster is named after its top entity (spec §5.7 — no
 * LLM "themes"), and the server resolves that name at read time, dropping a
 * forgotten or merged member (§15). Nothing here re-derives a label.
 */

import type Graph from 'graphology';
import { UndirectedGraph } from 'graphology';

import type { GraphOverview, GraphOverviewCluster } from '../../../services/graph';
import { SPEAKER_PALETTES } from '../../../utils/transcriptDisplay';
import type { ExplorerHandoff, ExplorerHandoffNode } from '../explorer/explorerHandoff';
import { ringPosition, type ExplorerPalette } from '../explorer/explorerModel';

/** The pooled "Unconnected" cluster (#371). */
export const UNCONNECTED_CLUSTER_ID = -1;
/** #370's cap on one expand's seeds, and the hand-off's (#374). */
export const OVERVIEW_DRILL_DOWN_MAX = 50;

// -----------------------------------------------------------------------------
// Colour
// -----------------------------------------------------------------------------

/**
 * The slice of an MUI theme the overview reads — the explorer's palette plus
 * the mode (which of the two categorical lists to use). A full `Theme`
 * satisfies it, so a caller passes `useTheme()` straight through.
 */
export interface OverviewPalette extends ExplorerPalette {
  palette: ExplorerPalette['palette'] & { mode: 'light' | 'dark' };
}

/**
 * Twelve categorical colours for one mode, all from existing tokens: five
 * theme roles and seven of the contrast-tested speaker hues
 * (`utils/transcriptDisplay.ts`), interleaved so neighbouring cluster ids —
 * the largest clusters come first — land on clearly different hues. The
 * theme's `warning` is left out: in dark mode it is the same amber as
 * `secondary`, so it would give two clusters one colour.
 */
export function clusterPalette(theme: OverviewPalette): string[] {
  const p = theme.palette;
  const speakers = SPEAKER_PALETTES[p.mode === 'dark' ? 'dark' : 'light'];
  return [
    p.primary.main,
    speakers[0], // teal
    p.secondary.main,
    speakers[1], // magenta
    p.success.main,
    speakers[4], // purple
    p.error.main,
    speakers[5], // blue
    speakers[3], // orange
    p.info.main,
    speakers[7], // slate
    speakers[6], // amber-brown
  ];
}

/** Deterministic: cluster `id` → one of twelve colours; `-1` (Unconnected) → neutral grey. */
export function clusterColor(id: number, theme: OverviewPalette): string {
  if (id < 0) return theme.palette.text.disabled;
  const palette = clusterPalette(theme);
  return palette[Math.floor(id) % palette.length];
}

// -----------------------------------------------------------------------------
// Graphs
// -----------------------------------------------------------------------------

export interface OverviewNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  clusterId: number;
  /** The undimmed colour and label, so a selection can be cleared (`applyClusterFocus`). */
  baseColor: string;
  baseLabel: string;
  /** Nodes layer only: the ontology type key. */
  entityType?: string;
  zIndex?: number;
}

export interface OverviewEdgeAttributes {
  type: 'line';
  size: number;
  color: string;
  weight: number;
}

export type OverviewGraph = Graph<OverviewNodeAttributes, OverviewEdgeAttributes>;

/** A cluster's node key in the clusters layer (`c3`, `c-1`). */
export function clusterNodeKey(id: number): string {
  return `c${id}`;
}

const MIN_CLUSTER_SIZE = 6;
const MAX_CLUSTER_SIZE = 30;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One node per cluster at its snapshot centroid, sized in proportion to its
 * radius (the largest cluster is `MAX_CLUSTER_SIZE` px), labelled
 * `Label (size)`; one edge per `clusterEdges` row, width ∝ `log(weight)`.
 */
export function buildClusterGraph(o: GraphOverview, theme: OverviewPalette): OverviewGraph {
  const graph: OverviewGraph = new UndirectedGraph<OverviewNodeAttributes, OverviewEdgeAttributes>();
  const maxRadius = Math.max(0, ...o.clusters.map((c) => c.radius));
  for (const cluster of o.clusters) {
    const key = clusterNodeKey(cluster.id);
    if (graph.hasNode(key)) continue;
    const share = maxRadius > 0 ? Math.max(0, cluster.radius) / maxRadius : 1;
    const color = clusterColor(cluster.id, theme);
    const label = `${cluster.label} (${cluster.size})`;
    graph.addNode(key, {
      x: cluster.x,
      y: cluster.y,
      size: round2(MIN_CLUSTER_SIZE + (MAX_CLUSTER_SIZE - MIN_CLUSTER_SIZE) * share),
      color,
      label,
      clusterId: cluster.id,
      baseColor: color,
      baseLabel: label,
    });
  }
  const edgeColor = theme.palette.text.disabled;
  for (const edge of o.clusterEdges) {
    const a = clusterNodeKey(edge.a);
    const b = clusterNodeKey(edge.b);
    if (a === b || !graph.hasNode(a) || !graph.hasNode(b) || graph.hasEdge(a, b)) continue;
    // An explicit key: graphology's generated ones come from a process-wide
    // counter, so two builds of one snapshot would differ.
    graph.addEdgeWithKey(`${a}~${b}`, a, b, {
      type: 'line',
      size: round2(1 + Math.log(Math.max(1, edge.weight))),
      color: edgeColor,
      weight: edge.weight,
    });
  }
  return graph;
}

/**
 * Every positioned node (≤ 5,000, the server's cap) coloured by its cluster,
 * sized `2 + log2(1 + degree)`. NO EDGES: the positions already carry the
 * structure, and 40k edges drawn at once is noise that costs a phone its
 * frame rate (the issue's rejected alternative).
 */
export function buildNodeGraph(o: GraphOverview, theme: OverviewPalette): OverviewGraph {
  const graph: OverviewGraph = new UndirectedGraph<OverviewNodeAttributes, OverviewEdgeAttributes>();
  for (const node of o.nodes) {
    if (graph.hasNode(node.id)) continue;
    const color = clusterColor(node.clusterId, theme);
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: round2(2 + Math.log2(1 + Math.max(0, node.degree))),
      color,
      label: node.label,
      clusterId: node.clusterId,
      baseColor: color,
      baseLabel: node.label,
      entityType: node.type,
    });
  }
  return graph;
}

/**
 * Dim every node outside `clusterId` (or restore all of them for `null`) —
 * "selecting a cluster dims the rest", in either layer. `GraphCanvas`'s own
 * selection dimming keys on ONE node and its neighbours, which in the nodes
 * layer (no edges) would dim the selected cluster's other members too.
 */
export function applyClusterFocus(
  graph: OverviewGraph,
  clusterId: number | null,
  dimColor: string,
): void {
  graph.forEachNode((key, attrs) => {
    const inFocus = clusterId === null || attrs.clusterId === clusterId;
    graph.mergeNodeAttributes(key, {
      color: inFocus ? attrs.baseColor : dimColor,
      label: inFocus ? attrs.baseLabel : '',
      zIndex: clusterId !== null && inFocus ? 1 : 0,
    });
  });
}

// -----------------------------------------------------------------------------
// Drill-down (the #374 hand-off; spec §22.3)
// -----------------------------------------------------------------------------

function byDegreeThenLabel(
  a: { degree: number; label: string; id: string },
  b: { degree: number; label: string; id: string },
): number {
  return b.degree - a.degree || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function membersOf(o: GraphOverview, clusterId: number) {
  return o.nodes.filter((node) => node.clusterId === clusterId).sort(byDegreeThenLabel);
}

/**
 * The cluster's top-degree members from `nodes`, topped up from the cluster's
 * `memberSample` (a truncated snapshot may position none of a small cluster's
 * members), at most `max`.
 */
export function clusterSeedIds(o: GraphOverview, clusterId: number, max = OVERVIEW_DRILL_DOWN_MAX): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (ids.length >= max || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const node of membersOf(o, clusterId)) push(node.id);
  const cluster = o.clusters.find((c) => c.id === clusterId);
  for (const member of cluster?.memberSample ?? []) push(member.id);
  return ids;
}

/**
 * What "Explore this cluster" hands the explorer: the seeds, the cluster's
 * label as the explorer's title, and each seed AT ITS OVERVIEW POSITION so
 * the explorer draws them at once. A sample member with no position (not in
 * the truncated `nodes`) is ringed around the cluster's centroid with the
 * explorer's own deterministic placement.
 */
export function clusterHandoff(
  o: GraphOverview,
  clusterId: number,
  max = OVERVIEW_DRILL_DOWN_MAX,
): ExplorerHandoff {
  const cluster = o.clusters.find((c) => c.id === clusterId);
  const seedIds = clusterSeedIds(o, clusterId, max);
  const positioned = new Map(o.nodes.map((node) => [node.id, node]));
  const sample = new Map((cluster?.memberSample ?? []).map((member) => [member.id, member]));
  const nodes: ExplorerHandoffNode[] = [];
  let ringIndex = 0;
  for (const id of seedIds) {
    const node = positioned.get(id);
    if (node) {
      nodes.push({ id, label: node.label, type: node.type, x: node.x, y: node.y, degree: node.degree });
      continue;
    }
    const member = sample.get(id);
    if (!member) continue;
    const at = ringPosition(cluster?.x ?? 0, cluster?.y ?? 0, ringIndex++);
    nodes.push({ id, label: member.label, type: member.type, x: at.x, y: at.y, degree: member.degree });
  }
  return { seedIds, title: cluster?.label, nodes };
}

// -----------------------------------------------------------------------------
// List view + keyboard order
// -----------------------------------------------------------------------------

export interface ClusterListRow {
  id: number;
  label: string;
  size: number;
  /** Up to three type keys, most frequent first. */
  topTypes: string[];
  /** Sample member labels, highest degree first. */
  sample: string[];
  /** The same sample, with ids, for links. */
  members: { id: string; label: string; type: string }[];
  labelEntityId: string | null;
}

function compareClusters(a: GraphOverviewCluster, b: GraphOverviewCluster): number {
  const aUnconnected = a.id === UNCONNECTED_CLUSTER_ID;
  const bUnconnected = b.id === UNCONNECTED_CLUSTER_ID;
  if (aUnconnected !== bUnconnected) return aUnconnected ? 1 : -1;
  return b.size - a.size || a.id - b.id;
}

/** The type keys of a cluster, most frequent first (ties by key). */
export function topTypes(typeCounts: Record<string, number>, limit = 3): string[] {
  return Object.entries(typeCounts)
    .filter(([, count]) => count > 0)
    .sort(([ak, ac], [bk, bc]) => bc - ac || ak.localeCompare(bk))
    .slice(0, limit)
    .map(([key]) => key);
}

/** Clusters largest first, "Unconnected" last. */
export function toClusterList(o: GraphOverview): ClusterListRow[] {
  return [...o.clusters].sort(compareClusters).map((cluster) => ({
    id: cluster.id,
    label: cluster.label,
    size: cluster.size,
    topTypes: topTypes(cluster.typeCounts),
    sample: cluster.memberSample.map((member) => member.label),
    members: cluster.memberSample.map(({ id, label, type }) => ({ id, label, type })),
    labelEntityId: cluster.labelEntityId,
  }));
}

/** Arrow-key order on the canvas: the list view's order. */
export function clusterKeyboardOrder(o: GraphOverview): number[] {
  return [...o.clusters].sort(compareClusters).map((cluster) => cluster.id);
}

/** "42 entities" / "1 entity". */
export function entityCount(n: number): string {
  return n === 1 ? '1 entity' : `${n.toLocaleString('en-US')} entities`;
}

/** The screen-reader sentence for a cluster reached by arrow key. */
export function clusterAnnouncement(cluster: Pick<GraphOverviewCluster, 'label' | 'size'>): string {
  return `Cluster ${cluster.label}, ${entityCount(cluster.size)}`;
}

/** Parse `?cluster=` to a cluster id present in this snapshot, else null. */
export function parseClusterParam(param: string | null, o: GraphOverview | null): number | null {
  if (param === null || !/^-?\d+$/.test(param) || !o) return null;
  const id = Number(param);
  return o.clusters.some((c) => c.id === id) ? id : null;
}
