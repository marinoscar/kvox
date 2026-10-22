import { describe, expect, it } from 'vitest';

import {
  createExplorerState,
  mergeSlice,
  type ExplorerState,
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import { buildEdgeReducer, buildNodeReducer, type ReducerContext } from '../../src/graph/ui/components/explorer/explorerReducers.js';
import {
  DEFAULT_PATH_HOPS,
  buildPathViews,
  clearPathRequest,
  describePath,
  hopSentence,
  parseHops,
  parseRelationList,
  pathIds,
  pathStrength,
  readPathRequest,
  writePathRequest,
} from '../../src/graph/ui/components/explorer/paths/pathModel.js';
import { topQuote } from '../../src/graph/ui/components/explorer/paths/useHopQuotes.js';
import { ACME_ID, JOE_ID } from './graphData.js';
import { COPILOT_ID, EDGE_INVOLVED, EDGE_USES, EDGE_WORKS_FOR, pathEvidence, pathsResponse, pathsSlice } from './pathsData.js';

describe('pathStrength', () => {
  it('maps the API score to strong, moderate and weak', () => {
    expect(pathStrength(2.2)).toBe('strong');
    expect(pathStrength(1.5)).toBe('strong');
    expect(pathStrength(1.0)).toBe('moderate');
    expect(pathStrength(0.8)).toBe('moderate');
    expect(pathStrength(0.3)).toBe('weak');
  });
});

describe('buildPathViews', () => {
  const views = buildPathViews(pathsResponse(), null);

  it('reads each path in walking order with role, stage and stance chips', () => {
    expect(views).toHaveLength(2);
    expect(views[0].nodes.map((n) => n.label)).toEqual(['Joe Rivera', 'Copilot rollout']);
    expect(views[0].strength).toBe('strong');
    expect(views[0].hops[0]).toMatchObject({ edgeId: EDGE_INVOLVED, chips: ['Stakeholder', 'skeptical'], evidenceCount: 5, reversed: false });
    expect(views[1].strength).toBe('moderate');
    expect(views[1].hops.map((h) => h.edgeId)).toEqual([EDGE_WORKS_FOR, EDGE_USES]);
    expect(views[1].hops[1].chips).toEqual(['Pilot']);
  });

  it('asks about a relation, an item behind a virtual edge, and never about a person fact', () => {
    expect(views[0].hops[0].evidenceSubject).toEqual({ kind: 'relation', id: EDGE_INVOLVED });
    const response = pathsResponse();
    const fact = { id: 'f1', nodeKind: 'item' as const, type: 'person_fact', label: 'A fact', depth: 1, degree: 1, status: null, occurredAt: null };
    response.slice.nodes.push(fact);
    response.slice.edges.push({ id: 'virt:f1:ABOUT', type: 'ABOUT', source: 'f1', target: JOE_ID, valid: null, confidence: null, virtual: true });
    response.paths = [{ nodeIds: ['f1', JOE_ID], edgeIds: ['virt:f1:ABOUT'], hops: 1, score: 0.7 }];
    expect(buildPathViews(response, null)[0].hops[0].evidenceSubject).toBeNull();
  });

  it('marks a hop walked against its stored direction', () => {
    const response = pathsResponse({ paths: [{ nodeIds: [COPILOT_ID, JOE_ID], edgeIds: [EDGE_INVOLVED], hops: 1, score: 1.8 }] });
    expect(buildPathViews(response, null)[0].hops[0].reversed).toBe(true);
  });

  it('drops a path that names a node or edge the slice lacks', () => {
    const response = pathsResponse({ paths: [{ nodeIds: [JOE_ID, gid9()], edgeIds: [EDGE_INVOLVED], hops: 1, score: 1 }] });
    expect(buildPathViews(response, null)).toEqual([]);
  });

  it('reads the path as a sentence for a screen reader', () => {
    expect(hopSentence(views[0], 0)).toBe('Joe Rivera, involved in as stakeholder, skeptical, Copilot rollout');
    expect(describePath(views[1])).toBe(
      'Path 2, moderate evidence, 2 hops: Joe Rivera, works for, Acme Corp, uses, pilot, Copilot rollout',
    );
  });

  it('lists the ids to highlight', () => {
    const ids = pathIds(views[1]);
    expect([...ids.nodeIds].sort()).toEqual([ACME_ID, COPILOT_ID, JOE_ID].sort());
    expect([...ids.edgeIds].sort()).toEqual([EDGE_USES, EDGE_WORKS_FOR].sort());
  });
});

function gid9(): string {
  return '00000000-0000-4000-8000-000000000999';
}

describe('the URL', () => {
  it('round-trips pathFrom and pathTo, leaving defaults out', () => {
    const params = new URLSearchParams('seed=x');
    writePathRequest(params, { from: JOE_ID, to: COPILOT_ID, maxHops: DEFAULT_PATH_HOPS, relationTypes: [] });
    expect(params.toString()).toBe(`seed=x&pathFrom=${JOE_ID}&pathTo=${COPILOT_ID}`);
    expect(readPathRequest(params)).toEqual({ from: JOE_ID, to: COPILOT_ID, maxHops: 4, relationTypes: [] });

    writePathRequest(params, { maxHops: 2, relationTypes: ['USES', 'WORKS_FOR'] });
    expect(readPathRequest(params)).toMatchObject({ maxHops: 2, relationTypes: ['USES', 'WORKS_FOR'] });

    clearPathRequest(params);
    expect(params.toString()).toBe('seed=x');
  });

  it('reads anything malformed as absent or the default', () => {
    const params = new URLSearchParams('pathFrom=nope&pathTo=&pathHops=9&pathRel=A-B,C');
    expect(readPathRequest(params)).toEqual({ from: null, to: null, maxHops: 4, relationTypes: ['C'] });
    expect(parseHops('1')).toBe(4);
    expect(parseHops('5')).toBe(5);
    expect(parseRelationList(null)).toEqual([]);
  });
});

describe('topQuote', () => {
  it('prefers the newest quote whose source still exists', () => {
    const gone = { ...pathEvidence[0], source: { ...pathEvidence[0].source, available: false } } as typeof pathEvidence[0];
    expect(topQuote([gone, pathEvidence[1]])?.id).toBe(pathEvidence[1].id);
    expect(topQuote([gone])?.id).toBe(gone.id);
    expect(topQuote([])).toBeNull();
  });
});

describe('path reducers', () => {
  function loaded(): ExplorerState {
    const state = createExplorerState();
    mergeSlice(state, pathsSlice());
    return state;
  }
  function context(state: ExplorerState, over: Partial<ReducerContext> = {}): ReducerContext {
    return {
      graph: state.graph,
      visibleIds: new Set(state.graph.nodes()),
      selectedId: null,
      focusId: null,
      accent: '#1976d2',
      dimColor: 'rgba(0,0,0,0.2)',
      ...over,
    };
  }
  const nodeData = (s: ExplorerState, id: string) => s.graph.getNodeAttributes(id) as unknown as Record<string, unknown>;
  const edgeData = (s: ExplorerState, id: string) => s.graph.getEdgeAttributes(id) as unknown as Record<string, unknown>;

  it('lights the path and dims everything else', () => {
    const state = loaded();
    const ctx = context(state, { pathNodeIds: new Set([JOE_ID, COPILOT_ID]), pathEdgeIds: new Set([EDGE_INVOLVED]) });
    const node = buildNodeReducer(ctx);
    const edge = buildEdgeReducer(ctx);

    const joe = node(JOE_ID, nodeData(state, JOE_ID));
    expect(joe.highlighted).toBe(true);
    expect(joe.forceLabel).toBe(true);
    const acme = node(ACME_ID, nodeData(state, ACME_ID));
    expect(acme.label).toBe('');
    expect(acme.color).not.toBe(state.graph.getNodeAttribute(ACME_ID, 'color'));

    const onPath = edge(EDGE_INVOLVED, edgeData(state, EDGE_INVOLVED));
    expect(onPath.zIndex).toBe(3);
    expect(Number(onPath.size)).toBeGreaterThanOrEqual(3);
    const off = edge(EDGE_WORKS_FOR, edgeData(state, EDGE_WORKS_FOR));
    expect(off.color).not.toBe(state.graph.getEdgeAttribute(EDGE_WORKS_FOR, 'color'));
  });

  it('draws as before with an empty path, and a focus takes over from the path', () => {
    const state = loaded();
    const plain = buildNodeReducer(context(state, { pathNodeIds: new Set(), pathEdgeIds: new Set() }));
    expect(plain(ACME_ID, nodeData(state, ACME_ID)).label).toBe(state.graph.getNodeAttribute(ACME_ID, 'label'));
    const focused = buildNodeReducer(context(state, { focusId: ACME_ID, pathNodeIds: new Set([JOE_ID]) }));
    expect(focused(ACME_ID, nodeData(state, ACME_ID)).forceLabel).toBe(true);
  });
});
