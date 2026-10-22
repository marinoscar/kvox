/**
 * The Insight Canvas inspector's pure model (GIC-11, #672; epic #661).
 *
 * NO REACT. What the inspector shows for the selected node, edge or set of
 * nodes is decided here from the explorer's graph, so it is covered by plain
 * unit tests: the selection (header facts), which tabs apply, which subject the
 * Evidence tab asks about, the Connections groups and the Expand menu.
 *
 * The API decides everything that matters (what is readable, what is
 * sensitive); this file only arranges what the slice and the entity detail
 * already carry.
 */

import type { GraphEntityDetail, GraphOntology, GraphValidRange } from '../../../../headless/clients/graph.js';
import type { EvidenceFeedSubject } from '../../../../headless/hooks/useGraphEvidenceFeed.js';
import { humanizeKey, relationPropsDisplay, relationTypeLabel } from '../../../../headless/utils/graphDisplay.js';
import type { RelationPropDisplay } from '../../../../headless/utils/graphDisplay.js';
import { stanceOf, type Stance } from '../explorerEncoding.js';
import { STUB_RELATION, type ExplorerGraph, type ExplorerState } from '../explorerModel.js';

/** The item kind whose evidence the inspector never asks for: a person fact may be sensitive, and a slice does not say. */
export const PERSON_FACT_TYPE = 'person_fact';

/** Shown instead of a tooltip title when an expand is refused at the node cap. */
export const CAP_TOOLTIP = 'Node limit reached — hide some nodes first';

/**
 * The selected node, with the facts the header shows.
 *
 * @stability experimental
 */
export interface NodeSelection {
  /** Discriminator. */
  kind: 'node';
  /** Node id (an entity or an item). */
  id: string;
  /** Display label. */
  label: string;
  /** The ontology type key (`Person`) or item kind (`commitment`). */
  entityType: string;
  /** The type's label from the ontology. */
  typeLabel: string;
  /** Whether the node is an entity or a knowledge item. */
  nodeKind: 'entity' | 'item';
  /** Readable relations in the whole graph. */
  degree: number;
  /** Item status, else `null`. */
  status: string | null;
  /** Date of an item or event-like entity, else `null`. */
  occurredAt: string | null;
  /** The node is a starting point of the exploration. */
  isSeed: boolean;
  /** An expand has already been run from the node. */
  expanded: boolean;
  /** How many notes mention the node, when the API says. */
  mentionCount: number | null;
  /** When the node was last seen, when the API says. */
  lastSeenAt: string | null;
  /** The node is pinned in the layout. */
  pinned: boolean;
}

/**
 * The selected edge, with the facts the header shows.
 *
 * @stability experimental
 */
export interface EdgeSelection {
  /** Discriminator. */
  kind: 'edge';
  /** Edge id. */
  id: string;
  /** The relation type key, e.g. `INVOLVED_IN`. */
  relationType: string;
  /** The relation's label, e.g. "Involved in". */
  relationLabel: string;
  /** Id of the node the edge leaves. */
  fromId: string;
  /** Label of the node the edge leaves. */
  fromLabel: string;
  /** Id of the node the edge points to. */
  toId: string;
  /** Label of the node the edge points to. */
  toLabel: string;
  /** The entity end whose page carries this relation; `null` if neither end is an entity. */
  pageId: string | null;
  /** Label of {@link EdgeSelection.pageId}'s entity. */
  pageLabel: string | null;
  /** When the relation holds, or `null`. */
  valid: GraphValidRange | null;
  /** Extraction confidence from 0 to 1, or `null`. */
  confidence: number | null;
  /** Derived from an item column rather than stored. */
  virtual: boolean;
  /** How many pieces of evidence back it, when the API says. */
  evidenceCount: number | null;
  /** The relation's own props, labelled from the ontology. */
  props: RelationPropDisplay[];
  /** Role and stage chips: `role`, `stage`, then the stance. */
  chips: string[];
  /** The `INVOLVED_IN` stance, or `null`. */
  stance: Stance | null;
  /** What the Evidence tab asks about, or `null` when it may not ask (a person fact). */
  evidenceSubject: EvidenceFeedSubject | null;
}

/**
 * What the inspector is showing.
 *
 * @stability experimental
 */
export type ExplorerSelection = NodeSelection | EdgeSelection;

/** The tabs of the inspector, in order. */
export const INSPECTOR_TABS = ['overview', 'evidence', 'connections', 'timeline', 'ask'] as const;
/**
 * One tab of the inspector.
 *
 * @stability experimental
 */
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

/** The visible name of a tab. */
export const INSPECTOR_TAB_LABELS: Readonly<Record<InspectorTab, string>> = {
  overview: 'Overview',
  evidence: 'Evidence',
  connections: 'Connections',
  timeline: 'Timeline',
  ask: 'Ask',
};

/** A tab from a URL parameter, or `null` for anything unknown. */
export function parseInspectorTab(raw: string | null | undefined): InspectorTab | null {
  return (INSPECTOR_TABS as readonly string[]).includes(raw ?? '') ? (raw as InspectorTab) : null;
}

/**
 * The tabs that apply to a selection. An edge has Overview and Evidence; an entity all five (Ask only when the host offers it); an item the first three, and never an Ask or Timeline of its own.
 */
export function tabsFor(selection: ExplorerSelection, askAvailable: boolean): InspectorTab[] {
  if (selection.kind === 'edge') return ['overview', 'evidence'];
  if (selection.nodeKind === 'item') return ['overview', 'evidence', 'connections'];
  return askAvailable
    ? ['overview', 'evidence', 'connections', 'timeline', 'ask']
    : ['overview', 'evidence', 'connections', 'timeline'];
}

/** The tab a selection opens on: Evidence for an edge, Overview for a node. */
export function defaultTabFor(selection: ExplorerSelection): InspectorTab {
  return selection.kind === 'edge' ? 'evidence' : 'overview';
}

/**
 * What the Evidence tab asks about for this node, or `null`: a stub asks for nothing, and a person fact never asks (it may be sensitive and a slice does not say).
 */
export function evidenceSubjectForNode(node: Pick<NodeSelection, 'id' | 'nodeKind' | 'entityType'>): EvidenceFeedSubject | null {
  if (node.nodeKind === 'item') {
    return node.entityType === PERSON_FACT_TYPE ? null : { kind: 'item', id: node.id };
  }
  return { kind: 'entity', id: node.id };
}

/** Whether a node is a "+N more" stub, which is neither selectable nor described. */
function isStubNode(graph: ExplorerGraph, id: string): boolean {
  return graph.getNodeAttribute(id, 'isStub') === true;
}

/**
 * Builds the inspector's selection from the URL-independent `selected` handle and the explorer's graph. Returns `null` when the node or edge is no longer on the canvas.
 */
export function buildSelection(input: {
  selected: { kind: 'node' | 'edge'; id: string } | null;
  state: ExplorerState;
  ontology: GraphOntology | null;
  typeLabel: (type: string) => string;
  pinned: (id: string) => boolean;
}): ExplorerSelection | null {
  const { selected, state, ontology, typeLabel, pinned } = input;
  const graph = state.graph;
  if (!selected) return null;
  if (selected.kind === 'node') {
    if (!graph.hasNode(selected.id)) return null;
    const attrs = graph.getNodeAttributes(selected.id);
    return {
      kind: 'node',
      id: selected.id,
      label: attrs.label,
      entityType: attrs.entityType,
      typeLabel: typeLabel(attrs.entityType),
      nodeKind: attrs.nodeKind,
      degree: attrs.degree,
      status: attrs.status,
      occurredAt: attrs.occurredAt,
      isSeed: state.seedIds.includes(selected.id),
      expanded: state.expanded.has(selected.id),
      mentionCount: attrs.mentionCount,
      lastSeenAt: attrs.lastSeenAt,
      pinned: pinned(selected.id),
    };
  }
  if (!graph.hasEdge(selected.id)) return null;
  const attrs = graph.getEdgeAttributes(selected.id);
  // The line to a "+N more" stub is not a relation.
  if (attrs.relationType === STUB_RELATION) return null;
  const [source, target] = graph.extremities(selected.id);
  const sourceAttrs = graph.getNodeAttributes(source);
  const targetAttrs = graph.getNodeAttributes(target);
  const pageEnd =
    sourceAttrs.nodeKind === 'entity'
      ? { id: source, label: sourceAttrs.label }
      : targetAttrs.nodeKind === 'entity'
        ? { id: target, label: targetAttrs.label }
        : null;
  // A real relation asks about itself; a derived one about the item it is derived from (its source).
  let evidenceSubject: EvidenceFeedSubject | null;
  if (attrs.virtual) {
    evidenceSubject =
      sourceAttrs.nodeKind === 'item' && sourceAttrs.entityType !== PERSON_FACT_TYPE ? { kind: 'item', id: source } : null;
  } else {
    evidenceSubject =
      sourceAttrs.entityType === PERSON_FACT_TYPE || targetAttrs.entityType === PERSON_FACT_TYPE
        ? null
        : { kind: 'relation', id: selected.id };
  }
  const chips: string[] = [];
  for (const key of ['role', 'stage']) {
    const value = attrs.props[key];
    if (typeof value === 'string' && value.trim()) chips.push(humanizeKey(value.trim()));
  }
  const stance = attrs.stance ?? stanceOf(attrs.props);
  if (stance) chips.push(stance);
  return {
    kind: 'edge',
    id: selected.id,
    relationType: attrs.relationType,
    relationLabel: relationTypeLabel(attrs.relationType, ontology),
    fromId: source,
    fromLabel: sourceAttrs.label,
    toId: target,
    toLabel: targetAttrs.label,
    pageId: pageEnd?.id ?? null,
    pageLabel: pageEnd?.label ?? null,
    valid: attrs.valid,
    confidence: attrs.confidence,
    virtual: attrs.virtual,
    evidenceCount: attrs.evidenceCount,
    props: relationPropsDisplay(attrs.relationType, attrs.props, ontology),
    chips,
    stance,
    evidenceSubject,
  };
}

// -----------------------------------------------------------------------------
// Connections
// -----------------------------------------------------------------------------

/**
 * One neighbour of the selected node, reached along one edge.
 *
 * @stability experimental
 */
export interface ConnectionItem {
  /** The edge's id. */
  edgeId: string;
  /** The neighbour's node id. */
  nodeId: string;
  /** The neighbour's label. */
  label: string;
  /** The neighbour's type key. */
  type: string;
  /** `out` when the edge leaves the selected node. */
  direction: 'out' | 'in';
  /** Role and stage chips of the edge, then its stance. */
  chips: string[];
  /** The edge's stance, or `null`. */
  stance: Stance | null;
}

/**
 * The neighbours on the canvas of one relation type.
 *
 * @stability experimental
 */
export interface ConnectionGroup {
  /** Relation type key. */
  relationType: string;
  /** Label from the ontology. */
  label: string;
  /** Neighbours on the canvas along this relation. */
  items: ConnectionItem[];
  /** How many the whole graph has along it, from the entity's counts; `null` when not known. */
  total: number | null;
}

/**
 * The selected node's neighbours that are on the canvas, grouped by relation type. A group lists each neighbour once per edge; "+N more" stubs are not neighbours. `totals` (the entity's `counts.relationsByType`) lets a group say how many are not on the canvas yet.
 */
export function connectionGroups(
  graph: ExplorerGraph,
  nodeId: string,
  ontology: GraphOntology | null,
  totals?: Readonly<Record<string, number>>,
): ConnectionGroup[] {
  if (!graph.hasNode(nodeId)) return [];
  const groups = new Map<string, ConnectionGroup>();
  const add = (edgeId: string, neighbourId: string, direction: 'out' | 'in') => {
    if (!graph.hasNode(neighbourId) || isStubNode(graph, neighbourId)) return;
    const edge = graph.getEdgeAttributes(edgeId);
    const node = graph.getNodeAttributes(neighbourId);
    const group = groups.get(edge.relationType) ?? {
      relationType: edge.relationType,
      label: relationTypeLabel(edge.relationType, ontology),
      items: [],
      total: totals?.[edge.relationType] ?? null,
    };
    const chips: string[] = [];
    for (const key of ['role', 'stage']) {
      const value = edge.props[key];
      if (typeof value === 'string' && value.trim()) chips.push(humanizeKey(value.trim()));
    }
    const stance = edge.stance ?? stanceOf(edge.props);
    if (stance) chips.push(stance);
    group.items.push({ edgeId, nodeId: neighbourId, label: node.label, type: node.entityType, direction, chips, stance });
    groups.set(edge.relationType, group);
  };
  graph.forEachOutEdge(nodeId, (edgeId, _attrs, _source, target) => add(edgeId, target, 'out'));
  graph.forEachInEdge(nodeId, (edgeId, _attrs, source) => add(edgeId, source, 'in'));
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

// -----------------------------------------------------------------------------
// The Expand menu
// -----------------------------------------------------------------------------

/**
 * One choice of the Expand menu.
 *
 * @stability experimental
 */
export interface ExpandChoice {
  /** The relation type or entity type key. */
  key: string;
  /** The label shown. */
  label: string;
  /** How many relations the whole graph has, or `null` when the API did not say. */
  count: number | null;
  /** The user's filters hide it, so expanding it would add nothing. */
  disabled: boolean;
}

/**
 * The Expand menu's two lists, from the entity's counts.
 *
 * @stability experimental
 */
export interface ExpandMenuModel {
  /** One choice per relation type the entity has. */
  byRelation: ExpandChoice[];
  /** One choice per entity type at the other end. */
  byType: ExpandChoice[];
}

/**
 * Builds the Expand menu from `counts.relationsByType` and `counts.relationsByNeighborType`, biggest first. A relation or type the user's filters hide is listed disabled. An older API without the counts gives two empty lists: the menu then offers only "All neighbours".
 */
export function expandMenuModel(input: {
  counts: Pick<GraphEntityDetail['counts'], 'relationsByType' | 'relationsByNeighborType'> | null | undefined;
  ontology: GraphOntology | null;
  typeLabel: (type: string) => string;
  hiddenRelationTypes: ReadonlySet<string>;
  hiddenTypes: ReadonlySet<string>;
}): ExpandMenuModel {
  const { counts, ontology, typeLabel, hiddenRelationTypes, hiddenTypes } = input;
  const order = (a: ExpandChoice, b: ExpandChoice) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label);
  const byRelation = Object.entries(counts?.relationsByType ?? {})
    .map(([key, count]) => ({
      key,
      label: relationTypeLabel(key, ontology),
      count,
      disabled: hiddenRelationTypes.has(key),
    }))
    .sort(order);
  const byType = Object.entries(counts?.relationsByNeighborType ?? {})
    .map(([key, count]) => ({ key, label: typeLabel(key), count, disabled: hiddenTypes.has(key) }))
    .sort(order);
  return { byRelation, byType };
}

// -----------------------------------------------------------------------------
// Several nodes
// -----------------------------------------------------------------------------

/**
 * What the Selection view says about two or more marked nodes.
 *
 * @stability experimental
 */
export interface SelectionSummary {
  /** The marked nodes still on the canvas. */
  ids: string[];
  /** Counts per type, biggest first. */
  byType: Array<{ type: string; count: number }>;
  /** Marked nodes that are seeds: they cannot be hidden. */
  seedCount: number;
  /** Nodes outside the selection that are next to at least two of its nodes, most connected first (at most 5). */
  shared: Array<{ id: string; label: string; count: number }>;
}

/**
 * Summarises a multi-selection from the graph: counts by type and the neighbours shared by two or more of the nodes. Nodes no longer on the canvas, and stubs, are ignored.
 */
export function summariseSelection(state: ExplorerState, marked: ReadonlySet<string>): SelectionSummary {
  const graph = state.graph;
  const ids = [...marked].filter((id) => graph.hasNode(id) && !isStubNode(graph, id));
  const counts = new Map<string, number>();
  for (const id of ids) {
    const type = graph.getNodeAttribute(id, 'entityType');
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const inSelection = new Set(ids);
  const shared = new Map<string, number>();
  for (const id of ids) {
    const neighbours = new Set<string>();
    graph.forEachNeighbor(id, (neighbour) => {
      if (!inSelection.has(neighbour) && !isStubNode(graph, neighbour)) neighbours.add(neighbour);
    });
    for (const neighbour of neighbours) shared.set(neighbour, (shared.get(neighbour) ?? 0) + 1);
  }
  return {
    ids,
    byType: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    seedCount: ids.filter((id) => state.seedIds.includes(id)).length,
    shared: [...shared.entries()]
      .filter(([, count]) => count >= 2)
      .map(([id, count]) => ({ id, label: graph.getNodeAttribute(id, 'label'), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 5),
  };
}
