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

import { MultiDirectedGraph, type UndirectedGraph } from 'graphology';

import { createTheme } from '@mui/material/styles';

import type { GraphEdge, GraphNode, GraphSlice, GraphValidRange } from '../../../headless/clients/graph.js';
import { humanizeKey } from '../../../headless/utils/graphDisplay.js';
import { pictogramDataUri, type PictogramName } from './icons/pictograms.js';
import {
  edgeAppearance,
  encodingFor,
  iconUrlFor,
  nodeSize,
  parallelCurvatures,
  type ExplorerMode,
  type Stance,
} from './explorerEncoding.js';

/** §22.2: past this, expansion is refused with a message naming the cap. */
export const EXPLORER_NODE_CAP = 300;
/** #370's cap on the seeds one expand call accepts. */
export const EXPLORER_MAX_REQUEST_SEEDS = 50;

// -----------------------------------------------------------------------------
// Graph attributes
// -----------------------------------------------------------------------------

/**
 * Attributes of a node in the explorer graph. Sigma draws `x`, `y`, `size`, `color` and `label` as they are.
 *
 * @stability experimental
 */
export interface ExplorerNodeAttributes {
  /** Horizontal position in layout space. */
  x: number;
  /** Vertical position in layout space. */
  y: number;
  /** Drawn radius, derived from the node's degree. */
  size: number;
  /** Fill colour, derived from the node's type. */
  color: string;
  /** Text drawn beside the node. */
  label: string;
  /** Whether the node is an entity or a knowledge item. */
  nodeKind: 'entity' | 'item';
  /** The ontology type key (`Person`) or item kind (`commitment`). */
  entityType: string;
  /** Number of readable relations the node has in the whole graph; drives its size. */
  degree: number;
  /** Item status, or `null` for an entity. */
  status: string | null;
  /** ISO 8601 instant for an event-like entity or an item, or `null` when it has none. */
  occurredAt: string | null;
  /** Set by a drag on the canvas; ForceAtlas2 leaves a fixed node where it is. */
  fixed?: boolean;
  /** How many notes mention the node, when the API sends it (#671); drives size and rank, `null` until then. */
  mentionCount: number | null;
  /** ISO 8601 instant the node was last seen in a note, when the API sends it; drives recency in the rank. */
  lastSeenAt: string | null;
  /** Set for the nodes the exploration started from; drawn with a thick ring. */
  isSeed: boolean;
  /** `data:` URL of the type's pictogram, drawn by `@sigma/node-image`. */
  image: string;
  /** Colour of the pictogram: white or near-black, whichever reads on `color`. */
  iconColor: string;
  /** `true` for a "+N more" aggregate node: it stands for `stubCount` unloaded neighbours of `stubParentId` of type `stubType`. */
  isStub?: boolean;
  /** The node a stub hangs from. */
  stubParentId?: string;
  /** The type the stub aggregates; its expansion sends `types: [stubType]`. */
  stubType?: string;
  /** How many neighbours the stub stands for. */
  stubCount?: number;
}

/**
 * Attributes of an edge in the explorer graph. Sigma draws `size` and `color` as they are.
 *
 * @stability experimental
 */
export interface ExplorerEdgeAttributes {
  /** Sigma's edge program — always an arrow: the stored direction is meaningful. */
  type: 'arrow';
  /** Relation type key, e.g. `WORKS_FOR`. Stored here because `type` names sigma's drawing program. */
  relationType: string;
  /** When the relation holds, or `null` for a non-temporal relation. */
  valid: GraphValidRange | null;
  /** Extraction confidence from 0 to 1, or `null` when the relation was not extracted. */
  confidence: number | null;
  /** `true` for an edge derived from an item column rather than a stored relation. */
  virtual: boolean;
  /** The relation's own props (#442), `{}` when none or from an older API. */
  props: Record<string, unknown>;
  /** Drawn line width: `log(1 + evidenceCount)`, else from `confidence`. */
  size: number;
  /** Line colour: the stance accent on an `INVOLVED_IN` edge, else muted. */
  color: string;
  /** How many pieces of evidence back the relation, when the API sends it (#671), else `null`. */
  evidenceCount: number | null;
  /** The `INVOLVED_IN` stance, or `null`. */
  stance: Stance | null;
  /** Derived edges and a `resistant` stance are meant to be dashed (see `edgeAppearance`). */
  dashed: boolean;
  /** Shown on hover or selection only: relation, role or stage, stance. */
  label: string;
  /** Bend of the edge, so parallel edges between one pair fan out; `0` is straight. */
  curvature: number;
}

/** The relation type of the edge that ties a "+N more" stub to its node. Never a real relation. */
export const STUB_RELATION = '__more';

/**
 * The directed multigraph the explorer builds from graph slices; nodes and edges carry the attributes above.
 *
 * @stability experimental
 */
export type ExplorerGraph = MultiDirectedGraph<ExplorerNodeAttributes, ExplorerEdgeAttributes>;

/**
 * Everything the explorer remembers: the graph, which nodes are seeds or expanded, the `as of` date, the active filters and whether the last slice was cut off.
 *
 * @stability experimental
 */
export interface ExplorerState {
  /** The graph the canvas draws. */
  graph: ExplorerGraph;
  /** Ids of the nodes the exploration started from; they survive filters and are never hidden. */
  seedIds: string[];
  /** Nodes whose one-hop neighbourhood has been requested. */
  expanded: Set<string>;
  /** The instant the graph is evaluated at (`YYYY-MM-DD` or ISO 8601), or `null` for now. */
  asOf: string | null;
  /** Node types currently hidden by the type and domain filters. */
  hiddenTypes: Set<string>;
  /** Relation types currently hidden by the filters. */
  hiddenRelationTypes: Set<string>;
  /** `true` when the last slice reported that more was reachable than it returned. */
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
 *
 * @stability experimental
 */
export interface ExplorerPalette {
  /** The colour tokens the model reads. */
  palette: {
    /** Which variant of the node colours to draw; `light` when absent. */
    mode?: ExplorerMode;
    /** Used for Person nodes. */
    primary: {
      /** Colour string of the token. */
      main: string;
    };
    /** Used for Organization nodes. */
    secondary: {
      /** Colour string of the token. */
      main: string;
    };
    /** Used for Project nodes. */
    success: {
      /** Colour string of the token. */
      main: string;
    };
    /** Used for Meeting nodes. */
    info: {
      /** Colour string of the token. */
      main: string;
    };
    /** Used for commitment nodes. */
    warning: {
      /** Colour string of the token. */
      main: string;
    };
    /** Used for decision nodes. */
    error: {
      /** Colour string of the token. */
      main: string;
    };
    /** Text colours; used for every other node type and for edges. */
    text: {
      /** Colour of nodes with no colour of their own. */
      secondary: string;
      /** Colour of edges. */
      disabled: string;
    };
  };
}

/** MUI's light palette, for a caller with no theme at hand (tests, the model's own default). */
const LIGHT = createTheme({ palette: { mode: 'light' } }).palette;
export const DEFAULT_EXPLORER_PALETTE: ExplorerPalette = {
  palette: {
    primary: { main: LIGHT.primary.main },
    secondary: { main: LIGHT.secondary.main },
    success: { main: LIGHT.success.main },
    info: { main: LIGHT.info.main },
    warning: { main: LIGHT.warning.main },
    error: { main: LIGHT.error.main },
    text: { secondary: LIGHT.text.secondary, disabled: LIGHT.text.disabled },
  },
};

type NodeStyleInput = Pick<GraphNode, 'nodeKind' | 'type' | 'label' | 'degree'> & {
  /** How many notes mention it, when the API sends it. */
  mentionCount?: number | null;
};

function modeOf(theme: ExplorerPalette): ExplorerMode {
  return theme.palette.mode === 'dark' ? 'dark' : 'light';
}

/**
 * Colour, pictogram and size of a node (#667). The colour and pictogram come
 * from the type (`explorerEncoding`), never from the MUI theme's brand colours;
 * only the light or dark variant follows `theme.palette.mode`. Size is
 * `√mentionCount`, else `√degree`.
 */
export function nodeStyle(
  node: NodeStyleInput,
  theme: ExplorerPalette = DEFAULT_EXPLORER_PALETTE,
): { color: string; size: number; label: string; image: string; iconColor: string } {
  const mode = modeOf(theme);
  const encoding = encodingFor(node.type, mode);
  return {
    color: encoding.color,
    size: nodeSize({ mentionCount: node.mentionCount, degree: node.degree, nodeKind: node.nodeKind }),
    label: node.label,
    image: iconUrlFor(node.type, mode),
    iconColor: encoding.iconColor,
  };
}

/** The style a "+N more" stub carries: its type's colour, the plus pictogram, a size that grows with the count. */
function stubStyle(type: string, count: number, theme: ExplorerPalette) {
  const encoding = encodingFor(type, modeOf(theme));
  return {
    color: encoding.color,
    iconColor: encoding.iconColor,
    image: pictogramDataUri('plus'),
    size: nodeSize({ mentionCount: count, degree: count }),
  };
}

type EdgeStyleInput = Pick<GraphEdge, 'type' | 'confidence' | 'virtual'> & {
  props?: Record<string, unknown>;
  evidenceCount?: number | null;
};

/** Colour, width, stance, dash flag and hover label of an edge. */
export function edgeStyle(
  theme: ExplorerPalette = DEFAULT_EXPLORER_PALETTE,
  edge?: EdgeStyleInput,
): { color: string; size: number; stance: Stance | null; dashed: boolean; label: string } {
  const base = theme.palette.text.disabled;
  if (!edge) return { color: base, size: 1.5, stance: null, dashed: false, label: '' };
  return edgeAppearance(
    {
      relationType: edge.type,
      confidence: edge.confidence,
      evidenceCount: edge.evidenceCount,
      virtual: edge.virtual,
      props: edge.props,
    },
    base,
    modeOf(theme),
  );
}

/** Re-apply colours after a theme change, keeping positions and everything else. */
export function restyle(state: ExplorerState, theme: ExplorerPalette): void {
  const { graph } = state;
  graph.forEachNode((id, attrs) => {
    if (attrs.isStub && attrs.stubType) {
      const style = stubStyle(attrs.stubType, attrs.stubCount ?? 0, theme);
      graph.mergeNodeAttributes(id, style);
      return;
    }
    const style = nodeStyle(
      {
        nodeKind: attrs.nodeKind,
        type: attrs.entityType,
        label: attrs.label,
        degree: attrs.degree,
        mentionCount: attrs.mentionCount,
      },
      theme,
    );
    graph.mergeNodeAttributes(id, {
      color: style.color,
      size: style.size,
      image: style.image,
      iconColor: style.iconColor,
    });
  });
  graph.forEachEdge((id, attrs) => {
    if (attrs.relationType === STUB_RELATION) {
      graph.mergeEdgeAttributes(id, { color: theme.palette.text.disabled });
      return;
    }
    const style = edgeStyle(theme, {
      type: attrs.relationType,
      confidence: attrs.confidence,
      virtual: attrs.virtual,
      props: attrs.props,
      evidenceCount: attrs.evidenceCount,
    });
    graph.mergeEdgeAttributes(id, { color: style.color, size: style.size });
  });
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
// Degree of interest (DOI)
// -----------------------------------------------------------------------------

/**
 * Weights of the degree-of-interest score (van Ham and Perer, 2009), pinned by
 * `explorerModel.test.ts`. `doi = importance·a + recency·b + interest·c − distance·d`.
 */
export const DOI_WEIGHTS = { importance: 1, recency: 0.5, interest: 2, distance: 0.75 } as const;

/** What decides how interesting a node is. */
export interface DoiInput {
  /** Notes that mention it, when the API sends it. */
  mentionCount?: number | null;
  /** Readable relations in the whole graph; the importance fallback. */
  degree: number;
  /** When it was last seen (ISO 8601), when known. */
  lastSeenAt?: string | null;
  /** The user dragged it into place. */
  pinned?: boolean;
  /** It matched the user's search. */
  searched?: boolean;
  /** The exploration started here. */
  seed?: boolean;
  /** Hops from the nearest seed. */
  distance: number;
}

const DAY_MS = 86_400_000;
/** Recency halves every 90 days. */
const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * `importance` is `ln(1 + mentionCount)` (else `degree`), `recency` is
 * `2^(−age / 90 days)` in `[0, 1]` (0 when the date is unknown), `interest` is
 * the count of seed, pinned and searched flags, `distance` is the hop count.
 * Higher is more interesting. `now` is a parameter so a test is deterministic.
 */
export function degreeOfInterest(
  input: DoiInput,
  weights: typeof DOI_WEIGHTS = DOI_WEIGHTS,
  now: number = Date.now(),
): number {
  const importance = Math.log1p(Math.max(0, input.mentionCount ?? input.degree));
  let recency = 0;
  if (input.lastSeenAt) {
    const seen = Date.parse(input.lastSeenAt);
    if (!Number.isNaN(seen)) recency = 2 ** (-Math.max(0, now - seen) / DAY_MS / RECENCY_HALF_LIFE_DAYS);
  }
  const interest = Number(Boolean(input.seed)) + Number(Boolean(input.pinned)) + Number(Boolean(input.searched));
  return (
    weights.importance * importance +
    weights.recency * recency +
    weights.interest * interest -
    weights.distance * Math.max(0, input.distance)
  );
}

/** Highest DOI first; ties by label then id, so the order never depends on arrival order. */
function byDoi<T extends { id: string; label: string }>(score: (item: T) => number): (a: T, b: T) => number {
  return (a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}

/** The wire fields the API will add (#671); read defensively, so an older API works. */
type SliceNode = GraphNode & { mentionCount?: number | null; lastSeenAt?: string | null };
type SliceEdge = GraphEdge & { evidenceCount?: number | null };

/** How many NEW neighbours one open or expand shows; the rest become per-type "+N more" stubs. */
export const EXPLORER_NEIGHBOUR_LIMIT = 30;

// -----------------------------------------------------------------------------
// Merge
// -----------------------------------------------------------------------------

export interface MergeOptions {
  /** The node that was expanded: new nodes ring around it. */
  parentId?: string;
  palette?: ExplorerPalette;
  /** Positions to reuse for nodes that were on screen before a rebuild (`as_of`). */
  previousPositions?: ReadonlyMap<string, { x: number; y: number }>;
  /**
   * Show at most this many NEW non-seed nodes, best DOI first; the rest are
   * summarised as one "+N more" stub per type and parent. Default: no limit,
   * so a caller that wants every node (a test, the overview) gets them.
   */
  neighbourLimit?: number;
  /** Ids that match the user's search; they rank higher. */
  searchedIds?: ReadonlySet<string>;
  /** The clock for recency; a parameter so a test is deterministic. */
  now?: number;
}

function sliceNodeAttrs(node: SliceNode) {
  return {
    mentionCount: typeof node.mentionCount === 'number' ? node.mentionCount : null,
    lastSeenAt: typeof node.lastSeenAt === 'string' ? node.lastSeenAt : null,
  };
}

/**
 * Add a slice's nodes and edges. IDEMPOTENT — a node or edge already present
 * keeps its position and has its data refreshed. NEVER EXCEEDS
 * `EXPLORER_NODE_CAP` real nodes (a stub does not count): when the new nodes do
 * not fit, the slice's own seeds go first, then the highest degree of interest,
 * and the rest are dropped (`capped: true`). With `neighbourLimit`, the best
 * that many new neighbours are shown and the others collapse into "+N more"
 * stubs. An edge is added only when both ends are on the graph.
 */
export function mergeSlice(
  state: ExplorerState,
  slice: GraphSlice,
  opts: MergeOptions = {},
): { added: string[]; capped: boolean } {
  const { graph } = state;
  const palette = opts.palette ?? DEFAULT_EXPLORER_PALETTE;
  const sliceSeeds = new Set(slice.seedIds);
  const now = opts.now ?? Date.now();

  // Refresh what is already here.
  for (const node of slice.nodes as SliceNode[]) {
    if (graph.hasNode(node.id) && !graph.getNodeAttribute(node.id, 'isStub')) {
      const extra = sliceNodeAttrs(node);
      const style = nodeStyle({ ...node, ...extra }, palette);
      graph.mergeNodeAttributes(node.id, {
        label: node.label,
        degree: node.degree,
        status: node.status,
        occurredAt: node.occurredAt,
        nodeKind: node.nodeKind,
        entityType: node.type,
        color: style.color,
        size: style.size,
        image: style.image,
        iconColor: style.iconColor,
        ...extra,
      });
    }
  }

  const fresh = (slice.nodes as SliceNode[]).filter((node) => !graph.hasNode(node.id));
  const score = (node: SliceNode) =>
    degreeOfInterest(
      {
        ...sliceNodeAttrs(node),
        degree: node.degree,
        lastSeenAt: sliceNodeAttrs(node).lastSeenAt ?? node.occurredAt,
        seed: sliceSeeds.has(node.id),
        searched: opts.searchedIds?.has(node.id),
        distance: node.depth,
      },
      DOI_WEIGHTS,
      now,
    );
  // Seeds of the slice first (a hard rule), then by degree of interest.
  const ranked = [...fresh].sort((a, b) => {
    const seedOrder = Number(sliceSeeds.has(b.id)) - Number(sliceSeeds.has(a.id));
    return seedOrder !== 0 ? seedOrder : byDoi<SliceNode>(score)(a, b);
  });

  // Past the neighbour limit, the rest become stubs; then the cap cuts what is left to show.
  const limit = opts.neighbourLimit ?? Number.POSITIVE_INFINITY;
  const limited: SliceNode[] = [];
  const overflow: SliceNode[] = [];
  let neighbours = 0;
  for (const node of ranked) {
    if (sliceSeeds.has(node.id)) limited.push(node);
    else if (neighbours < limit) {
      limited.push(node);
      neighbours += 1;
    } else overflow.push(node);
  }
  const capacity = remainingCapacity(state);
  const capped = limited.length > capacity;
  const kept = limited.slice(0, capacity);

  // Place deterministically: ids ascending, seeds of the slice first.
  const keptIds = kept.map((node) => node.id).sort();
  const keptById = new Map(kept.map((node) => [node.id, node]));
  const newSeeds = keptIds.filter((id) => sliceSeeds.has(id));
  const others = keptIds.filter((id) => !sliceSeeds.has(id));

  const add = (node: SliceNode, position: { x: number; y: number }) => {
    const extra = sliceNodeAttrs(node);
    const style = nodeStyle({ ...node, ...extra }, palette);
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
      isSeed: false,
      image: style.image,
      iconColor: style.iconColor,
      ...extra,
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
  for (const edge of slice.edges as SliceEdge[]) {
    if (graph.hasEdge(edge.id)) {
      graph.mergeEdgeAttributes(edge.id, edgeData(edge, palette));
      continue;
    }
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, edgeData(edge, palette));
  }

  // "+N more" stubs for what the neighbour limit left out, one per parent and type.
  const stubGroups = new Map<string, { parent: string; type: string; count: number }>();
  for (const node of overflow) {
    const parent = pickParent(graph, slice.edges, node.id, opts.parentId);
    if (!parent) continue;
    const id = stubId(parent, node.type);
    const group = stubGroups.get(id) ?? { parent, type: node.type, count: 0 };
    group.count += 1;
    stubGroups.set(id, group);
  }
  for (const [id, group] of [...stubGroups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    putStub(state, id, group.parent, group.type, group.count, palette, ringIndex);
  }

  refreshCurvature(graph);
  syncSeedFlags(state);
  state.truncated = slice.truncated;
  return { added: keptIds, capped };
}

/**
 * Make every node's `isSeed` flag (the thick ring) say what `state.seedIds` says.
 * `mergeSlice` calls it, and so must a caller that assigns `seedIds` afterwards
 * (a rebuild does). Writes only changes.
 */
export function syncSeedFlags(state: ExplorerState): void {
  const seeds = new Set(state.seedIds);
  state.graph.forEachNode((id, attrs) => {
    const want = seeds.has(id);
    if (attrs.isSeed !== want) state.graph.setNodeAttribute(id, 'isSeed', want);
  });
}

/** Id of the "+N more" stub for `type` neighbours of `parentId`. */
export function stubId(parentId: string, type: string): string {
  return `stub:${parentId}:${type}`;
}

function putStub(
  state: ExplorerState,
  id: string,
  parent: string,
  type: string,
  count: number,
  palette: ExplorerPalette,
  ringIndex: Map<string, number>,
): void {
  const { graph } = state;
  const style = stubStyle(type, count, palette);
  const label = `+${count} more ${humanizeKey(type)}`;
  if (graph.hasNode(id)) {
    graph.mergeNodeAttributes(id, { ...style, label, stubCount: count });
    return;
  }
  const center = graph.getNodeAttributes(parent);
  const index = ringIndex.get(parent) ?? 0;
  ringIndex.set(parent, index + 1);
  const position = ringPosition(center.x, center.y, index);
  graph.addNode(id, {
    x: position.x,
    y: position.y,
    ...style,
    label,
    nodeKind: 'entity',
    entityType: type,
    degree: 0,
    status: null,
    occurredAt: null,
    mentionCount: null,
    lastSeenAt: null,
    isSeed: false,
    isStub: true,
    stubParentId: parent,
    stubType: type,
    stubCount: count,
  });
  graph.addDirectedEdgeWithKey(`stubedge:${id}`, parent, id, {
    type: 'arrow',
    relationType: STUB_RELATION,
    valid: null,
    confidence: null,
    virtual: true,
    props: {},
    size: 1,
    color: palette.palette.text.disabled,
    evidenceCount: null,
    stance: null,
    dashed: true,
    label: '',
    curvature: 0,
  });
}

/** Drop a stub (and its edge) before the type it stood for is expanded. */
export function dropStub(state: ExplorerState, id: string): boolean {
  if (!state.graph.hasNode(id) || !state.graph.getNodeAttribute(id, 'isStub')) return false;
  state.graph.dropNode(id);
  return true;
}

/** The real (non-stub) nodes on the graph: what the cap counts. */
export function realNodeCount(state: ExplorerState): number {
  let count = 0;
  state.graph.forEachNode((_id, attrs) => {
    if (!attrs.isStub) count += 1;
  });
  return count;
}

function edgeData(edge: SliceEdge, palette: ExplorerPalette): ExplorerEdgeAttributes {
  const props = edge.props ?? {};
  const evidenceCount = typeof edge.evidenceCount === 'number' ? edge.evidenceCount : null;
  const style = edgeStyle(palette, { ...edge, evidenceCount });
  return {
    type: 'arrow',
    relationType: edge.type,
    valid: edge.valid,
    confidence: edge.confidence,
    virtual: edge.virtual,
    props,
    size: style.size,
    color: style.color,
    evidenceCount,
    stance: style.stance,
    dashed: style.dashed,
    label: style.label,
    curvature: 0,
  };
}

/**
 * Give every edge the curvature that fans parallel edges apart: edges between
 * one pair of nodes (either direction) are spread symmetrically by
 * `parallelCurvatures`, an edge stored the other way round negated so the bundle
 * bends to one side. A lone edge is straight. Idempotent; writes only changes.
 */
export function refreshCurvature(graph: ExplorerGraph): void {
  const groups = new Map<string, string[]>();
  graph.forEachEdge((id, _attrs, source, target) => {
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  });
  for (const ids of groups.values()) {
    ids.sort();
    const curvatures = parallelCurvatures(ids.length);
    ids.forEach((id, index) => {
      const [source, target] = graph.extremities(id);
      // `+ 0` turns a negated zero back into 0.
      const value = (source <= target ? curvatures[index] : -curvatures[index]) + 0;
      if (graph.getEdgeAttribute(id, 'curvature') !== value) graph.setEdgeAttribute(id, 'curvature', value);
    });
  }
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
      mentionCount: null,
      lastSeenAt: null,
      isSeed: false,
      image: style.image,
      iconColor: style.iconColor,
    });
  }
  state.seedIds = [...new Set(seedIds)].filter((id) => graph.hasNode(id));
  for (const id of state.seedIds) graph.setNodeAttribute(id, 'isSeed', true);
}

// -----------------------------------------------------------------------------
// Capacity, filters, hiding
// -----------------------------------------------------------------------------

/** Room for more real nodes: a "+N more" stub is not a node and does not count. */
export function remainingCapacity(state: ExplorerState): number {
  return Math.max(0, EXPLORER_NODE_CAP - realNodeCount(state));
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
      // The edge that ties a "+N more" stub to its node is not a relation.
      if (attrs.relationType !== STUB_RELATION && !allowedRelationTypes.has(attrs.relationType)) {
        dropEdges.push(id);
      }
    });
    for (const id of dropEdges) graph.dropEdge(id);
  }

  const reachable = reachableFromSeeds(state);
  const orphans = graph.filterNodes((id) => !seeds.has(id) && !reachable.has(id));
  for (const id of orphans) graph.dropNode(id);
  removed.push(...orphans);

  for (const id of removed) state.expanded.delete(id);
  refreshCurvature(graph);
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
  refreshCurvature(state.graph);
  return true;
}

/** Promote a node to a seed: it survives filters and anchors the next `as_of` rebuild. */
export function makeSeed(state: ExplorerState, id: string): boolean {
  if (!state.graph.hasNode(id) || state.seedIds.includes(id)) return false;
  state.seedIds = [...state.seedIds, id];
  state.graph.setNodeAttribute(id, 'isSeed', true);
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

/**
 * Visible nodes by degree of interest, best first — the keyboard's
 * ArrowRight/ArrowLeft order. Seeds come first, then DOI, then label; "+N more"
 * stubs come last. `now` is a parameter so a test is deterministic.
 */
export function keyboardOrder(state: ExplorerState, now: number = Date.now()): string[] {
  const { graph } = state;
  const depth = reachableFromSeeds(state);
  const seeds = new Set(state.seedIds);
  const score = (id: string) => {
    const attrs = graph.getNodeAttributes(id);
    return degreeOfInterest(
      {
        mentionCount: attrs.mentionCount,
        degree: attrs.degree,
        lastSeenAt: attrs.lastSeenAt ?? attrs.occurredAt,
        pinned: attrs.fixed,
        seed: seeds.has(id),
        distance: depth.get(id) ?? 0,
      },
      DOI_WEIGHTS,
      now,
    );
  };
  const rank = (id: string) => (seeds.has(id) ? 0 : graph.getNodeAttribute(id, 'isStub') ? 2 : 1);
  return visibleNodeIds(state).sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return graph.getNodeAttribute(a, 'label').localeCompare(graph.getNodeAttribute(b, 'label'));
  });
}

// -----------------------------------------------------------------------------
// Highlight (hover, first tap, selection)
// -----------------------------------------------------------------------------

/** What a highlight lights: the node, its neighbours, and the edges between them. */
export interface HighlightSet {
  /** The focus node and its neighbours. */
  nodes: ReadonlySet<string>;
  /** Edges incident to the focus: its own relations. */
  edges: ReadonlySet<string>;
}

/**
 * The focus node, its neighbours and its own edges, or `null` for no focus (or a
 * node that is not on the graph). Pure and cheap; the canvas recomputes it on a
 * hover and never writes it into the graph.
 */
export function highlightSet(
  graph: MultiDirectedGraph | UndirectedGraph,
  focusId: string | null,
): HighlightSet | null {
  if (!focusId || !graph.hasNode(focusId)) return null;
  const nodes = new Set<string>([focusId]);
  const edges = new Set<string>();
  graph.forEachEdge(focusId, (edge, _attrs, source, target) => {
    edges.add(edge);
    nodes.add(source);
    nodes.add(target);
  });
  return { nodes, edges };
}

/** The fraction of opacity a dimmed node or edge keeps. */
export const DIM_OPACITY = 0.15;

// -----------------------------------------------------------------------------
// Legend model
// -----------------------------------------------------------------------------

/** One row of the legend's type section.
 *
 * @stability experimental
 */
export interface LegendType {
  /** The type key the filter and the `types` URL parameter use. */
  key: string;
  /** What the row says. */
  label: string;
  /** Fill colour for the theme variant. */
  color: string;
  /** Pictogram name. */
  icon: PictogramName;
  /** Colour of the pictogram on `color`. */
  iconColor: string;
  /** Nodes of this type on the canvas now (0 while hidden). */
  count: number;
  /** Whether the type is currently shown. */
  shown: boolean;
}

/** One row of the legend's relation section.
 *
 * @stability experimental
 */
export interface LegendRelation {
  /** The relation type key. */
  key: string;
  /** What the row says. */
  label: string;
  /** Edges of this type on the canvas now. */
  count: number;
  /** Whether the relation type is currently shown. */
  shown: boolean;
}

/** The legend, as data.
 *
 * @stability experimental
 */
export interface LegendModel {
  /** Types present on the canvas, plus the hidden ones (so they can be turned back on). */
  types: LegendType[];
  /** Relation types present, plus the hidden ones. */
  relations: LegendRelation[];
  /** `true` when an `INVOLVED_IN` edge with a stance is on the canvas: the legend then shows the stance key. */
  hasStance: boolean;
}

/** Nodes per type on the canvas, "+N more" stubs excluded. */
export function typeCounts(state: ExplorerState): Map<string, number> {
  const counts = new Map<string, number>();
  state.graph.forEachNode((_id, attrs) => {
    if (attrs.isStub) return;
    counts.set(attrs.entityType, (counts.get(attrs.entityType) ?? 0) + 1);
  });
  return counts;
}

/** Edges per relation type on the canvas, stub ties excluded. */
export function relationCounts(state: ExplorerState): Map<string, number> {
  const counts = new Map<string, number>();
  state.graph.forEachEdge((_id, attrs) => {
    if (attrs.relationType === STUB_RELATION) return;
    counts.set(attrs.relationType, (counts.get(attrs.relationType) ?? 0) + 1);
  });
  return counts;
}

/**
 * The legend for the canvas now. A type or relation appears when it has nodes or
 * edges on the canvas or is hidden; the others would be rows of zeros. Order is
 * the options' (the ontology's) own.
 *
 * @stability experimental
 */
export function legendModel(
  state: ExplorerState,
  nodeTypes: readonly { key: string; label: string }[],
  relationTypes: readonly { key: string; label: string }[],
  mode: ExplorerMode = 'light',
): LegendModel {
  const counts = typeCounts(state);
  const relations = relationCounts(state);
  const types: LegendType[] = [];
  for (const option of nodeTypes) {
    const count = counts.get(option.key) ?? 0;
    const shown = !state.hiddenTypes.has(option.key);
    if (count === 0 && shown) continue;
    const encoding = encodingFor(option.key, mode);
    types.push({
      key: option.key,
      label: option.label,
      color: encoding.color,
      icon: encoding.icon,
      iconColor: encoding.iconColor,
      count,
      shown,
    });
  }
  const relationRows: LegendRelation[] = [];
  for (const option of relationTypes) {
    const count = relations.get(option.key) ?? 0;
    const shown = !state.hiddenRelationTypes.has(option.key);
    if (count === 0 && shown) continue;
    relationRows.push({ key: option.key, label: option.label, count, shown });
  }
  let hasStance = false;
  state.graph.forEachEdge((_id, attrs) => {
    if (attrs.stance) hasStance = true;
  });
  return { types, relations: relationRows, hasStance };
}
