/**
 * The graph explorer's pure model (#374, epic #347; spec §22.2).
 *
 * NO REACT, NO SIGMA. Every rule the explorer has — the 300-node cap, where a
 * new node is placed, what a filter removes, what the list view shows — lives
 * here, so it is covered by plain unit tests without a WebGL context (jsdom has
 * none). `GraphCanvas` only draws the `x`/`y`/`size`/`color`/`label`
 * attributes this file writes; it never computes styling of its own.
 *
 * ⚠ ATTRIBUTE NAMES. Sigma reads a node's or edge's `type` attribute as the
 * name of the WebGL PROGRAM to draw it with (`circle`, `arrow`), so the graph
 * type key lives in `entityType` and the relation type in `relationType`.
 * Writing `type: 'Person'` onto a node makes sigma throw at render time.
 *
 * ⚠ DETERMINISM. Placement is a pure function of the ids involved (sorted
 * ascending) and of the parent's position — never `Math.random()` — so the
 * static layout (`?layout=static`, `prefers-reduced-motion`, the visual
 * baselines) is identical across runs.
 */

import { MultiDirectedGraph } from 'graphology';

import { BRAND_TOKENS } from '../../../theme/tokens';

import type { GraphEdge, GraphNode, GraphSlice, GraphValidRange } from '../../../services/graph';

/** §22.2: past this, expansion is refused with a message naming the cap. */
export const EXPLORER_NODE_CAP = 300;
/** #370's cap on the seeds one expand call accepts. */
export const EXPLORER_MAX_REQUEST_SEEDS = 50;

// -----------------------------------------------------------------------------
// Graph attributes
// -----------------------------------------------------------------------------

export interface ExplorerNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeKind: 'entity' | 'item';
  /** The ontology type key (`Person`) or item kind (`commitment`). */
  entityType: string;
  degree: number;
  status: string | null;
  occurredAt: string | null;
  /** Set by a drag on the canvas; ForceAtlas2 leaves a fixed node where it is. */
  fixed?: boolean;
}

export interface ExplorerEdgeAttributes {
  /** Sigma's edge program — always an arrow: the stored direction is meaningful. */
  type: 'arrow';
  relationType: string;
  valid: GraphValidRange | null;
  confidence: number | null;
  virtual: boolean;
  size: number;
  color: string;
}

export type ExplorerGraph = MultiDirectedGraph<ExplorerNodeAttributes, ExplorerEdgeAttributes>;

export interface ExplorerState {
  graph: ExplorerGraph;
  seedIds: string[];
  /** Nodes whose one-hop neighbourhood has been requested. */
  expanded: Set<string>;
  asOf: string | null;
  hiddenTypes: Set<string>;
  hiddenRelationTypes: Set<string>;
  /** The LAST slice said more was reachable than it returned. */
  truncated: boolean;
}

export function createExplorerState(): ExplorerState {
  return {
    graph: new MultiDirectedGraph<ExplorerNodeAttributes, ExplorerEdgeAttributes>(),
    seedIds: [],
    expanded: new Set(),
    asOf: null,
    hiddenTypes: new Set(),
    hiddenRelationTypes: new Set(),
    truncated: false,
  };
}

// -----------------------------------------------------------------------------
// Styling
// -----------------------------------------------------------------------------

/**
 * The slice of an MUI theme this model reads. A full `Theme` satisfies it
 * structurally, so a caller passes `useTheme()` straight through and dark mode
 * restyles through the same tokens every other surface uses.
 */
export interface ExplorerPalette {
  palette: {
    primary: { main: string };
    secondary: { main: string };
    success: { main: string };
    info: { main: string };
    warning: { main: string };
    error: { main: string };
    text: { secondary: string; disabled: string };
  };
}

/** The light tokens, for a caller with no theme at hand (tests, the model's own default). */
const LIGHT = BRAND_TOKENS.light;
export const DEFAULT_EXPLORER_PALETTE: ExplorerPalette = {
  palette: {
    primary: { main: LIGHT.primary.main },
    secondary: { main: LIGHT.secondary.main },
    success: { main: LIGHT.success },
    info: { main: LIGHT.info },
    warning: { main: LIGHT.warning },
    error: { main: LIGHT.error },
    text: { secondary: LIGHT.text.secondary, disabled: LIGHT.text.disabled },
  },
};

type NodeStyleInput = Pick<GraphNode, 'nodeKind' | 'type' | 'label' | 'degree'>;

/** One colour per shipped type; anything the ontology adds later is neutral. */
function colorFor(node: NodeStyleInput, theme: ExplorerPalette): string {
  const p = theme.palette;
  switch (node.type) {
    case 'Person':
      return p.primary.main;
    case 'Organization':
      return p.secondary.main;
    case 'Project':
      return p.success.main;
    case 'Meeting':
      return p.info.main;
    case 'commitment':
      return p.warning.main;
    case 'decision':
      return p.error.main;
    default:
      return p.text.secondary;
  }
}

/** Colour by type, size by degree (`4 + 2·log2(1 + degree)`), items three-quarters of that. */
export function nodeStyle(
  node: NodeStyleInput,
  theme: ExplorerPalette = DEFAULT_EXPLORER_PALETTE,
): { color: string; size: number; label: string } {
  const base = 4 + 2 * Math.log2(1 + Math.max(0, node.degree));
  const size = node.nodeKind === 'item' ? base * 0.75 : base;
  return { color: colorFor(node, theme), size: Math.round(size * 100) / 100, label: node.label };
}

export function edgeStyle(theme: ExplorerPalette = DEFAULT_EXPLORER_PALETTE): {
  color: string;
  size: number;
} {
  return { color: theme.palette.text.disabled, size: 1.5 };
}

/** Re-apply colours after a theme change, keeping positions and everything else. */
export function restyle(state: ExplorerState, theme: ExplorerPalette): void {
  const { graph } = state;
  graph.forEachNode((id, attrs) => {
    const style = nodeStyle(
      { nodeKind: attrs.nodeKind, type: attrs.entityType, label: attrs.label, degree: attrs.degree },
      theme,
    );
    graph.mergeNodeAttributes(id, { color: style.color, size: style.size });
  });
  const edge = edgeStyle(theme);
  graph.forEachEdge((id) => graph.mergeEdgeAttributes(id, edge));
}

// -----------------------------------------------------------------------------
// Placement
// -----------------------------------------------------------------------------

/** ≈ 137.5°: consecutive children never line up, however many there are. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RING_SIZE = 12;

/** Position `index` of a ring around `(cx, cy)`: radius `80 + 20·ring`, angle `index·golden-angle`. */
export function ringPosition(cx: number, cy: number, index: number): { x: number; y: number } {
  const ring = Math.floor(index / RING_SIZE);
  const radius = 80 + 20 * ring;
  const angle = index * GOLDEN_ANGLE;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { x: round(cx + radius * Math.cos(angle)), y: round(cy + radius * Math.sin(angle)) };
}

// -----------------------------------------------------------------------------
// Merge
// -----------------------------------------------------------------------------

export interface MergeOptions {
  /** The node that was expanded: new nodes ring around it. */
  parentId?: string;
  palette?: ExplorerPalette;
  /** Positions to reuse for nodes that were on screen before a rebuild (`as_of`). */
  previousPositions?: ReadonlyMap<string, { x: number; y: number }>;
}

/**
 * Add a slice's nodes and edges. IDEMPOTENT — a node or edge already present
 * keeps its position and has its data refreshed. NEVER EXCEEDS
 * `EXPLORER_NODE_CAP`: when the new nodes do not fit, the slice's own seeds go
 * first, then the best connected, and the lowest-degree ones are dropped
 * (`capped: true`). An edge is added only when both ends are on the graph.
 */
export function mergeSlice(
  state: ExplorerState,
  slice: GraphSlice,
  opts: MergeOptions = {},
): { added: string[]; capped: boolean } {
  const { graph } = state;
  const palette = opts.palette ?? DEFAULT_EXPLORER_PALETTE;
  const sliceSeeds = new Set(slice.seedIds);

  // Refresh what is already here.
  for (const node of slice.nodes) {
    if (graph.hasNode(node.id)) {
      const style = nodeStyle(node, palette);
      graph.mergeNodeAttributes(node.id, {
        label: node.label,
        degree: node.degree,
        status: node.status,
        occurredAt: node.occurredAt,
        nodeKind: node.nodeKind,
        entityType: node.type,
        color: style.color,
        size: style.size,
      });
    }
  }

  const fresh = slice.nodes.filter((node) => !graph.hasNode(node.id));
  const capacity = remainingCapacity(state);
  let kept = fresh;
  let capped = false;
  if (fresh.length > capacity) {
    capped = true;
    kept = [...fresh]
      .sort((a, b) => {
        const seedOrder = Number(sliceSeeds.has(b.id)) - Number(sliceSeeds.has(a.id));
        if (seedOrder !== 0) return seedOrder;
        if (b.degree !== a.degree) return b.degree - a.degree;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, capacity);
  }

  // Place deterministically: ids ascending, seeds of the slice first.
  const keptIds = kept.map((node) => node.id).sort();
  const keptById = new Map(kept.map((node) => [node.id, node]));
  const newSeeds = keptIds.filter((id) => sliceSeeds.has(id));
  const others = keptIds.filter((id) => !sliceSeeds.has(id));

  const add = (node: GraphNode, position: { x: number; y: number }) => {
    const style = nodeStyle(node, palette);
    graph.addNode(node.id, {
      x: position.x,
      y: position.y,
      size: style.size,
      color: style.color,
      label: style.label,
      nodeKind: node.nodeKind,
      entityType: node.type,
      degree: node.degree,
      status: node.status,
      occurredAt: node.occurredAt,
    });
  };

  // Seeds with nowhere to hang: the first at the origin, the rest ringed around it.
  newSeeds.forEach((id, index) => {
    const previous = opts.previousPositions?.get(id);
    const position =
      previous ?? (graph.order === 0 ? { x: 0, y: 0 } : ringPosition(0, 0, index));
    add(keptById.get(id)!, position);
  });

  // Everything else rings around its parent: the expanded node, else the first
  // (lowest-id) neighbour already placed, else the origin.
  const ringIndex = new Map<string, number>();
  for (const id of others) {
    const node = keptById.get(id)!;
    const previous = opts.previousPositions?.get(id);
    if (previous) {
      add(node, previous);
      continue;
    }
    const parent = pickParent(graph, slice.edges, id, opts.parentId);
    const center = parent ? graph.getNodeAttributes(parent) : { x: 0, y: 0 };
    const key = parent ?? '';
    const index = ringIndex.get(key) ?? 0;
    ringIndex.set(key, index + 1);
    add(node, ringPosition(center.x, center.y, index));
  }

  // Edges whose both ends made it.
  const style = edgeStyle(palette);
  for (const edge of slice.edges) {
    if (graph.hasEdge(edge.id)) {
      graph.mergeEdgeAttributes(edge.id, edgeData(edge, style));
      continue;
    }
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, edgeData(edge, style));
  }

  state.truncated = slice.truncated;
  return { added: keptIds, capped };
}

function edgeData(
  edge: GraphEdge,
  style: { color: string; size: number },
): ExplorerEdgeAttributes {
  return {
    type: 'arrow',
    relationType: edge.type,
    valid: edge.valid,
    confidence: edge.confidence,
    virtual: edge.virtual,
    size: style.size,
    color: style.color,
  };
}

function pickParent(
  graph: ExplorerGraph,
  edges: readonly GraphEdge[],
  id: string,
  parentId: string | undefined,
): string | null {
  const neighbours: string[] = [];
  for (const edge of edges) {
    if (edge.source === id && graph.hasNode(edge.target)) neighbours.push(edge.target);
    else if (edge.target === id && graph.hasNode(edge.source)) neighbours.push(edge.source);
  }
  if (parentId && neighbours.includes(parentId)) return parentId;
  if (neighbours.length > 0) return [...neighbours].sort()[0];
  if (parentId && graph.hasNode(parentId)) return parentId;
  return null;
}

// -----------------------------------------------------------------------------
// Hand-off from the overview (#375)
// -----------------------------------------------------------------------------

export interface HandoffNode {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  degree: number;
}

/**
 * Put the overview's already-loaded nodes on the graph AT THEIR OVERVIEW
 * POSITIONS (§22.3: an instant render, no blank canvas), as seeds. The expand
 * that follows adds the edges and neighbours around them.
 */
export function seedFromNodes(
  state: ExplorerState,
  seedIds: readonly string[],
  nodes: readonly HandoffNode[],
  palette: ExplorerPalette = DEFAULT_EXPLORER_PALETTE,
): void {
  const { graph } = state;
  for (const node of nodes.slice(0, EXPLORER_NODE_CAP)) {
    if (graph.hasNode(node.id)) continue;
    const nodeKind = /^[a-z]/.test(node.type) ? 'item' : 'entity';
    const style = nodeStyle({ nodeKind, type: node.type, label: node.label, degree: node.degree }, palette);
    graph.addNode(node.id, {
      x: node.x,
      y: node.y,
      size: style.size,
      color: style.color,
      label: node.label,
      nodeKind,
      entityType: node.type,
      degree: node.degree,
      status: null,
      occurredAt: null,
    });
  }
  state.seedIds = [...new Set(seedIds)].filter((id) => graph.hasNode(id));
}

// -----------------------------------------------------------------------------
// Capacity, filters, hiding
// -----------------------------------------------------------------------------

export function remainingCapacity(state: ExplorerState): number {
  return Math.max(0, EXPLORER_NODE_CAP - state.graph.order);
}

/**
 * Drop every non-seed node whose type is not allowed, every edge whose
 * relation type is not allowed (`null` = all relation types), and then every
 * non-seed node that no longer connects to a seed — a node reached only along
 * a now-hidden relation would never have been fetched under this filter.
 * Seeds never disappear.
 */
export function applyFilters(
  state: ExplorerState,
  allowedTypes: ReadonlySet<string>,
  allowedRelationTypes: ReadonlySet<string> | null,
): { removed: string[] } {
  const { graph } = state;
  const seeds = new Set(state.seedIds);
  const removed: string[] = [];

  graph.forEachNode((id, attrs) => {
    if (!seeds.has(id) && !allowedTypes.has(attrs.entityType)) removed.push(id);
  });
  for (const id of removed) graph.dropNode(id);

  if (allowedRelationTypes) {
    const dropEdges: string[] = [];
    graph.forEachEdge((id, attrs) => {
      if (!allowedRelationTypes.has(attrs.relationType)) dropEdges.push(id);
    });
    for (const id of dropEdges) graph.dropEdge(id);
  }

  const reachable = reachableFromSeeds(state);
  const orphans = graph.filterNodes((id) => !seeds.has(id) && !reachable.has(id));
  for (const id of orphans) graph.dropNode(id);
  removed.push(...orphans);

  for (const id of removed) state.expanded.delete(id);
  return { removed: removed.sort() };
}

function reachableFromSeeds(state: ExplorerState): Map<string, number> {
  const { graph } = state;
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of state.seedIds) {
    if (graph.hasNode(seed) && !depth.has(seed)) {
      depth.set(seed, 0);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const next = depth.get(id)! + 1;
    graph.forEachNeighbor(id, (neighbour) => {
      if (!depth.has(neighbour)) {
        depth.set(neighbour, next);
        queue.push(neighbour);
      }
    });
  }
  return depth;
}

/** Seeds always; everything else unless its type is hidden. */
export function visibleNodeIds(state: ExplorerState): string[] {
  const seeds = new Set(state.seedIds);
  return state.graph.filterNodes(
    (id, attrs) => seeds.has(id) || !state.hiddenTypes.has(attrs.entityType),
  );
}

/** "Hide" a node from this session. Never a seed. Returns whether it was removed. */
export function removeNode(state: ExplorerState, id: string): boolean {
  if (state.seedIds.includes(id) || !state.graph.hasNode(id)) return false;
  state.graph.dropNode(id);
  state.expanded.delete(id);
  return true;
}

/** Promote a node to a seed: it survives filters and anchors the next `as_of` rebuild. */
export function makeSeed(state: ExplorerState, id: string): boolean {
  if (!state.graph.hasNode(id) || state.seedIds.includes(id)) return false;
  state.seedIds = [...state.seedIds, id];
  return true;
}

/** Every node's x/y, for carrying positions across a rebuild. */
export function positionsOf(state: ExplorerState): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  state.graph.forEachNode((id, attrs) => positions.set(id, { x: attrs.x, y: attrs.y }));
  return positions;
}

// -----------------------------------------------------------------------------
// The list view's model
// -----------------------------------------------------------------------------

export interface ExplorerListRow {
  id: string;
  label: string;
  type: string;
  nodeKind: 'entity' | 'item';
  degree: number;
  /** Hops from the nearest seed; `Infinity` never happens for a filtered graph. */
  depthFromSeed: number;
  isSeed: boolean;
  expandable: boolean;
}

/** Seeds first, then nearest, then best connected, then by label. */
export function toListModel(state: ExplorerState): ExplorerListRow[] {
  const depth = reachableFromSeeds(state);
  const seeds = new Set(state.seedIds);
  const visible = new Set(visibleNodeIds(state));
  const rows: ExplorerListRow[] = [];
  state.graph.forEachNode((id, attrs) => {
    if (!visible.has(id)) return;
    rows.push({
      id,
      label: attrs.label,
      type: attrs.entityType,
      nodeKind: attrs.nodeKind,
      degree: attrs.degree,
      depthFromSeed: depth.get(id) ?? Number.POSITIVE_INFINITY,
      isSeed: seeds.has(id),
      expandable: !state.expanded.has(id),
    });
  });
  return rows.sort((a, b) => {
    if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
    if (a.depthFromSeed !== b.depthFromSeed) return a.depthFromSeed - b.depthFromSeed;
    if (a.degree !== b.degree) return b.degree - a.degree;
    return a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1);
  });
}

/** Visible nodes by degree (desc), label — the keyboard's ArrowRight/ArrowLeft order. */
export function keyboardOrder(state: ExplorerState): string[] {
  const { graph } = state;
  return visibleNodeIds(state).sort((a, b) => {
    const da = graph.getNodeAttribute(a, 'degree');
    const db = graph.getNodeAttribute(b, 'degree');
    if (da !== db) return db - da;
    return graph.getNodeAttribute(a, 'label').localeCompare(graph.getNodeAttribute(b, 'label'));
  });
}
