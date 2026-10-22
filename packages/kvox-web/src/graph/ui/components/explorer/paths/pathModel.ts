/**
 * NO REACT. What path mode ("Connect A and B", GIC-13, #674; epic #661) shows,
 * derived from the paths API's answer: the three-level strength of a path, its
 * hops with the role, stage and stance chips of each edge, the screen-reader
 * sentence, and the URL parameters that make a path shareable.
 *
 * The API ranks and returns ids into one merged `slice`; this file only reads
 * the slice, so a path is described exactly as the graph holds it. A sensitive
 * person fact never reaches here (the slice omits it) and a hop that touches a
 * person fact asks for no evidence (`evidenceSubject: null`), the same rule as
 * the inspector's.
 */

import type {
  GraphEdge,
  GraphNode,
  GraphOntology,
  GraphPath,
  GraphPathsResponse,
} from '../../../../headless/clients/graph.js';
import { GRAPH_PATHS_MAX_HOPS } from '../../../../headless/clients/graph.js';
import type { EvidenceFeedSubject } from '../../../../headless/hooks/useGraphEvidenceFeed.js';
import { humanizeKey, relationTypeLabel } from '../../../../headless/utils/graphDisplay.js';
import { stanceOf } from '../explorerEncoding.js';

/**
 * The URL parameters of path mode. `pathFrom` alone opens the picker with A filled in (the entry point other surfaces link to); with `pathTo` the paths are searched and shown.
 *
 * @stability experimental
 */
export const PATH_PARAMS = {
  /** Id of the start entity. */
  from: 'pathFrom',
  /** Id of the end entity. */
  to: 'pathTo',
  /** Longest path, in edges (2 to 5). */
  hops: 'pathHops',
  /** Comma-separated relation types a path may follow; absent means all. */
  relations: 'pathRel',
} as const;

/** The fewest hops the picker offers. */
export const MIN_PATH_HOPS = 2;
/** The most hops the picker offers (the API's own limit). */
export const MAX_PATH_HOPS = GRAPH_PATHS_MAX_HOPS;
/** The hops asked for when the URL says nothing (the API's default). */
export const DEFAULT_PATH_HOPS = 4;
/** How many paths one search asks for. */
export const PATH_COUNT = 3;

/** A path whose score is at least this is "strong" evidence (about four citations per edge). */
export const STRONG_PATH_SCORE = 1.5;
/** A path whose score is at least this is "moderate" evidence. */
export const MODERATE_PATH_SCORE = 0.8;

/**
 * How well the evidence behind a path supports it.
 *
 * @stability experimental
 */
export type PathStrength = 'strong' | 'moderate' | 'weak';

/** The strength a score stands for. The score is the API's `mean(log(1 + evidenceCount))`, discounted for hubs. */
export function pathStrength(score: number): PathStrength {
  if (score >= STRONG_PATH_SCORE) return 'strong';
  if (score >= MODERATE_PATH_SCORE) return 'moderate';
  return 'weak';
}

/** "strong evidence", "moderate evidence" or "weak evidence". */
export function strengthLabel(strength: PathStrength): string {
  return `${strength} evidence`;
}

/**
 * One node of a path.
 *
 * @stability experimental
 */
export interface PathNodeView {
  /** The node's id. */
  id: string;
  /** Its label. */
  label: string;
  /** Its entity type or item kind. */
  type: string;
}

/**
 * One edge of a path, read in walking order.
 *
 * @stability experimental
 */
export interface PathHopView {
  /** The edge's id in the slice. */
  edgeId: string;
  /** Relation type key. */
  relationType: string;
  /** Relation label from the ontology. */
  relationLabel: string;
  /** `true` when the walk crosses the edge against its stored direction. */
  reversed: boolean;
  /** The node the walk leaves. */
  fromId: string;
  /** The node the walk arrives at. */
  toId: string;
  /** The edge's role (humanized), or `null`. */
  role: string | null;
  /** The edge's stage (humanized), or `null`. */
  stage: string | null;
  /** The edge's stance, or `null`. */
  stance: string | null;
  /** Role, stage and stance, in that order, for the chips. */
  chips: string[];
  /** How many citations support the edge (0 when the API did not say). */
  evidenceCount: number;
  /** What to ask the evidence API about, or `null` when nothing may be asked (a person fact). */
  evidenceSubject: EvidenceFeedSubject | null;
}

/**
 * One path, ready to draw.
 *
 * @stability experimental
 */
export interface PathView {
  /** Position in the ranking, from 0. */
  index: number;
  /** The API's score. */
  score: number;
  /** The score as strong, moderate or weak. */
  strength: PathStrength;
  /** The nodes in walking order. */
  nodes: PathNodeView[];
  /** The hops between consecutive nodes; one fewer than the nodes. */
  hops: PathHopView[];
}

const PERSON_FACT = 'person_fact';

function hopOf(
  edge: GraphEdge,
  fromId: string,
  toId: string,
  nodes: ReadonlyMap<string, GraphNode>,
  ontology: GraphOntology | null,
): PathHopView {
  const props = edge.props ?? {};
  const text = (key: string): string | null => {
    const value = props[key];
    return typeof value === 'string' && value.trim() ? humanizeKey(value.trim()) : null;
  };
  const role = text('role');
  const stage = text('stage');
  const stance = stanceOf(props);
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  let evidenceSubject: EvidenceFeedSubject | null;
  if (edge.virtual) {
    evidenceSubject = source?.nodeKind === 'item' && source.type !== PERSON_FACT ? { kind: 'item', id: edge.source } : null;
  } else {
    evidenceSubject =
      source?.type === PERSON_FACT || target?.type === PERSON_FACT ? null : { kind: 'relation', id: edge.id };
  }
  return {
    edgeId: edge.id,
    relationType: edge.type,
    relationLabel: relationTypeLabel(edge.type, ontology),
    reversed: edge.source !== fromId,
    fromId,
    toId,
    role,
    stage,
    stance,
    chips: [role, stage, stance].filter((chip): chip is string => chip !== null),
    evidenceCount: edge.evidenceCount ?? 0,
    evidenceSubject,
  };
}

/**
 * The answer of `GET /graph/paths` as views, best first. A path that names a node or an edge the slice lacks is dropped rather than drawn half-way.
 */
export function buildPathViews(response: GraphPathsResponse, ontology: GraphOntology | null): PathView[] {
  const nodes = new Map(response.slice.nodes.map((node) => [node.id, node]));
  const edges = new Map(response.slice.edges.map((edge) => [edge.id, edge]));
  const views: PathView[] = [];
  response.paths.forEach((path: GraphPath, index) => {
    if (path.nodeIds.length < 2 || path.edgeIds.length !== path.nodeIds.length - 1) return;
    const pathNodes: PathNodeView[] = [];
    for (const id of path.nodeIds) {
      const node = nodes.get(id);
      if (!node) return;
      pathNodes.push({ id, label: node.label, type: node.type });
    }
    const hops: PathHopView[] = [];
    for (let i = 0; i < path.edgeIds.length; i += 1) {
      const edge = edges.get(path.edgeIds[i]);
      if (!edge) return;
      hops.push(hopOf(edge, path.nodeIds[i], path.nodeIds[i + 1], nodes, ontology));
    }
    views.push({ index, score: path.score, strength: pathStrength(path.score), nodes: pathNodes, hops });
  });
  return views;
}

/** The hop in words: "Joe, involved in as stakeholder, skeptical, Copilot rollout". Without `withStart` the start node is left out (it was just said). */
export function hopSentence(path: PathView, hopIndex: number, withStart = true): string {
  const hop = path.hops[hopIndex];
  const from = path.nodes[hopIndex];
  const to = path.nodes[hopIndex + 1];
  const relation = `${hop.relationLabel.toLowerCase()}${hop.role ? ` as ${hop.role.toLowerCase()}` : ''}${hop.reversed ? ' (reversed)' : ''}`;
  const rest = [hop.stage, hop.stance].filter((part): part is string => part !== null).map((part) => part.toLowerCase());
  return [withStart ? from.label : null, relation, ...rest, to.label].filter((part) => part !== null).join(', ');
}

/** The whole path as one sentence for a screen reader: strength first, then the chain of hops. */
export function describePath(path: PathView): string {
  const hops = path.hops.map((_hop, index) => hopSentence(path, index, index === 0)).join(', ');
  const count = path.hops.length === 1 ? '1 hop' : `${path.hops.length} hops`;
  return `Path ${path.index + 1}, ${strengthLabel(path.strength)}, ${count}: ${hops}`;
}

/** The ids of every node and edge of a path, for highlighting. */
export function pathIds(path: PathView): { nodeIds: Set<string>; edgeIds: Set<string> } {
  return { nodeIds: new Set(path.nodes.map((node) => node.id)), edgeIds: new Set(path.hops.map((hop) => hop.edgeId)) };
}

/** `?pathHops=` as a number from {@link MIN_PATH_HOPS} to {@link MAX_PATH_HOPS}; anything else is the default. */
export function parseHops(raw: string | null): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_PATH_HOPS && value <= MAX_PATH_HOPS ? value : DEFAULT_PATH_HOPS;
}

/** `?pathRel=` as a list of relation type keys. */
export function parseRelationList(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((key) => key.trim()).filter((key) => /^[A-Za-z0-9_]+$/.test(key)))];
}

/**
 * What the URL says about path mode.
 *
 * @stability experimental
 */
export interface PathRequest {
  /** Start entity id, or `null`. */
  from: string | null;
  /** End entity id, or `null`. */
  to: string | null;
  /** Longest path in edges. */
  maxHops: number;
  /** Relation types a path may follow; empty means all. */
  relationTypes: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the path parameters; an id that is not a UUID reads as absent. */
export function readPathRequest(params: URLSearchParams): PathRequest {
  const id = (key: string) => {
    const value = params.get(key);
    return value && UUID.test(value) ? value : null;
  };
  return {
    from: id(PATH_PARAMS.from),
    to: id(PATH_PARAMS.to),
    maxHops: parseHops(params.get(PATH_PARAMS.hops)),
    relationTypes: parseRelationList(params.get(PATH_PARAMS.relations)),
  };
}

/** Writes a request into the parameters; defaults are left out so a shared link stays short. */
export function writePathRequest(params: URLSearchParams, request: Partial<PathRequest>): void {
  const set = (key: string, value: string | null) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  if ('from' in request) set(PATH_PARAMS.from, request.from ?? null);
  if ('to' in request) set(PATH_PARAMS.to, request.to ?? null);
  if (request.maxHops !== undefined) set(PATH_PARAMS.hops, request.maxHops === DEFAULT_PATH_HOPS ? null : String(request.maxHops));
  if (request.relationTypes !== undefined) set(PATH_PARAMS.relations, request.relationTypes.length > 0 ? request.relationTypes.join(',') : null);
}

/** Removes path mode from the parameters. */
export function clearPathRequest(params: URLSearchParams): void {
  for (const key of Object.values(PATH_PARAMS)) params.delete(key);
}
