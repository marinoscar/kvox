import { MultiDirectedGraph } from 'graphology';

import { pictogramDataUri } from '../../src/graph/ui/components/explorer/icons/pictograms.js';

/**
 * A small explorer-shaped graph with invented placeholders only, for the G6 canvas tests (#775):
 *
 *   Person A (seed) -WORKS_FOR-> Org Alpha
 *   Person A -INVOLVED_IN-> Project P1
 *   Project P1 -USES-> Product X
 *   Person B (no edge to the seed's neighbourhood)
 *   a "+3 more Person" stub on Person A
 */
export const PERSON_A = 'person-a';
export const PERSON_B = 'person-b';
export const ORG_ALPHA = 'org-alpha';
export const PROJECT_P1 = 'project-p1';
export const PRODUCT_X = 'product-x';
export const STUB = 'stub:person-a:Person';

function node(label: string, entityType: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return {
    x,
    y,
    size: 10,
    color: '#0d66a5',
    label,
    nodeKind: 'entity',
    entityType,
    degree: 1,
    status: null,
    occurredAt: null,
    mentionCount: null,
    lastSeenAt: null,
    isSeed: false,
    image: pictogramDataUri('person'),
    iconColor: '#ffffff',
    ...extra,
  };
}

function edge(relationType: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'arrow',
    relationType,
    valid: null,
    confidence: 0.9,
    virtual: false,
    props: {},
    size: 2,
    color: '#4a5aa8',
    evidenceCount: 2,
    stance: null,
    dashed: false,
    label,
    curvature: 0,
    ...extra,
  };
}

/** Builds the fixture graph; every call is a fresh graph. */
export function canvasGraph(): MultiDirectedGraph {
  const graph = new MultiDirectedGraph();
  graph.addNode(PERSON_A, node('Person A', 'Person', 0, 0, { isSeed: true, size: 14 }));
  graph.addNode(ORG_ALPHA, node('Org Alpha', 'Organization', 100, 0));
  graph.addNode(PROJECT_P1, node('Project P1', 'Project', 0, 100, { nodeKind: 'item', entityType: 'commitment' }));
  graph.addNode(PRODUCT_X, node('Product X', 'Product', 100, 100, { iconColor: '#111111' }));
  graph.addNode(PERSON_B, node('Person B', 'Person', 400, 400));
  graph.addNode(STUB, node('+3 more Person', 'Person', -60, -60, { isStub: true, stubCount: 3, stubParentId: PERSON_A }));
  graph.addDirectedEdgeWithKey('e-works', PERSON_A, ORG_ALPHA, edge('WORKS_FOR', 'Works for'));
  graph.addDirectedEdgeWithKey('e-involved', PERSON_A, PROJECT_P1, edge('INVOLVED_IN', 'Involved in', { dashed: true }));
  graph.addDirectedEdgeWithKey('e-uses', PROJECT_P1, PRODUCT_X, edge('USES', 'Uses', { curvature: 0.15 }));
  graph.addDirectedEdgeWithKey('e-stub', PERSON_A, STUB, edge('__more', ''));
  return graph;
}
