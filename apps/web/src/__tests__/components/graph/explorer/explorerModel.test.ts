import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPLORER_PALETTE,
  EXPLORER_NODE_CAP,
  GOLDEN_ANGLE,
  applyFilters,
  createExplorerState,
  keyboardOrder,
  makeSeed,
  mergeSlice,
  nodeStyle,
  positionsOf,
  remainingCapacity,
  removeNode,
  restyle,
  ringPosition,
  seedFromNodes,
  toListModel,
  visibleNodeIds,
  type ExplorerPalette,
} from '../../../../components/graph/explorer/explorerModel';
import type { GraphSlice } from '../../../../services/graph';
import {
  ACME_ID,
  ANA_ID,
  ATLAS_COMMITMENT_ID,
  BEN_ID,
  JOE_ID,
  Q3_MEETING_ID,
  expandFixture,
  gid,
  manyNodesSlice,
} from '../../../mocks/graphData';

/**
 * The explorer's pure model (#374) — every rule the canvas relies on, tested
 * with no WebGL anywhere near it.
 */

function joeSlice(): GraphSlice {
  return expandFixture({ nodeIds: [JOE_ID], cap: 300 })!;
}

function loaded(slice = joeSlice()) {
  const state = createExplorerState();
  mergeSlice(state, slice);
  state.seedIds = [...slice.seedIds];
  return state;
}

describe('mergeSlice', () => {
  it('adds every node and edge of a slice, with sigma-safe attributes', () => {
    const state = loaded();
    const slice = joeSlice();
    expect(state.graph.order).toBe(slice.nodes.length);
    expect(state.graph.size).toBe(slice.edges.length);

    const joe = state.graph.getNodeAttributes(JOE_ID);
    expect(joe).toMatchObject({ label: 'Joe Rivera', entityType: 'Person', nodeKind: 'entity' });
    // `type` is sigma's program name, never the graph type.
    expect('type' in joe).toBe(false);
    const edge = state.graph.getEdgeAttributes(gid(410));
    expect(edge).toMatchObject({ type: 'arrow', relationType: 'WORKS_FOR' });
  });

  it('is idempotent: merging the same slice twice adds nothing and keeps positions', () => {
    const state = loaded();
    const before = positionsOf(state);
    const { added, capped } = mergeSlice(state, joeSlice());
    expect(added).toEqual([]);
    expect(capped).toBe(false);
    expect(state.graph.order).toBe(joeSlice().nodes.length);
    expect(positionsOf(state)).toEqual(before);
  });

  it('refreshes data on a node it already has', () => {
    const state = loaded();
    const slice = joeSlice();
    slice.nodes[0] = { ...slice.nodes[0], label: 'Joseph Rivera', degree: 42 };
    mergeSlice(state, slice);
    expect(state.graph.getNodeAttribute(JOE_ID, 'label')).toBe('Joseph Rivera');
    expect(state.graph.getNodeAttribute(JOE_ID, 'degree')).toBe(42);
  });

  it('places the first seed at the origin and neighbours on a golden-angle ring around it', () => {
    const state = loaded();
    expect(state.graph.getNodeAttributes(JOE_ID)).toMatchObject({ x: 0, y: 0 });
    // Ids sorted ascending; ACME (gid 4) is the first non-seed after JOE's
    // neighbours ANA (gid 2) — index 0 is ANA, index 1 is ACME.
    expect(state.graph.getNodeAttributes(ANA_ID)).toMatchObject(ringPosition(0, 0, 0));
    expect(state.graph.getNodeAttributes(ACME_ID)).toMatchObject(ringPosition(0, 0, 1));
  });

  it('places deterministically: two runs give identical positions', () => {
    expect(positionsOf(loaded())).toEqual(positionsOf(loaded()));
  });

  it('rings new nodes around the expanded parent', () => {
    const state = loaded();
    state.graph.mergeNodeAttributes(ACME_ID, { x: 500, y: 500 });
    const { added } = mergeSlice(state, expandFixture({ nodeIds: [ACME_ID], cap: 300 })!, {
      parentId: ACME_ID,
    });
    expect(added.length).toBeGreaterThan(0);
    const first = [...added].sort()[0];
    expect(state.graph.getNodeAttributes(first)).toMatchObject(ringPosition(500, 500, 0));
  });

  it('keeps a node at a previous position when one is given (as_of rebuild)', () => {
    const state = createExplorerState();
    mergeSlice(state, joeSlice(), { previousPositions: new Map([[ANA_ID, { x: 7, y: 9 }]]) });
    expect(state.graph.getNodeAttributes(ANA_ID)).toMatchObject({ x: 7, y: 9 });
  });

  it('never exceeds the cap, dropping the lowest-degree NEW nodes first', () => {
    const state = createExplorerState();
    const big = manyNodesSlice(JOE_ID, 400);
    const { added, capped } = mergeSlice(state, big);
    expect(capped).toBe(true);
    expect(state.graph.order).toBe(EXPLORER_NODE_CAP);
    expect(added).toHaveLength(EXPLORER_NODE_CAP);
    // The slice's seed always survives.
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
    // Every kept neighbour is at least as connected as every dropped one.
    const keptDegrees = big.nodes.filter((n) => n.id !== JOE_ID && state.graph.hasNode(n.id)).map((n) => n.degree);
    const droppedDegrees = big.nodes.filter((n) => !state.graph.hasNode(n.id)).map((n) => n.degree);
    expect(Math.min(...keptDegrees)).toBeGreaterThanOrEqual(Math.max(...droppedDegrees));
    expect(remainingCapacity(state)).toBe(0);

    // At the cap, a further merge adds nothing and says so.
    const more = mergeSlice(state, manyNodesSlice(JOE_ID, 5, 9000));
    expect(more).toEqual({ added: [], capped: true });
    expect(state.graph.order).toBe(EXPLORER_NODE_CAP);
  });

  it('adds an edge only when both ends made it', () => {
    const state = createExplorerState();
    mergeSlice(state, manyNodesSlice(JOE_ID, 400));
    state.graph.forEachEdge((_edge, _attrs, source, target) => {
      expect(state.graph.hasNode(source) && state.graph.hasNode(target)).toBe(true);
    });
    expect(state.graph.size).toBe(EXPLORER_NODE_CAP - 1);
  });

  it('records whether the slice was truncated', () => {
    const state = createExplorerState();
    mergeSlice(state, { ...joeSlice(), truncated: true });
    expect(state.truncated).toBe(true);
  });
});

describe('ringPosition', () => {
  it('grows the radius every twelve nodes and turns by the golden angle', () => {
    expect(ringPosition(0, 0, 0)).toEqual({ x: 80, y: 0 });
    const second = ringPosition(0, 0, 1);
    expect(Math.hypot(second.x, second.y)).toBeCloseTo(80, 2);
    expect(Math.atan2(second.y, second.x)).toBeCloseTo(GOLDEN_ANGLE, 2);
    const thirteenth = ringPosition(10, 20, 12);
    expect(Math.hypot(thirteenth.x - 10, thirteenth.y - 20)).toBeCloseTo(100, 2);
  });
});

describe('applyFilters', () => {
  it('drops non-qualifying types, never a seed', () => {
    const state = loaded();
    const { removed } = applyFilters(state, new Set(['Organization']), null);
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
    expect(state.graph.hasNode(ACME_ID)).toBe(true);
    expect(state.graph.hasNode(ANA_ID)).toBe(false);
    expect(state.graph.hasNode(Q3_MEETING_ID)).toBe(false);
    expect(removed).toContain(ANA_ID);
    expect(removed).not.toContain(JOE_ID);
  });

  it('drops edges of hidden relation types and the nodes left unreachable', () => {
    const state = loaded();
    const allTypes = new Set(['Person', 'Organization', 'Meeting', 'commitment', 'decision', 'Project']);
    const relations = new Set(['ASSIGNED_TO']);
    const { removed } = applyFilters(state, allTypes, relations);
    // Everyone reached along WORKS_FOR / REPORTS_TO / ATTENDED goes; the
    // commitment ASSIGNED_TO Joe stays.
    expect(removed).toEqual(expect.arrayContaining([ANA_ID, ACME_ID, Q3_MEETING_ID]));
    expect(state.graph.hasNode(ATLAS_COMMITMENT_ID)).toBe(true);
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
    state.graph.forEachEdge((_e, attrs) => expect(relations.has(attrs.relationType)).toBe(true));
  });

  it('forgets removed nodes as expanded', () => {
    const state = loaded();
    state.expanded.add(ANA_ID);
    applyFilters(state, new Set(['Organization']), null);
    expect(state.expanded.has(ANA_ID)).toBe(false);
  });
});

describe('visibleNodeIds', () => {
  it('always includes seeds, and excludes hidden types', () => {
    const state = loaded();
    state.hiddenTypes = new Set(['Person', 'Meeting']);
    const visible = visibleNodeIds(state);
    expect(visible).toContain(JOE_ID);
    expect(visible).toContain(ACME_ID);
    expect(visible).not.toContain(ANA_ID);
    expect(visible).not.toContain(Q3_MEETING_ID);
  });
});

describe('removeNode and makeSeed', () => {
  it('hides a non-seed and refuses a seed', () => {
    const state = loaded();
    expect(removeNode(state, JOE_ID)).toBe(false);
    expect(state.graph.hasNode(JOE_ID)).toBe(true);
    expect(removeNode(state, ANA_ID)).toBe(true);
    expect(state.graph.hasNode(ANA_ID)).toBe(false);
    expect(removeNode(state, ANA_ID)).toBe(false);
  });

  it('promotes a node to a seed once', () => {
    const state = loaded();
    expect(makeSeed(state, ACME_ID)).toBe(true);
    expect(makeSeed(state, ACME_ID)).toBe(false);
    expect(makeSeed(state, gid(99999))).toBe(false);
    expect(state.seedIds).toEqual([JOE_ID, ACME_ID]);
    expect(removeNode(state, ACME_ID)).toBe(false);
  });
});

describe('toListModel', () => {
  it('orders seeds first, then by depth, degree and label, with depth from the seed', () => {
    const state = loaded();
    state.expanded.add(JOE_ID);
    const rows = toListModel(state);
    expect(rows[0]).toMatchObject({ id: JOE_ID, isSeed: true, depthFromSeed: 0, expandable: false });
    const rest = rows.slice(1);
    expect(rest.every((row) => row.depthFromSeed === 1)).toBe(true);
    for (let i = 1; i < rest.length; i += 1) {
      expect(rest[i - 1].degree).toBeGreaterThanOrEqual(rest[i].degree);
    }
    expect(rest.find((row) => row.id === ATLAS_COMMITMENT_ID)).toMatchObject({
      nodeKind: 'item',
      type: 'commitment',
      expandable: true,
    });
  });

  it('computes depth two hops out after an expansion', () => {
    const state = loaded();
    mergeSlice(state, expandFixture({ nodeIds: [ACME_ID], cap: 300 })!, { parentId: ACME_ID });
    const dana = toListModel(state).find((row) => row.label === 'Dana Li');
    expect(dana?.depthFromSeed).toBe(2);
  });
});

describe('keyboardOrder', () => {
  it('orders visible nodes by degree, then label', () => {
    const state = loaded();
    const order = keyboardOrder(state);
    expect(order[0]).toBe(JOE_ID);
    expect(new Set(order)).toEqual(new Set(visibleNodeIds(state)));
  });
});

describe('nodeStyle', () => {
  const palette: ExplorerPalette = {
    palette: {
      primary: { main: '#111111' },
      secondary: { main: '#222222' },
      success: { main: '#333333' },
      info: { main: '#444444' },
      warning: { main: '#555555' },
      error: { main: '#666666' },
      text: { secondary: '#777777', disabled: '#888888' },
    },
  };

  it('colours by type from the theme', () => {
    const style = (type: string, nodeKind: 'entity' | 'item' = 'entity') =>
      nodeStyle({ type, nodeKind, label: 'x', degree: 0 }, palette).color;
    expect(style('Person')).toBe('#111111');
    expect(style('Organization')).toBe('#222222');
    expect(style('Project')).toBe('#333333');
    expect(style('Meeting')).toBe('#444444');
    expect(style('commitment', 'item')).toBe('#555555');
    expect(style('decision', 'item')).toBe('#666666');
    expect(style('SomethingNew')).toBe('#777777');
  });

  it('sizes by 4 + 2·log2(1 + degree), items three-quarters of that', () => {
    expect(nodeStyle({ type: 'Person', nodeKind: 'entity', label: 'x', degree: 0 }).size).toBe(4);
    expect(nodeStyle({ type: 'Person', nodeKind: 'entity', label: 'x', degree: 3 }).size).toBe(8);
    expect(nodeStyle({ type: 'commitment', nodeKind: 'item', label: 'x', degree: 3 }).size).toBe(6);
    expect(nodeStyle({ type: 'Person', nodeKind: 'entity', label: 'Joe', degree: 1 }).label).toBe('Joe');
  });

  it('restyles an existing graph for a new theme without moving it', () => {
    const state = loaded();
    const before = positionsOf(state);
    restyle(state, palette);
    expect(state.graph.getNodeAttribute(JOE_ID, 'color')).toBe('#111111');
    expect(state.graph.getEdgeAttribute(gid(410), 'color')).toBe('#888888');
    expect(positionsOf(state)).toEqual(before);
    restyle(state, DEFAULT_EXPLORER_PALETTE);
    expect(state.graph.getNodeAttribute(JOE_ID, 'color')).toBe(DEFAULT_EXPLORER_PALETTE.palette.primary.main);
  });
});

describe('seedFromNodes (overview hand-off)', () => {
  it('places the hand-off nodes at their overview positions as seeds', () => {
    const state = createExplorerState();
    seedFromNodes(
      state,
      [JOE_ID, BEN_ID, gid(99999)],
      [
        { id: JOE_ID, label: 'Joe Rivera', type: 'Person', x: 12, y: -4, degree: 5 },
        { id: BEN_ID, label: 'Ben Okafor', type: 'Person', x: -30, y: 8, degree: 2 },
        { id: ATLAS_COMMITMENT_ID, label: 'Ship', type: 'commitment', x: 1, y: 1, degree: 1 },
      ],
    );
    expect(state.graph.getNodeAttributes(JOE_ID)).toMatchObject({ x: 12, y: -4 });
    expect(state.graph.getNodeAttributes(ATLAS_COMMITMENT_ID).nodeKind).toBe('item');
    // A seed id with no node is dropped rather than left dangling.
    expect(state.seedIds).toEqual([JOE_ID, BEN_ID]);

    // The expand that follows keeps those positions.
    mergeSlice(state, joeSlice());
    expect(state.graph.getNodeAttributes(JOE_ID)).toMatchObject({ x: 12, y: -4 });
  });
});
