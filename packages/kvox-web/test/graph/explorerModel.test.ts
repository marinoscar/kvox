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
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import { CATEGORICAL_PALETTE, NODE_SIZE_MIN, encodingFor, relationFamilyColor } from '../../src/graph/ui/components/explorer/explorerEncoding.js';
import type { GraphSlice } from '../../src/graph/headless/clients/graph.js';
import {
  KAPPA_ID,
  ANDERS_ID,
  ATLAS_COMMITMENT_ID,
  BRAM_ID,
  JONTY_ID,
  Q3_MEETING_ID,
  expandFixture,
  gid,
  manyNodesSlice,
} from './graphData.js';

/**
 * The explorer's pure model (#374) — every rule the canvas relies on, tested
 * with no WebGL anywhere near it.
 */

function jontySlice(): GraphSlice {
  return expandFixture({ nodeIds: [JONTY_ID], cap: 300 })!;
}

function loaded(slice = jontySlice()) {
  const state = createExplorerState();
  mergeSlice(state, slice);
  state.seedIds = [...slice.seedIds];
  return state;
}

describe('mergeSlice', () => {
  it('adds every node and edge of a slice, with sigma-safe attributes', () => {
    const state = loaded();
    const slice = jontySlice();
    expect(state.graph.order).toBe(slice.nodes.length);
    expect(state.graph.size).toBe(slice.edges.length);

    const jonty = state.graph.getNodeAttributes(JONTY_ID);
    expect(jonty).toMatchObject({ label: 'Jonty Placeholder', entityType: 'Person', nodeKind: 'entity' });
    // `type` is sigma's program name, never the graph type.
    expect('type' in jonty).toBe(false);
    const edge = state.graph.getEdgeAttributes(gid(410));
    expect(edge).toMatchObject({ type: 'arrow', relationType: 'WORKS_FOR' });
  });

  it('carries the owner\'s isSelf mark from the slice onto the node, on add and on refresh (#778)', () => {
    const slice = jontySlice();
    slice.nodes[0] = { ...slice.nodes[0], isSelf: true };
    const state = createExplorerState();
    mergeSlice(state, slice);
    state.seedIds = [...slice.seedIds];
    const marked = slice.nodes[0].id;
    expect(state.graph.getNodeAttribute(marked, 'isSelf')).toBe(true);
    expect(state.graph.nodes().filter((id) => state.graph.getNodeAttribute(id, 'isSelf') === true)).toEqual([marked]);
    // The user clears the choice: the next read has no mark and the node stops being "You".
    const cleared = jontySlice();
    mergeSlice(state, cleared);
    expect(state.graph.getNodeAttribute(marked, 'isSelf')).toBe(false);
  });

  it('is idempotent: merging the same slice twice adds nothing and keeps positions', () => {
    const state = loaded();
    const before = positionsOf(state);
    const { added, capped } = mergeSlice(state, jontySlice());
    expect(added).toEqual([]);
    expect(capped).toBe(false);
    expect(state.graph.order).toBe(jontySlice().nodes.length);
    expect(positionsOf(state)).toEqual(before);
  });

  it('refreshes data on a node it already has', () => {
    const state = loaded();
    const slice = jontySlice();
    slice.nodes[0] = { ...slice.nodes[0], label: 'Juno Placeholder', degree: 42 };
    mergeSlice(state, slice);
    expect(state.graph.getNodeAttribute(JONTY_ID, 'label')).toBe('Juno Placeholder');
    expect(state.graph.getNodeAttribute(JONTY_ID, 'degree')).toBe(42);
  });

  it('places the first seed at the origin and neighbours on a golden-angle ring around it', () => {
    const state = loaded();
    expect(state.graph.getNodeAttributes(JONTY_ID)).toMatchObject({ x: 0, y: 0 });
    // Ids sorted ascending; KAPPA (gid 4) is the first non-seed after JONTY's
    // neighbours ANDERS (gid 2) — index 0 is ANDERS, index 1 is KAPPA.
    expect(state.graph.getNodeAttributes(ANDERS_ID)).toMatchObject(ringPosition(0, 0, 0));
    expect(state.graph.getNodeAttributes(KAPPA_ID)).toMatchObject(ringPosition(0, 0, 1));
  });

  it('places deterministically: two runs give identical positions', () => {
    expect(positionsOf(loaded())).toEqual(positionsOf(loaded()));
  });

  it('rings new nodes around the expanded parent', () => {
    const state = loaded();
    state.graph.mergeNodeAttributes(KAPPA_ID, { x: 500, y: 500 });
    const { added } = mergeSlice(state, expandFixture({ nodeIds: [KAPPA_ID], cap: 300 })!, {
      parentId: KAPPA_ID,
    });
    expect(added.length).toBeGreaterThan(0);
    const first = [...added].sort()[0];
    expect(state.graph.getNodeAttributes(first)).toMatchObject(ringPosition(500, 500, 0));
  });

  it('keeps a node at a previous position when one is given (as_of rebuild)', () => {
    const state = createExplorerState();
    mergeSlice(state, jontySlice(), { previousPositions: new Map([[ANDERS_ID, { x: 7, y: 9 }]]) });
    expect(state.graph.getNodeAttributes(ANDERS_ID)).toMatchObject({ x: 7, y: 9 });
  });

  it('honours a smaller cap on the state (the phone budget, GIC-08)', () => {
    const state = createExplorerState(120);
    expect(state.cap).toBe(120);
    expect(createExplorerState().cap).toBe(EXPLORER_NODE_CAP);
    const { added, capped } = mergeSlice(state, manyNodesSlice(JONTY_ID, 400));
    expect(capped).toBe(true);
    expect(added).toHaveLength(120);
    expect(state.graph.order).toBe(120);
    expect(state.graph.hasNode(JONTY_ID)).toBe(true);
    expect(remainingCapacity(state)).toBe(0);
    // Raising it later (a rotation to a roomy window) frees room without dropping anything.
    state.cap = 300;
    expect(remainingCapacity(state)).toBe(180);
  });

  it('never exceeds the cap, dropping the lowest-degree NEW nodes first', () => {
    const state = createExplorerState();
    const big = manyNodesSlice(JONTY_ID, 400);
    const { added, capped } = mergeSlice(state, big);
    expect(capped).toBe(true);
    expect(state.graph.order).toBe(EXPLORER_NODE_CAP);
    expect(added).toHaveLength(EXPLORER_NODE_CAP);
    // The slice's seed always survives.
    expect(state.graph.hasNode(JONTY_ID)).toBe(true);
    // Every kept neighbour is at least as connected as every dropped one.
    const keptDegrees = big.nodes.filter((n) => n.id !== JONTY_ID && state.graph.hasNode(n.id)).map((n) => n.degree);
    const droppedDegrees = big.nodes.filter((n) => !state.graph.hasNode(n.id)).map((n) => n.degree);
    expect(Math.min(...keptDegrees)).toBeGreaterThanOrEqual(Math.max(...droppedDegrees));
    expect(remainingCapacity(state)).toBe(0);

    // At the cap, a further merge adds nothing and says so.
    const more = mergeSlice(state, manyNodesSlice(JONTY_ID, 5, 9000));
    expect(more).toEqual({ added: [], capped: true });
    expect(state.graph.order).toBe(EXPLORER_NODE_CAP);
  });

  it('adds an edge only when both ends made it', () => {
    const state = createExplorerState();
    mergeSlice(state, manyNodesSlice(JONTY_ID, 400));
    state.graph.forEachEdge((_edge, _attrs, source, target) => {
      expect(state.graph.hasNode(source) && state.graph.hasNode(target)).toBe(true);
    });
    expect(state.graph.size).toBe(EXPLORER_NODE_CAP - 1);
  });

  it('records whether the slice was truncated', () => {
    const state = createExplorerState();
    mergeSlice(state, { ...jontySlice(), truncated: true });
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
  it('drops non-qualifying types, a seed included, and keeps what was fetched from the seed (#764)', () => {
    const state = loaded();
    const { removed } = applyFilters(state, new Set(['Organization']), null);
    // The Person seed leaves the canvas; KAPPA, fetched FROM it, stays.
    expect(state.graph.hasNode(JONTY_ID)).toBe(false);
    expect(state.graph.hasNode(KAPPA_ID)).toBe(true);
    expect(state.graph.hasNode(ANDERS_ID)).toBe(false);
    expect(state.graph.hasNode(Q3_MEETING_ID)).toBe(false);
    expect(removed).toEqual(expect.arrayContaining([JONTY_ID, ANDERS_ID]));
    // The seed's id stays: it anchors the request that relaxes the filter.
    expect(state.seedIds).toEqual([JONTY_ID]);
  });

  it('a later pass with every seed already gone only drops by type', () => {
    const state = loaded();
    applyFilters(state, new Set(['Organization']), null);
    const { removed } = applyFilters(state, new Set(['Organization']), null);
    expect(removed).toEqual([]);
    expect(state.graph.hasNode(KAPPA_ID)).toBe(true);
  });

  it('a type no node has leaves the canvas empty — Products only with a Person seed (#764)', () => {
    const state = loaded();
    applyFilters(state, new Set(['Product']), null);
    expect(state.graph.order).toBe(0);
    expect(state.seedIds).toEqual([JONTY_ID]);
    expect(visibleNodeIds(state)).toEqual([]);
  });

  it('drops edges of hidden relation types and the nodes left unreachable', () => {
    const state = loaded();
    const allTypes = new Set(['Person', 'Organization', 'Meeting', 'commitment', 'decision', 'Project']);
    const relations = new Set(['ASSIGNED_TO']);
    const { removed } = applyFilters(state, allTypes, relations);
    // Everyone reached along WORKS_FOR / REPORTS_TO / ATTENDED goes; the
    // commitment ASSIGNED_TO Jonty stays.
    expect(removed).toEqual(expect.arrayContaining([ANDERS_ID, KAPPA_ID, Q3_MEETING_ID]));
    expect(state.graph.hasNode(ATLAS_COMMITMENT_ID)).toBe(true);
    expect(state.graph.hasNode(JONTY_ID)).toBe(true);
    state.graph.forEachEdge((_e, attrs) => expect(relations.has(attrs.relationType)).toBe(true));
  });

  it('forgets removed nodes as expanded', () => {
    const state = loaded();
    state.expanded.add(ANDERS_ID);
    applyFilters(state, new Set(['Organization']), null);
    expect(state.expanded.has(ANDERS_ID)).toBe(false);
  });
});

describe('visibleNodeIds', () => {
  it('excludes hidden types, seeds included (#764)', () => {
    const state = loaded();
    state.hiddenTypes = new Set(['Person', 'Meeting']);
    const visible = visibleNodeIds(state);
    expect(visible).not.toContain(JONTY_ID);
    expect(visible).toContain(KAPPA_ID);
    expect(visible).not.toContain(ANDERS_ID);
    expect(visible).not.toContain(Q3_MEETING_ID);
  });
});

describe('removeNode and makeSeed', () => {
  it('hides a non-seed and refuses a seed', () => {
    const state = loaded();
    expect(removeNode(state, JONTY_ID)).toBe(false);
    expect(state.graph.hasNode(JONTY_ID)).toBe(true);
    expect(removeNode(state, ANDERS_ID)).toBe(true);
    expect(state.graph.hasNode(ANDERS_ID)).toBe(false);
    expect(removeNode(state, ANDERS_ID)).toBe(false);
  });

  it('promotes a node to a seed once', () => {
    const state = loaded();
    expect(makeSeed(state, KAPPA_ID)).toBe(true);
    expect(makeSeed(state, KAPPA_ID)).toBe(false);
    expect(makeSeed(state, gid(99999))).toBe(false);
    expect(state.seedIds).toEqual([JONTY_ID, KAPPA_ID]);
    expect(removeNode(state, KAPPA_ID)).toBe(false);
  });
});

describe('toListModel', () => {
  it('orders seeds first, then by depth, degree and label, with depth from the seed', () => {
    const state = loaded();
    state.expanded.add(JONTY_ID);
    const rows = toListModel(state);
    expect(rows[0]).toMatchObject({ id: JONTY_ID, isSeed: true, depthFromSeed: 0, expandable: false });
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
    mergeSlice(state, expandFixture({ nodeIds: [KAPPA_ID], cap: 300 })!, { parentId: KAPPA_ID });
    const darcy = toListModel(state).find((row) => row.label === 'Darcy Placeholder');
    expect(darcy?.depthFromSeed).toBe(2);
  });
});

describe('keyboardOrder', () => {
  it('orders visible nodes by degree, then label', () => {
    const state = loaded();
    const order = keyboardOrder(state);
    expect(order[0]).toBe(JONTY_ID);
    expect(new Set(order)).toEqual(new Set(visibleNodeIds(state)));
  });
});

describe('nodeStyle', () => {
  const darkPalette: ExplorerPalette = {
    palette: {
      ...DEFAULT_EXPLORER_PALETTE.palette,
      mode: 'dark',
      text: { secondary: '#aaaaaa', disabled: '#888888' },
    },
  };

  it('colours by type from the validated palette, not the theme: the light or dark variant follows the mode', () => {
    const color = (type: string, palette = DEFAULT_EXPLORER_PALETTE) =>
      nodeStyle({ type, nodeKind: 'entity', label: 'x', degree: 0 }, palette).color;
    expect(color('Person')).toBe(CATEGORICAL_PALETTE.light[0]);
    expect(color('Person', darkPalette)).toBe(CATEGORICAL_PALETTE.dark[0]);
    expect(color('Interest')).not.toBe(color('Trip'));
    // Types that were all grey before now have a colour of their own.
    expect(new Set(['Interest', 'Trip', 'Milestone', 'claim', 'Topic', 'Product', 'Risk'].map((t) => color(t))).size).toBe(7);
  });

  it('carries the type pictogram and a glyph colour that reads on the fill', () => {
    const style = nodeStyle({ type: 'Risk', nodeKind: 'entity', label: 'x', degree: 0 });
    expect(style.image.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(style.iconColor).toBe(encodingFor('Risk').iconColor);
  });

  it('sizes by the square root of mentionCount, falling back to degree; an item is four-fifths', () => {
    const size = (input: Parameters<typeof nodeStyle>[0]) => nodeStyle(input).size;
    expect(size({ type: 'Person', nodeKind: 'entity', label: 'x', degree: 0 })).toBe(NODE_SIZE_MIN);
    expect(size({ type: 'Person', nodeKind: 'entity', label: 'x', degree: 9 })).toBeCloseTo(NODE_SIZE_MIN + 4.8, 2);
    expect(size({ type: 'Person', nodeKind: 'entity', label: 'x', degree: 9, mentionCount: 16 })).toBeCloseTo(NODE_SIZE_MIN + 6.4, 2);
    expect(size({ type: 'commitment', nodeKind: 'item', label: 'x', degree: 9 })).toBeCloseTo((NODE_SIZE_MIN + 4.8) * 0.8, 1);
    expect(nodeStyle({ type: 'Person', nodeKind: 'entity', label: 'Jonty', degree: 1 }).label).toBe('Jonty');
  });

  it('restyles an existing graph for a new theme without moving it', () => {
    const state = loaded();
    const before = positionsOf(state);
    restyle(state, darkPalette);
    expect(state.graph.getNodeAttribute(JONTY_ID, 'color')).toBe(CATEGORICAL_PALETTE.dark[0]);
    // An edge takes its relation family's colour for the theme variant, never the disabled-text grey.
    const relation = state.graph.getEdgeAttribute(gid(410), 'relationType');
    expect(state.graph.getEdgeAttribute(gid(410), 'color')).toBe(relationFamilyColor(relation, 'dark'));
    expect(state.graph.getEdgeAttribute(gid(410), 'color')).not.toBe('#888888');
    expect(positionsOf(state)).toEqual(before);
    restyle(state, DEFAULT_EXPLORER_PALETTE);
    expect(state.graph.getNodeAttribute(JONTY_ID, 'color')).toBe(CATEGORICAL_PALETTE.light[0]);
  });
});

describe('seedFromNodes (overview hand-off)', () => {
  it('places the hand-off nodes at their overview positions as seeds', () => {
    const state = createExplorerState();
    seedFromNodes(
      state,
      [JONTY_ID, BRAM_ID, gid(99999)],
      [
        { id: JONTY_ID, label: 'Jonty Placeholder', type: 'Person', x: 12, y: -4, degree: 5 },
        { id: BRAM_ID, label: 'Bram Example', type: 'Person', x: -30, y: 8, degree: 2 },
        { id: ATLAS_COMMITMENT_ID, label: 'Ship', type: 'commitment', x: 1, y: 1, degree: 1 },
      ],
    );
    expect(state.graph.getNodeAttributes(JONTY_ID)).toMatchObject({ x: 12, y: -4 });
    expect(state.graph.getNodeAttributes(ATLAS_COMMITMENT_ID).nodeKind).toBe('item');
    // A seed id with no node is dropped rather than left dangling.
    expect(state.seedIds).toEqual([JONTY_ID, BRAM_ID]);

    // The expand that follows keeps those positions.
    mergeSlice(state, jontySlice());
    expect(state.graph.getNodeAttributes(JONTY_ID)).toMatchObject({ x: 12, y: -4 });
  });
});
