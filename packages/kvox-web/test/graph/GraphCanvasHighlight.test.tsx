import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeGraph, FakeResizeObserver } from './fakeG6.js';
import {
  ORG_ALPHA,
  PERSON_A,
  PERSON_B,
  PRODUCT_X,
  PROJECT_P1,
  STUB,
  canvasGraph,
} from './canvasFixtures.js';

/**
 * `GraphCanvas` over G6 (#775), with `@antv/g6` replaced by a fake `Graph` (jsdom has no canvas): the
 * instance's lifecycle, the data it is given, the interaction STATES the reducers produce, the events it
 * reports, the layouts it runs and the plugins it installs. The reducers' own rules are
 * `explorerVisual.test.ts`; the encoding is `canvasData.test.ts`.
 */

vi.mock('@antv/g6', () => ({ Graph: FakeGraph }));

const { GraphCanvas } = await import('../../src/graph/ui/components/explorer/GraphCanvas.js');
type Props = Parameters<typeof GraphCanvas>[0];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(over: Partial<Props> = {}, strict = false) {
  const graph = over.graph ?? canvasGraph();
  const props: Props = {
    graph,
    version: 1,
    visibleIds: new Set(graph.nodes()),
    selectedId: null,
    layout: 'static',
    onNodeClick: vi.fn(),
    onNodeDoubleClick: vi.fn(),
    onStageClick: vi.fn(),
    onEdgeClick: vi.fn(),
    onNodeContextMenu: vi.fn(),
    height: 400,
    ...over,
  };
  const element = <GraphCanvas {...props} />;
  const result = render(strict ? <StrictMode>{element}</StrictMode> : element);
  await flush();
  return { props, graph, ...result };
}

const states = (id: string) => FakeGraph.last().states[id] ?? [];

beforeEach(() => {
  FakeGraph.reset();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GraphCanvas — the G6 instance', () => {
  it('creates one live instance under StrictMode and destroys it on unmount', async () => {
    const { unmount } = await mount({}, true);
    const live = FakeGraph.instances.filter((graph) => !graph.destroyed);
    expect(live).toHaveLength(1);
    expect(live[0]!.options.zoomRange).toEqual([0.1, 6]);
    expect(live[0]!.options.autoResize).toBe(false);
    unmount();
    expect(FakeGraph.instances.every((graph) => graph.destroyed)).toBe(true);
    expect(FakeResizeObserver.all.size).toBe(0);
  });

  it('wires zoom, pan, drag and the edge-hiding optimisation, and none of them for a non-interactive canvas', async () => {
    await mount();
    const types = (FakeGraph.last().options.behaviors as Array<{ type: string }>).map((b) => b.type);
    expect(types).toEqual(['zoom-canvas', 'drag-canvas', 'drag-element', 'optimize-viewport-transform']);
    expect(FakeGraph.last().listeners.has('node:click')).toBe(true);

    FakeGraph.reset();
    await mount({ interactive: false });
    expect(FakeGraph.last().options.behaviors).toEqual([]);
    expect(FakeGraph.last().listeners.has('node:click')).toBe(false);
  });
});

describe('GraphCanvas — lifecycle', () => {
  it('never asks the instance for its camera before the first draw', async () => {
    const original = FakeGraph.prototype.draw;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the first draw: the instance exists but has no viewport yet.
    FakeGraph.prototype.draw = async function held(this: FakeGraph) {
      await gate;
      return original.call(this);
    };
    try {
      const { rerender, props } = await mount({ selectedId: null });
      const g6 = FakeGraph.last();
      expect(g6.viewport).toBe(false);
      // A resize, a hover and a selection change all arrive before the draw.
      act(() => FakeResizeObserver.trigger());
      act(() => g6.emitElement('node:pointerenter', PERSON_A));
      rerender(<GraphCanvas {...props} selectedId={ORG_ALPHA} />);
      await flush();
      release();
      await flush();
      expect(g6.viewport).toBe(true);
      expect(states(ORG_ALPHA)).toContain('selected');
    } finally {
      FakeGraph.prototype.draw = original;
    }
  });

  it('ignores a transform that finishes after the instance was destroyed', async () => {
    const { unmount } = await mount();
    const g6 = FakeGraph.last();
    unmount();
    expect(g6.destroyed).toBe(true);
    expect(() => g6.emit('aftertransform')).not.toThrow();
    expect(() => g6.emit('afterdraw')).not.toThrow();
  });

  it('a remount (StrictMode, a key change) leaves one live instance and no stray camera calls', async () => {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    try {
      const { unmount } = await mount({ layout: 'forceatlas' }, true);
      const live = FakeGraph.instances.filter((graph) => !graph.destroyed);
      expect(live).toHaveLength(1);
      unmount();
      for (const graph of FakeGraph.instances) graph.emit('aftertransform');
      await flush();
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});

describe('GraphCanvas — data', () => {
  it('draws only the visible nodes and the edges between them', async () => {
    const graph = canvasGraph();
    await mount({ graph, visibleIds: new Set(graph.nodes().filter((id) => id !== PRODUCT_X)) });
    const g6 = FakeGraph.last();
    expect(g6.nodes.map((node) => node.id)).not.toContain(PRODUCT_X);
    expect(g6.edges.map((edge) => edge.id)).not.toContain('e-uses');
    expect(g6.calls).toContain('draw');
    expect(g6.calls).not.toContain('render');
  });

  it('draws an item as a rounded rectangle, a stub with its count badge, and a derived edge dashed', async () => {
    await mount();
    const g6 = FakeGraph.last();
    expect(g6.node(PROJECT_P1).type).toBe('rect');
    expect(g6.node(PERSON_A).type).toBe('circle');
    expect((g6.node(STUB).style as { badges: Array<{ text: string }> }).badges[0]!.text).toBe('+3');
    const involved = g6.edges.find((edge) => edge.id === 'e-involved')!;
    expect(involved.type).toBe('quadratic');
    expect(involved.style!.lineDash).toEqual([6, 4]);
  });
});

describe('GraphCanvas — hover and selection states', () => {
  it('lights the hovered node and its neighbours and dims the rest; leaving restores the view', async () => {
    await mount();
    const g6 = FakeGraph.last();
    expect(states(PERSON_B)).not.toContain('dim');

    act(() => g6.emitElement('node:pointerenter', PERSON_A));
    await flush();
    expect(states(PERSON_A)).toContain('active');
    expect(states(ORG_ALPHA)).toContain('labelled');
    expect(states(PERSON_B)).toContain('dim');
    expect(states('e-works')).toContain('labelled');

    act(() => g6.emitElement('node:pointerleave', PERSON_A));
    await flush();
    expect(states(PERSON_B)).not.toContain('dim');
    expect(states(PERSON_A)).not.toContain('active');
  });

  it('labels a hovered edge only while it is hovered', async () => {
    await mount();
    const g6 = FakeGraph.last();
    expect(states('e-uses')).not.toContain('labelled');
    act(() => g6.emitElement('edge:pointerenter', 'e-uses'));
    await flush();
    expect(states('e-uses')).toEqual(expect.arrayContaining(['active', 'labelled']));
    act(() => g6.emitElement('edge:pointerleave', 'e-uses'));
    await flush();
    expect(states('e-uses')).not.toContain('labelled');
  });

  it('rings the selection and the seed, and lights the selection when nothing is hovered', async () => {
    await mount({ selectedId: ORG_ALPHA });
    expect(states(ORG_ALPHA)).toEqual(expect.arrayContaining(['selected', 'active']));
    expect(states(PERSON_A)).toContain('seed');
    expect(states(PERSON_B)).toContain('dim');
  });

  it('marks the path and dims everything else', async () => {
    await mount({ pathNodeIds: new Set([PERSON_A, ORG_ALPHA]), pathEdgeIds: new Set(['e-works']) });
    expect(states(ORG_ALPHA)).toContain('path');
    expect(states('e-works')).toContain('path');
    expect(states(PRODUCT_X)).toContain('dim');
  });

  it('on a busy canvas, hides labels below the level-of-detail zoom, except the seed', async () => {
    const graph = canvasGraph();
    for (let i = 0; i < 30; i += 1) {
      graph.addNode(`extra-${i}`, { ...graph.getNodeAttributes(PERSON_B), label: `Person ${i}`, x: i * 10, y: 500 });
    }
    await mount({ graph });
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(0.4);
    });
    await flush();
    expect(states(PERSON_B)).toContain('nolabel');
    expect(states(PERSON_A)).toContain('labelled');
    await act(async () => {
      await g6.zoomTo(1.2);
    });
    await flush();
    expect(states(PERSON_B)).not.toContain('nolabel');
  });

  it('a small canvas keeps every label at any zoom', async () => {
    await mount();
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(0.2);
    });
    await flush();
    expect(states(PERSON_B)).not.toContain('nolabel');
  });

  it("always labels and rings the user's own node", async () => {
    const graph = canvasGraph();
    graph.setNodeAttribute(PERSON_B, 'isSelf', true);
    await mount({ graph });
    const g6 = FakeGraph.last();
    await act(async () => {
      await g6.zoomTo(0.2);
    });
    await flush();
    expect(states(PERSON_B)).toEqual(expect.arrayContaining(['self', 'labelled']));
  });
});

describe('GraphCanvas — events', () => {
  it('reports a click with its Shift state, and a double-click as an expand', async () => {
    const { props } = await mount();
    const g6 = FakeGraph.last();
    act(() => g6.emitElement('node:click', ORG_ALPHA));
    expect(props.onNodeClick).toHaveBeenCalledWith(ORG_ALPHA, { shiftKey: false });
    act(() => g6.emitElement('node:click', ORG_ALPHA, { shiftKey: true }));
    expect(props.onNodeClick).toHaveBeenLastCalledWith(ORG_ALPHA, { shiftKey: true });
    act(() => g6.emitElement('node:dblclick', ORG_ALPHA));
    expect(props.onNodeDoubleClick).toHaveBeenCalledWith(ORG_ALPHA);
  });

  it('activating a "+N more" stub expands it and never selects it', async () => {
    const { props } = await mount();
    act(() => FakeGraph.last().emitElement('node:click', STUB));
    expect(props.onNodeDoubleClick).toHaveBeenCalledWith(STUB);
    expect(props.onNodeClick).not.toHaveBeenCalled();
  });

  it('reports the stage, an edge, and a right-click with where to anchor the menu', async () => {
    const { props } = await mount();
    const g6 = FakeGraph.last();
    act(() => g6.emit('canvas:click', { targetType: 'canvas' }));
    expect(props.onStageClick).toHaveBeenCalled();
    act(() => g6.emitElement('edge:click', 'e-works'));
    expect(props.onEdgeClick).toHaveBeenCalledWith('e-works');
    act(() => g6.emitElement('node:contextmenu', ORG_ALPHA, { clientX: 120, clientY: 80 }));
    expect(props.onNodeContextMenu).toHaveBeenCalledWith({ id: ORG_ALPHA, clientX: 120, clientY: 80, source: 'right-click' });
  });

  it('on a touch screen: ignores hover, lights the preview, and a quick second tap is never an expand', async () => {
    const { props } = await mount({ inputModality: 'touch', previewId: PERSON_A });
    const g6 = FakeGraph.last();
    expect(states(PERSON_A)).toContain('active');
    expect(states(PERSON_B)).toContain('dim');
    act(() => g6.emitElement('node:pointerenter', PERSON_B));
    await flush();
    expect(states(PERSON_B)).toContain('dim');
    act(() => g6.emitElement('node:dblclick', ORG_ALPHA));
    expect(props.onNodeDoubleClick).not.toHaveBeenCalled();
  });

  it('a dragged node is pinned where it was dropped', async () => {
    const onPinnedCountChange = vi.fn();
    const { graph } = await mount({ onPinnedCountChange });
    const g6 = FakeGraph.last();
    g6.updateNodeData([{ id: ORG_ALPHA, style: { x: 321, y: 123 } }]);
    const drag = (g6.options.behaviors as Array<{ type: string; onFinish?: (ids: string[]) => void; state?: string }>).find(
      (b) => b.type === 'drag-element',
    )!;
    // Only the node under the pointer moves, never "the selection".
    expect(drag.state).not.toBe('selected');
    act(() => drag.onFinish!([ORG_ALPHA]));
    await flush();
    expect(graph.getNodeAttributes(ORG_ALPHA)).toMatchObject({ x: 321, y: 123, fixed: true });
    expect(onPinnedCountChange).toHaveBeenLastCalledWith(1);
  });
});

describe('GraphCanvas — layouts', () => {
  it('forceatlas: lays out every node first, then only the new ones, with the rest fixed', async () => {
    const graph = canvasGraph();
    const { rerender, props } = await mount({ graph, layout: 'forceatlas' });
    const g6 = FakeGraph.last();
    expect(g6.calls).toContain('render');
    expect(g6.layoutOptions).toMatchObject({ type: 'd3-force', animation: false });
    expect(g6.layoutOptions).not.toHaveProperty('enableWorker');
    // The layout's positions are written back to the model.
    expect(graph.getNodeAttributes(ORG_ALPHA)).toMatchObject({ x: 200, y: 50 });

    graph.addNode('person-c', { ...graph.getNodeAttributes(PERSON_B), label: 'Person C', x: 10, y: 10 });
    rerender(<GraphCanvas {...props} version={2} visibleIds={new Set(graph.nodes())} />);
    await flush();
    expect(g6.node(ORG_ALPHA)).toMatchObject({ fx: 200, fy: 50 });
    expect(g6.node('person-c').fx).toBeUndefined();
    expect(graph.getNodeAttributes(ORG_ALPHA)).toMatchObject({ x: 200, y: 50 });
    expect(graph.getNodeAttributes('person-c')).toMatchObject({ x: 110, y: 60 });
  });

  it('concentric: a radial layout around the first seed; static: no layout at all', async () => {
    await mount({ layout: 'concentric', seedIds: [PERSON_A] });
    expect(FakeGraph.last().layoutOptions).toMatchObject({ type: 'radial', focusNode: PERSON_A });
    expect(FakeGraph.last().layoutOptions).not.toHaveProperty('enableWorker');

    FakeGraph.reset();
    const graph = canvasGraph();
    await mount({ graph, layout: 'static' });
    expect(FakeGraph.last().layoutOptions).toBeNull();
    expect(graph.getNodeAttributes(ORG_ALPHA)).toMatchObject({ x: 100, y: 0 });
  });

  it('a pinned node keeps its place through a radial layout', async () => {
    const graph = canvasGraph();
    graph.mergeNodeAttributes(PERSON_B, { fixed: true });
    sessionStorage.setItem('kvox.graph.pins:view', JSON.stringify({ [PERSON_B]: { x: 7, y: 9 } }));
    await mount({ graph, layout: 'concentric', seedIds: [PERSON_A], pinsKey: 'view' });
    expect(FakeGraph.last().node(PERSON_B).style).toMatchObject({ x: 7, y: 9 });
    sessionStorage.clear();
  });
});

describe('GraphCanvas — plugins', () => {
  it('draws the minimap into the given element, never on a compact window', async () => {
    const frame = document.createElement('div');
    await mount({ minimapContainer: frame });
    const minimap = FakeGraph.last().plugins.find((plugin) => plugin.type === 'minimap');
    expect(minimap).toMatchObject({ container: frame });

    FakeGraph.reset();
    await mount({ minimapContainer: null });
    expect(FakeGraph.last().plugins.find((plugin) => plugin.type === 'minimap')).toBeUndefined();
  });

  it('shows a tooltip on a fine pointer, with the label escaped', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query === '(pointer: fine)' ? true : original(query).matches,
    })) as typeof window.matchMedia;
    try {
      await mount();
      const tooltip = FakeGraph.last().plugins.find((plugin) => plugin.type === 'tooltip') as {
        getContent: (event: unknown, items: unknown[]) => Promise<string>;
      };
      expect(tooltip).toBeDefined();
      const html = await tooltip.getContent({}, [{ id: 'x', data: { label: '<b>Org Alpha</b>', entityType: 'Organization' } }]);
      expect(html).toContain('&#60;b&#62;Org Alpha');
      expect(html).not.toContain('<b>Org');
    } finally {
      window.matchMedia = original;
    }
  });

  it('no tooltip on a touch screen', async () => {
    await mount({ inputModality: 'touch' });
    expect(FakeGraph.last().plugins.find((plugin) => plugin.type === 'tooltip')).toBeUndefined();
  });
});
