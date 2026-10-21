import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';

import {
  createExplorerState,
  mergeSlice,
  stubId,
  type ExplorerState,
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import { CURVED_ARROW_PROGRAM, PICTOGRAM_PROGRAM } from '../../src/graph/ui/components/explorer/explorerReducers.js';
import { ACME_ID, ANA_ID, JOE_ID, Q3_MEETING_ID, expandFixture, hubFixture } from './graphData.js';

/**
 * `GraphCanvas`'s interaction (#667) with sigma stood in for: hover, the first
 * tap on a touch screen, a stub's activation and the programs it registers. The
 * reducers' own rules are `explorerVisual.test.ts`; this proves the canvas wires
 * the right events to them.
 *
 * jsdom has no WebGL, so `@react-sigma/core` and the `@sigma/*` programs (which
 * read `WebGLRenderingContext` when imported) are replaced.
 */

type Reducer = (key: string, data: Record<string, unknown>) => Record<string, unknown>;
type Handlers = Record<string, (event: Record<string, unknown>) => void>;

const sigma = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  containerSettings: {} as Record<string, unknown>,
  handlers: {} as Record<string, (event: Record<string, unknown>) => void>,
}));

vi.mock('@react-sigma/core/lib/style.css', () => ({}));
vi.mock('@react-sigma/core', () => ({
  SigmaContainer: ({ children, settings }: { children?: ReactNode; settings: Record<string, unknown> }) => {
    sigma.containerSettings = settings;
    return <div data-testid="sigma">{children}</div>;
  },
  useSigma: () => ({
    refresh: () => {},
    getBBox: () => ({}),
    getCustomBBox: () => ({}),
    setCustomBBox: () => {},
    viewportToGraph: () => ({ x: 0, y: 0 }),
  }),
  useSetSettings: () => (next: Record<string, unknown>) => {
    sigma.settings = { ...sigma.settings, ...next };
  },
  useRegisterEvents: () => (next: Record<string, (event: Record<string, unknown>) => void>) => {
    sigma.handlers = next;
  },
  useCamera: () => ({ zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
}));
vi.mock('@sigma/node-image', () => ({ createNodeImageProgram: vi.fn(() => class ImageProgram {}) }));
vi.mock('@sigma/node-border', () => ({ createNodeBorderProgram: vi.fn(() => class BorderProgram {}) }));
vi.mock('@sigma/edge-curve', () => ({
  createEdgeCurveProgram: vi.fn(() => class CurveProgram {}),
  createDrawCurvedEdgeLabel: vi.fn(() => () => {}),
}));
vi.mock('sigma/rendering', () => ({ createNodeCompoundProgram: vi.fn(() => class CompoundProgram {}) }));

const { GraphCanvas } = await import('../../src/graph/ui/components/explorer/GraphCanvas.js');

const nodeReducer = () => sigma.settings.nodeReducer as Reducer;
const edgeReducer = () => sigma.settings.edgeReducer as Reducer;
const handler = (name: string) => (sigma.handlers as Handlers)[name];

function explorer(): ExplorerState {
  const state = createExplorerState();
  const slice = expandFixture({ nodeIds: [JOE_ID], cap: 300 })!;
  state.seedIds = [JOE_ID];
  mergeSlice(state, slice);
  // A node with no edge to Joe, to be dimmed.
  state.graph.addNode('lone', { ...state.graph.getNodeAttributes(ACME_ID), label: 'Lone' });
  return state;
}

function mountCanvas(state: ExplorerState, over: Partial<Parameters<typeof GraphCanvas>[0]> = {}) {
  const props = {
    graph: state.graph,
    version: 1,
    visibleIds: new Set(state.graph.nodes()),
    selectedId: null,
    layout: 'static' as const,
    onNodeClick: vi.fn(),
    onNodeDoubleClick: vi.fn(),
    onStageClick: vi.fn(),
    onEdgeClick: vi.fn(),
    height: 400,
    ...over,
  };
  return { props, ...render(<GraphCanvas {...props} />) };
}

const data = (state: ExplorerState, id: string) => state.graph.getNodeAttributes(id) as unknown as Record<string, unknown>;

/** `(hover: none)` is what a touch screen answers. */
function setHoverNone(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.replace(/\s/g, '').includes('(hover:none)') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  sigma.settings = {};
  sigma.handlers = {};
  setHoverNone(false);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GraphCanvas — programs', () => {
  it('registers the pictogram node program and the curved arrow, and draws edge labels', () => {
    mountCanvas(explorer());
    expect(Object.keys(sigma.containerSettings.nodeProgramClasses as object)).toEqual([PICTOGRAM_PROGRAM]);
    expect(Object.keys(sigma.containerSettings.edgeProgramClasses as object)).toEqual([CURVED_ARROW_PROGRAM]);
    expect(sigma.containerSettings.renderEdgeLabels).toBe(true);
  });
});

describe('GraphCanvas — hover', () => {
  it('lights the hovered node and its neighbours and dims the rest; leaving restores the view', () => {
    const state = explorer();
    mountCanvas(state);

    const idle = nodeReducer()('lone', data(state, 'lone'));
    expect(idle.label).toBe('Lone');

    act(() => handler('enterNode')({ node: JOE_ID }));
    expect(nodeReducer()(JOE_ID, data(state, JOE_ID)).highlighted).toBe(true);
    expect(nodeReducer()(ACME_ID, data(state, ACME_ID)).forceLabel).toBe(true);
    const dimmed = nodeReducer()('lone', data(state, 'lone'));
    expect(dimmed.label).toBe('');
    expect(String(dimmed.color)).toContain('0.15');
    // Dimmed, never hidden.
    expect(dimmed.hidden).toBeUndefined();
    const lit = state.graph.edges().find((e) => state.graph.extremities(e).includes(JOE_ID))!;
    expect(edgeReducer()(lit, state.graph.getEdgeAttributes(lit) as never).label).not.toBe('');

    act(() => handler('leaveNode')({}));
    expect(nodeReducer()('lone', data(state, 'lone'))).toEqual(idle);
    expect(nodeReducer()(JOE_ID, data(state, JOE_ID)).highlighted).toBeUndefined();
    expect(edgeReducer()(lit, state.graph.getEdgeAttributes(lit) as never).label).toBe('');
  });

  it('shows the label of a hovered edge only while it is hovered', () => {
    const state = explorer();
    mountCanvas(state);
    const edge = state.graph.edges()[0];
    const attrs = state.graph.getEdgeAttributes(edge) as never;
    expect(edgeReducer()(edge, attrs).label).toBe('');
    act(() => handler('enterEdge')({ edge }));
    expect(edgeReducer()(edge, attrs).label).toBe(state.graph.getEdgeAttribute(edge, 'label'));
    act(() => handler('leaveEdge')({}));
    expect(edgeReducer()(edge, attrs).label).toBe('');
  });

  it('a click selects at once with a pointer', () => {
    const state = explorer();
    const { props } = mountCanvas(state);
    act(() => handler('clickNode')({ node: ACME_ID }));
    expect(props.onNodeClick).toHaveBeenCalledWith(ACME_ID);
  });

  it('the selection lights its neighbours when nothing is hovered', () => {
    const state = explorer();
    mountCanvas(state, { selectedId: ACME_ID });
    expect(nodeReducer()(ACME_ID, data(state, ACME_ID)).highlighted).toBe(true);
    expect(nodeReducer()('lone', data(state, 'lone')).label).toBe('');
  });

  it('hides what is not visible', () => {
    const state = explorer();
    mountCanvas(state, { visibleIds: new Set(state.graph.nodes().filter((id) => id !== ANA_ID)) });
    expect(nodeReducer()(ANA_ID, data(state, ANA_ID)).hidden).toBe(true);
  });
});

describe('GraphCanvas — touch: the first tap does what hover does', () => {
  it('the first tap lights the node and selects nothing; the second tap selects it', () => {
    setHoverNone(true);
    const state = explorer();
    const { props } = mountCanvas(state);

    act(() => handler('clickNode')({ node: JOE_ID }));
    expect(props.onNodeClick).not.toHaveBeenCalled();
    expect(nodeReducer()(JOE_ID, data(state, JOE_ID)).highlighted).toBe(true);
    expect(nodeReducer()('lone', data(state, 'lone')).label).toBe('');

    act(() => handler('clickNode')({ node: JOE_ID }));
    expect(props.onNodeClick).toHaveBeenCalledTimes(1);
    expect(props.onNodeClick).toHaveBeenCalledWith(JOE_ID);
  });

  it('tapping another node moves the highlight instead of selecting', () => {
    setHoverNone(true);
    const state = explorer();
    const { props } = mountCanvas(state);
    act(() => handler('clickNode')({ node: JOE_ID }));
    act(() => handler('clickNode')({ node: ACME_ID }));
    expect(props.onNodeClick).not.toHaveBeenCalled();
    expect(nodeReducer()(ACME_ID, data(state, ACME_ID)).highlighted).toBe(true);
    expect(nodeReducer()(JOE_ID, data(state, JOE_ID)).highlighted).toBeUndefined();
  });

  it('tapping the stage clears the highlight and the selection', () => {
    setHoverNone(true);
    const state = explorer();
    const { props } = mountCanvas(state);
    act(() => handler('clickNode')({ node: JOE_ID }));
    act(() => handler('clickStage')({}));
    expect(props.onStageClick).toHaveBeenCalled();
    expect(nodeReducer()('lone', data(state, 'lone')).label).toBe('Lone');
  });

  it('ignores hover events on a touch screen', () => {
    setHoverNone(true);
    const state = explorer();
    mountCanvas(state);
    act(() => handler('enterNode')({ node: JOE_ID }));
    expect(nodeReducer()('lone', data(state, 'lone')).label).toBe('Lone');
  });
});

describe('GraphCanvas — "+N more" stubs', () => {
  it('activating a stub expands it, whatever the input, and never selects it', () => {
    const state = createExplorerState();
    state.seedIds = [JOE_ID];
    mergeSlice(state, hubFixture({ nodeIds: [JOE_ID], cap: 300 })!, { neighbourLimit: 30 });
    const stub = stubId(JOE_ID, 'Person');
    const { props } = mountCanvas(state);

    act(() => handler('clickNode')({ node: stub }));
    expect(props.onNodeDoubleClick).toHaveBeenCalledWith(stub);
    expect(props.onNodeClick).not.toHaveBeenCalled();
  });

  it('a stub on a touch screen also expands on the first tap', () => {
    setHoverNone(true);
    const state = createExplorerState();
    state.seedIds = [JOE_ID];
    mergeSlice(state, hubFixture({ nodeIds: [JOE_ID], cap: 300 })!, { neighbourLimit: 30 });
    const stub = stubId(JOE_ID, 'Meeting');
    const { props } = mountCanvas(state);
    act(() => handler('clickNode')({ node: stub }));
    expect(props.onNodeDoubleClick).toHaveBeenCalledWith(stub);
  });
});

describe('GraphCanvas — a non-interactive canvas', () => {
  it('registers no handlers and still reduces', () => {
    const state = explorer();
    mountCanvas(state, { interactive: false, selectedId: Q3_MEETING_ID });
    expect(Object.keys(sigma.handlers)).toHaveLength(0);
    expect(nodeReducer()(Q3_MEETING_ID, data(state, Q3_MEETING_ID)).highlighted).toBe(true);
  });
});
