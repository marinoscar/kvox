/**
 * "Ask about this selection" (GIC-17, #678): what the explorer sends to the Ask slot.
 *
 * The scope is made of STARTING HANDLES: the ids of the selected entities and, for an edge, the ids
 * of the evidence that backs it. The Ask turn names them to the agent, which still retrieves the
 * evidence through its own tools; the graph is never a retrieval source on its own. The server
 * checks every id and answers 404 for one the user cannot read.
 *
 * A "+N more" stub and an item (commitment, decision, claim) are not entities and are not sent; a
 * personal fact's evidence is never asked for (the server would refuse it anyway).
 */

import type { KvoxWebHost } from '../../../../../core/headless/index.js';
import { getSubjectEvidence } from '../../../../headless/clients/graph.js';
import type { ExplorerGraph } from '../explorerModel.js';
import type { EdgeSelection } from '../inspector/inspectorModel.js';

/** Most ids of each kind the Ask request carries (the API's limit). */
export const ASK_SCOPE_MAX_IDS = 50;

/**
 * What the Ask slot is opened with.
 *
 * @stability experimental
 */
export interface AskSelectionScope {
  /** Entity ids the question is about. */
  entityIds: string[];
  /** Evidence ids of the selected edge or path; empty for a plain node selection. */
  evidenceIds: string[];
  /** Human name of the selection: "Joe", "Joe and 2 more", "Joe → Copilot rollout". */
  label: string;
  /** The first entity, which the Ask panel scopes its conversation to. */
  primaryId: string;
  /** The primary entity's label. */
  primaryLabel: string;
  /** The primary entity's type key. */
  primaryType: string;
}

function isEntityNode(graph: ExplorerGraph, id: string): boolean {
  if (!graph.hasNode(id)) return false;
  const attrs = graph.getNodeAttributes(id);
  return attrs.nodeKind === 'entity' && attrs.isStub !== true;
}

/** The label of a selection of entities: one name, or the first and a count. */
export function selectionLabel(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? 'this selection';
  return `${labels[0]} and ${labels.length - 1} more`;
}

/**
 * The scope of a set of selected nodes.
 *
 * @param graph - The explorer's graph.
 * @param ids - The selected node ids.
 * @returns The scope, or `null` when none of them is an entity.
 *
 * @stability experimental
 */
export function scopeFromNodes(graph: ExplorerGraph, ids: Iterable<string>): AskSelectionScope | null {
  const entityIds = [...new Set(ids)].filter((id) => isEntityNode(graph, id)).slice(0, ASK_SCOPE_MAX_IDS);
  if (entityIds.length === 0) return null;
  const primary = graph.getNodeAttributes(entityIds[0]);
  return {
    entityIds,
    evidenceIds: [],
    label: selectionLabel(entityIds.map((id) => graph.getNodeAttribute(id, 'label'))),
    primaryId: entityIds[0],
    primaryLabel: primary.label,
    primaryType: primary.entityType,
  };
}

/**
 * The scope of a selected edge: its entity ends and the ids of its evidence.
 *
 * @param host - The host.
 * @param graph - The explorer's graph.
 * @param edge - The selected edge.
 * @param signal - Aborts the evidence request.
 * @returns The scope, or `null` when neither end is an entity.
 *
 * @stability experimental
 */
export async function scopeFromEdge(
  host: KvoxWebHost,
  graph: ExplorerGraph,
  edge: Pick<EdgeSelection, 'fromId' | 'toId' | 'fromLabel' | 'toLabel' | 'evidenceSubject' | 'virtual'>,
  signal?: AbortSignal,
): Promise<AskSelectionScope | null> {
  const ends = scopeFromNodes(graph, [edge.fromId, edge.toId]);
  if (!ends) return null;
  let evidenceIds: string[] = [];
  const subject = edge.evidenceSubject;
  if (subject) {
    const links = await getSubjectEvidence(host, subject.kind, subject.id, signal);
    evidenceIds = links.map((link) => link.id).slice(0, ASK_SCOPE_MAX_IDS);
  }
  return { ...ends, evidenceIds, label: `${edge.fromLabel} → ${edge.toLabel}` };
}
