import { UndirectedGraph } from 'graphology';
import { describe, expect, it } from 'vitest';

import {
  EDGE_LINE_MAX,
  EDGE_LINE_MIN,
  LABEL_LOD_ZOOM,
  MIN_GRAPHICAL_CONTRAST,
  NODE_DIAMETER_MAX,
  NODE_DIAMETER_MIN,
  NODE_SIZE_MAX,
  NODE_SIZE_MIN,
  RELATION_FAMILY_COLORS,
  clusterDiameter,
  SEED_DIAMETER_BONUS,
  VALIDATION_BACKGROUNDS,
  contrastRatio,
  edgeCurveOffset,
  edgeLineWidth,
  nodeDiameter,
  relationFamily,
  relationFamilyColor,
  type ExplorerMode,
} from '../../src/graph/ui/components/explorer/explorerEncoding.js';
import {
  NODE_Z,
  buildCanvasData,
  clusterSize,
  computeElementStates,
  diameterOf,
  labelScale,
  edgeStateStyles,
  iconSource,
  nodeStateStyles,
  toEdgeDatum,
  toNodeDatum,
  type CanvasTheme,
  type StateContext,
} from '../../src/graph/ui/components/explorer/g6/canvasData.js';
import { pictogramDataUri } from '../../src/graph/ui/components/explorer/icons/pictograms.js';
import { ORG_ALPHA, PERSON_A, PERSON_B, PRODUCT_X, PROJECT_P1, STUB, canvasGraph } from './canvasFixtures.js';

/**
 * The G6 canvas's encoding (#775), pure: node and edge sizes, colours, the data each element carries,
 * and the interaction states (including the level-of-detail threshold) the reducers turn into.
 */

const THEME: CanvasTheme = {
  mode: 'light',
  paper: '#ffffff',
  text: '#111111',
  textSecondary: '#555555',
  accent: '#1565c0',
  self: '#9c27b0',
  marked: '#ed6c02',
  fontFamily: 'Inter, sans-serif',
};

describe('node and edge sizes', () => {
  it('maps the model radius onto 18 to 56 px, a seed a little bigger, never past the maximum', () => {
    expect(nodeDiameter(NODE_SIZE_MIN * 0.8)).toBe(NODE_DIAMETER_MIN);
    expect(nodeDiameter(NODE_SIZE_MAX)).toBe(NODE_DIAMETER_MAX);
    expect(nodeDiameter(undefined)).toBeGreaterThanOrEqual(NODE_DIAMETER_MIN);
    const plain = nodeDiameter(10);
    expect(nodeDiameter(10, true)).toBeCloseTo(plain + SEED_DIAMETER_BONUS);
    expect(nodeDiameter(NODE_SIZE_MAX, true)).toBe(NODE_DIAMETER_MAX);
    expect(nodeDiameter(14)).toBeGreaterThan(nodeDiameter(8));
  });

  it('maps the model edge width onto 1.25 to 5 px', () => {
    expect(edgeLineWidth(1)).toBe(EDGE_LINE_MIN);
    expect(edgeLineWidth(6)).toBe(EDGE_LINE_MAX);
    expect(edgeLineWidth(100)).toBe(EDGE_LINE_MAX);
    expect(edgeLineWidth(3.5)).toBeGreaterThan(EDGE_LINE_MIN);
    expect(edgeLineWidth(undefined)).toBeGreaterThan(EDGE_LINE_MIN);
  });

  it('fans parallel edges out on one side of a slight common bend', () => {
    expect(edgeCurveOffset(0)).toBeGreaterThan(0);
    expect(edgeCurveOffset(0.15)).toBeGreaterThan(edgeCurveOffset(0));
    expect(edgeCurveOffset(-0.15)).toBeLessThan(edgeCurveOffset(0));
  });
});

describe('screen-constant labels and cluster sizes', () => {
  it('keeps label text the same size on screen between zoom 0.4 and 2.5', () => {
    for (const zoom of [0.4, 0.7, 1, 1.6, 2.5]) {
      const scale = labelScale(zoom);
      const onScreen = (scale.node.labelFontSize as number) * zoom;
      expect(onScreen).toBeGreaterThan(11);
      expect(onScreen).toBeLessThan(14.5);
      expect((scale.edge.labelFontSize as number) * zoom).toBeLessThan(onScreen);
    }
    // Outside the range the text scales with the camera again.
    expect(labelScale(0.1)).toEqual(labelScale(0.05));
    expect(labelScale(6)).toEqual(labelScale(10));
    // Quantised: a small zoom change keeps the same styles (no restyle on every frame).
    expect(labelScale(1.02)).toEqual(labelScale(1));
  });

  it('a datum carries the scale it is given, and the pill in the paper colour', () => {
    const graph = canvasGraph();
    const datum = toNodeDatum(ORG_ALPHA, graph.getNodeAttributes(ORG_ALPHA), THEME, labelScale(0.5));
    expect(datum.style).toMatchObject({
      labelFontSize: labelScale(0.5).node.labelFontSize,
      labelBackground: true,
      labelBackgroundFill: THEME.paper,
      labelBackgroundOpacity: 0.85,
    });
  });

  it('draws nodes above edges, so an edge never runs over a label', () => {
    const graph = canvasGraph();
    const node = toNodeDatum(ORG_ALPHA, graph.getNodeAttributes(ORG_ALPHA), THEME);
    const edge = toEdgeDatum('e-works', PERSON_A, ORG_ALPHA, graph.getEdgeAttributes('e-works'), THEME);
    const edgeStyles = edgeStateStyles(THEME);
    const highestEdge = Math.max(0, ...Object.values(edgeStyles).map((style) => Number(style.zIndex ?? 0)));
    expect((node.style as { zIndex: number }).zIndex).toBe(NODE_Z);
    expect((edge.style as { zIndex: number }).zIndex).toBe(0);
    expect(highestEdge).toBeLessThan(Number(nodeStateStyles(THEME).dim!.zIndex));
  });

  it('sizes an overview cluster by its member count, within 18 to 56 px', () => {
    expect(clusterDiameter(0)).toBe(NODE_DIAMETER_MIN);
    expect(clusterDiameter(4)).toBeGreaterThan(nodeDiameter(10));
    expect(clusterDiameter(24)).toBeGreaterThan(clusterDiameter(6));
    expect(clusterDiameter(10_000)).toBe(NODE_DIAMETER_MAX);
    expect(diameterOf({ size: 6, memberCount: 9 })).toBe(clusterDiameter(9));
  });

  it('keeps an overview cluster the same size on screen when the overview is fitted far out', () => {
    for (const zoom of [0.4, 0.6, 1, 2]) {
      expect(clusterSize(24, labelScale(zoom)) * zoom).toBeGreaterThan(clusterDiameter(24) * 0.85);
      expect(clusterSize(24, labelScale(zoom)) * zoom).toBeLessThan(clusterDiameter(24) * 1.15);
    }
    const datum = toNodeDatum('cluster:1', { x: 0, y: 0, size: 6, color: '#0d66a5', label: 'Cluster 1 (24)', memberCount: 24 }, THEME, labelScale(0.5));
    expect((datum.style as { size: number }).size).toBe(clusterSize(24, labelScale(0.5)));
    expect(datum.data).toMatchObject({ memberCount: 24 });
  });
});

describe('relation families', () => {
  it('groups known relations and sends the rest to "other"', () => {
    expect(relationFamily('WORKS_FOR')).toBe('organisation');
    expect(relationFamily('friend_of')).toBe('personal');
    expect(relationFamily('ATTENDED')).toBe('activity');
    expect(relationFamily('MENTIONS')).toBe('reference');
    expect(relationFamily('SOMETHING_NEW')).toBe('other');
  });

  it('every family colour reads on every canvas background, in both variants', () => {
    for (const mode of ['light', 'dark'] as ExplorerMode[]) {
      for (const color of Object.values(RELATION_FAMILY_COLORS[mode])) {
        for (const background of VALIDATION_BACKGROUNDS[mode]) {
          expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(MIN_GRAPHICAL_CONTRAST);
        }
      }
    }
    expect(relationFamilyColor('WORKS_FOR', 'dark')).toBe(RELATION_FAMILY_COLORS.dark.organisation);
  });
});

describe('element data', () => {
  it('a node carries its position, diameter, fill, centred icon and a label pill in the theme paper', () => {
    const graph = canvasGraph();
    const datum = toNodeDatum(PERSON_A, graph.getNodeAttributes(PERSON_A), THEME);
    const style = datum.style as Record<string, unknown>;
    expect(datum.type).toBe('circle');
    expect(style).toMatchObject({ x: 0, y: 0, fill: '#0d66a5', labelText: 'Person A', labelBackgroundFill: '#ffffff' });
    expect(style.size).toBe(nodeDiameter(14, true));
    expect(style.labelFontSize).toBeGreaterThanOrEqual(12);
    expect(String(style.iconSrc)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(datum.data).toMatchObject({ isSeed: true, diameter: nodeDiameter(14, true) });
  });

  it('an item is a rounded rectangle; a stub shows how many neighbours it hides', () => {
    const graph = canvasGraph();
    const item = toNodeDatum(PROJECT_P1, graph.getNodeAttributes(PROJECT_P1), THEME);
    expect(item.type).toBe('rect');
    expect((item.style as { radius: number }).radius).toBeGreaterThan(0);
    const stub = toNodeDatum(STUB, graph.getNodeAttributes(STUB), THEME);
    expect((stub.style as { badges: Array<{ text: string }> }).badges).toEqual([{ text: '+3', placement: 'right-top' }]);
  });

  it('re-fills the icon in a dark glyph colour when white would not read', () => {
    const white = pictogramDataUri('person');
    expect(iconSource(white, '#ffffff')).toBe(white);
    const dark = iconSource(white, '#111111')!;
    expect(dark).not.toBe(white);
    expect(atob(dark.split(',')[1]!)).toContain('fill="#111111"');
    expect(iconSource(undefined, '#ffffff')).toBeUndefined();
  });

  it('an edge is a quadratic arrow with its family colour, width, bend and hidden label; derived edges are dashed', () => {
    const graph = canvasGraph();
    const [source, target] = graph.extremities('e-uses');
    const datum = toEdgeDatum('e-uses', source, target, graph.getEdgeAttributes('e-uses'), THEME);
    expect(datum).toMatchObject({ type: 'quadratic', source: PROJECT_P1, target: PRODUCT_X });
    expect(datum.style).toMatchObject({ stroke: '#4a5aa8', endArrow: true, label: false, labelText: 'Uses' });
    expect((datum.style as { curveOffset: number }).curveOffset).toBe(edgeCurveOffset(0.15));
    expect((datum.style as { lineDash?: number[] }).lineDash).toBeUndefined();
    const dashed = toEdgeDatum('e-involved', PERSON_A, PROJECT_P1, graph.getEdgeAttributes('e-involved'), THEME);
    expect((dashed.style as { lineDash: number[] }).lineDash).toEqual([6, 4]);
  });

  it('an undirected graph (the overview) draws no arrow heads', () => {
    const graph = new UndirectedGraph();
    graph.addNode('cluster-1', { x: 0, y: 0, size: 8, color: '#0d66a5', label: 'Cluster 1' });
    graph.addNode('cluster-2', { x: 50, y: 0, size: 8, color: '#509720', label: 'Cluster 2' });
    graph.addEdgeWithKey('link', 'cluster-1', 'cluster-2', { size: 2, color: '#646b78' });
    const data = buildCanvasData(graph, new Set(['cluster-1', 'cluster-2']), THEME);
    expect(data.edges![0]!.style).toMatchObject({ endArrow: false });
    expect(data.nodes![0]!.style).toMatchObject({ icon: false });
  });

  it('buildCanvasData keeps only the visible nodes and the edges between them', () => {
    const graph = canvasGraph();
    const data = buildCanvasData(graph, new Set([PERSON_A, ORG_ALPHA]), THEME);
    expect(data.nodes!.map((node) => node.id)).toEqual([PERSON_A, ORG_ALPHA]);
    expect(data.edges!.map((edge) => edge.id)).toEqual(['e-works']);
  });
});

function ctx(over: Partial<StateContext> = {}): StateContext {
  const graph = over.graph ?? canvasGraph();
  return { graph, visibleIds: new Set(graph.nodes()), selectedId: null, focusId: null, zoom: 1, ...over };
}

describe('computeElementStates', () => {
  it('with nothing focused: no dim, a ring on the seed, labels on', () => {
    const states = computeElementStates(ctx());
    expect(states.nodes[PERSON_A]).toEqual(expect.arrayContaining(['seed', 'labelled']));
    expect(states.nodes[PERSON_B]).toEqual([]);
    expect(Object.values(states.nodes).flat()).not.toContain('dim');
    expect(states.edges['e-works']).toEqual([]);
  });

  it('a focus lights its neighbourhood, labels its edges and dims the rest', () => {
    const states = computeElementStates(ctx({ focusId: PERSON_A }));
    expect(states.nodes[PERSON_A]).toContain('active');
    expect(states.nodes[ORG_ALPHA]).toContain('labelled');
    expect(states.nodes[PERSON_B]).toEqual(expect.arrayContaining(['dim', 'nolabel']));
    expect(states.edges['e-works']).toContain('labelled');
    expect(states.edges['e-uses']).toContain('dim');
  });

  it('the selection gets the selected ring over the seed ring; a pinned node its own', () => {
    const graph = canvasGraph();
    graph.setNodeAttribute(PERSON_B, 'fixed', true);
    const states = computeElementStates(ctx({ graph, selectedId: PERSON_A }));
    expect(states.nodes[PERSON_A]).toContain('selected');
    expect(states.nodes[PERSON_A]).not.toContain('seed');
    // Lit by the selection's focus or not, a pinned node outside it is dimmed and loses its ring.
    expect(states.nodes[PERSON_B]).toContain('dim');
    expect(computeElementStates(ctx({ graph })).nodes[PERSON_B]).toContain('pinned');
  });

  it('below the LOD zoom only the seed, the selection, the path and the own node keep labels', () => {
    const graph = canvasGraph();
    graph.setNodeAttribute(PRODUCT_X, 'isSelf', true);
    const zoom = LABEL_LOD_ZOOM - 0.1;
    const states = computeElementStates(ctx({ graph, zoom, selectedId: null, pathNodeIds: new Set() }));
    expect(states.nodes[PERSON_B]).toContain('nolabel');
    expect(states.nodes[ORG_ALPHA]).toContain('nolabel');
    expect(states.nodes[PERSON_A]).toContain('labelled');
    expect(states.nodes[PRODUCT_X]).toEqual(expect.arrayContaining(['self', 'labelled']));
    // At or above the threshold, nothing is held back.
    expect(computeElementStates(ctx({ graph, zoom: LABEL_LOD_ZOOM })).nodes[PERSON_B]).not.toContain('nolabel');
    // A small canvas (at most `lodMinNodes` visible) keeps every label.
    expect(computeElementStates(ctx({ graph, zoom, lodMinNodes: 25 })).nodes[PERSON_B]).not.toContain('nolabel');
    // A constrained window holds labels back a little longer.
    expect(computeElementStates(ctx({ graph, zoom: 0.7, lodZoom: 0.8 })).nodes[PERSON_B]).toContain('nolabel');
  });

  it('path mode marks the path and dims everything else', () => {
    const states = computeElementStates(
      ctx({ pathNodeIds: new Set([PERSON_A, ORG_ALPHA]), pathEdgeIds: new Set(['e-works']) }),
    );
    expect(states.nodes[ORG_ALPHA]).toEqual(expect.arrayContaining(['path', 'labelled']));
    expect(states.nodes[PRODUCT_X]).toContain('dim');
    expect(states.edges['e-works']).toEqual(expect.arrayContaining(['path', 'labelled']));
    expect(states.edges['e-uses']).toContain('dim');
  });

  it('a marked node is highlighted and never dimmed; hidden nodes have no state at all', () => {
    const graph = canvasGraph();
    const states = computeElementStates(
      ctx({ graph, focusId: PERSON_A, markedIds: new Set([PERSON_B]), visibleIds: new Set([PERSON_A, PERSON_B]) }),
    );
    expect(states.nodes[PERSON_B]).toContain('marked');
    expect(states.nodes[PERSON_B]).not.toContain('dim');
    expect(states.nodes[ORG_ALPHA]).toBeUndefined();
    expect(states.edges['e-works']).toBeUndefined();
  });

  it('every state it produces has a style', () => {
    const nodeStyles = nodeStateStyles(THEME);
    const edgeStyles = edgeStateStyles(THEME);
    const graph = canvasGraph();
    graph.setNodeAttribute(PERSON_B, 'isSelf', true);
    graph.setNodeAttribute(ORG_ALPHA, 'fixed', true);
    const runs = [
      computeElementStates(ctx({ graph })),
      computeElementStates(ctx({ graph, focusId: PERSON_A, hoveredEdgeId: 'e-works', zoom: 0.2 })),
      computeElementStates(ctx({ graph, selectedId: PROJECT_P1, markedIds: new Set([PRODUCT_X]) })),
      computeElementStates(ctx({ graph, pathNodeIds: new Set([PERSON_A]), pathEdgeIds: new Set(['e-works']) })),
    ];
    for (const run of runs) {
      for (const state of Object.values(run.nodes).flat()) expect(nodeStyles).toHaveProperty(state);
      for (const state of Object.values(run.edges).flat()) expect(edgeStyles).toHaveProperty(state);
    }
    expect(nodeStyles.dim!.opacity).toBeLessThan(0.5);
    expect(nodeStyles.selected!.stroke).toBe(THEME.accent);
    expect(nodeStyles.pinned!.lineDash).toBeDefined();
  });
});
