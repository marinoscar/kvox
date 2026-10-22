import { describe, expect, it } from 'vitest';

import {
  DIM_OPACITY,
  DOI_WEIGHTS,
  EXPLORER_NEIGHBOUR_LIMIT,
  EXPLORER_NODE_CAP,
  STUB_RELATION,
  applyFilters,
  createExplorerState,
  degreeOfInterest,
  dropStub,
  highlightSet,
  keyboardOrder,
  legendModel,
  makeSeed,
  mergeSlice,
  realNodeCount,
  refreshCurvature,
  remainingCapacity,
  stubId,
  toListModel,
  type ExplorerState,
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import {
  CURVED_ARROW_PROGRAM,
  MAX_FOCUS_EDGE_LABELS,
  PICTOGRAM_PROGRAM,
  buildEdgeReducer,
  buildNodeReducer,
  type ReducerContext,
} from '../../src/graph/ui/components/explorer/explorerReducers.js';
import { STANCE_COLORS } from '../../src/graph/ui/components/explorer/explorerEncoding.js';
import type { GraphEdge, GraphSlice } from '../../src/graph/headless/clients/graph.js';
import { ACME_ID, ANA_ID, JOE_ID, Q3_MEETING_ID, expandFixture, gid, hubFixture } from './graphData.js';

/**
 * The explorer's visual language, model half (#667): degree of interest, the
 * "+N more" stubs, parallel-edge curvature, the highlight reducers and the legend
 * model. No sigma and no WebGL anywhere: the reducers are pure.
 */

const NOW = Date.parse('2026-09-26T00:00:00.000Z');

function joeSlice(): GraphSlice {
  return expandFixture({ nodeIds: [JOE_ID], cap: 300 })!;
}

function loaded(slice: GraphSlice = joeSlice(), opts: Parameters<typeof mergeSlice>[2] = {}): ExplorerState {
  const state = createExplorerState();
  state.seedIds = [...slice.seedIds];
  mergeSlice(state, slice, { now: NOW, ...opts });
  return state;
}

function hubState(): ExplorerState {
  return loaded(hubFixture({ nodeIds: [JOE_ID], cap: 300 })!, { neighbourLimit: EXPLORER_NEIGHBOUR_LIMIT });
}

describe('degreeOfInterest', () => {
  const base = { degree: 4, distance: 1 };

  it('rises with mentions (else degree), with recency and with the user interest flags; falls with distance', () => {
    const score = (input: Partial<Parameters<typeof degreeOfInterest>[0]>) =>
      degreeOfInterest({ ...base, ...input }, DOI_WEIGHTS, NOW);
    expect(score({ degree: 40 })).toBeGreaterThan(score({ degree: 4 }));
    expect(score({ mentionCount: 40 })).toBeGreaterThan(score({ mentionCount: 4 }));
    // mentionCount wins over degree when present.
    expect(score({ mentionCount: 1, degree: 1000 })).toBeLessThan(score({ degree: 1000 }));
    expect(score({ lastSeenAt: '2026-09-25T00:00:00.000Z' })).toBeGreaterThan(score({ lastSeenAt: '2024-01-01T00:00:00.000Z' }));
    expect(score({ lastSeenAt: '2024-01-01T00:00:00.000Z' })).toBeGreaterThan(score({}));
    expect(score({ pinned: true })).toBeGreaterThan(score({}));
    expect(score({ searched: true })).toBeGreaterThan(score({}));
    expect(score({ seed: true })).toBeGreaterThan(score({}));
    expect(score({ distance: 2 })).toBeLessThan(score({ distance: 1 }));
  });

  it('has pinned default weights', () => {
    expect(DOI_WEIGHTS).toEqual({ importance: 1, recency: 0.5, interest: 2, distance: 0.75 });
    // importance only: ln(1 + 4); a seed at distance 0 adds 2.
    expect(degreeOfInterest({ degree: 4, distance: 0 }, DOI_WEIGHTS, NOW)).toBeCloseTo(Math.log(5), 6);
    expect(degreeOfInterest({ degree: 4, distance: 0, seed: true }, DOI_WEIGHTS, NOW)).toBeCloseTo(Math.log(5) + 2, 6);
    expect(degreeOfInterest({ degree: 4, distance: 2 }, DOI_WEIGHTS, NOW)).toBeCloseTo(Math.log(5) - 1.5, 6);
  });

  it('recency halves every 90 days and ignores an unparseable date', () => {
    const fresh = degreeOfInterest({ degree: 0, distance: 0, lastSeenAt: new Date(NOW).toISOString() }, DOI_WEIGHTS, NOW);
    const later = degreeOfInterest({ degree: 0, distance: 0, lastSeenAt: new Date(NOW - 90 * 86_400_000).toISOString() }, DOI_WEIGHTS, NOW);
    expect(fresh).toBeCloseTo(0.5, 6);
    expect(later).toBeCloseTo(0.25, 6);
    expect(degreeOfInterest({ degree: 0, distance: 0, lastSeenAt: 'not a date' }, DOI_WEIGHTS, NOW)).toBe(0);
  });
});

describe('truncation order is degree of interest', () => {
  function slice(nodes: { id: string; degree: number; lastSeenAt?: string; mentionCount?: number }[]): GraphSlice {
    return {
      seedIds: [JOE_ID],
      asOf: '2026-09-26T00:00:00.000Z',
      nodes: [
        { id: JOE_ID, nodeKind: 'entity', type: 'Person', label: 'Joe', depth: 0, degree: 3, status: null, occurredAt: null },
        ...nodes.map((n) => ({
          nodeKind: 'entity' as const,
          type: 'Person',
          label: n.id,
          depth: 1,
          status: null,
          occurredAt: null,
          ...n,
        })),
      ],
      edges: nodes.map((n, i) => ({
        id: gid(900 + i),
        type: 'WORKS_FOR',
        source: n.id,
        target: JOE_ID,
        valid: null,
        confidence: 0.5,
        virtual: false,
      })),
      truncated: false,
      cap: 300,
    };
  }

  it('keeps the node with the most mentions over a higher-degree one when only mentions are sent', () => {
    const a = gid(701);
    const b = gid(702);
    const state = createExplorerState();
    state.seedIds = [JOE_ID];
    // Room for the seed and ONE neighbour.
    const filler = Array.from({ length: EXPLORER_NODE_CAP - 2 }, (_, i) => gid(10_000 + i));
    mergeSlice(state, { ...slice([]), nodes: [slice([]).nodes[0], ...filler.map((id) => ({ ...slice([]).nodes[0], id, label: id }))] });
    expect(remainingCapacity(state)).toBe(1);
    mergeSlice(state, slice([{ id: a, degree: 50, mentionCount: 1 }, { id: b, degree: 2, mentionCount: 90 }]), { now: NOW });
    expect(state.graph.hasNode(b)).toBe(true);
    expect(state.graph.hasNode(a)).toBe(false);
  });

  it('a recent node beats an equally connected stale one', () => {
    const recent = gid(711);
    const stale = gid(712);
    const state = loaded(
      slice([
        { id: stale, degree: 3, lastSeenAt: '2023-01-01T00:00:00.000Z' },
        { id: recent, degree: 3, lastSeenAt: '2026-09-20T00:00:00.000Z' },
      ]),
      { neighbourLimit: 1 },
    );
    expect(state.graph.hasNode(recent)).toBe(true);
    expect(state.graph.hasNode(stale)).toBe(false);
    expect(state.graph.hasNode(stubId(JOE_ID, 'Person'))).toBe(true);
  });

  it('searched nodes outrank the rest', () => {
    const wanted = gid(721);
    const other = gid(722);
    const state = loaded(slice([{ id: other, degree: 9 }, { id: wanted, degree: 1 }]), {
      neighbourLimit: 1,
      searchedIds: new Set([wanted]),
    });
    expect(state.graph.hasNode(wanted)).toBe(true);
    expect(state.graph.hasNode(other)).toBe(false);
  });

  it('the seeds of a slice always come first, whatever their score', () => {
    const state = createExplorerState();
    const big = hubFixture({ nodeIds: [JOE_ID], cap: 300 })!;
    mergeSlice(state, { ...big, nodes: big.nodes.map((n) => (n.id === JOE_ID ? { ...n, degree: 0 } : n)) }, { neighbourLimit: 5 });
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
  });
});

describe('first open of a 200-neighbour hub', () => {
  it('shows at most 30 neighbours plus one "+N more" stub per type', () => {
    const state = hubState();
    const real = state.graph.filterNodes((_id, a) => !a.isStub && a.entityType !== undefined);
    expect(real).toHaveLength(1 + EXPLORER_NEIGHBOUR_LIMIT);
    expect(realNodeCount(state)).toBe(31);

    const stubs = state.graph.filterNodes((_id, a) => Boolean(a.isStub));
    // Every type that overflowed has exactly one stub, and the counts add up to the rest.
    const shown = (type: string) => real.filter((id) => state.graph.getNodeAttribute(id, 'entityType') === type && id !== JOE_ID).length;
    const total = { Person: 120, Organization: 50, Meeting: 30 } as const;
    for (const type of Object.keys(total) as (keyof typeof total)[]) {
      const stub = state.graph.getNodeAttributes(stubId(JOE_ID, type));
      expect(stub.isStub).toBe(true);
      expect(stub.stubParentId).toBe(JOE_ID);
      expect(stub.stubType).toBe(type);
      expect(stub.stubCount).toBe(total[type] - shown(type));
      expect(stub.label).toBe(`+${stub.stubCount} more ${type}`);
    }
    expect(stubs).toHaveLength(3);
    expect(shown('Person') + shown('Organization') + shown('Meeting')).toBe(30);
  });

  it('the 30 are the best by degree of interest: every shown neighbour is at least as connected as every hidden one', () => {
    const state = hubState();
    const slice = hubFixture({ nodeIds: [JOE_ID], cap: 300 })!;
    const shown = slice.nodes.filter((n) => n.id !== JOE_ID && state.graph.hasNode(n.id)).map((n) => n.degree);
    const hidden = slice.nodes.filter((n) => n.id !== JOE_ID && !state.graph.hasNode(n.id)).map((n) => n.degree);
    expect(shown).toHaveLength(30);
    expect(Math.min(...shown)).toBeGreaterThanOrEqual(Math.max(...hidden));
  });

  it('a stub is tied to its node, does not count toward the cap and is not a relation to filter', () => {
    const state = hubState();
    const id = stubId(JOE_ID, 'Person');
    expect(state.graph.hasEdge(`stubedge:${id}`)).toBe(true);
    expect(state.graph.getEdgeAttribute(`stubedge:${id}`, 'relationType')).toBe(STUB_RELATION);
    expect(remainingCapacity(state)).toBe(EXPLORER_NODE_CAP - 31);

    // A relation filter that allows nothing keeps the seed's stubs attached (a stub tie is no relation).
    applyFilters(state, new Set(['Person', 'Organization', 'Meeting']), new Set(['SOMETHING_ELSE']));
    expect(state.graph.hasNode(id)).toBe(true);
  });

  it('dropping a stub removes its node and edge; only a stub can be dropped', () => {
    const state = hubState();
    const id = stubId(JOE_ID, 'Person');
    expect(dropStub(state, id)).toBe(true);
    expect(state.graph.hasNode(id)).toBe(false);
    expect(state.graph.hasEdge(`stubedge:${id}`)).toBe(false);
    expect(dropStub(state, JOE_ID)).toBe(false);
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
  });

  it('a stub follows its type: hiding the type removes it', () => {
    const state = hubState();
    state.hiddenTypes = new Set(['Meeting']);
    applyFilters(state, new Set(['Person', 'Organization']), null);
    expect(state.graph.hasNode(stubId(JOE_ID, 'Meeting'))).toBe(false);
    expect(state.graph.hasNode(stubId(JOE_ID, 'Person'))).toBe(true);
  });

  it('stubs are in the list and the keyboard order, last; they never count as nodes', () => {
    const state = hubState();
    const rows = toListModel(state);
    expect(rows).toHaveLength(31 + 3);
    const order = keyboardOrder(state, NOW);
    expect(order[0]).toBe(JOE_ID);
    expect(order.slice(-3).every((id) => state.graph.getNodeAttribute(id, 'isStub'))).toBe(true);
  });

  it('without a limit a merge adds every node and no stub', () => {
    const state = loaded(hubFixture({ nodeIds: [JOE_ID], cap: 300 })!);
    expect(state.graph.filterNodes((_id, a) => Boolean(a.isStub))).toHaveLength(0);
    expect(state.graph.order).toBe(201);
  });
});

describe('keyboardOrder is degree of interest', () => {
  it('puts the seed first, then at each distance the best connected, then label', () => {
    const state = loaded();
    const order = keyboardOrder(state, NOW);
    expect(order[0]).toBe(JOE_ID);
    expect(new Set(order)).toEqual(new Set(state.graph.nodes()));
    const depth = new Map(toListModel(state).map((row) => [row.id, row.depthFromSeed]));
    for (const distance of new Set(depth.values())) {
      const degrees = order
        // Nodes with a date also score recency, so compare the undated ones.
        .filter((id) => id !== JOE_ID && depth.get(id) === distance && !state.graph.getNodeAttribute(id, 'occurredAt'))
        .map((id) => state.graph.getNodeAttribute(id, 'degree'));
      expect([...degrees].sort((a, b) => b - a)).toEqual(degrees);
    }
  });

  it('a pinned node outranks a better connected one', () => {
    const state = loaded();
    const others = keyboardOrder(state, NOW).filter((id) => id !== JOE_ID);
    const last = others[others.length - 1];
    state.graph.setNodeAttribute(last, 'fixed', true);
    expect(keyboardOrder(state, NOW)[1]).toBe(last);
  });
});

describe('seed flags and rings', () => {
  it('marks the seeds of a merge, and a promoted node', () => {
    const state = loaded();
    expect(state.graph.getNodeAttribute(JOE_ID, 'isSeed')).toBe(true);
    expect(state.graph.getNodeAttribute(ACME_ID, 'isSeed')).toBe(false);
    makeSeed(state, ACME_ID);
    expect(state.graph.getNodeAttribute(ACME_ID, 'isSeed')).toBe(true);
  });

  it('an expand does not turn the expanded node into a seed', () => {
    const state = loaded();
    mergeSlice(state, expandFixture({ nodeIds: [ACME_ID], cap: 300 })!, { parentId: ACME_ID });
    expect(state.graph.getNodeAttribute(ACME_ID, 'isSeed')).toBe(false);
    expect(state.graph.getNodeAttribute(JOE_ID, 'isSeed')).toBe(true);
  });
});

describe('edge appearance in the graph', () => {
  function stanceSlice(): GraphSlice {
    const project = gid(801);
    return {
      seedIds: [JOE_ID],
      asOf: '2026-09-26T00:00:00.000Z',
      nodes: [
        { id: JOE_ID, nodeKind: 'entity', type: 'Person', label: 'Joe', depth: 0, degree: 2, status: null, occurredAt: null },
        { id: project, nodeKind: 'entity', type: 'Project', label: 'Copilot rollout', depth: 1, degree: 2, status: null, occurredAt: null },
      ],
      edges: [
        // Two parallel relations in the same direction, and one back the other way.
        { id: gid(811), type: 'INVOLVED_IN', source: JOE_ID, target: project, valid: null, confidence: 0.9, virtual: false, props: { stance: 'resistant', role: 'sponsor' } },
        { id: gid(812), type: 'WORKS_ON', source: JOE_ID, target: project, valid: null, confidence: 0.4, virtual: false, props: {} },
        { id: gid(813), type: 'OWNS', source: project, target: JOE_ID, valid: null, confidence: 0.5, virtual: true, props: {} },
      ],
      truncated: false,
      cap: 300,
    };
  }

  it('gives an INVOLVED_IN edge its stance colour, dash flag and hover label', () => {
    const state = loaded(stanceSlice());
    const attrs = state.graph.getEdgeAttributes(gid(811));
    expect(attrs.stance).toBe('resistant');
    expect(attrs.color).toBe(STANCE_COLORS.light.resistant);
    expect(attrs.dashed).toBe(true);
    expect(attrs.label).toBe('Involved in · Sponsor · resistant');
    expect(state.graph.getEdgeAttribute(gid(812), 'stance')).toBeNull();
  });

  it('widens by evidenceCount when sent, by confidence until then', () => {
    const slice = stanceSlice();
    const withEvidence: GraphSlice = {
      ...slice,
      edges: slice.edges.map((e) => (e.id === gid(811) ? ({ ...e, evidenceCount: 12 } as GraphEdge) : e)),
    };
    const a = loaded(withEvidence);
    expect(a.graph.getEdgeAttribute(gid(811), 'evidenceCount')).toBe(12);
    expect(a.graph.getEdgeAttribute(gid(811), 'size')).toBeGreaterThan(3);
    const b = loaded(slice);
    expect(b.graph.getEdgeAttribute(gid(811), 'evidenceCount')).toBeNull();
    // 1 + 1.5 * 0.9 and 1 + 1.5 * 0.4
    expect(b.graph.getEdgeAttribute(gid(811), 'size')).toBeCloseTo(2.35, 2);
    expect(b.graph.getEdgeAttribute(gid(812), 'size')).toBeCloseTo(1.6, 2);
  });

  it('fans parallel edges apart, mirrored for the opposite direction, and leaves a lone edge straight', () => {
    const state = loaded(stanceSlice());
    const c = (id: string) => state.graph.getEdgeAttribute(id, 'curvature');
    const [a, b] = [gid(811), gid(812)];
    // Three edges between one pair: -0.3, 0, 0.3 in the canonical direction.
    const values = [c(a), c(b), -c(gid(813))].sort((x, y) => x - y);
    expect(values).toEqual([-0.3, 0, 0.3]);

    // Drop two of them and the survivor is straight again.
    state.graph.dropEdge(a);
    state.graph.dropEdge(b);
    refreshCurvature(state.graph);
    expect(c(gid(813))).toBe(0);
  });

  it('a lone edge between two nodes has no curvature', () => {
    const state = loaded();
    state.graph.forEachEdge((_id, attrs) => expect(attrs.curvature).toBeDefined());
    const pairs = new Map<string, number>();
    state.graph.forEachEdge((_id, _a, s, t) => {
      const key = [s, t].sort().join('|');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    });
    state.graph.forEachEdge((id, attrs, s, t) => {
      if (pairs.get([s, t].sort().join('|')) === 1) expect(attrs.curvature, id).toBe(0);
    });
  });
});

describe('highlightSet', () => {
  it('is the node, its neighbours and its own edges; null for no focus or an unknown node', () => {
    const state = loaded();
    const set = highlightSet(state.graph, JOE_ID)!;
    expect(set.nodes.has(JOE_ID)).toBe(true);
    expect(set.nodes.has(ACME_ID)).toBe(true);
    expect(set.nodes.has(Q3_MEETING_ID)).toBe(true);
    expect(set.edges.size).toBe(state.graph.degree(JOE_ID));
    expect(highlightSet(state.graph, null)).toBeNull();
    expect(highlightSet(state.graph, gid(123456))).toBeNull();
  });
});

describe('reducers', () => {
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
  const nodeData = (state: ExplorerState, id: string) => state.graph.getNodeAttributes(id) as unknown as Record<string, unknown>;
  const edgeData = (state: ExplorerState, id: string) => state.graph.getEdgeAttributes(id) as unknown as Record<string, unknown>;

  it('a node marked in Select mode is highlighted and never dimmed, whatever the focus', () => {
    const state = loaded();
    // A node with no edge to the focus, so it would be dimmed.
    const marked = 'lone-marked';
    state.graph.addNode(marked, { ...state.graph.getNodeAttributes(state.graph.nodes()[0]!), label: 'Lone' });
    const node = buildNodeReducer({ ...context(state, { focusId: JOE_ID }), markedIds: new Set([marked]) });
    const out = node(marked, nodeData(state, marked));
    expect(out.highlighted).toBe(true);
    expect(out.forceLabel).toBe(true);
    expect(out.color).toBe(state.graph.getNodeAttribute(marked, 'color'));
    // Unmarked, the same node is dimmed.
    const plain = buildNodeReducer(context(state, { focusId: JOE_ID }));
    expect(plain(marked, nodeData(state, marked)).label).toBe('');
  });

  it('with no focus: draws every node as a pictogram, hides nothing, dims nothing, labels no edge', () => {
    const state = loaded();
    const node = buildNodeReducer(context(state));
    const edge = buildEdgeReducer(context(state));
    for (const id of state.graph.nodes()) {
      const out = node(id, nodeData(state, id));
      expect(out.hidden).toBeUndefined();
      expect(out.type).toBe(PICTOGRAM_PROGRAM);
      expect(out.color).toBe(state.graph.getNodeAttribute(id, 'color'));
      expect(out.label).toBe(state.graph.getNodeAttribute(id, 'label'));
    }
    for (const id of state.graph.edges()) {
      const out = edge(id, edgeData(state, id));
      expect(out.label).toBe('');
      expect(out.hidden).toBeUndefined();
    }
  });

  it('hover: lights the node and its neighbours, forces their labels, and dims the rest to 15% — hidden: nothing', () => {
    const state = loaded();
    // A node with no edge to Joe: not his neighbour.
    state.graph.addNode(gid(990), { ...state.graph.getNodeAttributes(ACME_ID), label: 'Stranger' });
    const ctx = context(state, { focusId: JOE_ID });
    const node = buildNodeReducer(ctx);
    const lit = highlightSet(state.graph, JOE_ID)!;

    const joe = node(JOE_ID, nodeData(state, JOE_ID));
    expect(joe.highlighted).toBe(true);
    expect(joe.forceLabel).toBe(true);
    expect(joe.zIndex).toBeGreaterThan(Number(node(ACME_ID, nodeData(state, ACME_ID)).zIndex));

    for (const id of lit.nodes) {
      const out = node(id, nodeData(state, id));
      expect(out.forceLabel, id).toBe(true);
      expect(out.color, id).toBe(state.graph.getNodeAttribute(id, 'color'));
      expect(out.hidden).toBeUndefined();
    }

    const stranger = node(gid(990), nodeData(state, gid(990)));
    expect(stranger.hidden).toBeUndefined();
    expect(stranger.label).toBe('');
    expect(stranger.zIndex).toBe(0);
    expect(String(stranger.color)).toContain(`${DIM_OPACITY}`);
    expect(String(stranger.iconColor)).toContain(`${DIM_OPACITY}`);
    expect(stranger.ringSize).toBe(0);
  });

  it('leaving restores the view: no focus gives back exactly the undimmed output', () => {
    const state = loaded();
    const idle = buildNodeReducer(context(state));
    const hovered = buildNodeReducer(context(state, { focusId: JOE_ID }));
    const back = buildNodeReducer(context(state, { focusId: null }));
    for (const id of state.graph.nodes()) {
      expect(back(id, nodeData(state, id))).toEqual(idle(id, nodeData(state, id)));
    }
    expect(hovered(JOE_ID, nodeData(state, JOE_ID))).not.toEqual(idle(JOE_ID, nodeData(state, JOE_ID)));
  });

  it('the selection lights its neighbours when nothing is hovered, and the hover wins over it', () => {
    const state = loaded();
    const selected = buildNodeReducer(context(state, { selectedId: ACME_ID }));
    expect(selected(ACME_ID, nodeData(state, ACME_ID)).highlighted).toBe(true);
    const hoverWins = buildNodeReducer(context(state, { selectedId: ACME_ID, focusId: JOE_ID }));
    expect(hoverWins(JOE_ID, nodeData(state, JOE_ID)).highlighted).toBe(true);
    expect(hoverWins(ACME_ID, nodeData(state, ACME_ID)).highlighted).toBeUndefined();
  });

  it('the TimeBar dims the nodes outside the window and the edges touching them, never a marked or focused node (GIC-15)', () => {
    const state = loaded();
    const faded = new Set([ANA_ID, JOE_ID]);
    const node = buildNodeReducer({ ...context(state, { focusId: JOE_ID }), dimmedIds: faded, markedIds: new Set([ACME_ID]) });
    const idle = buildNodeReducer(context(state, { focusId: JOE_ID }));

    // Dimmed: faded, unlabelled, unringed.
    const ana = node(ANA_ID, nodeData(state, ANA_ID));
    expect(ana.label).toBe('');
    expect(ana.ringSize).toBe(0);
    expect(String(ana.color)).toContain(`${DIM_OPACITY}`);
    // The focused node keeps its look even when listed.
    expect(node(JOE_ID, nodeData(state, JOE_ID))).toEqual(idle(JOE_ID, nodeData(state, JOE_ID)));

    const timeOnly = buildNodeReducer({ ...context(state), dimmedIds: new Set([ANA_ID]) });
    const plain = buildNodeReducer(context(state));
    expect(timeOnly(ANA_ID, nodeData(state, ANA_ID)).label).toBe('');
    expect(timeOnly(ACME_ID, nodeData(state, ACME_ID))).toEqual(plain(ACME_ID, nodeData(state, ACME_ID)));
    // A marked node is never dimmed.
    const marked = buildNodeReducer({ ...context(state), dimmedIds: new Set([ACME_ID]), markedIds: new Set([ACME_ID]) });
    expect(marked(ACME_ID, nodeData(state, ACME_ID)).highlighted).toBe(true);

    // An edge with a dimmed end is dimmed; the rest are untouched. Nothing dimmed: identical to no TimeBar.
    const edge = buildEdgeReducer({ ...context(state), dimmedIds: new Set([ANA_ID]) });
    const plainEdge = buildEdgeReducer(context(state));
    for (const id of state.graph.edges()) {
      const [a, b] = state.graph.extremities(id);
      const out = edge(id, edgeData(state, id));
      if (a === ANA_ID || b === ANA_ID) expect(String(out.color)).toContain(`${DIM_OPACITY}`);
      else expect(out).toEqual(plainEdge(id, edgeData(state, id)));
    }
    const none = buildNodeReducer({ ...context(state), dimmedIds: new Set() });
    expect(none(ANA_ID, nodeData(state, ANA_ID))).toEqual(plain(ANA_ID, nodeData(state, ANA_ID)));
  });

  it('hides nodes and edges outside visibleIds, without dimming the rest', () => {
    const state = loaded();
    const visibleIds = new Set(state.graph.nodes().filter((id) => id !== ANA_ID));
    const node = buildNodeReducer(context(state, { visibleIds }));
    const edge = buildEdgeReducer(context(state, { visibleIds }));
    expect(node(ANA_ID, nodeData(state, ANA_ID)).hidden).toBe(true);
    expect(node(JOE_ID, nodeData(state, JOE_ID)).hidden).toBeUndefined();
    const anaEdge = state.graph.edges().find((id) => state.graph.extremities(id).includes(ANA_ID))!;
    expect(edge(anaEdge, edgeData(state, anaEdge)).hidden).toBe(true);
  });

  it('edges: the focus edges are lit and labelled, the others dimmed and unlabelled', () => {
    const state = loaded();
    const edge = buildEdgeReducer(context(state, { focusId: ACME_ID }));
    const own = state.graph.edges().filter((id) => state.graph.extremities(id).includes(ACME_ID));
    const foreign = state.graph.edges().filter((id) => !state.graph.extremities(id).some((n) => highlightSet(state.graph, ACME_ID)!.nodes.has(n)));
    expect(own.length).toBeGreaterThan(0);
    for (const id of own) {
      const out = edge(id, edgeData(state, id));
      expect(out.label).toBe(state.graph.getEdgeAttribute(id, 'label'));
      expect(out.color).toBe(state.graph.getEdgeAttribute(id, 'color'));
    }
    for (const id of foreign) {
      const out = edge(id, edgeData(state, id));
      expect(out.label).toBe('');
      expect(String(out.color)).toContain(`${DIM_OPACITY}`);
      expect(out.zIndex).toBe(0);
    }
  });

  it('edge labels appear only on hover or selection, and a hub does not paint a wall of text', () => {
    const state = loaded();
    const edgeId = state.graph.edges()[0];
    const idle = buildEdgeReducer(context(state));
    expect(idle(edgeId, edgeData(state, edgeId)).label).toBe('');
    const hovered = buildEdgeReducer(context(state, { hoveredEdgeId: edgeId }));
    expect(hovered(edgeId, edgeData(state, edgeId)).label).toBe(state.graph.getEdgeAttribute(edgeId, 'label'));

    const hub = hubState();
    const wall = buildEdgeReducer(context(hub, { focusId: JOE_ID }));
    expect(MAX_FOCUS_EDGE_LABELS).toBeLessThan(hub.graph.degree(JOE_ID));
    for (const id of hub.graph.edges()) expect(wall(id, edgeData(hub, id)).label).toBe('');
  });

  it('switches a parallel edge to the curved program and leaves a straight one alone', () => {
    const state = loaded();
    const edge = buildEdgeReducer(context(state));
    const id = state.graph.edges()[0];
    expect(edge(id, { ...edgeData(state, id), curvature: 0 }).type).toBe('arrow');
    expect(edge(id, { ...edgeData(state, id), curvature: 0.3 }).type).toBe(CURVED_ARROW_PROGRAM);
  });

  it('rings: a seed, a pinned and the selected node each get theirs; a plain node none', () => {
    const state = loaded();
    state.graph.setNodeAttribute(ANA_ID, 'fixed', true);
    const node = buildNodeReducer(context(state, { selectedId: ACME_ID }));
    const joe = node(JOE_ID, nodeData(state, JOE_ID));
    const ana = node(ANA_ID, nodeData(state, ANA_ID));
    const acme = node(ACME_ID, nodeData(state, ACME_ID));
    expect(joe.ringSize).toBeGreaterThan(Number(acme.ringSize));
    expect(Number(ana.gapSize)).toBeGreaterThan(0);
    expect(acme.ringColor).toBe('#1976d2');
    const plain = buildNodeReducer(context(state))(Q3_MEETING_ID, nodeData(state, Q3_MEETING_ID));
    expect(plain.ringSize).toBeUndefined();
  });

  it('a graph without pictograms or curvature (the overview) draws as it did', () => {
    const state = loaded();
    const node = buildNodeReducer(context(state));
    const edge = buildEdgeReducer(context(state));
    const plainNode = { x: 0, y: 0, size: 5, color: '#123456', label: 'A' };
    expect(node(JOE_ID, plainNode)).toEqual(plainNode);
    const plainEdge = { size: 1, color: '#123456', type: 'arrow' };
    expect(edge(state.graph.edges()[0], plainEdge)).toEqual({ ...plainEdge, label: '' });
  });

  it('a stub keeps its label even with nothing lit', () => {
    const state = hubState();
    const node = buildNodeReducer(context(state));
    const id = stubId(JOE_ID, 'Person');
    expect(node(id, nodeData(state, id)).forceLabel).toBe(true);
  });

  it('compact: seeds keep their labels', () => {
    const state = loaded();
    const node = buildNodeReducer(context(state, { compact: true }));
    expect(node(JOE_ID, nodeData(state, JOE_ID)).forceLabel).toBe(true);
    expect(node(ACME_ID, nodeData(state, ACME_ID)).forceLabel).toBeUndefined();
  });
});

describe('legendModel', () => {
  const nodeTypes = [
    { key: 'Person', label: 'People' },
    { key: 'Organization', label: 'Organizations' },
    { key: 'Meeting', label: 'Meetings' },
    { key: 'Project', label: 'Projects' },
    { key: 'Topic', label: 'Topics' },
  ];
  const relationTypes = [
    { key: 'WORKS_FOR', label: 'Works for' },
    { key: 'REPORTS_TO', label: 'Reports to' },
    { key: 'ATTENDED', label: 'Attended' },
    { key: 'INVOLVED_IN', label: 'Involved in' },
  ];

  it('lists the types on the canvas with their colour, pictogram and count', () => {
    const state = loaded();
    const model = legendModel(state, nodeTypes, relationTypes);
    const person = model.types.find((t) => t.key === 'Person')!;
    expect(person.count).toBe(state.graph.filterNodes((_id, a) => a.entityType === 'Person').length);
    expect(person.color).toBe(state.graph.getNodeAttribute(JOE_ID, 'color'));
    expect(person.icon).toBe('person');
    expect(person.shown).toBe(true);
    // Nothing on the canvas, nothing hidden: no row of zeros.
    expect(model.types.find((t) => t.key === 'Topic')).toBeUndefined();
    expect(model.hasStance).toBe(false);
  });

  it('keeps a hidden type so it can be switched back on, with a count of zero', () => {
    const state = loaded();
    state.hiddenTypes = new Set(['Topic']);
    const model = legendModel(state, nodeTypes, relationTypes);
    const topic = model.types.find((t) => t.key === 'Topic')!;
    expect(topic).toMatchObject({ shown: false, count: 0 });
  });

  it('counts relations, ignoring stub ties, and flags the stance key when a stance is present', () => {
    const hub = hubState();
    const model = legendModel(hub, nodeTypes, relationTypes);
    const works = model.relations.find((r) => r.key === 'WORKS_FOR')!;
    expect(works.count).toBe(30);
    expect(model.relations.find((r) => r.key === STUB_RELATION)).toBeUndefined();
    expect(model.types.find((t) => t.key === 'Person')!.count).toBeLessThanOrEqual(31);

    const state = loaded();
    state.graph.setEdgeAttribute(state.graph.edges()[0], 'stance', 'champion');
    expect(legendModel(state, nodeTypes, relationTypes).hasStance).toBe(true);
  });

  it('uses the dark colours for the dark variant', () => {
    const state = loaded();
    const light = legendModel(state, nodeTypes, relationTypes, 'light').types[0];
    const dark = legendModel(state, nodeTypes, relationTypes, 'dark').types[0];
    expect(light.color).not.toBe(dark.color);
    expect(light.key).toBe(dark.key);
  });
});
